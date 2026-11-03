/**
 * Read-only API keys (Enterprise and Dedicated). A key lets an accountant's tool, a spreadsheet or another system READ
 * bookings and customers. It can never change anything and never sees payments, messages, settings or the team.
 *
 *   POST /api/keys/create  { workspaceId, name }   owner/admin: returns the key ONCE; only its SHA-256 is stored
 *   POST /api/keys/revoke  { workspaceId, id }     owner/admin: the key stops working immediately
 *   GET  /api/v1/bookings  ?status=&limit=&cursor=   Authorization: Bearer zxk_...
 *   GET  /api/v1/customers
 *
 * A key looks like zxk_<workspace id>.<48 hex>. The workspace id is public by design; the 192-bit secret is not.
 */
import { requireMember } from '../auth';
import type { Ctx } from '../env';
import { fsCommit, fsGet, fsQuery, type FsDoc } from '../fs';
import { HttpError, json, randomHex, readJson, sha256Hex, timingSafeEqual } from '../util';
import { throttled } from '../index';
import { appendAudit } from './audit';
import { riskPlanOk } from './risk';

const WID_RE = /^[A-Za-z0-9_-]{20}$/;
const KEY_RE = /^zxk_([A-Za-z0-9_-]{20})\.([a-f0-9]{48})$/;
const MAX_KEYS = 5;
const PER_MINUTE = 60;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const keyId = (hash: string): string => hash.slice(0, 32);

