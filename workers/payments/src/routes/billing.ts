import type { Deps, Env } from '../env';
import { verifyFirebaseIdToken } from '../auth';
import { fsCommit, fsGet } from '../fs';
import { getLiveNgnRate, DEFAULT_FALLBACK_RATE } from '../rates';
import { ID_RE, json, paystackSignature, randomRef, timingSafeEqual } from '../util';
import { settleDeposit } from './deposits';
import { settleOrder } from './shop';


// ───────────── pricing (mirrors apps/api/src/billing/plans.ts) ─────────────
export type Tier = 'starter' | 'growth' | 'agency' | 'enterprise' | 'dedicated';
export type Cycle = 'monthly' | 'annual';
export type Currency = 'NGN' | 'USD';
/**
 * Prices are set in US dollars; annual is ten months (two free). A card payment in naira is converted at the live rate when
 * checkout starts, and that amount is stored with the order. Enterprise and Dedicated are agreed with our team and cannot be
 * bought here; their entries only keep the plan-change arithmetic working for workspaces we set up by hand.
 */
export const PLANS: Record<Tier, { monthlyUsd: number; annualUsd: number }> = {
  starter: { monthlyUsd: 8, annualUsd: 80 },
  growth: { monthlyUsd: 43, annualUsd: 430 },
  agency: { monthlyUsd: 133, annualUsd: 1330 },
  enterprise: { monthlyUsd: 499, annualUsd: 4990 },
  dedicated: { monthlyUsd: 1500, annualUsd: 15000 },
};
/** Paystack can flag very large single charges as fraud on accounts with a low limit; above this we ask the buyer to contact us. */
export const DEFAULT_MAX_CHECKOUT_NGN = 1_000_000;
export const maxCheckoutNgn = (env: Env): number => { const n = Number(env.MAX_CHECKOUT_NGN); return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHECKOUT_NGN; };
export const RANK: Record<string, number> = { free: 0, starter: 1, growth: 2, agency: 3, enterprise: 4, dedicated: 5 };
/** The plan a workspace is paying for right now (free once it has lapsed), and when it ends. */
export function activePlan(ws: Record<string, unknown> | undefined, now: Date): { tier: string; expires: Date | null } {
  const tier = String(ws?.plan ?? 'free');
  const exp = ws?.planExpiresAt instanceof Date ? ws.planExpiresAt : null;
  return tier !== 'free' && exp && exp > now ? { tier, expires: exp } : { tier: 'free', expires: null };
}
/** Days of the new plan that the unused time on the old one is worth (same daily value as its monthly price). */
export function creditDays(oldTier: string, remainingMs: number, newTier: Tier): number {
  const old = PLANS[oldTier as Tier]; if (!old || remainingMs <= 0) return 0;
  return Math.floor((remainingMs / 86_400_000) * old.monthlyUsd / PLANS[newTier].monthlyUsd);
}
export const isTier = (v: unknown): v is Tier => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v);
export function amountMinor(tier: Tier, cycle: Cycle, currency: Currency, ngnPerUsd = DEFAULT_FALLBACK_RATE): number {
  const usd = cycle === 'annual' ? PLANS[tier].annualUsd : PLANS[tier].monthlyUsd;
  return Math.round((currency === 'NGN' ? usd * ngnPerUsd : usd) * 100);
}

const PAID_RANK: Record<Tier, number> = { starter: 0, growth: 1, agency: 2, enterprise: 3, dedicated: 4 };

/**
 * What a successful payment does to the workspace. Time is never lost:
 *  - same plan: the new period is added to what is left;
 *  - upgrade: what is left on the old plan is converted into time on the new one, at the ratio of their monthly prices;
 *  - paying for a lower plan while a higher one is active (an old checkout left open): the higher plan stays and is extended
 *    by the equivalent time.
 */
