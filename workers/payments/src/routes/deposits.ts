/**
 * Booking deposits. Money goes straight to the business: each business has a Paystack *subaccount* tied to its bank
 * account, and every deposit is a normal Paystack transaction split to that subaccount (the business bears Paystack's
 * fee). ZexCore's own Paystack account is only the parent; it never holds the deposit.
 *
 *   GET  /api/banks?workspaceId=            Nigerian banks (for the payout form)
 *   POST /api/payout/setup                  owner: verify the account name with Paystack and create/update the subaccount
 *   POST /api/public/deposit                booking page: start a deposit payment for a booking the visitor just made
 *   POST /api/deposit/link                  team: payment link for an existing booking
 *   GET  /api/public/deposit-status         booking page: did the payment go through? (also verifies with Paystack)
 * The webhook (routes/billing.ts) settles deposits too, so closing the tab never loses a payment.
 */
import { DOERS, requireMember } from '../auth';
import type { Ctx, Deps, Env } from '../env';
import { FsConflict, fsCommit, fsGet } from '../fs';
import { sendMail } from '../mail';
import { ownerEmail } from '../automation';
import { HttpError, ID_RE, json, randomRef, readJson } from '../util';
import { getLiveNgnRate } from '../rates';

const PAYSTACK = 'https://api.paystack.co';
const BOOKING_RE = /^\d{6}_\d{1,6}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const ps = (env: Env, d: Deps, path: string, init: RequestInit = {}) =>
  d.fetch(`${PAYSTACK}${path}`, { ...init, headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

export async function banks(c: Ctx): Promise<Response> {
  await requireMember(c, c.url.searchParams.get('workspaceId'));
  const r = await ps(c.env, c.d, '/bank?country=nigeria&perPage=200&use_cursor=false');
  const j = (await r.json().catch(() => ({}))) as { data?: { name: string; code: string; active?: boolean }[] };
  if (!r.ok || !Array.isArray(j.data)) throw new HttpError(502, 'Could not load the list of banks. Try again shortly.');
  const seen = new Set<string>();
  const list = j.data.filter((b) => b.active !== false && !seen.has(b.code) && seen.add(b.code)).map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name));
  return json({ banks: list }, 200, { ...c.headers, 'cache-control': 'private, max-age=3600' });
}

export async function payoutSetup(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid, caller } = await requireMember(c, b.workspaceId, ['owner']);
  const bankCode = String(b.bankCode ?? ''); const accountNumber = String(b.accountNumber ?? '');
  if (!/^\d{3,6}$/.test(bankCode)) throw new HttpError(400, 'Choose your bank.');
  if (!/^\d{10}$/.test(accountNumber)) throw new HttpError(400, 'Enter your 10-digit account number.');
  const res = await ps(c.env, c.d, `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
  const rj = (await res.json().catch(() => ({}))) as { status?: boolean; data?: { account_name?: string } };
  if (!res.ok || !rj.status || !rj.data?.account_name) throw new HttpError(422, 'We could not find that account. Check the bank and account number.', 'account_not_found');
  const accountName = rj.data.account_name;

  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const existing = await fsGet(c.env, c.d, `workspaces/${wid}/payout/main`);
  const payload = { business_name: String(ws?.data.name ?? 'ZexCore business').slice(0, 100), settlement_bank: bankCode, account_number: accountNumber, percentage_charge: 0, description: `ZexCore workspace ${wid}` };
  const sub = existing?.data.subaccountCode
    ? await ps(c.env, c.d, `/subaccount/${encodeURIComponent(String(existing.data.subaccountCode))}`, { method: 'PUT', body: JSON.stringify(payload) })
    : await ps(c.env, c.d, '/subaccount', { method: 'POST', body: JSON.stringify(payload) });
  const sj = (await sub.json().catch(() => ({}))) as { status?: boolean; data?: { subaccount_code?: string } };
  const code = sj.data?.subaccount_code ?? (existing?.data.subaccountCode as string | undefined);
  if (!sub.ok || !sj.status || !code) throw new HttpError(502, 'Paystack could not set up your payout account. Try again shortly.');
  await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/payout/main`, fields: { subaccountCode: code, bankCode, bankName: String(b.bankName ?? '').slice(0, 80), accountName, last4: accountNumber.slice(-4), updatedAt: c.d.now(), updatedBy: caller.uid } }]);
  // Tell the owner every time the place deposits are paid is set or changed, so a hijacked session cannot redirect money silently.
  const changed = Boolean(existing?.data.last4) && (existing?.data.bankCode !== bankCode || existing?.data.last4 !== accountNumber.slice(-4));
  const note = `${changed ? 'The bank account for your ZexCore deposits was changed.' : 'A bank account was set for your ZexCore deposits.'}\n\nAccount name: ${accountName}\nBank: ${String(b.bankName ?? '').slice(0, 80) || bankCode}\nAccount ending: ${accountNumber.slice(-4)}\n\nIf this was not you, sign in, change your password straight away and contact support.`;
  const owner = await ownerEmail(c, wid);
  await sendMail(c.env, c.d, owner, changed ? 'ZexCore: your payout account was changed' : 'ZexCore: payout account set', note);
  if (caller.email && caller.email.toLowerCase() !== owner.toLowerCase()) await sendMail(c.env, c.d, caller.email, changed ? 'ZexCore: your payout account was changed' : 'ZexCore: payout account set', note);
  return json({ ok: true, accountName, last4: accountNumber.slice(-4) }, 200, c.headers);
}

