/**
 * Licences and dedicated-cluster requests.
 *
 *   POST /api/license                owner/admin of an Enterprise or Dedicated workspace: returns a signed licence file.
 *   GET  /api/public/license-key     the public key (Ed25519) that verifies licences, so anyone can check one offline.
 *   POST /api/public/license-verify  checks a licence's signature and dates, and whether the workspace still holds the plan.
 *   GET  /api/cluster/request        owner/admin: the workspace's current dedicated-cluster request, if any.
 *   POST /api/cluster/request        owner: asks our team to set up a dedicated cluster. Nothing is created automatically:
 *                                    a person from Zexlabs follows up by email.
 *
 * A licence is `ZXL1.<payload>.<signature>` where payload is base64url JSON and signature is Ed25519 over the payload text.
 * The private key lives only in the Worker secret LICENSE_PRIVATE_JWK (see scripts/gen-license-key.mjs); the licence says what
 * plan a workspace holds and until when. It is a statement of entitlement, not a lock: the plan limits themselves are enforced by
 * the database rules.
 */
import type { Ctx, Env } from '../env';
import { requireMember } from '../auth';
import { fsCommit, fsGet } from '../fs';
import { queueFormal } from '../outbox';
import { ownerContact } from '../automation';
import { HttpError, WID_RE, b64url, enc, fromB64url, json, randomHex, readJson } from '../util';

export const LICENSE_PREFIX = 'ZXL1';
const GRACE_DAYS = 3;
const LICENSED = new Set(['enterprise', 'dedicated']);

export interface LicensePayload { v: 1; id: string; workspaceId: string; business: string; plan: string; issuedAt: string; expiresAt: string; graceDays: number }

interface Jwk { kty: 'OKP'; crv: 'Ed25519'; d?: string; x: string }
function jwk(env: Env): Jwk {
  const raw = (env.LICENSE_PRIVATE_JWK ?? '').trim();
  if (!raw) throw new HttpError(503, 'Licences are not switched on yet. Please contact us.', 'license_unavailable');
  try {
    const j = JSON.parse(raw) as Jwk;
    if (j.kty !== 'OKP' || j.crv !== 'Ed25519' || !j.d || !j.x) throw new Error('bad key');
    return j;
  } catch { throw new HttpError(503, 'Licences are not switched on yet. Please contact us.', 'license_unavailable'); }
}
export const publicKeyOf = (env: Env): string => jwk(env).x;

async function signKey(env: Env): Promise<CryptoKey> {
  const j = jwk(env);
  return crypto.subtle.importKey('jwk', { kty: j.kty, crv: j.crv, d: j.d, x: j.x }, { name: 'Ed25519' }, false, ['sign']);
}
async function verifyKey(x: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x }, { name: 'Ed25519' }, false, ['verify']);
}

export async function signLicense(env: Env, p: LicensePayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, await signKey(env), enc.encode(body));
  return `${LICENSE_PREFIX}.${body}.${b64url(sig)}`;
}

export type LicenseState = 'active' | 'grace' | 'expired' | 'invalid';
/** Signature and date check only. */
export async function checkLicense(env: Env, licence: string, now: Date): Promise<{ state: LicenseState; payload?: LicensePayload }> {
  const parts = licence.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { state: 'invalid' };
  try {
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, await verifyKey(publicKeyOf(env)), fromB64url(parts[2]!), enc.encode(parts[1]!));
    if (!ok) return { state: 'invalid' };
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as LicensePayload;
    if (p.v !== 1 || typeof p.expiresAt !== 'string') return { state: 'invalid' };
    const end = Date.parse(p.expiresAt);
    if (!Number.isFinite(end)) return { state: 'invalid' };
    const t = now.getTime();
    return { state: t < end ? 'active' : t < end + p.graceDays * 86_400_000 ? 'grace' : 'expired', payload: p };
  } catch { return { state: 'invalid' }; }
}

/** The workspace's effective plan today, using the same 3-day grace as the rest of the platform. */
async function currentPlan(c: Ctx, wid: string): Promise<{ plan: string; expires: Date | null; name: string }> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws) throw new HttpError(404, 'Workspace not found');
  const plan = String(ws.data.plan ?? 'free');
  const expires = ws.data.planExpiresAt instanceof Date ? ws.data.planExpiresAt : null;
  const live = plan !== 'free' && (!expires || c.d.now().getTime() < expires.getTime() + GRACE_DAYS * 86_400_000);
  const settings = (ws.data.settings ?? {}) as Record<string, unknown>;
  return { plan: live ? plan : 'free', expires, name: String(settings.publicName ?? ws.data.name ?? 'Workspace') };
}

