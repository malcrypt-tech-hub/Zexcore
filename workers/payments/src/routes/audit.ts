/**
 * Tamper-evident audit trail.
 *
 *   workspaces/{wid}/auditChain/{0000000001}   one entry per action, each carrying the SHA-256 of the one before it
 *   workspaces/{wid}/auditMeta/head            { seq, hash } of the newest entry
 *
 * Browsers cannot write either collection (see firestore.rules); only this Worker appends, and it takes the actor from
 * the verified ID token, so nobody can write an entry in someone else's name. Changing, removing or reordering any
 * entry breaks every hash after it, which /api/audit/verify detects.
 */
import type { Ctx } from '../env';
import { DOERS, requireMember } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { HttpError, json, readJson, sha256Hex } from '../util';

const GENESIS = '0'.repeat(64);
const ACTION_RE = /^[a-z][a-z0-9_.]{2,39}$/;
export const entryId = (seq: number): string => String(seq).padStart(10, '0');
export const entryHash = (prev: string, seq: number, at: string, actor: string, action: string, target: string, detail: string): Promise<string> =>
  sha256Hex(JSON.stringify([prev, seq, at, actor, action, target, detail]));

export async function appendAudit(c: Ctx, wid: string, actor: string, action: string, target = '', detail = ''): Promise<{ seq: number; hash: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const head = await fsGet(c.env, c.d, `workspaces/${wid}/auditMeta/head`);
    const seq = Number(head?.data.seq ?? 0) + 1;
    const prev = String(head?.data.hash ?? GENESIS);
    const at = c.d.now();
    const hash = await entryHash(prev, seq, at.toISOString(), actor, action, target, detail);
    try {
      await fsCommit(c.env, c.d, [
        { path: `workspaces/${wid}/auditChain/${entryId(seq)}`, fields: { seq, at, actor, action, target, detail, prevHash: prev, hash }, precondition: { exists: false }, serverTime: ['committedAt'] },
        { path: `workspaces/${wid}/auditMeta/head`, fields: { seq, hash, at }, precondition: head ? { updateTime: head.updateTime } : { exists: false } },
      ]);
      return { seq, hash };
    } catch (e) {
      if (!(e instanceof FsConflict)) throw e;   // somebody else appended first: re-read the head and try again
    }
  }
  throw new HttpError(503, 'The audit log is busy. Try again.');
}

/** POST /api/audit  { workspaceId, action, target?, detail? } */
export async function audit(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { caller, wid } = await requireMember(c, b.workspaceId, DOERS);
  const action = String(b.action ?? ''); const target = String(b.target ?? '').slice(0, 120); const detail = String(b.detail ?? '').slice(0, 300);
  if (!ACTION_RE.test(action)) throw new HttpError(400, 'Invalid action');
  const r = await appendAudit(c, wid, caller.uid, action, target, detail);
  return json({ ok: true, ...r }, 201, c.headers);
}

/** GET /api/audit/verify?workspaceId=...  (owner/admin) — recomputes the chain end to end. */
export async function verifyAudit(c: Ctx): Promise<Response> {
  const { wid } = await requireMember(c, c.url.searchParams.get('workspaceId'), ['owner', 'admin', 'viewer']);
  const head = await fsGet(c.env, c.d, `workspaces/${wid}/auditMeta/head`);
  const expected = Number(head?.data.seq ?? 0);
  let prev = GENESIS; let seq = 0; let after: string | undefined;
  for (let page = 0; page < 40; page++) {
    const docs = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'auditChain', orderBy: [{ field: '__name__' }], limit: 250, startAfterId: after });
    if (!docs.length) break;
    for (const doc of docs) {
      const e = doc.data; seq += 1;
      const at = e.at instanceof Date ? e.at.toISOString() : '';
      const okLink = e.seq === seq && doc.id === entryId(seq) && e.prevHash === prev;
      const okHash = okLink && e.hash === await entryHash(prev, seq, at, String(e.actor), String(e.action), String(e.target ?? ''), String(e.detail ?? ''));
      if (!okHash) return json({ ok: false, entries: seq - 1, brokenAt: seq, reason: okLink ? 'entry was altered' : 'entry removed, reordered or relinked' }, 200, c.headers);
      prev = String(e.hash);
    }
    after = docs[docs.length - 1]!.id;
    if (docs.length < 250) break;
  }
  if (seq !== expected || (head && head.data.hash !== prev)) return json({ ok: false, entries: seq, brokenAt: seq + 1, reason: 'entries missing from the end of the log' }, 200, c.headers);
  return json({ ok: true, entries: seq, headHash: prev }, 200, c.headers);
}