interface Plan { wid: string; slug: string; bookingId: string; amountMinor: number; usdMinor: number; rate: number; subaccount: string; email: string }

async function planDeposit(c: Ctx, wid: string, slug: string, bookingId: string, emailIn: unknown, opts: { requireFresh: boolean }): Promise<Plan> {
  if (!BOOKING_RE.test(bookingId)) throw new HttpError(400, 'Invalid booking');
  const [ws, booking, payout] = await Promise.all([fsGet(c.env, c.d, `workspaces/${wid}`), fsGet(c.env, c.d, `workspaces/${wid}/bookings/${bookingId}`), fsGet(c.env, c.d, `workspaces/${wid}/payout/main`)]);
  const st = (ws?.data.settings ?? {}) as Record<string, any>;
  if (!ws || !booking) throw new HttpError(404, 'Booking not found');
  if (st.depositEnabled !== true || !(Number(st.depositMinor) > 0)) throw new HttpError(409, 'This business does not take deposits online.', 'deposits_off');
  if (!payout?.data.subaccountCode) throw new HttpError(409, 'This business has not finished setting up payouts yet.', 'payout_missing');
  if (booking.data.status === 'cancelled') throw new HttpError(409, 'This booking was cancelled.');
  if (booking.data.depositStatus === 'paid') throw new HttpError(409, 'The deposit is already paid.', 'already_paid');
  if (opts.requireFresh) {
    const created = booking.data.createdAt instanceof Date ? booking.data.createdAt.getTime() : 0;
    if (booking.data.source !== 'public' || c.d.now().getTime() - created > 30 * 60_000) throw new HttpError(404, 'Booking not found');
  }
  const svc = await fsGet(c.env, c.d, `workspaces/${wid}/services/${String(booking.data.serviceId)}`);
  const price = Number(svc?.data.priceMinor ?? 0);
  // Prices and deposits are US-dollar cents; the business sets its own exchange rate and Paystack charges naira (kobo).
  const usdMinor = price > 0 ? Math.min(Number(st.depositMinor), price) : Number(st.depositMinor);
  let rate = Number(st.exchangeRate);
  if (!Number.isFinite(rate) || rate < 100 || st.exchangeRateMode === 'auto') {
    rate = await getLiveNgnRate(c.env, c.d);
  }
  const amountMinor = Math.round(usdMinor * rate);
  const email = String(emailIn || booking.data.customerEmail || `pay+${bookingId.replace('_', '')}@zexcore.com.ng`).trim();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address for your receipt.');
  return { wid, slug, bookingId, amountMinor, usdMinor, rate, subaccount: String(payout.data.subaccountCode), email };
}

async function startPayment(c: Ctx, p: Plan, by: string): Promise<{ reference: string; authorizationUrl: string; amountMinor: number }> {
  const reference = randomRef(p.wid);
  await fsCommit(c.env, c.d, [{ path: `workspaces/${p.wid}/depositPayments/${reference}`, fields: { reference, bookingId: p.bookingId, amountMinor: p.amountMinor, usdMinor: p.usdMinor, rate: p.rate, currency: 'NGN', status: 'pending', createdAt: c.d.now(), createdBy: by }, precondition: { exists: false } }]);
  const fee = Math.max(0, Math.min(Number(c.env.DEPOSIT_FEE_MINOR ?? 0) || 0, Math.floor(p.amountMinor / 2)));
  const r = await ps(c.env, c.d, '/transaction/initialize', { method: 'POST', body: JSON.stringify({
    email: p.email, amount: p.amountMinor, currency: 'NGN', reference, subaccount: p.subaccount, bearer: 'subaccount', ...(fee ? { transaction_charge: fee } : {}),
    callback_url: `${c.env.APP_URL}/${p.slug}?pay=${reference}`, metadata: { kind: 'deposit', workspaceId: p.wid, bookingId: p.bookingId },
  }) });
  const j = (await r.json().catch(() => ({}))) as { status?: boolean; data?: { authorization_url?: string } };
  if (!r.ok || !j.status || !j.data?.authorization_url) throw new HttpError(502, 'Payment provider is unavailable. Try again shortly.');
  return { reference, authorizationUrl: j.data.authorization_url, amountMinor: p.amountMinor };
}

