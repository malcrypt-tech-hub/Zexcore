/** Data export: download your workspace data as CSV or JSON. Enterprise and Dedicated. */
import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { ApiError } from '../lib/api';
import { toast, busy } from '../lib/ui';
import { current, canAdmin } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import { DATASETS, exportDataset, exportEverything, type DatasetKey, type Exported } from '../lib/fb/export';

function download(f: Exported): void {
  const url = URL.createObjectURL(new Blob([f.text], { type: f.mime }));
  const a = document.createElement('a'); a.href = url; a.download = f.filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function renderExport(view: HTMLElement): void {
  const me = current()!;
  if (!canAdmin()) { mount(view, html`<div class="page-head"><div><h1>Export data</h1></div></div><div class="alert alert-info">Only owners and admins can export data.</div>`); return; }
  if (!hasFeatureAccess(me.tenant.tier, 'export')) {
    mount(view, html`<div class="page-head"><div><h1>Export data</h1><p>Download your bookings, customers, payments and audit log.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--primary-tint,#fff1f2);color:var(--primary,#e50920);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">${ic('lock', 'ico-md')}</div>
        <h2>Data export is part of Enterprise</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">Download everything in CSV for spreadsheets or JSON for other systems, including the tamper-evident audit log.</p>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg">${ic('arrow-right', 'ico-sm')} See plans</a></div></div>`);
    return;
  }
  const keys = Object.keys(DATASETS) as DatasetKey[];
  mount(view, html`<div class="page-head"><div><h1>Export data</h1><p>Your data, in files you can open anywhere. Every export is recorded in the audit log.</p></div>
      <button class="btn btn-primary" data-all>${ic('download', 'ico-sm')} Everything (JSON)</button></div>
    <div class="card"><div class="list">${keys.map((k) => html`<div class="list-item"><span class="icon-tile">${ic('file-text')}</span><div class="grow"><b>${DATASETS[k].label}</b></div>
      <button class="btn btn-secondary btn-sm" data-ds="${k}" data-fmt="csv">CSV</button><button class="btn btn-secondary btn-sm" data-ds="${k}" data-fmt="json">JSON</button></div>`)}</div></div>
    <p class="muted small" style="margin-top:12px">CSV files open in Excel and Google Sheets. Customer-entered text that could run as a spreadsheet formula is made safe with a leading apostrophe.</p>`);
  const run = (btn: HTMLElement, job: () => Promise<Exported>): void => void busy(btn as HTMLButtonElement, async () => {
    try { const f = await job(); download(f); toast(`Exported ${f.rows.toLocaleString('en-NG')} records`, 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not export. Please try again.', 'error'); }
  });
  view.querySelectorAll<HTMLElement>('[data-ds]').forEach((b) => b.addEventListener('click', () => run(b, () => exportDataset(b.dataset.ds as DatasetKey, b.dataset.fmt as 'csv' | 'json'))));
  $('[data-all]', view)!.addEventListener('click', (e) => run(e.currentTarget as HTMLElement, exportEverything));
}
