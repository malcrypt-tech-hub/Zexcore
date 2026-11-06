/**
 * Delete account.  POST /api/account/delete  { confirm: "<your sign-in email>" }
 *
 * The caller must type their own email (password accounts also re-enter their password in the app). No fresh Google
 * sign-in is demanded on top of that; a confirmation email is sent to the address when it is done. Then, for every workspace the account belongs to:
 *   - a team member just leaves: their access is removed and a `account.delete` entry is written to that workspace's log;
 *   - an owner closes the workspace: the entry is written FIRST, then bookings, customers, payments, messages and every
 *     other record are erased, every teammate loses access, and the booking page address is released.
 * The tamper-evident audit log of a closed workspace is kept (it holds no customer data), so the record that the
 * account was deleted, by whom and when, survives. Finally the sign-in itself is removed.
 * Safe to run again if it stops part-way: the workspace is marked `closing` and the steps repeat without double-logging.
 */
import type { Ctx } from '../env';
import { verifyFirebaseIdToken } from '../auth';
import { fsCommit, fsGet, fsQuery } from '../fs';
import { accessToken } from '../google';
import { sendFormal } from '../mail';
import { HttpError, json, readJson } from '../util';
import { appendAudit } from './audit';

const WID_RE = /^[A-Za-z0-9_-]{20}$/;
/** Everything in a workspace that is business or customer data. auditChain and auditMeta are deliberately not listed. */
const WIPE = ['services', 'staff', 'contacts', 'stages', 'leads', 'customers', 'pages', 'bookings', 'locks', 'payments', 'devices', 'alertRules', 'alerts', 'rules',
  'automationRuns', 'automationMarkers', 'payout', 'depositPayments', 'messages', 'convState', 'retention', 'erasures', 'consents', 'backups', 'appointments', 'invites', 'apiKeys', 'seen', 'waitlist', 'products', 'orders', 'audit'] as const;
const PAGE = 300;
const MAX_ROUNDS = 80;

async function wipeCollection(c: Ctx, parent: string, collection: string, budget: { rounds: number }): Promise<void> {
  for (;;) {
    if (budget.rounds-- <= 0) throw new HttpError(503, 'Closing your workspace is taking longer than usual. Please press delete again to continue.', 'unavailable');
    const docs = await fsQuery(c.env, c.d, { parent, collection, limit: PAGE });
    if (!docs.length) return;
    if (collection === 'devices') for (const dv of docs) await wipeCollection(c, dv.path, 'readings', budget);
    await fsCommit(c.env, c.d, docs.map((d) => ({ path: d.path, delete: true })));
    if (docs.length < PAGE) return;
  }
}

async function closeWorkspace(c: Ctx, wid: string, uid: string, email: string, budget: { rounds: number }): Promise<void> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws) return;
  if (ws.data.status !== 'closing' && ws.data.status !== 'deleted') {
    await appendAudit(c, wid, uid, 'account.delete', `member:${uid}`, `${email} deleted their account; owner closed the workspace and erased its data`);
    await fsCommit(c.env, c.d, [{ path: ws.path, fields: { status: 'closing', closingAt: c.d.now() }, mask: ['status', 'closingAt'], precondition: { exists: true } }]);
  }
  const parent = `workspaces/${wid}`;
  for (const name of WIPE) await wipeCollection(c, parent, name, budget);
  const members = await fsQuery(c.env, c.d, { parent, collection: 'members', limit: 1100 });
  for (const m of members) {
    const u = await fsGet(c.env, c.d, `users/${m.id}`);
    const ids = Array.isArray(u?.data.workspaceIds) ? (u!.data.workspaceIds as string[]).filter((x) => x !== wid) : null;
    if (u && ids) await fsCommit(c.env, c.d, [{ path: u.path, fields: { workspaceIds: ids }, mask: ['workspaceIds'] }]);
  }
  if (members.length) await fsCommit(c.env, c.d, members.map((m) => ({ path: m.path, delete: true })));
  const slug = String(ws.data.slug ?? '');
  if (slug) await fsCommit(c.env, c.d, [{ path: `slugs/${slug}`, delete: true }]);
  await fsCommit(c.env, c.d, [{ path: ws.path, fields: { status: 'deleted', deletedAt: c.d.now(), slug: null, plan: 'free' }, mask: ['status', 'deletedAt', 'slug', 'plan'] }]);
}

async function deleteLogin(c: Ctx, uid: string): Promise<void> {
  const host = c.env.FIRESTORE_EMULATOR_HOST;
  if (host) return;   // the emulator suite signs users out by itself; production deletes below
  const r = await c.d.fetch(`https://identitytoolkit.googleapis.com/v1/projects/${c.env.FIREBASE_PROJECT_ID}/accounts:delete`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken(c.env, c.d)}`, 'content-type': 'application/json' }, body: JSON.stringify({ localId: uid }),
  });
  if (!r.ok && r.status !== 400) throw new HttpError(502, 'We removed your data but could not remove the sign-in. Please press delete again.', 'unavailable');
}

export async function deleteAccount(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!caller) throw new HttpError(401, 'Sign in again to continue.', 'unauthenticated');
  const email = (caller.email ?? '').toLowerCase();
  if (!email || String(b.confirm ?? '').trim().toLowerCase() !== email) throw new HttpError(400, 'Type your sign-in email exactly to confirm.', 'confirm');

  const u = await fsGet(c.env, c.d, `users/${caller.uid}`);
  const ids = (Array.isArray(u?.data.workspaceIds) ? (u!.data.workspaceIds as string[]) : []).filter((w) => WID_RE.test(w));
  const budget = { rounds: MAX_ROUNDS };
  let closed = 0; let left = 0;
  for (const wid of ids) {
    const m = await fsGet(c.env, c.d, `workspaces/${wid}/members/${caller.uid}`);
    if (m?.data.role === 'owner') { await closeWorkspace(c, wid, caller.uid, email, budget); closed++; continue; }
    if (m) {
      await appendAudit(c, wid, caller.uid, 'account.delete', `member:${caller.uid}`, `${email} (${String(m.data.role)}) deleted their account`);
      await fsCommit(c.env, c.d, [{ path: m.path, delete: true }]);
      left++;
    }
  }
  await wipeCollection(c, `users/${caller.uid}`, 'signins', budget);   // Security Watch record goes with the account
  if (u) await fsCommit(c.env, c.d, [{ path: u.path, delete: true }]);
  await deleteLogin(c, caller.uid);
  await sendFormal(c.env, c.d, email, 'Your ZexCore account was deleted', {
    heading: 'Your account was deleted', greeting: 'Hello,',
    paragraphs: ['Your ZexCore account and the workspaces you owned have been deleted, as you requested.', 'If you did not ask for this, write to hello@zexcore.com.ng straight away.'],
  }).catch((e) => console.error('deletion email failed', e instanceof Error ? e.message : e));
  return json({ ok: true, workspacesClosed: closed, workspacesLeft: left }, 200, c.headers);
}
