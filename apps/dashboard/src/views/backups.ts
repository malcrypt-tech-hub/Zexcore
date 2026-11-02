/** Backups page: status, history, download and certificate. Enterprise and Dedicated. */
import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { ApiError } from '../lib/api';
import { toast, busy, skeletonRows, errorState, emptyState } from '../lib/ui';
import { current, canAdmin } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import { listBackups, runBackupNow, saveBackupFile, type BackupRow } from '../lib/fb/backups';

const when = (s: string | null): string => (s ? new Date(s).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const size = (b: number): string => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function renderBackups(view: HTMLElement): void {
  const me = current()!;
  if (!canAdmin()) { mount(view, html`<div class="page-head"><div><h1>Backups</h1></div></div><div class="alert alert-info">Only owners and admins can see backups.</div>`); return; }
  if (!hasFeatureAccess(me.tenant.tier, 'backups')) {
    mount(view, html`<div class="page-head"><div><h1>Backups</h1><p>Encrypted daily copies of your workspace.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--primary-tint,#fff1f2);color:var(--primary,#e50920);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">${ic('lock', 'ico-md')}</div>
        <h2>Daily encrypted backups are part of Enterprise</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">Every day your whole workspace is copied, encrypted, checked and stored, with a certificate you can show an auditor or a client.</p>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg">${ic('arrow-right', 'ico-sm')} See plans</a></div></div>`);
    return;
  }
  mount(view, html`<div class="page-head"><div><h1>Backups</h1><p>A full encrypted copy of your workspace is made every day and the last 30 are kept.</p></div>
      <button class="btn btn-primary" data-run>${ic('database', 'ico-sm')} Back up now</button></div>
    <div id="status"></div><div class="card" id="l"></div>
    <p class="muted small" style="margin-top:12px">Each backup is encrypted, then read back and checked before it is marked verified. Downloads are decrypted for you. Restoring a backup is done by ZexCore on request: contact support and say which backup you want.</p>`);
  const host = $('#l', view)!;
  const load = async () => {
    mount(host, skeletonRows(3));
    try {
      const rows = await listBackups();
      const last = rows[0];
      const stale = !last?.createdAt || Date.now() - new Date(last.createdAt).getTime() > 36 * 3_600_000;
      mount($('#status', view)!, html`<div class="alert ${last && last.verified && !stale ? 'alert-success' : 'alert-info'}" style="margin-bottom:16px">${ic(last && last.verified && !stale ? 'check-check' : 'info', 'ico-sm')}
        ${!last ? 'No backup yet. The first one runs within a day, or press Back up now.' : stale ? `Your last backup was ${when(last.createdAt)}. If this keeps showing, contact support.` : `Last backup ${when(last.createdAt)}, ${last.verified ? 'verified' : 'NOT verified'}.`}</div>`);
      if (!rows.length) { mount(host, emptyState({ icon: 'database', title: 'No backups yet', text: 'Press Back up now to make the first one.' })); return; }
      mount(host, html`<div class="list">${rows.map((r: BackupRow) => html`<div class="list-item"><span class="icon-tile">${ic('database')}</span>
        <div class="grow"><b>${when(r.createdAt)}</b> ${r.verified ? html`<span class="badge">Verified</span>` : html`<span class="badge">Not verified</span>`} ${r.partial ? html`<span class="badge">Incomplete</span>` : ''}
          <div class="muted small">${r.records.toLocaleString('en-NG')} records, ${size(r.bytes)}, ${r.trigger === 'manual' ? 'on demand' : 'daily'}</div></div>
        <button class="btn btn-secondary btn-sm" data-file="download" data-id="${r.id}">Download</button>
        <button class="btn btn-secondary btn-sm" data-file="certificate" data-id="${r.id}">Certificate</button></div>`)}</div>`);
      host.querySelectorAll<HTMLElement>('[data-file]').forEach((b) => b.addEventListener('click', () => void busy(b as HTMLButtonElement, async () => {
        try { await saveBackupFile(b.dataset.file as 'download' | 'certificate', b.dataset.id!); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not download', 'error'); }
      })));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load backups')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  $('[data-run]', view)!.addEventListener('click', (e) => void busy(e.currentTarget as HTMLButtonElement, async () => {
    try { const r = await runBackupNow(); toast(r.verified ? 'Backup made and verified' : 'Backup made but could not be verified', r.verified ? 'success' : 'error'); void load(); }
    catch (x) { toast(x instanceof ApiError ? x.message : 'Could not make a backup', 'error'); }
  }));
  void load();
}
