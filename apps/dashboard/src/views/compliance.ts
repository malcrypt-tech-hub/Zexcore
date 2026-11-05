import { ApiError } from '../lib/api';
import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { ago } from '../lib/format';
import { emptyState, skeletonRows, confirmDialog } from '../lib/ui';
import { canAdmin, canManage, current } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import { api, toast, badge, pageHead, formModal, inp, fail, errMsg } from './shared';

type Tab = 'retention' | 'erasure' | 'consent' | 'subject' | 'breaches' | 'access';
interface Breach { id: string; title: string; description: string; affected: number | null; discovered_at: string | null; notified_at: string | null; closed: boolean }
const NOTICE_MS = 72 * 3_600_000;
interface Policy { id: string; entity: string; retention_days: number; action: string; enabled: boolean; last_run_at: string | null }
interface Erasure { id: string; subject_id: string; status: string; requested_at: string; completed_at?: string | null }
interface Consent { id: string; subject_id: string; purpose: string; legal_basis: string; granted_at: string; revoked_at: string | null }
interface Access { id: string; subject_id: string | null; entity: string; action?: string; accessed_at: string; actor_id?: string | null }

const ENTITIES: Record<string, string> = { messages: 'Messages', bookings: 'Past bookings' };
const BASIS: [string, string][] = [['consent', 'Consent'], ['contract', 'Contract'], ['legal_obligation', 'Legal obligation'], ['vital_interests', 'Vital interests'], ['legitimate_interests', 'Legitimate interests']];

