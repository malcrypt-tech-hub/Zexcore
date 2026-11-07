/** Licence file and dedicated-cluster request: both are issued and stored by the Worker. */
import { worker } from './worker';
import { loadCtx, requireAdmin } from './core';

export interface LicenseDto { license: string; payload: { id: string; plan: string; business: string; issuedAt: string; expiresAt: string; graceDays: number }; publicKey: string }
export interface ClusterRequestDto { status: string; size: string; needs: string; region: string; phone: string; createdAt: string | null }

export async function getLicense(): Promise<LicenseDto> {
  const c = await loadCtx(); requireAdmin(c);
  return worker<LicenseDto>('/api/license', { body: { workspaceId: c.wid } });
}
export async function getClusterRequest(): Promise<{ request: ClusterRequestDto | null }> {
  const c = await loadCtx(); requireAdmin(c);
  return worker('/api/cluster/request', { query: { workspaceId: c.wid } });
}
export async function requestCluster(b: { size: string; needs: string; region: string; phone: string }): Promise<{ ok: true; notified: boolean }> {
  const c = await loadCtx();
  return worker('/api/cluster/request', { body: { workspaceId: c.wid, ...b } });
}
