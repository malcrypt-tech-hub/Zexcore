/** Revenue protection: the waitlist and what it has won back. Enterprise and Dedicated. */
import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money } from '../lib/format';
import { toast, skeletonRows, errorState, emptyState, confirmDialog } from '../lib/ui';
import { current } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import type { WaitlistView } from '../lib/fb/waitlist';

const day = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const at = (s: string): string => new Date(s).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

export function renderWaitlist(view: HTMLElement): void {
  const me = current()!;
  if (!hasFeatureAccess(me.tenant.tier, 'waitlist')) {
    mount(view, html`<div class="page-head"><div><h1>Revenue protection</h1><p>Win back the time customers cancel.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto"><h2>Revenue protection is part of Enterprise</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">When a day is full, customers join a waitlist. If someone cancels, we email the people waiting for that service and day, and the first to book takes the time.</p>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg">${ic('arrow-right', 'ico-sm')} See plans</a></div></div>`);
    return;
  }
  mount(view, html`<div class="page-head"><div><h1>Revenue protection</h1><p>People waiting for a time, and the bookings they have won back.</p></div></div><div id="b">${skeletonRows(3)}</div>`);
  const host = $('#b', view)!;
  const load = async () => {
    try {
      const v = await api<WaitlistView>('/api/waitlist');
      mount(host, html`
        ${v.enabled ? '' : html`<div class="alert alert-warn">${ic('triangle-alert', 'ico-sm')}<span>The waitlist is switched off, so your booking page does not offer it. Turn it on in <a href="/app/settings" data-link>Settings</a>, under Revenue protection.</span></div>`}
        <div class="stack" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:16px 0">
          <div class="card card-pad"><div class="muted small">Waiting now</div><b class="num" style="font-size:1.6rem">${v.waiting.filter((x) => x.status === 'waiting').length}</b></div>
          <div class="card card-pad"><div class="muted small">Offered a time</div><b class="num" style="font-size:1.6rem">${v.waiting.filter((x) => x.status === 'offered').length}</b></div>
          <div class="card card-pad"><div class="muted small">Bookings won back</div><b class="num" style="font-size:1.6rem">${v.recovered.length}</b><div class="muted small">${money(v.recoveredMinor, 'USD')} at list price</div></div></div>
        <h3 style="margin:20px 0 10px">Waitlist</h3>
        <div class="card">${v.waiting.length ? html`<div class="list">${v.waiting.map((w) => html`<div class="list-item"><div class="grow"><b>${w.name}</b> <span class="muted small">${w.serviceName} · ${day(w.date)}</span>
          <div class="muted small">${w.phone} · ${w.email} · ${w.status === 'offered' ? html`<span class="badge badge-warning">Offered ${w.offeredAt ? at(w.offeredAt) : ''}</span>` : `joined ${w.createdAt ? at(w.createdAt) : ''}`}</div></div>
          <button class="btn btn-soft-danger btn-sm" data-rm="${w.id}" data-name="${w.name}">Remove</button></div>`)}</div>` : emptyState({ icon: 'clock', title: 'Nobody is waiting', text: 'When a day is full, your booking page offers a waitlist. People who join appear here.' })}</div>
        <h3 style="margin:24px 0 10px">Won back</h3>
        <div class="card">${v.recovered.length ? html`<div class="list">${v.recovered.map((r) => html`<div class="list-item"><div class="grow"><b>${r.customerName}</b> <span class="muted small">${r.serviceName}</span><div class="muted small">${at(r.startsAt)}</div></div><b class="num">${money(r.priceMinor, 'USD')}</b></div>`)}</div>` : emptyState({ icon: 'circle-check', title: 'Nothing yet', text: 'A booking appears here when someone we offered a cancelled time books it.' })}</div>
        <p class="muted small" style="margin-top:12px">An offer is not a hold: we email up to three people and the first to book gets the time. Values use each service's current list price, not what was paid.</p>`);
      host.querySelectorAll<HTMLElement>('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog({ title: `Remove ${b.dataset.name}?`, message: 'They will no longer be told when a time opens up.', confirmLabel: 'Remove', danger: true })) return;
        try { await api('/api/waitlist/' + b.dataset.rm, { method: 'DELETE' }); toast('Removed', 'success'); void load(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove', 'error'); }
      }));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load the waitlist')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  void load();
}
