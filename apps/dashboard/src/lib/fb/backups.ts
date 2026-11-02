/** Encrypted daily backups (Enterprise and Dedicated). The files live in R2; the Worker makes, decrypts and certifies them. */
import { getDocs, limit as qLimit, orderBy, query } from 'firebase/firestore';
import { ApiError, iso, loadCtx, requireAdmin, wsCol } from './core';
import { fb, paymentsUrl } from './firebase';
import { worker } from './worker';

export interface BackupRow { id: string; createdAt: string | null; bytes: number; records: number; verified: boolean; partial: boolean; trigger: 'schedule' | 'manual' }

export async function listBackups(): Promise<BackupRow[]> {
  const c = await loadCtx(); requireAdmin(c);
  const s = await getDocs(query(wsCol(c, 'backups'), orderBy('createdAt', 'desc'), qLimit(40)));
  return s.docs.map((d) => { const x = d.data(); return { id: d.id, createdAt: iso(x.createdAt), bytes: Number(x.bytes) || 0, records: Number(x.records) || 0, verified: x.verified === true, partial: x.partial === true, trigger: x.trigger === 'manual' ? 'manual' : 'schedule' }; });
}
export async function runBackupNow(): Promise<{ verified: boolean; records: number }> {
  const c = await loadCtx(); requireAdmin(c);
  return worker('/api/backups/run', { body: { workspaceId: c.wid } });
}
/** Downloads a file from the Worker with the user's sign-in and saves it. */
export async function saveBackupFile(kind: 'download' | 'certificate', id: string): Promise<void> {
  const c = await loadCtx(); requireAdmin(c);
  const base = paymentsUrl(); const token = await fb().auth.currentUser?.getIdToken();
  if (!base || !token) throw new ApiError(401, 'Sign in again to continue.', 'unauthenticated');
  let res: Response;
  try { res = await fetch(`${base}/api/backups/${kind}?workspaceId=${encodeURIComponent(c.wid)}&id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } }); }
  catch { throw new ApiError(0, 'Cannot reach the ZexCore service. Check your connection and try again.', 'network'); }
  if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: string }; throw new ApiError(res.status, j.error ?? 'Could not download that file.'); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = kind === 'certificate' ? `zexcore-backup-certificate-${id}.pdf` : `zexcore-backup-${id}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
