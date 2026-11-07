/**
 * Platform admins: the few people (you and your co-founder) who may give a workspace a plan without paying.
 *
 *   GET  /api/admin/me           { admin: boolean } for the signed-in caller. Never an error for ordinary users.
 *   POST /api/admin/grant-plan   { workspaceId, plan, days? } sets the workspace's plan. `days` omitted means no expiry.
 *
 * The allow-list is the Worker secret PLATFORM_ADMIN_EMAILS (comma separated). The caller's e-mail must also be verified by
 * Firebase, so nobody can claim an address they do not own. A platform admin does NOT get access to other businesses' data:
 * this only changes the plan field, and every grant is written to that workspace's tamper-evident audit log.
 */
import type { Ctx } from '../env';
import { verifyFirebaseIdToken, type Caller } from '../auth';
import { fsCommit, fsGet } from '../fs';
import { HttpError, WID_RE, json, readJson } from '../util';
import { appendAudit } from './audit';

const PLANS = ['starter', 'growth', 'agency', 'enterprise', 'dedicated'] as const;

export const adminEmails = (env: { PLATFORM_ADMIN_EMAILS?: string }): Set<string> =>
  new Set((env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

async function who(c: Ctx): Promise<Caller> {
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!caller) throw new HttpError(401, 'Sign in again to continue.', 'unauthenticated');
  return caller;
}
const isAdmin = (c: Ctx, caller: Caller): boolean => Boolean(caller.email && caller.emailVerified && adminEmails(c.env).has(caller.email.toLowerCase()));

export async function adminMe(c: Ctx): Promise<Response> {
  return json({ admin: isAdmin(c, await who(c)) }, 200, c.headers);
}

export async function grantPlan(c: Ctx): Promise<Response> {
  const caller = await who(c);
  if (!isAdmin(c, caller)) throw new HttpError(403, 'Only a platform admin can do that.', 'forbidden');
  const b = await readJson(c.req);
  const wid = String(b.workspaceId ?? '');
  const plan = String(b.plan ?? '');
  if (!WID_RE.test(wid)) throw new HttpError(400, 'Invalid workspace');
  if (!(PLANS as readonly string[]).includes(plan)) throw new HttpError(400, 'Choose a paid plan.');
  const days = b.days === undefined || b.days === null || b.days === '' ? null : Number(b.days);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new HttpError(400, 'Days must be a whole number from 1 to 3650, or empty for no expiry.');
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws) throw new HttpError(404, 'Workspace not found');
  const now = c.d.now();
  const expires = days === null ? null : new Date(now.getTime() + days * 86_400_000);
  await fsCommit(c.env, c.d, [{
    path: ws.path,
    fields: { plan, ...(expires ? { planExpiresAt: expires } : {}), planGrantedBy: caller.email, planGrantedAt: now },
    mask: ['plan', 'planExpiresAt', 'planGrantedBy', 'planGrantedAt'],   // a mask entry without a value clears the field: "no expiry"
    precondition: { updateTime: ws.updateTime },
  }]);
  try { await appendAudit(c, wid, caller.uid, 'plan.grant', `workspace:${wid}`, `${plan} ${expires ? `until ${expires.toISOString().slice(0, 10)}` : 'with no expiry'} by ${caller.email}`); }
  catch (e) { console.error('audit append failed', e instanceof Error ? e.message : e); }
  return json({ ok: true, plan, expiresAt: expires ? expires.toISOString() : null }, 200, c.headers);
}
