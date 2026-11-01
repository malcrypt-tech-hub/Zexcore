/**
 * Team access: invite people to a workspace as admin or editor, accept an invite, change a role, remove someone.
 * Browsers cannot write member rows (the database rules forbid it), so the Worker does it after checking who is asking.
 *
 * owner  – everything, including plan, payouts and who the admins are
 * admin  – everything except changing admins or the plan owner
 * editor – day-to-day work: bookings, customers, services, staff, pages (never settings, billing, team)
 */
import type { Ctx } from '../env';
import { requireMember, verifyFirebaseIdToken } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { sendMail } from '../mail';
import { activePlan } from './billing';
import { HttpError, ID_RE, WID_RE, json, randomHex, readJson, sha256Hex } from '../util';

/** Team logins per plan. Mirrors the "Team members" limit shown on the pricing page (LIMITS.staff in the dashboard); a test keeps them equal. */
export const SEATS: Record<string, number> = { free: 1, starter: 3, growth: 10, agency: 50, enterprise: 1000, dedicated: 1000 };
const INVITE_DAYS = 7;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_WORKSPACES = 5;      // the users/{uid} rule caps workspaceIds at 5

const hashToken = (t: string): Promise<string> => sha256Hex(`zx-invite:${t}`);

async function seatsUsed(c: Ctx, wid: string): Promise<{ members: number; pending: number }> {
  const [m, i] = await Promise.all([
    fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'members', limit: 1100 }),
    fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'invites', limit: 200 }),
  ]);
  const now = c.d.now();
  return { members: m.length, pending: i.filter((x) => x.data.expiresAt instanceof Date && x.data.expiresAt > now).length };
}
async function seatLimit(c: Ctx, wid: string): Promise<number> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  return SEATS[activePlan(ws?.data, c.d.now()).tier] ?? 1;
}

async function setUserWorkspaces(c: Ctx, uid: string, edit: (ids: string[]) => string[]): Promise<void> {
  const u = await fsGet(c.env, c.d, `users/${uid}`);
  const cur = Array.isArray(u?.data.workspaceIds) ? (u!.data.workspaceIds as string[]) : [];
  const next = edit(cur);
  if (next.length === cur.length && next.every((x, i) => x === cur[i])) return;
  await fsCommit(c.env, c.d, [{ path: `users/${uid}`, fields: { workspaceIds: next }, mask: ['workspaceIds'] }]);
}

// POST /api/team/invite  { wid, email, role: 'admin'|'editor' }
export async function invite(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { caller, role: me, wid } = await requireMember(c, b.wid, ['owner', 'admin']);
  const email = String(b.email ?? '').trim().toLowerCase();
  const role = b.role;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (role !== 'admin' && role !== 'editor') throw new HttpError(400, 'Choose a role: admin or editor.');
  if (role === 'admin' && me !== 'owner') throw new HttpError(403, 'Only the workspace owner can invite an admin.', 'forbidden');
  const members = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'members', limit: 1100 });
  if (members.some((m) => String(m.data.email ?? '').toLowerCase() === email)) throw new HttpError(409, 'That person is already on your team.', 'exists');
  const limit = await seatLimit(c, wid);
  const used = await seatsUsed(c, wid);
  if (used.members + used.pending >= limit) {
    throw new HttpError(402, limit <= 1 ? 'Your plan has one login. Upgrade to add team members.' : `Your plan includes ${limit} team logins and they are all used or reserved. Remove someone or upgrade.`, 'seat_limit');
  }
  const token = randomHex(24);
  const now = c.d.now();
  const id = await hashToken(token);
  await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/invites/${id}`, precondition: { exists: false }, fields: {
    email, role, invitedBy: caller.uid, invitedByEmail: caller.email ?? null, createdAt: now, expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
  } }]);
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const link = `${c.env.APP_URL.replace(/\/$/, '')}/accept-invite?w=${wid}&t=${token}`;
  const sent = await sendMail(c.env, c.d, email, `You're invited to ${String(ws?.data.name ?? 'a workspace')} on ZexCore`,
    `${caller.email ?? 'A teammate'} invited you to join ${String(ws?.data.name ?? 'their workspace')} on ZexCore as ${role === 'admin' ? 'an admin' : 'an editor'}.\n\nAccept the invitation (sign in or create an account with ${email}):\n${link}\n\nThe link works for ${INVITE_DAYS} days. If you weren't expecting this, you can ignore this email.`);
  return json({ ok: true, id, link, emailed: sent, expiresInDays: INVITE_DAYS }, 200, c.headers);
}

