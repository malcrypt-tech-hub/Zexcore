import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, timeOf, longDate } from '../lib/format';
import { errorState, skeletonRows, copyText } from '../lib/ui';
import { current } from '../lib/session';
import { loadSettings, bookingUrl, type Booking } from '../lib/store';
import { termsFor } from '../lib/industries';
import { statusBadge, depositBadge, openNewBooking } from './bookings';

interface Summary {
  businessName: string | null; currency: string; today: string; utcOffsetMinutes: number;
  setup: { onboarded: boolean; services: number; staff: number; depositEnabled: boolean; hasPhone: boolean; hasName: boolean };
  todayBookings: Booking[];
  week: { total: number; depositsMinor: number; noShows: number; perDay: number[] };
  attention: { pending: number; unpaidCount: number; unpaidMinor: number; waitingReplies: number };
  popularServices: { name: string; count: number; pct: number }[];
}

export async function renderHome(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="skel" style="height:190px;border-radius:0 0 28px 28px;margin:-16px -16px 20px"></div>${skeletonRows(3)}`);
  const settings = await loadSettings();
  const tm = termsFor(settings.businessType);
  let s: Summary;
  try { s = await api<Summary>('/api/bookings/summary'); }
  catch (e) { mount(view, html`<div class="card">${errorState(e instanceof ApiError ? e.message : 'Could not load your dashboard')}</div>`); $('[data-retry]', view)?.addEventListener('click', () => void renderHome(view)); return; }

  const me = current()!;
  const first = (me.user.name || '').split(' ')[0] || 'there';
  const off = s.utcOffsetMinutes, cur = 'USD';   // prices and deposits are US dollars
  const dow = new Date(s.today + 'T00:00:00Z').getUTCDay();
  const steps = [
    { done: s.setup.hasName, t: 'Business name', s: 'Shown on your booking page', href: '/app/settings' },
    { done: s.setup.hasPhone, t: 'Business phone or WhatsApp', s: 'So customers can reach you', href: '/app/settings' },
    { done: s.setup.services > 0, t: 'At least one service', s: 'What customers can book', href: '/app/services' },
    { done: s.setup.onboarded, t: 'Opening hours confirmed', s: 'Sets the times people can book', href: '/app/onboarding' },
  ];
  const needsSetup = steps.some((x) => !x.done);
  const a = s.attention;
  const attention = a.pending + (a.unpaidCount ? 1 : 0) + a.waitingReplies;
  const max = Math.max(1, ...s.week.perDay);
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const todayIdx = (dow + 6) % 7;

  mount(view, html`
    <section class="hero-banner" aria-label="Today at a glance">
      <div class="row between" style="align-items:flex-start;position:relative">
        <div><h1>Hi, ${first}</h1><div class="date">${longDate(s.today)}</div></div>
        <span class="live-pill"><span class="dot" style="background:#7dffb0"></span>${s.businessName || me.tenant.name}</span>
      </div>
      <div class="stat-grid">
        <div class="stat-tile"><div class="k">${tm.many.charAt(0).toUpperCase() + tm.many.slice(1)} today ${ic('calendar-check', 'ico-sm')}</div><div class="v num">${s.todayBookings.length}</div></div>
        <div class="stat-tile"><div class="k">Waiting for reply ${ic('message-square', 'ico-sm')}</div><div class="v num">${a.waitingReplies}</div></div>
        <div class="stat-tile"><div class="k">Deposits this week ${ic('banknote', 'ico-sm')}</div><div class="v num">${money(s.week.depositsMinor, cur)}</div></div>
        <div class="stat-tile"><div class="k">No-shows this week ${ic('circle-check', 'ico-sm')}</div><div class="v num">${s.week.noShows}<small>${s.week.total ? `${Math.round((s.week.noShows / s.week.total) * 100)}%` : ''}</small></div></div>
      </div>
    </section>

    <nav class="row wrap" style="gap:8px;margin-bottom:20px" aria-label="Quick actions">${tm.actions.map((x) => x.newBooking
      ? html`<button class="btn btn-secondary btn-sm" data-new>${ic(x.icon, 'ico-sm')} ${x.t}</button>`
      : html`<a class="btn btn-secondary btn-sm" href="${x.href!}" data-link>${ic(x.icon, 'ico-sm')} ${x.t}</a>`)}</nav>

    ${needsSetup ? html`
    <div class="card card-pad" style="margin-bottom:20px;border-color:var(--primary-border)">
      <div class="row between wrap" style="margin-bottom:12px"><div class="row"><span class="icon-tile" style="background:var(--primary-tint);color:var(--primary)">${ic('rocket')}</span>
        <div><h3>Complete your setup</h3><p class="muted small">${steps.filter((x) => x.done).length} of ${steps.length} done. Customers can only book you once this is finished.</p></div></div>
        <a class="btn btn-primary" href="/app/onboarding" data-link>Continue setup ${ic('arrow-right', 'ico-sm')}</a></div>
      <div class="stack-sm">${steps.map((x) => html`<a class="attn-item" href="${x.href}" data-link style="text-decoration:none;color:inherit"><span class="dot ${x.done ? 'dot-success' : 'dot-warning'}"></span><div class="grow"><div class="t">${x.t}${x.done ? ' (done)' : ''}</div><div class="s">${x.s}</div></div>${x.done ? ic('circle-check', 'ico-sm') : ic('chevron-right', 'ico-sm')}</a>`)}</div>
    </div>` : ''}

    <div class="home-grid">
      <div class="stack-lg">
        <section class="card" aria-labelledby="att">
          <div class="card-head"><h3 id="att" class="row">${ic('circle-alert', 'ico-sm')} Needs attention</h3>${attention ? html`<span class="badge badge-primary">${attention} ${attention === 1 ? 'task' : 'tasks'}</span>` : ''}</div>
          <div class="card-pad">${attention === 0 ? html`<div class="row" style="color:var(--success)">${ic('circle-check')}<span style="font-weight:600">You're all caught up.</span></div>` : html`
            ${a.pending ? html`<div class="attn-item"><span class="dot dot-primary"></span><div class="grow"><div class="t">${a.pending} ${a.pending === 1 ? 'booking needs' : 'bookings need'} confirming</div><div class="s">Waiting for your approval</div></div><a class="btn btn-primary btn-sm" href="/app/bookings" data-link>Review</a></div>` : ''}
            ${a.unpaidCount ? html`<div class="attn-item"><span class="dot dot-warning"></span><div class="grow"><div class="t">${a.unpaidCount} ${a.unpaidCount === 1 ? 'deposit' : 'deposits'} unpaid</div><div class="s">${money(a.unpaidMinor, cur)} pending</div></div><a class="btn btn-secondary btn-sm" href="/app/bookings" data-link>Remind</a></div>` : ''}
            ${a.waitingReplies ? html`<div class="attn-item"><span class="dot dot-success"></span><div class="grow"><div class="t">${a.waitingReplies} ${a.waitingReplies === 1 ? 'customer' : 'customers'} waiting</div><div class="s">Unanswered messages</div></div><a class="btn btn-secondary btn-sm" href="/app/messages" data-link>Open</a></div>` : ''}`}
          </div>
        </section>

        <section class="card" aria-labelledby="sched">
          <div class="card-head"><div><h3 id="sched">${tm.today}</h3><div class="muted small">${s.todayBookings.length} ${s.todayBookings.length === 1 ? tm.one : tm.many}</div></div><a class="small" href="/app/bookings" data-link style="color:var(--primary);font-weight:600">See all</a></div>
          ${s.todayBookings.length === 0 ? html`<div class="empty"><div class="badge-ico">${ic('calendar-days', 'ico-lg')}</div><h3>${tm.emptyTitle}</h3><p>${tm.emptyText}</p><div class="row"><button class="btn btn-primary btn-sm" data-new>${ic('plus', 'ico-sm')} ${tm.newLabel}</button><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy booking link</button></div></div>` : html`<div class="list">${s.todayBookings.map((b) => html`
            <div class="sched-item"><div class="time-box">${timeOf(b.startsAt, off).slice(0, 5)}<small>${timeOf(b.startsAt, off).slice(6)}</small></div>
              <div class="grow"><div class="row between"><b>${b.customerName}</b><span class="mono ${b.depositStatus === 'paid' ? '' : 'muted'}" style="${b.depositStatus === 'paid' ? 'color:var(--success)' : ''}">${b.depositStatus === 'paid' ? `${money(b.depositMinor, cur)} paid` : b.depositMinor ? `${money(b.depositMinor, cur)} due` : ''}</span></div>
              <div class="muted small" style="margin:2px 0 8px">${b.serviceName}${b.staffName ? ` · ${b.staffName}` : ''}</div>
              <div class="row wrap" style="gap:6px">${statusBadge(b.status)} ${depositBadge(b)}</div></div></div>`)}</div>`}
        </section>
      </div>

      <div class="stack-lg">
        <section class="card card-pad" aria-labelledby="wk">
          <div class="row between"><div><h3 id="wk">${tm.many.charAt(0).toUpperCase() + tm.many.slice(1)} this week</h3><div class="muted small">${s.week.total} total</div></div><span class="badge">Mon – Sun</span></div>
          <div class="chart-bars" style="margin-top:18px" role="img" aria-label="${tm.many} per day this week">${s.week.perDay.map((n, i) => html`<div class="col ${i === todayIdx ? 'today' : ''}"><span class="num">${n || ''}</span><div class="bar-v" style="height:${Math.max(4, (n / max) * 88)}px"></div><span>${days[i]}</span></div>`)}</div>
          <hr style="border:0;border-top:1px solid var(--border);margin:20px 0 14px">
          <h4>Popular services <span class="faint" style="font-weight:500">· last 30 days</span></h4>
          ${s.popularServices.length === 0 ? html`<p class="muted small" style="margin-top:8px">Your most booked services will appear here.</p>` : html`<div class="stack-sm" style="margin-top:12px">${s.popularServices.map((p) => html`<div><div class="row between small"><span>${p.name}</span><b class="num">${p.pct}%</b></div><div class="bar" style="margin-top:4px"><i style="width:${p.pct}%"></i></div></div>`)}</div>`}
        </section>
        <section class="link-card">
          <div class="row"><span class="icon-tile" style="background:var(--primary-tint);color:var(--primary)">${ic('link')}</span><div><b>Public booking link</b><div class="muted small">Customers book and pay deposits here.</div></div></div>
          <div class="copy-box"><code>${bookingUrl()}</code><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy</button></div>
        </section>
        <p class="small muted" style="text-align:center">${ic("shield-check", "ico-sm")} Every change to your data is recorded in your <a href="/app/audit" data-link style="text-decoration:underline">audit log</a>.</p>
      </div>
    </div>`);
  view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(bookingUrl())));
  $('[data-new]', view)?.addEventListener('click', () => void openNewBooking(() => void renderHome(view)));

  void (null as unknown as Raw);
}