export function planAfterPayment(currentPlan: unknown, currentExpiry: Date | null, tier: Tier, cycle: Cycle, now: Date): { plan: Tier; expires: Date } {
  const addMs = (cycle === 'annual' ? 365 : 31) * 86_400_000;
  const active = isTier(currentPlan) && currentExpiry !== null && currentExpiry > now;
  if (!active) return { plan: tier, expires: new Date(now.getTime() + addMs) };
  const cur = currentPlan as Tier;
  if (cur === tier) return { plan: tier, expires: new Date(currentExpiry!.getTime() + addMs) };
  if (PAID_RANK[cur] < PAID_RANK[tier]) {
    const carriedDays = creditDays(cur, currentExpiry!.getTime() - now.getTime(), tier);   // whole days, same rule as everywhere else
    return { plan: tier, expires: new Date(now.getTime() + carriedDays * 86_400_000 + addMs) };
  }
  const extra = addMs * (PLANS[tier].monthlyUsd / PLANS[cur].monthlyUsd);
  return { plan: cur, expires: new Date(currentExpiry!.getTime() + extra) };
}

// ───────────── POST /api/checkout ─────────────
export async function checkout(req: Request, env: Env, d: Deps, headers: Record<string, string>): Promise<Response> {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(env, d, bearer) : null;
  if (!caller) return json({ error: 'Sign in again to continue.' }, 401, headers);
  if (!caller.email) return json({ error: 'Your account must have an email address for payment invoices.', code: 'email_missing' }, 400, headers);

  let body: any; try { body = await req.json(); } catch { return json({ error: 'Invalid request' }, 400, headers); }
  const { workspaceId, tier, cycle = 'monthly', currency = 'NGN' } = body ?? {};
  if (typeof workspaceId !== 'string' || !ID_RE.test(workspaceId)) return json({ error: 'Invalid workspace' }, 400, headers);
  if (!isTier(tier)) return json({ error: 'Unknown plan' }, 400, headers);
  if (tier === 'enterprise' || tier === 'dedicated') return json({ error: 'Enterprise and Dedicated plans are set up with our team. Please contact us at hello@zexcore.com.ng.', code: 'contact_us' }, 409, headers);
  if (cycle !== 'monthly' && cycle !== 'annual') return json({ error: 'Invalid billing cycle' }, 400, headers);
  if (currency !== 'NGN' && currency !== 'USD') return json({ error: 'Unsupported currency' }, 400, headers);

  const member = await fsGet(env, d, `workspaces/${workspaceId}/members/${caller.uid}`);
  if (!member || !['owner', 'admin'].includes(String(member.data.role))) return json({ error: 'Only a workspace owner or admin can change the plan.' }, 403, headers);

  // Buying a cheaper plan while a dearer one is still running would throw the paid time away. Ask them to wait or write to us.
  const wsNow = await fsGet(env, d, `workspaces/${workspaceId}`);
  const cur = activePlan(wsNow?.data, d.now());
  if ((RANK[tier] ?? 0) < (RANK[cur.tier] ?? 0)) return json({ error: `You are on the ${cur.tier} plan until ${cur.expires?.toISOString().slice(0, 10)}. To move to a cheaper plan, wait until it ends or contact us.`, code: 'downgrade_blocked' }, 409, headers);

  const liveRate = await getLiveNgnRate(env, d);
  const amount = amountMinor(tier, cycle, currency, liveRate);
  if (currency === 'NGN' && amount > maxCheckoutNgn(env) * 100) return json({ error: `Payments this large are arranged with our team. Please choose monthly billing, or contact us at hello@zexcore.com.ng to pay for the ${tier} plan by ${cycle === 'annual' ? 'the year' : 'bank transfer'}.`, code: 'contact_us' }, 409, headers);
  const reference = randomRef(workspaceId);
  await fsCommit(env, d, [{
    path: `workspaces/${workspaceId}/payments/${reference}`,
    fields: { reference, tier, cycle, currency, amountMinor: amount, rate: liveRate, status: 'pending', createdBy: caller.uid, createdAt: d.now() },
    precondition: { exists: false },
  }]);

  const r = await d.fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: caller.email, amount, currency, reference, callback_url: `${env.APP_URL}/app/billing?reference=${reference}`, metadata: { workspaceId, tier, cycle } }),
  });
  const j = (await r.json().catch(() => ({}))) as { status?: boolean; data?: { authorization_url?: string } };
  if (!r.ok || !j.status || !j.data?.authorization_url) return json({ error: 'Payment provider is unavailable. Try again shortly.' }, 502, headers);
  return json({ reference, authorizationUrl: j.data.authorization_url, amountMinor: amount, currency }, 201, headers);
}

