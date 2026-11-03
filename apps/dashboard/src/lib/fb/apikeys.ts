/** Read-only API keys (Enterprise and Dedicated). The key itself is only ever shown once, when it is made. */
import { getDocs, orderBy, query } from 'firebase/firestore';
import { iso, loadCtx, requireAdmin, requireFeature, wsCol } from './core';
import { worker } from './worker';

export interface ApiKeyRow { id: string; name: string; prefix: string; createdAt: string | null; createdByEmail: string | null; lastUsedAt: string | null }

export async function listKeys(): Promise<ApiKeyRow[]> {
  const c = await loadCtx(); requireAdmin(c);
  const s = await getDocs(query(wsCol(c, 'apiKeys'), orderBy('createdAt', 'desc')));
  return s.docs.map((d) => { const x = d.data(); return { id: d.id, name: String(x.name ?? ''), prefix: String(x.prefix ?? ''), createdAt: iso(x.createdAt), createdByEmail: (x.createdByEmail as string | null) ?? null, lastUsedAt: iso(x.lastUsedAt) }; });
}
export async function createKey(name: string): Promise<{ key: string; name: string }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'api');
  return worker('/api/keys/create', { body: { workspaceId: c.wid, name } });
}
export async function revokeKey(id: string): Promise<void> {
  const c = await loadCtx(); requireAdmin(c);
  await worker('/api/keys/revoke', { body: { workspaceId: c.wid, id } });
}