export async function issueLicense(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  jwk(c.env);   // fail early, with the friendly message, when licences are off
  const ws = await currentPlan(c, wid);
  if (!LICENSED.has(ws.plan)) throw new HttpError(403, 'Licence files come with the Enterprise and Dedicated plans.', 'plan_required');
  const now = c.d.now();
  const expires = ws.expires ?? new Date(now.getTime() + 365 * 86_400_000);
  const payload: LicensePayload = {
    v: 1, id: `LIC-${wid.slice(0, 6).toUpperCase()}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomHex(3).toUpperCase()}`,
    workspaceId: wid, business: ws.name, plan: ws.plan, issuedAt: now.toISOString(), expiresAt: expires.toISOString(), graceDays: GRACE_DAYS,
  };
  return json({ ok: true, license: await signLicense(c.env, payload), payload, publicKey: publicKeyOf(c.env) }, 200, c.headers);
}

export async function licenseKey(c: Ctx): Promise<Response> {
  return json({ algorithm: 'Ed25519', format: `${LICENSE_PREFIX}.<base64url payload>.<base64url signature>`, publicKey: publicKeyOf(c.env) }, 200, c.headers);
}

export async function verifyLicenseRoute(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 8_192);
  const r = await checkLicense(c.env, String(b.license ?? ''), c.d.now());
  if (r.state === 'invalid' || !r.payload) return json({ ok: true, valid: false, state: 'invalid' }, 200, c.headers);
  // Online extra: does the workspace still hold the plan the licence was issued for?
  let planStillHeld: boolean | null = null;
  if (WID_RE.test(r.payload.workspaceId)) {
    try { planStillHeld = LICENSED.has((await currentPlan(c, r.payload.workspaceId)).plan); } catch { planStillHeld = null; }
  }
  const valid = (r.state === 'active' || r.state === 'grace') && planStillHeld !== false;
  return json({ ok: true, valid, state: r.state, planStillHeld, business: r.payload.business, plan: r.payload.plan, expiresAt: r.payload.expiresAt, id: r.payload.id }, 200, c.headers);
}

// ── Dedicated cluster requests ──────────────────────────────────────────────────────────────────────────────────────────

const SIZES = ['small', 'medium', 'large', 'unsure'] as const;
const requestPath = (wid: string): string => `workspaces/${wid}/clusterRequests/current`;
const dto = (d: Record<string, any>): Record<string, unknown> => ({ status: d.status, size: d.size, needs: d.needs, region: d.region ?? '', phone: d.phone ?? '', createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : null });

export async function getClusterRequest(c: Ctx): Promise<Response> {
  const { wid } = await requireMember(c, c.url.searchParams.get('workspaceId'), ['owner', 'admin']);
  const r = await fsGet(c.env, c.d, requestPath(wid));
  return json({ request: r ? dto(r.data) : null }, 200, c.headers);
}

export async function clusterRequest(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid, caller } = await requireMember(c, b.workspaceId, ['owner']);
  const needs = String(b.needs ?? '').trim();
  const size = String(b.size ?? '');
  const region = String(b.region ?? '').trim().slice(0, 80);
  const phone = String(b.phone ?? '').trim().slice(0, 30);
  if (needs.length < 10 || needs.length > 1500) throw new HttpError(400, 'Tell us a little about what you need (10 to 1,500 characters).');
  if (!(SIZES as readonly string[]).includes(size)) throw new HttpError(400, 'Choose a size.');
  const existing = await fsGet(c.env, c.d, requestPath(wid));
  if (existing && existing.data.status !== 'closed') throw new HttpError(409, 'You already have an open request. Our team will be in touch by email.', 'already_requested');
  const now = c.d.now();
  const who = await ownerContact(c, wid);
  const email = caller.email ?? who.email;
  await fsCommit(c.env, c.d, [{
    path: requestPath(wid),
    fields: { status: 'new', size, needs, region, phone, email, requestedBy: caller.uid, createdAt: now },
    precondition: existing ? { updateTime: existing.updateTime } : { exists: false },
  }]);
  const ws = await currentPlan(c, wid);
  const sales = (c.env.SALES_EMAIL ?? '').trim();
  if (sales) await queueFormal(c.env, c.d, `clusterreq:${wid}:${now.getTime()}`, sales, `Dedicated cluster request from ${ws.name}`, {
    heading: 'Dedicated cluster request', paragraphs: ['A workspace owner has asked for a dedicated cluster.'],
    details: [['Business', ws.name], ['Plan', ws.plan], ['Size', size], ['Region', region || 'Not given'], ['Reply to', email || 'Not given'], ['Phone', phone || 'Not given'], ['Workspace', wid], ['Needs', needs]],
  }, wid);
  if (email) await queueFormal(c.env, c.d, `clusterreqack:${wid}:${now.getTime()}`, email, 'We received your dedicated cluster request', {
    heading: 'We received your request', greeting: 'Hello,',
    paragraphs: [`Thank you. We have your request for a dedicated cluster for ${ws.name}. A member of our team will reply to this email address to talk through what you need.`, 'Nothing has been set up or charged yet.'],
  }, wid);
  return json({ ok: true, notified: Boolean(sales) }, 200, c.headers);
}
