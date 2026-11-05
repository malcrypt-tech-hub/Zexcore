import { html, mount, $, $$, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { ymd, MON_LONG, longDate } from '../lib/format';
import { emptyState, errorState, toast, openModal, busy } from '../lib/ui';
import { loadSettings, type Booking } from '../lib/store';
import { bookingCard, wireBookingCards, openNewBooking } from './bookings';
import { canManage } from '../lib/session';
import { DEFAULT_REMINDER_MIN, MAX_PER_DAY, REMINDER_CHOICES, REPEAT_TEXT, dayPriority, expand, timeLabel, type Appointment, type Occurrence } from '../lib/appointments';
import { minutesToTime, timeToMinutes } from '../lib/format';
import { reloadReminders } from '../lib/reminders';

const pad = (n: number): string => String(n).padStart(2, '0');
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];
const durLabel = (m: number): string => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`);

export async function renderCalendar(view: HTMLElement, startDate?: string | null): Promise<void> {
  const s = await loadSettings();
  const off = s.utcOffsetMinutes;
  const todayStr = ymd(new Date().toISOString(), off);
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : todayStr;
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)) - 1;
  let selected = start;
  const canEdit = canManage();

  mount(view, html`
    <div class="page-head"><div><h1>Calendar</h1><p>Click a date to add appointments. Browse any month, past or future.</p></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">${canEdit ? html`<button class="btn btn-secondary" data-new>${ic('plus', 'ico-sm')} New booking</button>` : ''}${canEdit ? html`<button class="btn btn-primary" data-add-appt>${ic('plus', 'ico-sm')} Add appointment</button>` : ''}</div></div>
    <div id="notif"></div><div id="pinned"></div>
    <div class="card card-pad"><div class="row between cal-bar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm btn-icon" data-prev aria-label="Previous month">${ic('chevron-left', 'ico-sm')}</button>
      <div class="cal-jump"><select class="input" id="cal-m" aria-label="Month">${MON_LONG.map((n, i) => html`<option value="${i}">${n}</option>`)}</select>
        <input class="input" id="cal-y" type="number" min="1990" max="2100" style="width:92px" aria-label="Year">
        <button class="btn btn-secondary btn-sm" data-today>Today</button></div>
      <button class="btn btn-secondary btn-sm btn-icon" data-next aria-label="Next month">${ic('chevron-right', 'ico-sm')}</button></div>
      <div id="cal"></div>
      <div class="row small muted" style="gap:14px;margin-top:12px;flex-wrap:wrap"><span class="row" style="gap:5px"><span class="cal-dots"><i class="high"></i></span> High</span><span class="row" style="gap:5px"><span class="cal-dots"><i class="normal"></i></span> Normal</span><span class="row" style="gap:5px"><span class="cal-dots"><i class="low"></i></span> Low</span><span class="row" style="gap:5px"><span class="cal-pin">&#9733;</span> Pinned</span></div></div>
    <div class="row between" style="margin:24px 0 12px;gap:8px;flex-wrap:wrap"><h3 id="day-title"></h3></div>
    <div id="day" class="stack"></div>`);
  $('[data-new]', view)?.addEventListener('click', () => void openNewBooking(() => void load()));
  $('[data-add-appt]', view)?.addEventListener('click', () => form(null));

  let bookingCounts: Record<string, number> = {};
  let monthBookings: Booking[] = [];
  let appts: Appointment[] = [];
  let occ = new Map<string, Occurrence[]>();

  const firstDate = (): string => `${y}-${pad(m + 1)}-01`;
  const lastDate = (): string => `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;

  async function load(): Promise<void> {
    const first = Date.UTC(y, m, 1) - off * 60_000, last = Date.UTC(y, m + 1, 1) - off * 60_000;
    try {
      const [b, a] = await Promise.all([
        api<{ bookings: Booking[] }>(`/api/bookings?limit=200&status=pending,confirmed,completed,no_show&from=${new Date(first).toISOString()}&to=${new Date(last).toISOString()}`),
        api<{ appointments: Appointment[] }>(`/api/appointments?from=${firstDate()}&to=${lastDate()}`),
      ]);
      monthBookings = b.bookings; appts = a.appointments;
      bookingCounts = {};
      for (const x of monthBookings) { const d = ymd(x.startsAt, off); bookingCounts[d] = (bookingCounts[d] ?? 0) + 1; }
      occ = expand(appts, firstDate(), lastDate());
      drawMonth(); drawDay(); void drawPinned(); drawNotifPrompt();
    } catch (e) { mount($('#cal', view)!, errorState(e instanceof ApiError ? e.message : 'Could not load calendar')); $('[data-retry]', view)?.addEventListener('click', () => void load()); }
  }

  function drawNotifPrompt(): void {
    const host = $('#notif', view)!;
    if (!('Notification' in window) || Notification.permission !== 'default') { mount(host, ''); return; }
    mount(host, html`<div class="alert alert-info" style="margin-bottom:16px">${ic('bell', 'ico-sm')} <span class="grow">Reminders appear here while ZexCore is open. Turn on desktop notifications to also see them over other windows.</span><button class="btn btn-secondary btn-sm" data-notif>Turn on</button></div>`);
    $('[data-notif]', host)!.addEventListener('click', () => void Notification.requestPermission().then(drawNotifPrompt));
  }

  async function drawPinned(): Promise<void> {
    const host = $('#pinned', view)!;
    try {
      const { appointments } = await api<{ appointments: Appointment[] }>('/api/appointments/pinned');
      if (!appointments.length) { mount(host, ''); return; }
      mount(host, html`<div class="card card-pad" style="margin-bottom:16px"><div class="row" style="gap:6px;margin-bottom:8px"><span class="cal-pin">&#9733;</span><b>Pinned</b></div>
        <div class="stack-sm">${appointments.map((a) => html`<button class="list-item hover" style="width:100%;text-align:left" data-jump="${a.date}"><span class="grow"><b>${a.title}</b><span class="muted small" style="display:block">${longDate(a.date)} · ${timeLabel(a.startMin)}${a.recur.freq !== 'none' ? ' · repeats' : ''}</span></span>${ic('chevron-right', 'ico-sm')}</button>`)}</div></div>`);
      $$('[data-jump]', host).forEach((b) => b.addEventListener('click', () => go(b.dataset.jump!)));
    } catch { mount(host, ''); }
  }

  function go(date: string): void { selected = date; y = Number(date.slice(0, 4)); m = Number(date.slice(5, 7)) - 1; void load(); }

  function drawMonth(): void {
    ($('#cal-m', view) as HTMLSelectElement).value = String(m);
    ($('#cal-y', view) as HTMLInputElement).value = String(y);
    const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells: string[] = [];
    for (let i = 0; i < firstDow; i++) cells.push('');
    for (let d = 1; d <= days; d++) cells.push(`${y}-${pad(m + 1)}-${pad(d)}`);
    mount($('#cal', view)!, html`<div class="cal-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="cal-head">${d}</div>`)}
      ${cells.map((c) => {
        if (!c) return html`<div class="cal-cell off"></div>`;
        const o = occ.get(c), p = dayPriority(o), nb = bookingCounts[c] ?? 0, pinned = o?.some((x) => x.pinned);
        return html`<button class="cal-cell ${c === todayStr ? 'today' : ''}" data-d="${c}" aria-pressed="${c === selected}" aria-label="${longDate(c)}, ${nb} bookings, ${o?.length ?? 0} appointments"><span class="row between" style="gap:2px"><b>${Number(c.slice(8))}</b>${pinned ? html`<span class="cal-pin" aria-hidden="true">&#9733;</span>` : ''}</span>
          ${p ? html`<span class="cal-dots" aria-hidden="true"><i class="${p}"></i>${o!.length > 1 ? html`<span class="cal-count">${o!.length}</span>` : ''}</span>` : ''}
          ${nb ? html`<span class="cal-count">${nb}<span class="cal-count-word"> ${nb === 1 ? 'booking' : 'bookings'}</span></span>` : ''}</button>`;
      })}</div>`);
    $$('[data-d]', view).forEach((b) => b.addEventListener('click', () => { selected = b.dataset.d!; drawMonth(); drawDay(); }));
  }

  function apptRow(a: Occurrence): Raw {
    const end = a.startMin + a.durationMin;
    return html`<div class="appt ${a.priority} ${a.done ? 'done' : ''}"><div class="appt-time">${timeLabel(a.startMin)}<div class="muted small" style="font-weight:500">${end <= 1439 ? `to ${timeLabel(end)}` : durLabel(a.durationMin)}</div></div>
      <div class="grow"><div class="appt-title"><b>${a.title}</b> ${a.pinned ? html`<span class="cal-pin" title="Pinned">&#9733;</span>` : ''}</div>
        <div class="row small muted" style="gap:8px;flex-wrap:wrap"><span>${a.priority === 'high' ? 'High priority' : a.priority === 'low' ? 'Low priority' : 'Normal priority'}</span>${a.recur.freq !== 'none' ? html`<span>${ic('rotate-cw', 'ico-xs')} ${REPEAT_TEXT(a.recur)}</span>` : ''}${a.reminderMin === null ? '' : html`<span>${ic('bell', 'ico-xs')} ${a.reminderMin === 0 ? 'At start' : REMINDER_CHOICES.find((r) => r.min === a.reminderMin)?.label ?? `${a.reminderMin} min before`}</span>`}</div>
        ${a.notes ? html`<p class="small" style="margin-top:6px;white-space:pre-wrap">${a.notes}</p>` : ''}</div>
      ${canEdit ? html`<div class="appt-actions"><button class="btn btn-ghost btn-sm btn-icon" data-pin="${a.id}" aria-label="${a.pinned ? 'Unpin' : 'Pin'}" title="${a.pinned ? 'Unpin' : 'Pin'}">${a.pinned ? html`<span class="cal-pin">&#9733;</span>` : ic('target', 'ico-sm')}</button>
        ${a.recur.freq === 'none' ? html`<button class="btn btn-ghost btn-sm btn-icon" data-done="${a.id}" aria-label="${a.done ? 'Mark not done' : 'Mark done'}" title="${a.done ? 'Mark not done' : 'Mark done'}">${ic('circle-check', 'ico-sm')}</button>` : ''}
        <button class="btn btn-ghost btn-sm btn-icon" data-edit="${a.id}" aria-label="Edit">${ic('pencil', 'ico-sm')}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-del="${a.id}" aria-label="Delete">${ic('trash-2', 'ico-sm')}</button></div>` : ''}</div>`;
  }

  function drawDay(): void {
    $('#day-title', view)!.textContent = longDate(selected);
    const host = $('#day', view)!;
    const list = occ.get(selected) ?? [];
    const books = monthBookings.filter((b) => ymd(b.startsAt, off) === selected).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const head = html`<div class="row between" style="gap:8px;flex-wrap:wrap"><b>Appointments <span class="muted small">${list.length} of ${MAX_PER_DAY}</span></b>${canEdit ? html`<button class="btn btn-secondary btn-sm" data-add-day>${ic('plus', 'ico-sm')} Add on this day</button>` : ''}</div>`;
    mount(host, html`${head}
      ${list.length ? html`<div class="stack-sm">${list.map(apptRow)}</div>` : html`<div class="card">${emptyState({ icon: 'calendar-days', title: 'No appointments', text: canEdit ? 'Press Add on this day to plan something.' : 'Nothing planned for this day.' })}</div>`}
      <b style="margin-top:12px">Customer bookings <span class="muted small">${books.length}</span></b>
      ${books.length ? html`<div class="stack" id="bk" style="gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))">${books.map(bookingCard)}</div>` : html`<div class="card">${emptyState({ icon: 'calendar-check', title: 'No bookings this day', text: 'Share your booking link to fill the day.' })}</div>`}`);
    if (books.length) wireBookingCards($('#bk', host)!, books, () => void load());
    $('[data-add-day]', host)?.addEventListener('click', () => form(null));
    const find = (id: string) => appts.find((a) => a.id === id)!;
    $$('[data-edit]', host).forEach((b) => b.addEventListener('click', () => form(find(b.dataset.edit!))));
    $$('[data-pin]', host).forEach((b) => b.addEventListener('click', () => void flag(b.dataset.pin!, { pinned: !find(b.dataset.pin!).pinned })));
    $$('[data-done]', host).forEach((b) => b.addEventListener('click', () => void flag(b.dataset.done!, { done: !find(b.dataset.done!).done })));
    $$('[data-del]', host).forEach((b) => b.addEventListener('click', () => void remove(find(b.dataset.del!))));
  }

  async function flag(id: string, f: { pinned?: boolean; done?: boolean }): Promise<void> {
    try { await api(`/api/appointments/${id}/flag`, { method: 'POST', body: f }); await load(); void reloadReminders(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update', 'error'); }
  }
  async function remove(a: Appointment): Promise<void> {
    if (!window.confirm(a.recur.freq === 'none' ? `Delete "${a.title}"?` : `Delete "${a.title}" and every repeat of it?`)) return;
    try { await api(`/api/appointments/${a.id}`, { method: 'DELETE' }); toast('Deleted', 'success'); await load(); void reloadReminders(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete', 'error'); }
  }

  function form(a: Appointment | null): void {
    const v = a ?? { title: '', date: selected, startMin: 540, durationMin: 30, notes: '', priority: 'normal', pinned: false, reminderMin: DEFAULT_REMINDER_MIN, recur: { freq: 'none', interval: 1, until: null } } as unknown as Appointment;
    openModal({
      title: a ? 'Edit appointment' : 'Add appointment', subtitle: a && a.recur.freq !== 'none' ? 'Changes apply to every repeat.' : undefined,
      body: html`<form id="af" class="form-grid" novalidate><div id="ae" class="alert alert-error hidden" role="alert"></div>
        <div class="field"><label for="at">Title</label><input class="input" id="at" maxlength="120" required value="${v.title}" placeholder="e.g. Meet supplier"></div>
        <div class="form-grid two"><div class="field"><label for="ad">Date</label><input class="input" id="ad" type="date" min="1990-01-01" max="2100-12-31" required value="${v.date}"></div>
          <div class="field"><label for="as">Time</label><input class="input" id="as" type="time" required value="${minutesToTime(v.startMin)}"></div></div>
        <div class="form-grid two"><div class="field"><label for="al">Length</label><select class="input" id="al">${[...new Set([...DURATIONS, v.durationMin])].sort((x, y2) => x - y2).map((d) => html`<option value="${d}" ${d === v.durationMin ? 'selected' : ''}>${durLabel(d)}</option>`)}</select></div>
          <div class="field"><label for="ap">Priority</label><select class="input" id="ap">${(['high', 'normal', 'low'] as const).map((p) => html`<option value="${p}" ${p === v.priority ? 'selected' : ''}>${p[0]!.toUpperCase() + p.slice(1)}</option>`)}</select></div></div>
        <div class="field"><label for="ar">Reminder</label><select class="input" id="ar">${REMINDER_CHOICES.map((r) => html`<option value="${r.min ?? ''}" ${r.min === v.reminderMin ? 'selected' : ''}>${r.label}</option>`)}</select><span class="hint">Shown on screen while ZexCore is open. You can change it any time.</span></div>
        <div class="field"><label for="ay">Repeat</label><div class="row" style="gap:8px;flex-wrap:wrap"><select class="input" id="ay" style="flex:1;min-width:130px">${(['none', 'daily', 'weekly', 'monthly', 'yearly'] as const).map((f) => html`<option value="${f}" ${f === v.recur.freq ? 'selected' : ''}>${f === 'none' ? 'Does not repeat' : f[0]!.toUpperCase() + f.slice(1)}</option>`)}</select>
          <span class="row ${v.recur.freq === 'none' ? 'hidden' : ''}" id="arx" style="gap:6px;align-items:center">every <input class="input" id="ai" type="number" min="1" max="52" style="width:68px" value="${v.recur.interval}"> until <input class="input" id="au" type="date" value="${v.recur.until ?? ''}" aria-label="Repeat until (optional)"></span></div></div>
        <div class="field"><label for="an">Notes <span class="faint">(optional)</span></label><textarea class="input" id="an" rows="3" maxlength="1000" placeholder="Anything to remember">${v.notes ?? ''}</textarea></div>
        <label class="row" style="gap:8px"><input type="checkbox" id="ak" ${v.pinned ? 'checked' : ''}> Pin this to the top of the calendar</label></form>`,
      footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-save>${a ? 'Save changes' : 'Add appointment'}</button>`,
      onMount: (el, close) => {
        const val = (id: string): string => ($(`#${id}`, el) as HTMLInputElement).value;
        $('#ay', el)!.addEventListener('change', () => $('#arx', el)!.classList.toggle('hidden', val('ay') === 'none'));
        $('[data-save]', el)!.addEventListener('click', () => void busy($('[data-save]', el) as HTMLButtonElement, async () => {
          const err = $('#ae', el)!; err.classList.add('hidden');
          const body = { title: val('at'), date: val('ad'), startMin: timeToMinutes(val('as') || '09:00'), durationMin: Number(val('al')), priority: val('ap'), reminderMin: val('ar') === '' ? null : Number(val('ar')),
            notes: val('an'), pinned: ($('#ak', el) as HTMLInputElement).checked, recur: { freq: val('ay'), interval: Number(val('ai')) || 1, until: val('au') || null } };
          try {
            await (a ? api(`/api/appointments/${a.id}`, { method: 'PATCH', body }) : api('/api/appointments', { method: 'POST', body }));
            toast(a ? 'Saved' : 'Appointment added', 'success'); close();
            if (body.date.slice(0, 7) !== `${y}-${pad(m + 1)}`) go(body.date); else { selected = body.date; await load(); }
            void reloadReminders();
          } catch (x) { err.textContent = x instanceof ApiError ? x.message : 'Could not save'; err.classList.remove('hidden'); }
        }));
      },
    });
  }

  $('[data-prev]', view)!.addEventListener('click', () => { m--; if (m < 0) { m = 11; y--; } void load(); });
  $('[data-next]', view)!.addEventListener('click', () => { m++; if (m > 11) { m = 0; y++; } void load(); });
  $('[data-today]', view)!.addEventListener('click', () => go(todayStr));
  $('#cal-m', view)!.addEventListener('change', (e) => { m = Number((e.target as HTMLSelectElement).value); void load(); });
  $('#cal-y', view)!.addEventListener('change', (e) => { const n = Number((e.target as HTMLInputElement).value); if (n >= 1990 && n <= 2100) { y = n; void load(); } });
  await load();
}
