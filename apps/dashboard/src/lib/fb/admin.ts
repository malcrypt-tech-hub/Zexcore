/** Platform-admin tools. The Worker decides who is an admin (an allow-list of verified e-mails); the app only asks. */
import { worker } from './worker';

export async function adminMe(): Promise<{ admin: boolean }> {
  try { return await worker<{ admin: boolean }>('/api/admin/me'); } catch { return { admin: false }; }
}
export async function grantPlan(b: { workspaceId: string; plan: string; days: number | null }): Promise<{ ok: true; plan: string; expiresAt: string | null }> {
  return worker('/api/admin/grant-plan', { body: { workspaceId: b.workspaceId, plan: b.plan, ...(b.days === null ? {} : { days: b.days }) } });
}
