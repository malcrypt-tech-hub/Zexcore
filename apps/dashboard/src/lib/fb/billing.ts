import { getDocs, query, orderBy, limit as qLimit, where, documentId, type QueryDocumentSnapshot } from 'firebase/firestore';
import { fb, paymentsUrl } from './firebase';
import { worker } from './worker';
import { ApiError, iso, loadCtx, monthPrefix, requireAdmin, wsCol } from './core';
import { LABELS, LIMITS, PRICES, toLimits, type EnforcedKey } from './plan';
import { getLiveNgnRate } from '../fx';

export async function plans(): Promise<unknown> {
  const liveRate = await getLiveNgnRate();
  return {
    currencyRates: { NGN_PER_USD: liveRate }, paystackPublicKey: paymentsUrl() ? 'hosted-checkout' : null,
    plans: [...(Object.keys(PRICES) as (keyof typeof PRICES)[]).map((tier) => ({ tier, ...PRICES[tier], limits: toLimits(tier) })),
      ...(['enterprise', 'dedicated'] as const).map((tier) => ({ tier, monthlyNgn: null, annualNgn: null, approxUsd: null, limits: toLimits(tier) }))],
    freeLimits: toLimits('free'), limitLabels: LABELS,
  };
}

export async function usage(): Promise<unknown> {
  const c = await loadCtx(true);
  const count = async (name: string): Promise<number> => (await getDocs(wsCol(c, name))).size;
  const ym = monthPrefix();
  const [services, staff, contacts, pages, devices, rules, bookings] = await Promise.all([
    count('services'), count('staff'), count('contacts'), count('pages'), count('devices'), count('rules'),
    getDocs(query(wsCol(c, 'bookings'), where(documentId(), '>=', `${ym}_`), where(documentId(), '<', `${ym}\``))).then((s) => s.size),
  ]);
  const used: Record<EnforcedKey, number> = { bookingsPerMonth: bookings, staff, services, cmsPages: pages, crmContacts: contacts, devices, rules };
  const lim = LIMITS[c.tier];
  const out = Object.fromEntries((Object.keys(used) as EnforcedKey[]).map((k) => [k, { used: used[k], limit: lim[k] }]));
  return { tier: c.plan, effectiveTier: c.tier, usage: out, labels: LABELS };
}

export async function checkout(b: Record<string, unknown>): Promise<unknown> {
  const c = await loadCtx(true); requireAdmin(c);
  if (!c.email) throw new ApiError(400, 'Your account must have an email address for billing receipts.', 'email_missing');
  const base = paymentsUrl();
  if (!base) throw new ApiError(503, 'Online payments are not switched on yet.', 'unavailable');
  const token = await fb().auth.currentUser?.getIdToken();
  let res: Response;
  try {
    res = await fetch(`${base}/api/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ workspaceId: c.wid, tier: b.tier, cycle: b.cycle ?? 'monthly', currency: b.currency ?? 'NGN' }) });
  } catch { throw new ApiError(0, 'Cannot reach the payment service. Check your connection and try again.', 'network'); }
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, j.error ?? 'Could not start checkout.', j.code);
  return j;
}

/** Receipts show what was charged: the plan's naira list price (or the stored amount for older payments). */
const usdAmount = (x: Record<string, any>): { currency: string; amount_minor: number } => {
  const t = PRICES[x.tier as keyof typeof PRICES];
  const ngn = t && x.currency === 'NGN' ? (x.cycle === 'annual' ? t.annualNgn : t.monthlyNgn) : null;
  return ngn == null ? { currency: x.currency, amount_minor: x.amountMinor ?? 0 } : { currency: 'NGN', amount_minor: ngn * 100 };
};
const pay = (d: QueryDocumentSnapshot) => {
  const x = d.data();
  return {
    reference: d.id, tier: x.tier, cycle: x.cycle, ...usdAmount(x), paid_minor: x.paidMinor ?? null, status: x.status ?? 'pending',
    gateway: 'paystack', created_at: iso(x.createdAt) ?? new Date().toISOString(), paid_at: iso(x.paidAt),
  };
};
export async function payments(): Promise<{ payments: unknown[] }> {
  const c = await loadCtx(); requireAdmin(c);
  const s = await getDocs(query(wsCol(c, 'payments'), orderBy('createdAt', 'desc'), qLimit(50)));
  return { payments: s.docs.map(pay) };
}

export async function auditLog(): Promise<{ entries: unknown[] }> {
  const c = await loadCtx(); requireAdmin(c);
  const s = await getDocs(query(wsCol(c, 'auditChain'), orderBy('seq', 'desc'), qLimit(100)));
  // Who did it: member rows give emails. Read-only logins cannot list the team, so they see a short id instead.
  const who = new Map<string, string>();
  if (c.role !== 'viewer') { try { (await getDocs(wsCol(c, 'members'))).forEach((m) => who.set(m.id, String(m.data().email ?? m.data().name ?? ''))); } catch { /* names are a courtesy */ } }
  return { entries: s.docs.map((d) => {
    const x = d.data(); const [entity, ...id] = String(x.target ?? '').split(':');
    const actor = String(x.actor ?? '');
    // committedAt is stamped by Google's servers when the entry is saved; entries from before that existed carry the ZexCore server clock.
    return { seq: x.seq, action: x.action, entity: entity || null, entity_id: id.join(':') || null, actor: who.get(actor) || (actor ? `user ${actor.slice(0, 6)}…` : 'system'), detail: String(x.detail ?? ''),
      created_at: iso(x.committedAt) ?? iso(x.at) ?? new Date().toISOString(), google_time: !!x.committedAt, hash: x.hash ?? '' };
  }) };
}

export async function verifyAuditLog(): Promise<unknown> {
  const c = await loadCtx(); requireAdmin(c);
  const r = await worker<{ ok: boolean; entries: number; brokenAt?: number; reason?: string; headHash?: string }>('/api/audit/verify', { query: { workspaceId: c.wid } });
  return { valid: r.ok, total: r.entries, brokenSeq: r.ok ? null : r.brokenAt ?? null, reason: r.ok ? null : r.reason ?? null, headHash: r.headHash ?? null };
}
