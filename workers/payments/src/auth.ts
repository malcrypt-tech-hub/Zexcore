import type { Ctx, Deps, Env } from './env';
import { enc, fromB64url, HttpError, WID_RE } from './util';
import { fsGet } from './fs';

let jwksCache: { keys: any[]; exp: number } | null = null;
export function resetJwksCache(): void { jwksCache = null; }
export interface Caller { uid: string; email: string | null; emailVerified: boolean }

export async function verifyFirebaseIdToken(env: Env, d: Deps, token: string): Promise<Caller | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let head: any, claims: any;
  try { head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!))); claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))); } catch { return null; }
  const nowS = Math.floor(d.now().getTime() / 1000);
  const claimsOk = claims.aud === env.FIREBASE_PROJECT_ID && claims.iss === `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`
    && typeof claims.exp === 'number' && claims.exp > nowS && typeof claims.sub === 'string' && !!claims.sub;
  // The Firebase Auth emulator issues unsigned tokens. Accepted ONLY when the emulator host is configured (tests), never in production.
  if (env.FIRESTORE_EMULATOR_HOST && head.alg === 'none') return claimsOk ? { uid: claims.sub, email: claims.email ?? null, emailVerified: claims.email_verified === true } : null;
  if (head.alg !== 'RS256' || !head.kid) return null;
  if (!jwksCache || jwksCache.exp < nowS) {
    const r = await d.fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!r.ok) return null;
    jwksCache = { keys: ((await r.json()) as { keys: any[] }).keys, exp: nowS + 3600 };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok || !claimsOk) return null;
  return { uid: claims.sub, email: claims.email ?? null, emailVerified: claims.email_verified === true };
}

export type Role = 'owner' | 'admin' | 'editor' | 'staff';
/** Verifies the bearer token and that the caller belongs to the workspace (optionally with one of `roles`). */
export async function requireMember(c: Ctx, wid: unknown, roles?: Role[]): Promise<{ caller: Caller; role: Role; wid: string }> {
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!caller) throw new HttpError(401, 'Sign in again to continue.', 'unauthenticated');
  if (typeof wid !== 'string' || !WID_RE.test(wid)) throw new HttpError(400, 'Invalid workspace');
  const m = await fsGet(c.env, c.d, `workspaces/${wid}/members/${caller.uid}`);
  const role = m?.data.role as Role | undefined;
  if (!role) throw new HttpError(403, 'You do not have access to that workspace.', 'forbidden');
  if (roles && !roles.includes(role)) throw new HttpError(403, 'Only a workspace owner or admin can do that.', 'forbidden');
  return { caller, role, wid };
}