export async function publicDeposit(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 2048);
  const slug = String(b.slug ?? '');
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  if (!wid) throw new HttpError(404, 'Not found');
  const plan = await planDeposit(c, wid, slug, String(b.bookingId ?? ''), b.email, { requireFresh: true });
  return json(await startPayment(c, plan, 'visitor'), 201, c.headers);
}

export async function depositLink(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 2048);
  const { wid, caller } = await requireMember(c, b.workspaceId, DOERS);
  const slug = String((await fsGet(c.env, c.d, `workspaces/${wid}`))?.data.slug ?? '');
  const plan = await planDeposit(c, wid, slug, String(b.bookingId ?? ''), b.email, { requireFresh: false });
  return json(await startPayment(c, plan, caller.uid), 201, c.headers);
}

/** Verifies a deposit with Paystack and, if it is genuinely paid in full, confirms the booking. Safe to call repeatedly. */
export async function settleDeposit(env: Env, d: Deps, wid: string, reference: string): Promise<'paid' | 'pending' | 'mismatch' | 'unknown'> {
  const path = `workspaces/${wid}/depositPayments/${reference}`;
  const pay = await fsGet(env, d, path);
  if (!pay) return 'unknown';
  if (pay.data.status === 'paid') return 'paid';
  const v = await ps(env, d, `/transaction/verify/${encodeURIComponent(reference)}`);
  const vj = (await v.json().catch(() => ({}))) as { status?: boolean; data?: { status?: string; amount?: number; currency?: string; reference?: string } };
  if (!v.ok || !vj.status || vj.data?.status !== 'success' || vj.data.reference !== reference) return 'pending';
  if (vj.data.currency !== pay.data.currency || (vj.data.amount ?? 0) < Number(pay.data.amountMinor)) {
    await fsCommit(env, d, [{ path, fields: { status: 'mismatch', paidMinor: vj.data.amount ?? 0, updatedAt: d.now() }, mask: ['status', 'paidMinor', 'updatedAt'], precondition: { updateTime: pay.updateTime } }]).catch(() => undefined);
    return 'mismatch';
  }
  const now = d.now();
  try {
    await fsCommit(env, d, [
      { path, fields: { status: 'paid', paidMinor: vj.data.amount, paidAt: now }, mask: ['status', 'paidMinor', 'paidAt'], precondition: { updateTime: pay.updateTime } },
      { path: `workspaces/${wid}/bookings/${String(pay.data.bookingId)}`, fields: { depositStatus: 'paid', depositMinor: Number(pay.data.usdMinor) || 0, paymentReference: reference, status: 'confirmed' }, mask: ['depositStatus', 'depositMinor', 'paymentReference', 'status'], precondition: { exists: true } },
    ]);
  } catch (e) { if (!(e instanceof FsConflict)) throw e; return (await fsGet(env, d, path))?.data.status === 'paid' ? 'paid' : 'pending'; }
  return 'paid';
}

export async function depositStatus(c: Ctx): Promise<Response> {
  const slug = c.url.searchParams.get('slug') ?? ''; const reference = c.url.searchParams.get('reference') ?? '';
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || !ID_RE.test(reference)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  if (!wid || !reference.startsWith(`zx_${wid.slice(0, 12)}_`)) throw new HttpError(404, 'Not found');
  const state = await settleDeposit(c.env, c.d, wid, reference);
  if (state === 'unknown') throw new HttpError(404, 'Not found');
  const pay = await fsGet(c.env, c.d, `workspaces/${wid}/depositPayments/${reference}`);
  const booking = pay ? await fsGet(c.env, c.d, `workspaces/${wid}/bookings/${String(pay.data.bookingId)}`) : null;
  const svc = booking ? await fsGet(c.env, c.d, `workspaces/${wid}/services/${String(booking.data.serviceId)}`) : null;
  const id = String(pay?.data.bookingId ?? '');
  return json({ ref: `ZX-${id.replace('_', '-')}`, status: booking?.data.status ?? 'pending', depositStatus: state === 'paid' ? 'paid' : state === 'mismatch' ? 'mismatch' : 'unpaid', amountMinor: Number(pay?.data.usdMinor ?? 0), currency: 'USD', chargedNgnMinor: Number(pay?.data.amountMinor ?? 0), rate: Number(pay?.data.rate ?? 0),
    serviceName: svc?.data.name ?? '', startsAt: booking?.data.startsAt instanceof Date ? booking.data.startsAt.toISOString() : null }, 200, c.headers);
}
