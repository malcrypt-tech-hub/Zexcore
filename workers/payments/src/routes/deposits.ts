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
 *   POST /api/deposit/refund                owner/admin: refund a paid deposit through Paystack
 * The webhook (routes/billing.ts) settles deposits too, so closing the tab never loses a payment.
 */
import { DOERS, requireMember } from '../auth';
import type { Ctx, Deps, Env } from '../env';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { ownerContact } from '../automation';
import { sendFormal } from '../mail';
import { queueFormal } from '../outbox';
import { HttpError, ID_RE, firstName, json, localWhen, randomRef, readJson } from '../util';
import { getLiveNgnRate } from '../rates';
import { assessBooking } from './risk';

const PAYSTACK = 'https://api.paystack.co';
const BOOKING_RE = /^\d{6}_\d{1,6}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
export const ps = (env: Env, d: Deps, path: string, init: RequestInit = {}) =>
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
  const subject = changed ? 'ZexCore: your payout account was changed' : 'ZexCore: payout account set';
  const spec = (hello: string) => ({
    heading: changed ? 'Your payout account was changed' : 'Your payout account is set', greeting: `Hello ${hello},`,
    paragraphs: [changed ? 'The bank account that receives your ZexCore booking deposits was changed.' : 'A bank account was set to receive your ZexCore booking deposits.', 'If this was not you, sign in, change your password straight away and contact us.'],
    details: [['Account name', accountName], ['Bank', String(b.bankName ?? '').slice(0, 80) || bankCode], ['Account ending', accountNumber.slice(-4)], ['Time', `${c.d.now().toISOString().replace('T', ' ').slice(0, 16)} UTC`]] as [string, string][],
    button: { text: 'Open dashboard', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/settings` }, note: 'We email you every time the payout account changes so nobody can redirect your money unnoticed.',
  });
  const owner = await ownerContact(c, wid);
  await sendFormal(c.env, c.d, owner.email, subject, spec(owner.name));
  if (caller.email && caller.email.toLowerCase() !== owner.email.toLowerCase()) await sendFormal(c.env, c.d, caller.email, subject, spec(firstName('', caller.email)));
  return json({ ok: true, accountName, last4: accountNumber.slice(-4) }, 200, c.headers);
}

/** Naira per US dollar for this business: its own fixed rate, or the live one when it uses automatic rates. */
export async function ngnRateFor(c: Ctx, st: Record<string, any>): Promise<number> {
  const rate = Number(st.exchangeRate);
  return !Number.isFinite(rate) || rate < 100 || st.exchangeRateMode === 'auto' ? getLiveNgnRate(c.env, c.d) : rate;
}

interface Plan { wid: string; slug: string; bookingId: string; amountMinor: number; usdMinor: number; rate: number; subaccount: string; email: string; risk: boolean }

async function planDeposit(c: Ctx, wid: string, slug: string, bookingId: string, emailIn: unknown, opts: { requireFresh: boolean }): Promise<Plan> {
  if (!BOOKING_RE.test(bookingId)) throw new HttpError(400, 'Invalid booking');
  const [ws, booking, payout] = await Promise.all([fsGet(c.env, c.d, `workspaces/${wid}`), fsGet(c.env, c.d, `workspaces/${wid}/bookings/${bookingId}`), fsGet(c.env, c.d, `workspaces/${wid}/payout/main`)]);
  const st = (ws?.data.settings ?? {}) as Record<string, any>;
  if (!ws || !booking) throw new HttpError(404, 'Booking not found');
  // A deposit is due when the business takes deposits from everyone, or (Enterprise) when this booking's no-show risk is high enough.
  const everyone = st.depositEnabled === true && Number(st.depositMinor) > 0;
  let baseUsd = Number(st.depositMinor); let risk = false;
  if (!everyone) {
    const r = st.riskDepositEnabled === true ? await assessBooking(c, wid, bookingId) : null;
    const need = st.riskDepositLevel === 'medium' ? 30 : 60;
    if (!r || r.score < need || !(Number(st.riskDepositMinor) > 0)) throw new HttpError(409, 'This business does not take deposits online.', 'deposits_off');
    baseUsd = Number(st.riskDepositMinor); risk = true;
  }
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
  const usdMinor = price > 0 ? Math.min(baseUsd, price) : baseUsd;
  const rate = await ngnRateFor(c, st);
  const amountMinor = Math.round(usdMinor * rate);
  const email = String(emailIn || booking.data.customerEmail || `pay+${bookingId.replace('_', '')}@zexcore.com.ng`).trim();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address for your receipt.');
  return { wid, slug, bookingId, amountMinor, usdMinor, rate, subaccount: String(payout.data.subaccountCode), email, risk };
}

async function startPayment(c: Ctx, p: Plan, by: string): Promise<{ reference: string; authorizationUrl: string; amountMinor: number }> {
  const reference = randomRef(p.wid);
  await fsCommit(c.env, c.d, [
    { path: `workspaces/${p.wid}/depositPayments/${reference}`, fields: { reference, bookingId: p.bookingId, amountMinor: p.amountMinor, usdMinor: p.usdMinor, rate: p.rate, currency: 'NGN', status: 'pending', createdAt: c.d.now(), createdBy: by }, precondition: { exists: false } },
    // A risk-based deposit is not in the business's settings, so the booking itself records that one is owed.
    ...(p.risk ? [{ path: `workspaces/${p.wid}/bookings/${p.bookingId}`, fields: { depositStatus: 'unpaid', depositMinor: p.usdMinor, riskDeposit: true }, mask: ['depositStatus', 'depositMinor', 'riskDeposit'], precondition: { exists: true } }] : []),
  ]);
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
  // Send a customer receipt only after the verified payment and booking update have committed.
  // The paid-state guard above makes webhook/status retries idempotent and prevents duplicate receipts.
  const bookingId = String(pay.data.bookingId ?? '');
  const [booking, workspace] = await Promise.all([
    fsGet(env, d, `workspaces/${wid}/bookings/${bookingId}`),
    fsGet(env, d, `workspaces/${wid}`),
  ]);
  const customerEmail = String(booking?.data.customerEmail ?? '').trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(customerEmail)) {
    const service = booking ? await fsGet(env, d, `workspaces/${wid}/services/${String(booking.data.serviceId)}`) : null;
    const settings = (workspace?.data.settings ?? {}) as Record<string, unknown>;
    const offset = Number(settings.utcOffsetMinutes ?? 60);
    const paidNgn = Number(vj.data.amount ?? pay.data.amountMinor);
    const usdMinor = Number(pay.data.usdMinor ?? 0);
    await queueFormal(env, d, `receipt:${wid}:${reference}`, customerEmail, 'Your booking deposit payment receipt', {
      heading: 'Your deposit payment was received',
      preheader: `Payment received for booking ${bookingId.replace('_', '-')}`,
      greeting: `Hello ${firstName(String(booking?.data.customerName ?? ''), customerEmail)},`,
      paragraphs: ['Your booking deposit has been successfully verified and recorded. Keep this email as your payment receipt.'],
      details: [
        ['Business', String(workspace?.data.name ?? 'ZexCore business')],
        ['Service', String(service?.data.name ?? 'Booking deposit')],
        ['Booking reference', `ZX-${bookingId.replace('_', '-')}`],
        ['Payment reference', reference],
        ['Amount paid', `₦${(paidNgn / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
        ...(usdMinor > 0 ? [['Deposit value', `${(usdMinor / 100).toFixed(2)}`] as [string, string]] : []),
        ['Payment date', now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
        ...(booking?.data.startsAt instanceof Date ? [['Appointment', localWhen(booking.data.startsAt.toISOString(), offset)] as [string, string]] : []),
      ],
      note: 'This receipt confirms the deposit payment only. Contact the business directly if you need to change or cancel your appointment.',
      card: true,
    }).catch((e) => console.error('deposit receipt email failed', e instanceof Error ? e.message : e));
  }
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

/** Refunds a paid deposit through Paystack and records it. Owners and admins only; a deposit can be refunded once. */
export async function refundDeposit(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid, caller } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const bookingId = String(b.bookingId ?? '');
  if (!BOOKING_RE.test(bookingId)) throw new HttpError(400, 'Invalid booking');
  const paid = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'depositPayments', where: [{ field: 'bookingId', op: 'EQUAL', value: bookingId }, { field: 'status', op: 'EQUAL', value: 'paid' }], limit: 1 });
  const pay = paid[0];
  if (!pay) throw new HttpError(409, 'There is no paid deposit to refund for this booking.', 'nothing_to_refund');
  const r = await ps(c.env, c.d, '/refund', { method: 'POST', body: JSON.stringify({ transaction: String(pay.data.reference), customer_note: 'Booking deposit refund', merchant_note: `Refund requested by ${caller.uid}` }) });
  const j = (await r.json().catch(() => ({}))) as { status?: boolean; message?: string };
  if (!r.ok || !j.status) throw new HttpError(502, j.message ? `Paystack could not refund this deposit: ${j.message}` : 'Paystack could not refund this deposit. Try again shortly.', 'refund_failed');
  const now = c.d.now();
  await fsCommit(c.env, c.d, [
    { path: pay.path, fields: { status: 'refunded', refundedAt: now, refundedBy: caller.uid }, mask: ['status', 'refundedAt', 'refundedBy'], precondition: { exists: true } },
    { path: `workspaces/${wid}/bookings/${bookingId}`, fields: { depositStatus: 'refunded' }, mask: ['depositStatus'], precondition: { exists: true } },
  ]);
  return json({ ok: true }, 200, c.headers);
}
