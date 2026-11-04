/** Business insights: plain counts from your own bookings. Owners, admins and viewers. Enterprise and Dedicated. */
import { html, mount, $, $$ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money } from '../lib/format';
import { skeletonRows, errorState } from '../lib/ui';
import { current } from '../lib/session';
import { hasFeatureAccess } from '../lib/fb/plan';
import type { InsightsView } from '../lib/fb/insights';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hr = (h: number): string => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const pct = (v: number | null): string => (v === null ? 'No data yet' : `${v}%`);
/** "up 12% on the previous 30 days", or nothing when there is nothing to compare with. */
function vs(cur: number, prev: number, days: number, good: 'up' | 'down' = 'up'): ReturnType<typeof html> | string {
  if (prev === 0) return '';
  const d = Math.round(((cur - prev) / prev) * 100);
  if (d === 0) return html`<span class="muted small">same as the previous ${days} days</span>`;
  const better = (d > 0) === (good === 'up');
  return html`<span class="small" style="color:${better ? 'var(--success,#15803d)' : 'var(--danger,#b91c1c)'}">${d > 0 ? 'Up' : 'Down'} ${Math.abs(d)}% on the previous ${days} days</span>`;
}
const bars = (labels: string[], vals: number[]) => {
  const max = Math.max(1, ...vals);
  return html`<div style="display:flex;align-items:flex-end;gap:6px;height:130px">${vals.map((v, i) => html`<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0" title="${labels[i]}: ${v}">
    <span class="small num muted">${v || ''}</span><div style="width:100%;max-width:34px;border-radius:4px 4px 0 0;background:var(--primary,#e50920);opacity:${v ? 1 : .15};height:${Math.max(v ? 4 : 2, Math.round((v / max) * 92))}px"></div><span class="small muted" style="margin-top:4px">${labels[i]}</span></div>`)}</div>`;
};

export function renderInsights(view: HTMLElement): void {
  const me = current()!;
  if (!['owner', 'admin', 'viewer'].includes(String(me.role))) { mount(view, html`<div class="page-head"><div><h1>Business insights</h1></div></div><div class="alert alert-info">Insights show revenue, so they are for owners, admins and viewers.</div>`); return; }
  if (!hasFeatureAccess(me.tenant.tier, 'insights')) {
    mount(view, html`<div class="page-head"><div><h1>Business insights</h1><p>See what is working in your business.</p></div></div>
      <div class="card card-pad stack" style="text-align:center;padding:48px 24px;max-width:640px;margin:32px auto"><h2>Business insights are part of Enterprise</h2>
        <p class="muted" style="max-width:480px;margin:0 auto 20px">Bookings, revenue at list price, no-show and cancellation rates, your busiest days and hours and your top services, plus a summary email every Monday.</p>
        <div><a href="/app/billing" data-link class="btn btn-primary btn-lg">${ic('arrow-right', 'ico-sm')} See plans</a></div></div>`);
    return;
  }
  let days = 30;
  mount(view, html`<div class="page-head"><div><h1>Business insights</h1><p>Counted from your own bookings. Nothing is estimated.</p></div>
    <div class="chips">${[7, 30, 90].map((d) => html`<button class="chip-btn" data-d="${d}" aria-pressed="${d === days}">${d} days</button>`)}</div></div><div id="b">${skeletonRows(3)}</div>`);
  const host = $('#b', view)!;
  const load = async () => {
    $$('[data-d]', view).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.d) === days)));
    mount(host, skeletonRows(3));
    try {
      const v = await api<InsightsView>(`/api/insights?days=${days}`);
      const c = v.current, p = v.previous;
      const tile = (label: string, value: string, extra: unknown = '') => html`<div class="card card-pad"><div class="muted small">${label}</div><b class="num" style="font-size:1.6rem">${value}</b><div>${extra}</div></div>`;
      mount(host, html`
        ${v.truncated ? html`<div class="alert alert-warn">${ic('triangle-alert', 'ico-sm')}<span>You have more bookings than we can count in one go, so these numbers are lower than the real totals. Choose a shorter period.</span></div>` : ''}
        <div class="stack" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:16px 0">
          ${tile('Bookings', String(c.bookings), vs(c.bookings, p.bookings, days))}
          ${tile('Revenue at list price', money(c.revenueMinor, 'USD'), html`${vs(c.revenueMinor, p.revenueMinor, days)}<div class="muted small">${c.completed} completed</div>`)}
          ${tile('Deposits paid', money(c.depositsMinor, 'USD'))}
          ${tile('No-show rate', pct(c.noShowRate), html`<span class="muted small">${c.noShows} no-show${c.noShows === 1 ? '' : 's'}</span>`)}
          ${tile('Cancellation rate', pct(c.cancelRate), html`<span class="muted small">${c.cancelled} cancelled</span>`)}
          ${tile('Repeat customers', `${c.repeatCustomers} of ${c.customers}`, html`<span class="muted small">booked more than once</span>`)}
        </div>
        <div class="stack" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))">
          <section class="card card-pad stack-sm"><h3>Busiest days</h3><p class="muted small">${v.busiestDay ? `${v.busiestDay} is your busiest day.` : 'No bookings in this period.'}</p>${bars(DAYS, c.byWeekday)}</section>
          <section class="card card-pad stack-sm"><h3>Busiest hours</h3><p class="muted small">${v.busiestHour !== null ? `${hr(v.busiestHour)} is your busiest hour.` : 'No bookings in this period.'}</p>${bars(Array.from({ length: 24 }, (_, h) => hr(h)).slice(6, 22), c.byHour.slice(6, 22))}</section></div>
        <section class="card card-pad stack-sm" style="margin-top:16px"><h3>Top services</h3>
          ${c.topServices.length ? html`<div class="list">${c.topServices.map((s) => html`<div class="list-item"><div class="grow"><b>${s.name}</b></div><span class="muted small">${s.bookings} booking${s.bookings === 1 ? '' : 's'}</span><b class="num" style="min-width:90px;text-align:right">${money(s.revenueMinor, 'USD')}</b></div>`)}</div>` : html`<p class="muted small">Nothing booked in this period.</p>`}</section>
        ${c.recoveredBookings ? html`<section class="card card-pad" style="margin-top:16px"><b>Won back from the waitlist:</b> ${c.recoveredBookings} booking${c.recoveredBookings === 1 ? '' : 's'}, ${money(c.recoveredMinor, 'USD')} at list price.</section>` : ''}
        <p class="muted small" style="margin-top:12px">${v.note} Cancelled bookings are left out of busy times and top services. "Previous ${days} days" is the period just before this one. Revenue only counts bookings marked completed. We also email a summary every Monday; you can switch that off in Settings.</p>`);
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load your insights')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  $$('[data-d]', view).forEach((b) => b.addEventListener('click', () => { days = Number(b.dataset.d); void load(); }));
  void load();
}
