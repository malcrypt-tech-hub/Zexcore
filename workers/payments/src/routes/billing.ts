import type { Deps, Env } from '../env';
import { verifyFirebaseIdToken } from '../auth';
import { fsCommit, fsGet } from '../fs';
import { ID_RE, json, paystackSignature, randomRef, timingSafeEqual } from '../util';
import { settleDeposit } from './deposits';

import { getLiveNgnRate, DEFAULT_FALLBACK_RATE } from '../rates';

// ───────────── pricing (mirrors apps/api/src/billing/plans.ts) ─────────────
export type Tier = 'starter' | 'growth' | 'agency' | 'enterprise' | 'dedicated';
export type Cycle = 'monthly' | 'annual';
export type Currency = 'NGN' | 'USD';
export const PLANS: Record<Tier, { monthlyUsd: number; annualUsd: number }> = {
  starter: { monthlyUsd: 19, annualUsd: 190 },
  growth: { monthlyUsd: 49, annualUsd: 490 },
  agency: { monthlyUsd: 149, annualUsd: 1490 },
  enterprise: { monthlyUsd: 499, annualUsd: 4990 },
  dedicated: { monthlyUsd: 1500, annualUsd: 15000 },
};
const RANK: Record<string, number> = { free: 0, starter: 1, growth: 2, agency: 3, enterprise: 4, dedicated: 5 };
/** The plan a workspace is paying for right now (free once it has lapsed), and when it ends. */
export function activePlan(ws: Record<string, unknown> | undefined, now: Date): { tier: string; expires: Date | null } {
  const tier = String(ws?.plan ?? 'free');
  const exp = ws?.planExpiresAt instanceof Date ? ws.planExpiresAt : null;
  return tier !== 'free' && exp && exp > now ? { tier, expires: exp } : { tier: 'free', expires: null };
}
/** Days of the new plan that the unused time on the old one is worth (same daily value as its monthly price). */
export function creditDays(oldTier: string, remainingMs: number, newTier: Tier): number {
  const old = PLANS[oldTier as Tier]; if (!old || remainingMs <= 0) return 0;
  return Math.floor((remainingMs / 86_400_000) * (old.monthlyUsd / PLANS[newTier].monthlyUsd));
}
export const isTier = (v: unknown): v is Tier => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v);
export function amountMinor(tier: Tier, cycle: Cycle, currency: Currency, ngnPerUsd = DEFAULT_FALLBACK_RATE): number {
  const usd = cycle === 'annual' ? PLANS[tier].annualUsd : PLANS[tier].monthlyUsd;
  return Math.round((currency === 'NGN' ? usd * ngnPerUsd : usd) * 100);
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
  const days = cycle === 'annual' ? 365 : 31;
  const now = d.now();
  const cur = activePlan(ws.data, now);
  // Renewing the same plan early keeps the remaining time. Moving up a plan turns the unused time into extra days on the new one.
  const base = cur.tier === tier && cur.expires ? cur.expires : now;
  const credit = cur.tier !== tier && cur.expires && (RANK[tier] ?? 0) > (RANK[cur.tier] ?? 0) ? creditDays(cur.tier, cur.expires.getTime() - now.getTime(), tier) : 0;
  const expires = new Date(base.getTime() + (days + credit) * 86400000);

  await fsCommit(env, d, [
    { path, fields: { status: 'paid', paidMinor: vj.data.amount, paidAt: now }, mask: ['status', 'paidMinor', 'paidAt'], precondition: { updateTime: pay.updateTime } },
    { path: `workspaces/${metaWid}`, fields: { plan: tier, planCycle: cycle, planExpiresAt: expires }, mask: ['plan', 'planCycle', 'planExpiresAt'], precondition: { exists: true } },
  ]);
  return json({ ok: true, activated: tier, expiresAt: expires.toISOString() });
}