export async function renderCompliance(view: HTMLElement): Promise<void> {
  const me = current()!;
  if (!hasFeatureAccess(me.tenant.tier, 'compliance')) {
    mount(view, html`<div class="page-head"><div><h1>Data protection</h1><p>Retention, erasure requests, consent and access records for personal data.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--primary-tint,#fff1f2);color:var(--primary,#e50920);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">${ic('lock', 'ico-md')}</div>
        <h2>Data Protection is available on the Starter plan</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">Meet NDPA and GDPR regulatory requirements with automated data retention policies, right-to-be-forgotten requests, and consent logging.</p>
        <div class="stack-sm" style="background:var(--bg-subtle,#f8f9fa);border-radius:12px;padding:16px;text-align:left;max-width:420px;margin:0 auto 24px">
          <div style="display:flex;align-items:center;gap:8px;font-size:13px">${ic('check', 'ico-sm')} Automated retention schedules & data purging</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:13px">${ic('check', 'ico-sm')} Subject erasure (right to be forgotten) workflows</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:13px">${ic('check', 'ico-sm')} Tamper-evident consent & access audit trail</div>
        </div>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg" style="display:inline-flex;align-items:center;gap:8px">${ic('arrow-right', 'ico-sm')} Upgrade to Starter</a></div>
      </div>`);
    return;
  }
  let tab: Tab = 'retention';
  mount(view, html`${pageHead('Data protection', 'Retention, erasure requests, consent and access records for the personal data you hold (NDPA and GDPR style duties).')}
    <div class="chips" role="tablist" style="margin-bottom:16px">${(['retention', 'erasure', 'consent', 'subject', 'breaches', 'access'] as Tab[]).map((t) => html`<button class="chip-btn" role="tab" data-tab="${t}" aria-pressed="${t === tab}">${{ retention: 'Retention', erasure: 'Erasure', consent: 'Consent', subject: 'Their data', breaches: 'Breaches', access: 'Access logs' }[t]}</button>`)}</div>
    <div id="cb"></div>`);
  const host = $('#cb', view)!;
  const card = (inner: Raw): Raw => html`<div class="card">${inner}</div>`;

  const retention = async (): Promise<void> => {
    mount(host, card(skeletonRows(2)));
    try {
      const { policies } = await api<{ policies: Policy[] }>('/api/compliance/retention');
      mount(host, html`<div class="row" style="justify-content:flex-end;gap:8px;margin-bottom:12px">${canAdmin() ? html`<button class="btn btn-secondary" data-run>${ic('rotate-cw', 'ico-sm')} Run now</button><button class="btn btn-primary" data-pol>${ic('plus', 'ico-sm')} Set policy</button>` : ''}</div>
        ${card(policies.length === 0 ? emptyState({ icon: 'database', title: 'No retention policies', text: 'Decide how long data is kept. Older records are removed when a policy runs.' })
          : html`<div class="table-wrap"><table class="table"><thead><tr><th>Data</th><th>Keep for</th><th>Status</th><th>Last run</th></tr></thead><tbody>${policies.map((p) => html`<tr><td><b>${ENTITIES[p.entity] ?? p.entity}</b></td><td>${p.retention_days} days</td><td>${badge(p.enabled ? 'On' : 'Off', p.enabled ? 'success' : '')}</td><td class="muted small">${p.last_run_at ? ago(p.last_run_at) : 'Never'}</td></tr>`)}</tbody></table></div>`)}`);
      $('[data-pol]', host)?.addEventListener('click', () => formModal({
        title: 'Retention policy', submitLabel: 'Save policy',
        body: html`<div class="field"><label for="re">Data</label><select class="input" id="re">${Object.entries(ENTITIES).map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
          <div class="field"><label for="rd">Keep for (days)</label><input class="input" id="rd" type="number" min="1" max="3650" value="365"></div>
          <label class="check"><input type="checkbox" id="ron" checked> Enabled</label>`,
        submit: async (el) => {
          const days = Number(inp(el, '#rd')); if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiError(0, 'Enter between 1 and 3650 days');
          await api('/api/compliance/retention', { method: 'POST', body: { entity: inp(el, '#re'), retentionDays: days, action: 'hard_delete', enabled: ($('#ron', el) as HTMLInputElement).checked } });
          toast('Policy saved', 'success'); void retention();
        },
      }));
      $('[data-run]', host)?.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Run retention now?', message: 'Records older than each enabled policy are permanently deleted.', confirmLabel: 'Run now', danger: true })) return;
        try { const r = await api<{ summary: { entity: string; purged: number }[] }>('/api/compliance/retention/run', { method: 'POST' }); toast(`Done. ${r.summary.reduce((a, x) => a + x.purged, 0)} records removed.`, 'success'); void retention(); }
        catch (e) { toast(errMsg(e, 'Run failed'), 'error'); }
      });
    } catch (e) { mount(host, card(fail(host, e, () => void retention(), 'Could not load retention policies'))); }
  };

  const erasure = async (): Promise<void> => {
    mount(host, card(skeletonRows(2)));
    try {
      const { requests } = await api<{ requests: Erasure[] }>('/api/compliance/erasure');
      mount(host, html`<div class="row" style="justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary" data-new>${ic('plus', 'ico-sm')} New request</button></div>
        ${card(requests.length === 0 ? emptyState({ icon: 'clipboard-list', title: 'No erasure requests', text: 'Record a person’s right-to-be-forgotten request here, then carry it out once verified.' })
          : html`<div class="list">${requests.map((r) => html`<div class="list-item"><span class="icon-tile">${ic('clipboard-list')}</span><div class="grow"><b class="mono">${r.subject_id}</b><br><span class="muted small">Requested ${ago(r.requested_at)}</span></div>${badge(r.status, r.status === 'completed' ? 'success' : r.status === 'pending' ? 'warning' : '')}${canAdmin() && r.status === 'pending' ? html`<button class="btn btn-soft-danger btn-sm" data-exec="${r.id}">Carry out</button>` : ''}</div>`)}</div>`)}`);
      $('[data-new]', host)!.addEventListener('click', () => formModal({
        title: 'Erasure request', submitLabel: 'Record request',
        body: html`<div class="field"><label for="es">Phone or email</label><input class="input mono" id="es" required placeholder="Phone number or email"></div><div class="field"><label for="er">Reason <span class="faint">(optional)</span></label><input class="input" id="er" maxlength="255"></div>`,
        submit: async (el) => { if (!inp(el, '#es')) throw new ApiError(0, 'Enter who the request is for'); const b: Record<string, unknown> = { subjectId: inp(el, '#es') }; if (inp(el, '#er')) b.reason = inp(el, '#er'); await api('/api/compliance/erasure', { method: 'POST', body: b }); toast('Request recorded', 'success'); void erasure(); },
      }));
      host.querySelectorAll<HTMLElement>('[data-exec]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Carry out this erasure?', message: 'This permanently erases the person’s data and cannot be undone.', confirmLabel: 'Erase data', danger: true })) return;
        try { await api(`/api/compliance/erasure/${b.dataset.exec}/execute`, { method: 'POST' }); toast('Erasure completed', 'success'); void erasure(); }
        catch (e) { toast(errMsg(e, 'Could not carry out the erasure'), 'error'); }
      }));
    } catch (e) { mount(host, card(fail(host, e, () => void erasure(), 'Could not load erasure requests'))); }
  };

  const consent = (): void => {
    mount(host, html`<form class="card card-pad" id="cf" style="margin-bottom:16px"><div class="row" style="gap:8px;flex-wrap:wrap"><input class="input grow" id="cs" placeholder="Phone number or email" aria-label="Subject ID" style="min-width:220px"><button class="btn btn-primary">Look up</button>${canManage() ? html`<button type="button" class="btn btn-secondary" data-rec>${ic('plus', 'ico-sm')} Record consent</button>` : ''}</div></form><div id="cr"></div>`);
    const look = async (id: string): Promise<void> => {
      const box = $('#cr', host)!; mount(box, card(skeletonRows(2)));
      try {
        const { consents } = await api<{ consents: Consent[] }>(`/api/compliance/consent/${encodeURIComponent(id)}`);
        mount(box, card(consents.length === 0 ? emptyState({ icon: 'scale', title: 'No consent on record', text: 'Nothing has been recorded for this subject.' })
          : html`<div class="list">${consents.map((c) => html`<div class="list-item"><span class="icon-tile">${ic('scale')}</span><div class="grow"><b>${c.purpose}</b><br><span class="muted small">${BASIS.find(([v]) => v === c.legal_basis)?.[1] ?? c.legal_basis} · granted ${ago(c.granted_at)}</span></div>${c.revoked_at ? badge('Revoked') : badge('Active', 'success')}${canManage() && !c.revoked_at ? html`<button class="btn btn-ghost btn-sm" data-rev="${c.purpose}">Revoke</button>` : ''}</div>`)}</div>`));
        box.querySelectorAll<HTMLElement>('[data-rev]').forEach((b) => b.addEventListener('click', async () => {
          try { await api('/api/compliance/consent/revoke', { method: 'POST', body: { subjectId: id, purpose: b.dataset.rev } }); toast('Consent revoked', 'success'); void look(id); } catch (e) { toast(errMsg(e, 'Could not revoke'), 'error'); }
        }));
      } catch (e) { mount(box, card(fail(box, e, () => void look(id), 'Could not look up consent'))); }
    };
    $('#cf', host)!.addEventListener('submit', (ev) => { ev.preventDefault(); const v = ($('#cs', host) as HTMLInputElement).value.trim(); if (v) void look(v); });
    $('[data-rec]', host)?.addEventListener('click', () => formModal({
      title: 'Record consent', submitLabel: 'Record',
      body: html`<div class="field"><label for="ks">Phone or email</label><input class="input mono" id="ks" required value="${($('#cs', host) as HTMLInputElement).value}"></div><div class="field"><label for="kp">Purpose</label><input class="input" id="kp" maxlength="128" required placeholder="Appointment reminders"></div>
        <div class="field"><label for="kb">Legal basis</label><select class="input" id="kb">${BASIS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>`,
      submit: async (el) => { if (!inp(el, '#ks') || inp(el, '#kp').length < 2) throw new ApiError(0, 'Enter the subject and a purpose'); await api('/api/compliance/consent', { method: 'POST', body: { subjectId: inp(el, '#ks'), purpose: inp(el, '#kp'), legalBasis: inp(el, '#kb') } }); toast('Consent recorded', 'success'); void look(inp(el, '#ks')); },
    }));
  };

  const subject = (): void => {
    mount(host, html`<form class="card card-pad stack" id="sf"><p class="muted small">When someone asks what you hold about them, look them up here and download it. It covers bookings, contacts, messages, enquiries and consent records for that phone number or email.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><input class="input mono grow" id="ss" placeholder="Phone number or email" required><button class="btn btn-primary" type="submit">${ic('download', 'ico-sm')} Download their data</button></div><div id="sm" class="muted small" role="status"></div></form>`);
    $('#sf', host)!.addEventListener('submit', async (ev) => {
      ev.preventDefault(); const v = ($('#ss', host) as HTMLInputElement).value.trim(); const msg = $('#sm', host)!;
      try {
        const r = await api<{ subject: string; data: Record<string, unknown[]> }>('/api/compliance/access-request', { method: 'POST', body: { subjectId: v } });
        const total = Object.values(r.data).reduce((a, x) => a + x.length, 0);
        if (total === 0) { msg.textContent = 'Nothing is held about this person.'; return; }
        const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `data-held-${r.subject.replace(/[^a-z0-9]+/gi, '-')}.json`; a.click(); URL.revokeObjectURL(url);
        msg.textContent = `Downloaded ${total} record${total === 1 ? '' : 's'}.`;
      } catch (e) { msg.textContent = errMsg(e, 'Could not look that person up'); }
    });
  };

  const breaches = async (): Promise<void> => {
    mount(host, card(skeletonRows(2)));
    try {
      const { breaches: rows } = await api<{ breaches: Breach[] }>('/api/compliance/breaches');
      const left = (b: Breach): string => { const h = (new Date(b.discovered_at ?? Date.now()).getTime() + NOTICE_MS - Date.now()) / 3_600_000; return h <= 0 ? 'The 72 hours have passed' : `${Math.floor(h)}h left of 72`; };
      mount(host, html`<div class="alert alert-info small" style="margin-bottom:12px">The Nigeria Data Protection Act expects you to tell the Commission within 72 hours of becoming aware of a breach that risks people's rights. This register keeps the record and the clock. It does not send anything for you, and it is not legal advice.</div>
        <div class="row" style="justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary" data-new>${ic('plus', 'ico-sm')} Log an incident</button></div>
        ${card(rows.length === 0 ? emptyState({ icon: 'triangle-alert', title: 'No incidents logged', text: 'Log anything that exposed or lost personal data, even if you are unsure it counts.' })
          : html`<div class="list">${rows.map((b) => html`<div class="list-item"><span class="icon-tile">${ic('triangle-alert')}</span><div class="grow"><b>${b.title}</b><br><span class="muted small">${b.description}</span><br><span class="muted small">Found ${ago(b.discovered_at ?? '')}${b.affected != null ? ` · ${b.affected} people` : ''} · ${b.notified_at ? `Commission told ${ago(b.notified_at)}` : b.closed ? 'Closed' : left(b)}</span></div>${canAdmin() && !b.closed ? html`<div class="row" style="gap:6px">${b.notified_at ? '' : html`<button class="btn btn-secondary btn-sm" data-told="${b.id}">Mark Commission told</button>`}<button class="btn btn-secondary btn-sm" data-close="${b.id}">Close</button></div>` : ''}</div>`)}</div>`)}`);
      $('[data-new]', host)!.addEventListener('click', () => formModal({
        title: 'Log an incident', submitLabel: 'Log incident',
        body: html`<div class="field"><label for="bt">Title</label><input class="input" id="bt" maxlength="120" required></div><div class="field"><label for="bd">What happened</label><textarea class="input" id="bd" rows="4" maxlength="2000" required></textarea></div>
          <div class="field"><label for="bw">When you found out</label><input class="input" id="bw" type="datetime-local"></div><div class="field"><label for="ba">People affected (leave empty if unknown)</label><input class="input" id="ba" type="number" min="0"></div>`,
        submit: async (el) => { const w = inp(el, '#bw'); await api('/api/compliance/breaches', { method: 'POST', body: { title: inp(el, '#bt'), description: inp(el, '#bd'), discoveredAt: w ? new Date(w).toISOString() : undefined, affected: inp(el, '#ba') } }); toast('Incident logged', 'success'); void breaches(); },
      }));
      host.querySelectorAll<HTMLElement>('[data-told],[data-close]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/api/compliance/breaches/${b.dataset.told ?? b.dataset.close}`, { method: 'POST', body: b.dataset.told ? { notified: true } : { closed: true } }); void breaches(); } catch (e) { toast(errMsg(e, 'Could not update'), 'error'); }
      }));
    } catch (e) { mount(host, card(fail(host, e, () => void breaches(), 'Could not load the register'))); }
  };

  const access = async (): Promise<void> => {
    mount(host, card(skeletonRows(3)));
    try {
      const { accessLogs } = await api<{ accessLogs: Access[] }>('/api/compliance/access-logs?limit=100');
      mount(host, card(accessLogs.length === 0 ? emptyState({ icon: 'eye', title: 'No activity yet', text: 'Retention runs, erasures and consent changes are recorded here.' })
        : html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Action</th><th>Subject</th></tr></thead><tbody>${accessLogs.map((a) => html`<tr><td class="muted small">${ago(a.accessed_at)}</td><td>${a.entity}</td><td class="mono small">${a.subject_id ?? '–'}</td></tr>`)}</tbody></table></div>`));
    } catch (e) { mount(host, card(fail(host, e, () => void access(), 'Could not load access logs'))); }
  };

  const show = (): void => { view.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab))); void ({ retention, erasure, consent: async () => consent(), subject: async () => subject(), breaches, access }[tab]()); };
  view.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab as Tab; show(); }));
  show();
}