export async function createKey(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { caller, wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws || !riskPlanOk(ws.data, c.d.now())) throw new HttpError(402, 'API keys are part of the Enterprise and Dedicated plans.', 'plan_feature');
  const name = String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Give the key a name, for example "Accountant spreadsheet".');
  const existing = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'apiKeys', limit: MAX_KEYS + 1 });
  if (existing.length >= MAX_KEYS) throw new HttpError(409, `You can have ${MAX_KEYS} keys at a time. Revoke one you no longer use.`, 'limit');
  const secret = randomHex(24);
  const hash = await sha256Hex(`zx-apikey:${secret}`);
  const id = keyId(hash);
  const now = c.d.now();
  await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/apiKeys/${id}`, precondition: { exists: false }, fields: { name, hash, prefix: secret.slice(0, 6), createdBy: caller.uid, createdByEmail: caller.email ?? null, createdAt: now, lastUsedAt: null } }]);
  try { await appendAudit(c, wid, caller.uid, 'apikey.create', `apikey:${id.slice(0, 12)}`, name); } catch (e) { console.error('audit append failed', e instanceof Error ? e.message : e); }
  return json({ ok: true, id, name, key: `zxk_${wid}.${secret}` }, 201, c.headers);
}

export async function revokeKey(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { caller, wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const id = String(b.id ?? '');
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'Invalid key');
  const k = await fsGet(c.env, c.d, `workspaces/${wid}/apiKeys/${id}`);
  if (!k) throw new HttpError(404, 'That key no longer exists.');
  await fsCommit(c.env, c.d, [{ path: k.path, delete: true }]);
  try { await appendAudit(c, wid, caller.uid, 'apikey.revoke', `apikey:${id.slice(0, 12)}`, String(k.data.name ?? '')); } catch (e) { console.error('audit append failed', e instanceof Error ? e.message : e); }
  return json({ ok: true }, 200, c.headers);
}

/** Checks the bearer key, the plan and the rate limit. Every failure looks the same to the caller, so keys cannot be probed. */
async function authKey(c: Ctx): Promise<{ wid: string; id: string }> {
  const bad = new HttpError(401, 'Invalid or revoked API key.', 'invalid_key');
  const m = KEY_RE.exec(/^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1] ?? '');
  if (!m) throw bad;
  const [, wid, secret] = m as unknown as [string, string, string];
  const hash = await sha256Hex(`zx-apikey:${secret}`);
  const id = keyId(hash);
  const k = await fsGet(c.env, c.d, `workspaces/${wid}/apiKeys/${id}`);
  if (!k || !timingSafeEqual(String(k.data.hash ?? ''), hash)) throw bad;
  if (throttled(`apikey ${id}`, c.d.now().getTime(), PER_MINUTE)) throw new HttpError(429, `Limit is ${PER_MINUTE} requests a minute for each key.`, 'rate_limited');
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws || !riskPlanOk(ws.data, c.d.now())) throw new HttpError(402, 'This workspace\'s plan no longer includes API access.', 'plan_feature');
  const last = k.data.lastUsedAt instanceof Date ? k.data.lastUsedAt.getTime() : 0;
  if (c.d.now().getTime() - last > 3_600_000) await fsCommit(c.env, c.d, [{ path: k.path, fields: { lastUsedAt: c.d.now() }, mask: ['lastUsedAt'], precondition: { exists: true } }]).catch(() => undefined);
  return { wid, id };
}

async function serviceNames(c: Ctx, wid: string): Promise<Map<string, string>> {
  const rows = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'services', limit: 1000 });
  return new Map(rows.map((s) => [s.id, String(s.data.name ?? '')]));
}
const bookingOut = (b: FsDoc, names: Map<string, string>) => ({
  id: b.id, ref: `ZX-${b.id.replace('_', '-')}`, status: String(b.data.status ?? ''), service: { id: String(b.data.serviceId ?? ''), name: names.get(String(b.data.serviceId ?? '')) ?? null },
  staffId: (b.data.staffId as string | null | undefined) ?? null, customerName: String(b.data.customerName ?? ''), customerPhone: String(b.data.customerPhone ?? ''), customerEmail: (b.data.customerEmail as string | null | undefined) ?? null,
  startsAt: iso(b.data.startsAt), endsAt: iso(b.data.endsAt), depositStatus: String(b.data.depositStatus ?? 'none'), depositMinor: Number(b.data.depositMinor ?? 0), currency: 'USD', source: String(b.data.source ?? ''), createdAt: iso(b.data.createdAt),
});

export async function v1Bookings(c: Ctx): Promise<Response> {
  const { wid } = await authKey(c);
  const q = c.url.searchParams;
  const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 100) || 100));
  const status = q.get('status');
  if (status && !['pending', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status)) throw new HttpError(400, 'status must be pending, confirmed, completed, cancelled or no_show.');
  const cursor = q.get('cursor') ?? undefined;
  if (cursor && !/^\d{6}_\d{1,6}$/.test(cursor)) throw new HttpError(400, 'Invalid cursor');
  const rows = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'bookings', ...(status ? { where: [{ field: 'status', op: 'EQUAL' as const, value: status }] } : {}), orderBy: [{ field: '__name__' }], limit, startAfterId: cursor });
  const names = await serviceNames(c, wid);
  return json({ data: rows.map((r) => bookingOut(r, names)), nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null }, 200, c.headers);
}

export async function v1Customers(c: Ctx): Promise<Response> {
  const { wid } = await authKey(c);
  const by = new Map<string, { phone: string; name: string; email: string | null; bookings: number; completed: number; noShows: number; firstBooking: string | null; lastBooking: string | null }>();
  let after: string | undefined; let truncated = false;
  for (let page = 0; page < 10; page++) {
    const rows = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'bookings', orderBy: [{ field: '__name__' }], limit: 200, startAfterId: after });
    for (const r of rows) {
      const phone = String(r.data.customerPhone ?? ''); if (!phone) continue;
      const when = iso(r.data.startsAt);
      const x = by.get(phone) ?? { phone, name: String(r.data.customerName ?? ''), email: null, bookings: 0, completed: 0, noShows: 0, firstBooking: when, lastBooking: when };
      if (r.data.status !== 'cancelled') x.bookings += 1;
      if (r.data.status === 'completed') x.completed += 1;
      if (r.data.status === 'no_show') x.noShows += 1;
      if (r.data.customerEmail) x.email = String(r.data.customerEmail);
      if (when && (!x.firstBooking || when < x.firstBooking)) x.firstBooking = when;
      if (when && (!x.lastBooking || when > x.lastBooking)) { x.lastBooking = when; x.name = String(r.data.customerName ?? x.name); }
      by.set(phone, x);
    }
    after = rows[rows.length - 1]?.id;
    if (rows.length < 200) break;
    if (page === 9) truncated = true;
  }
  return json({ data: [...by.values()].sort((a, b) => String(b.lastBooking).localeCompare(String(a.lastBooking))), truncated }, 200, c.headers);
}
