/** API keys page: read-only keys for bookings and customers (Enterprise and Dedicated). Owners and admins only. */
import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { toast, busy, skeletonRows, errorState, emptyState, openModal, confirmDialog, copyText } from '../lib/ui';
import { current, canAdmin } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import { paymentsUrl } from '../lib/fb/firebase';
import type { ApiKeyRow } from '../lib/fb/apikeys';

const when = (s: string | null): string => (s ? new Date(s).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export function renderApiKeys(view: HTMLElement): void {
  const me = current()!;
  if (!canAdmin()) { mount(view, html`<div class="page-head"><div><h1>API keys</h1></div></div><div class="alert alert-info">Only owners and admins can manage API keys.</div>`); return; }
  if (!hasFeatureAccess(me.tenant.tier, 'api')) {
    mount(view, html`<div class="page-head"><div><h1>API keys</h1><p>Let other tools read your bookings and customers.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--primary-tint,#fff1f2);color:var(--primary,#e50920);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">${ic('lock', 'ico-md')}</div>
        <h2>API keys are part of Enterprise</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">Create read-only keys so an accountant's spreadsheet, a reporting tool or another system can read your bookings and customers. Keys can never change anything.</p>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg">${ic('arrow-right', 'ico-sm')} See plans</a></div></div>`);
    return;
  }
  const base = paymentsUrl() ?? 'https://YOUR-ZEXCORE-API';
  mount(view, html`<div class="page-head"><div><h1>API keys</h1><p>Read-only access to your bookings and customers for other systems.</p></div><button class="btn btn-primary" data-new>${ic('plus', 'ico-sm')} New key</button></div>
    <div class="card" id="l"></div>
    <section class="card card-pad stack-sm" style="margin-top:16px"><h3>Using a key</h3>
      <p class="muted small">Send it as a bearer token. Keys can only read: bookings and customers, nothing else. Up to 60 requests a minute per key. Keep a key private, like a password; if it leaks, revoke it here.</p>
      <pre class="mono small" style="overflow:auto;padding:12px;background:var(--surface-2,#f6f7f9);border-radius:8px;margin:0">curl -H "Authorization: Bearer YOUR_KEY" \\
  "${base}/api/v1/bookings?status=completed&amp;limit=100"

curl -H "Authorization: Bearer YOUR_KEY" \\
  "${base}/api/v1/customers"</pre>
      <p class="muted small">Bookings are returned oldest first, up to 200 at a time. If <span class="mono">nextCursor</span> is not null, pass it back as <span class="mono">?cursor=</span> for the next page. Customers are worked out from your bookings (most recent 2,000); <span class="mono">truncated</span> says if there were more.</p></section>`);
  const host = $('#l', view)!;
  const load = async () => {
    mount(host, skeletonRows(2));
    try {
      const { keys } = await api<{ keys: ApiKeyRow[] }>('/api/keys');
      if (!keys.length) { mount(host, emptyState({ icon: 'key-round', title: 'No keys yet', text: 'Make a key for each tool that needs to read your data, so you can revoke one without affecting the others.' })); return; }
      mount(host, html`<div class="list">${keys.map((k) => html`<div class="list-item"><span class="icon-tile">${ic('key-round')}</span>
        <div class="grow"><b>${k.name}</b> <span class="mono muted small">…${k.prefix}</span>
          <div class="muted small">Made ${when(k.createdAt)}${k.createdByEmail ? ` by ${k.createdByEmail}` : ''} · ${k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : 'never used'}</div></div>
        <button class="btn btn-soft-danger btn-sm" data-revoke="${k.id}" data-name="${k.name}">Revoke</button></div>`)}</div>`);
      host.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog({ title: `Revoke “${b.dataset.name}”?`, message: 'Anything using this key stops working straight away. This cannot be undone, and the revocation is recorded in your audit log.', confirmLabel: 'Revoke key', danger: true })) return;
        try { await api('/api/keys/revoke', { method: 'POST', body: { id: b.dataset.revoke } }); toast('Key revoked', 'success'); void load(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not revoke', 'error'); }
      }));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load your keys')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  $('[data-new]', view)!.addEventListener('click', () => openModal({
    title: 'New API key', subtitle: 'Read-only: bookings and customers',
    body: html`<div id="ke" class="alert alert-error hidden"></div><div class="field"><label for="kn">Name</label><input class="input" id="kn" maxlength="60" placeholder="e.g. Accountant spreadsheet" required></div><p class="muted small" style="margin-top:8px">Name it after the tool that will use it. You will see the key once.</p>`,
    footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-go>Create key</button>`,
    onMount: (el, close) => $('[data-go]', el)!.addEventListener('click', () => void busy($('[data-go]', el) as HTMLButtonElement, async () => {
      try {
        const r = await api<{ key: string; name: string }>('/api/keys', { method: 'POST', body: { name: ($('#kn', el) as HTMLInputElement).value.trim() } });
        close(); void load();
        openModal({
          title: 'Copy your key now', subtitle: r.name,
          body: html`<div class="alert alert-info">${ic('triangle-alert', 'ico-sm')}<span>This is the only time the key is shown. We store only a fingerprint, so we cannot show it again. If you lose it, revoke it and make a new one.</span></div><div class="copy-box" style="margin-top:12px"><code style="word-break:break-all">${r.key}</code><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy</button></div>`,
          footer: html`<button class="btn btn-primary" data-close>I have saved it</button>`,
          onMount: (e2) => $('[data-copy]', e2)!.addEventListener('click', () => copyText(r.key)),
        });
      } catch (x) { const e = $('#ke', el)!; e.textContent = x instanceof ApiError ? x.message : 'Could not create the key'; e.classList.remove('hidden'); }
    })),
  }));
  void load();
}
