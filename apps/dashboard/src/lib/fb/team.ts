/** Team access: who can sign in to a workspace. Reading is done with the database rules; changes go through the Worker. */
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { ApiError, iso, loadCtx, requireAdmin, setPreferredWorkspace, clearCtx, wsCol } from './core';
import { fb } from './firebase';
import { worker } from './worker';
import { slotLimit } from './plan';

export interface TeamMember { uid: string; email: string | null; name: string | null; role: 'owner' | 'admin' | 'editor' | 'staff'; you: boolean }
export interface TeamInvite { id: string; email: string; role: 'admin' | 'editor'; expiresAt: string | null }

export async function listTeam(): Promise<{ members: TeamMember[]; invites: TeamInvite[]; seats: number; myRole: string }> {
  const c = await loadCtx();
  const ms = await getDocs(wsCol(c, 'members'));
  const order = { owner: 0, admin: 1, editor: 2, staff: 3 } as const;
  const members = ms.docs.map((d) => ({ uid: d.id, email: (d.data().email as string | undefined) ?? null, name: (d.data().name as string | undefined) ?? null, role: d.data().role as TeamMember['role'], you: d.id === c.uid }))
    .sort((a, b) => order[a.role] - order[b.role] || String(a.email).localeCompare(String(b.email)));
  let invites: TeamInvite[] = [];
  if (c.role === 'owner' || c.role === 'admin') {
    const is = await getDocs(query(wsCol(c, 'invites'), orderBy('createdAt', 'desc')));
    invites = is.docs.map((d) => ({ id: d.id, email: String(d.data().email), role: d.data().role as TeamInvite['role'], expiresAt: iso(d.data().expiresAt) }))
      .filter((i) => !i.expiresAt || new Date(i.expiresAt) > new Date());
  }
  return { members, invites, seats: slotLimit(c.tier, 'staff'), myRole: c.role };
}

export async function invite(b: Record<string, unknown>): Promise<{ link: string; emailed: boolean }> {
  const c = await loadCtx(); requireAdmin(c);
  const r = await worker<{ link: string; emailed: boolean }>('/api/team/invite', { body: { wid: c.wid, email: b.email, role: b.role } });
  return { link: r.link, emailed: r.emailed };
}
export async function revokeInvite(id: string): Promise<{ ok: true }> { const c = await loadCtx(); await worker('/api/team/revoke', { body: { wid: c.wid, id } }); return { ok: true }; }
export async function setRole(uid: string, role: string): Promise<{ ok: true }> { const c = await loadCtx(); await worker('/api/team/role', { body: { wid: c.wid, uid, role } }); return { ok: true }; }
export async function removeMember(uid: string): Promise<{ ok: true }> { const c = await loadCtx(); await worker('/api/team/remove', { body: { wid: c.wid, uid } }); return { ok: true }; }

export const inviteInfo = (w: string, t: string) => worker<{ workspace: string; role: 'admin' | 'editor'; email: string }>('/api/team/invite-info', { query: { w, t }, auth: false });
export async function acceptInvite(wid: string, token: string): Promise<{ wid: string; role: string }> {
  const r = await worker<{ wid: string; role: string }>('/api/team/accept', { body: { wid, token } });
  setPreferredWorkspace(r.wid); clearCtx();
  return r;
}

/** Every workspace this account can open (for the switcher). */
export async function myWorkspaces(): Promise<{ id: string; name: string; role: string }[]> {
  const { auth, db } = fb();
  const uid = auth.currentUser?.uid; if (!uid) throw new ApiError(401, 'Please sign in.', 'unauthenticated');
  const ids = ((await getDoc(doc(db, 'users', uid))).data()?.workspaceIds as string[] | undefined) ?? [];
  const rows = await Promise.all(ids.map(async (id) => {
    const [w, m] = await Promise.all([getDoc(doc(db, 'workspaces', id)), getDoc(doc(collection(db, 'workspaces', id, 'members'), uid))]);
    return w.exists() && m.exists() ? { id, name: String(w.data().name), role: String(m.data().role) } : null;
  }));
  return rows.filter((r): r is { id: string; name: string; role: string } => !!r);
}
export const switchWorkspace = (id: string): void => setPreferredWorkspace(id);