async function loadInvite(c: Ctx, wid: unknown, token: unknown) {
  if (typeof wid !== 'string' || !WID_RE.test(wid) || typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw new HttpError(400, 'This invitation link is not valid.');
  const id = await hashToken(token);
  const inv = await fsGet(c.env, c.d, `workspaces/${wid}/invites/${id}`);
  if (!inv || !(inv.data.expiresAt instanceof Date) || inv.data.expiresAt <= c.d.now()) throw new HttpError(410, 'This invitation has expired or was cancelled. Ask for a new one.', 'invite_gone');
  return { wid, id, inv };
}

// GET /api/team/invite-info?w=&t=   (public: the link itself is the secret)
export async function inviteInfo(c: Ctx): Promise<Response> {
  const { wid, inv } = await loadInvite(c, c.url.searchParams.get('w'), c.url.searchParams.get('t'));
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  return json({ workspace: String(ws?.data.name ?? 'a workspace'), role: inv.data.role, email: inv.data.email }, 200, c.headers);
}

// POST /api/team/accept  { wid, token }   (signed in as the invited email)
export async function accept(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!caller) throw new HttpError(401, 'Sign in to accept the invitation.', 'unauthenticated');
  const { wid, id, inv } = await loadInvite(c, b.wid, b.token);
  if (!caller.email || caller.email.toLowerCase() !== String(inv.data.email).toLowerCase())
    throw new HttpError(403, `This invitation was sent to ${inv.data.email}. Sign in with that email address.`, 'wrong_email');
  if (!caller.emailVerified) throw new HttpError(403, 'Verify your email address first, then open the invitation again.', 'unverified');
  const existing = await fsGet(c.env, c.d, `workspaces/${wid}/members/${caller.uid}`);
  if (existing) {   // already in: just clear the invite
    await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/invites/${id}`, delete: true }]);
    return json({ ok: true, wid, role: existing.data.role }, 200, c.headers);
  }
  const mine = await fsGet(c.env, c.d, `users/${caller.uid}`);
  const ids = Array.isArray(mine?.data.workspaceIds) ? (mine!.data.workspaceIds as string[]) : [];
  if (ids.length >= MAX_WORKSPACES) throw new HttpError(409, 'Your account is already in the maximum number of workspaces.', 'too_many');
  const members = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'members', limit: 1100 });
  if (members.length >= await seatLimit(c, wid)) throw new HttpError(402, 'This workspace has no free team logins right now. Ask the owner to make room or upgrade.', 'seat_limit');
  try {
    await fsCommit(c.env, c.d, [
      { path: `workspaces/${wid}/members/${caller.uid}`, precondition: { exists: false }, fields: { role: inv.data.role, email: caller.email.toLowerCase(), name: null, createdAt: c.d.now(), invitedBy: inv.data.invitedBy ?? null } },
      { path: `workspaces/${wid}/invites/${id}`, delete: true },
    ]);
  } catch (e) { if (e instanceof FsConflict) throw new HttpError(409, 'That invitation was already used.', 'invite_gone'); throw e; }
  await setUserWorkspaces(c, caller.uid, (cur) => (cur.includes(wid) ? cur : [...cur, wid]));
  return json({ ok: true, wid, role: inv.data.role }, 200, c.headers);
}

// POST /api/team/revoke  { wid, id }
export async function revoke(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid } = await requireMember(c, b.wid, ['owner', 'admin']);
  if (typeof b.id !== 'string' || !/^[a-f0-9]{64}$/.test(b.id)) throw new HttpError(400, 'Invalid invitation');
  await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/invites/${b.id}`, delete: true }]);
  return json({ ok: true }, 200, c.headers);
}

async function target(c: Ctx, wid: string, uid: unknown) {
  if (typeof uid !== 'string' || !ID_RE.test(uid)) throw new HttpError(400, 'Invalid member');
  const m = await fsGet(c.env, c.d, `workspaces/${wid}/members/${uid}`);
  if (!m) throw new HttpError(404, 'That person is not on this team.');
  if (m.data.role === 'owner') throw new HttpError(403, 'The workspace owner cannot be changed or removed.', 'forbidden');
  return m;
}

// POST /api/team/role  { wid, uid, role }   owner only (admins are the owner's call)
export async function setRole(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid } = await requireMember(c, b.wid, ['owner']);
  if (b.role !== 'admin' && b.role !== 'editor') throw new HttpError(400, 'Choose a role: admin or editor.');
  const m = await target(c, wid, b.uid);
  await fsCommit(c.env, c.d, [{ path: m.path, fields: { role: b.role }, mask: ['role'], precondition: { exists: true } }]);
  return json({ ok: true }, 200, c.headers);
}

// POST /api/team/remove  { wid, uid }   owner removes anyone; admin removes editors; anyone may leave (uid = self, not owner)
export async function remove(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { caller, role: me, wid } = await requireMember(c, b.wid);
  const m = await target(c, wid, b.uid);
  const self = m.id === caller.uid;
  if (!self && me === 'editor') throw new HttpError(403, 'Only an owner or admin can remove people.', 'forbidden');
  if (!self && me === 'admin' && m.data.role !== 'editor') throw new HttpError(403, 'Only the owner can remove an admin.', 'forbidden');
  await fsCommit(c.env, c.d, [{ path: m.path, delete: true, precondition: { exists: true } }]);
  await setUserWorkspaces(c, m.id, (cur) => cur.filter((x) => x !== wid));
  return json({ ok: true }, 200, c.headers);
}