// ───────────── POST /api/paystack-webhook ─────────────
export async function webhook(req: Request, env: Env, d: Deps): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get('x-paystack-signature') ?? '';
  if (!sig || !timingSafeEqual(sig, await paystackSignature(raw, env.PAYSTACK_SECRET_KEY))) return json({ error: 'Invalid signature' }, 401);

  let event: any; try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid payload' }, 400); }
  if (event?.event !== 'charge.success') return json({ ok: true, ignored: true });
  const reference = event.data?.reference;
  const metaWid = event.data?.metadata?.workspaceId;
  if (event.data?.metadata?.kind === 'deposit' && typeof reference === 'string' && typeof metaWid === 'string' && ID_RE.test(metaWid)) return json({ ok: true, deposit: await settleDeposit(env, d, metaWid, reference) });
  if (event.data?.metadata?.kind === 'order' && typeof reference === 'string' && typeof metaWid === 'string' && ID_RE.test(metaWid)) return json({ ok: true, order: await settleOrder(env, d, metaWid, reference) });
  if (typeof reference !== 'string' || typeof metaWid !== 'string' || !ID_RE.test(metaWid)) return json({ ok: true, ignored: true });

  // Our own record of what was asked for is the only source of tier, cycle, currency and price.
  const path = `workspaces/${metaWid}/payments/${reference}`;
  const pay = await fsGet(env, d, path);
  if (!pay) return json({ ok: true, ignored: 'unknown_reference' });
  if (pay.data.status === 'paid') return json({ ok: true, duplicate: true });

  // Ask Paystack directly rather than trusting the posted body.
  const v = await d.fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } });
  const vj = (await v.json().catch(() => ({}))) as { status?: boolean; data?: { status?: string; amount?: number; currency?: string; reference?: string } };
  if (!v.ok || !vj.status || vj.data?.status !== 'success' || vj.data.reference !== reference) return json({ ok: true, ignored: 'not_successful' });
  if (vj.data.currency !== pay.data.currency || (vj.data.amount ?? 0) < Number(pay.data.amountMinor)) {
    await fsCommit(env, d, [{ path, fields: { status: 'mismatch', paidMinor: vj.data.amount ?? 0, paidCurrency: vj.data.currency ?? null, updatedAt: d.now() }, mask: ['status', 'paidMinor', 'paidCurrency', 'updatedAt'], precondition: { updateTime: pay.updateTime } }]);
    return json({ ok: true, ignored: 'amount_mismatch' });
  }

  const tier = String(pay.data.tier); const cycle = pay.data.cycle === 'annual' ? 'annual' : 'monthly';
  if (!isTier(tier)) return json({ ok: true, ignored: 'bad_tier' });
  const ws = await fsGet(env, d, `workspaces/${metaWid}`);
  if (!ws) return json({ ok: true, ignored: 'unknown_workspace' });
  const now = d.now();
  const { plan: newPlan, expires } = planAfterPayment(ws.data.plan, ws.data.planExpiresAt instanceof Date ? ws.data.planExpiresAt : null, tier, cycle, now);

  await fsCommit(env, d, [
    { path, fields: { status: 'paid', paidMinor: vj.data.amount, paidAt: now }, mask: ['status', 'paidMinor', 'paidAt'], precondition: { updateTime: pay.updateTime } },
    { path: `workspaces/${metaWid}`, fields: { plan: newPlan, planCycle: newPlan === tier ? cycle : (ws.data.planCycle ?? cycle), planExpiresAt: expires }, mask: ['plan', 'planCycle', 'planExpiresAt'], precondition: { exists: true } },
  ]);
  return json({ ok: true, activated: newPlan, expiresAt: expires.toISOString() });
}

