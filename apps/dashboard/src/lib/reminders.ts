/**
 * Appointment reminders. While ZexCore is open in a browser tab, an appointment's reminder (30 minutes before by default,
 * changeable per appointment) appears on screen and, if the person allowed it, as a desktop notification.
 * Reminders do not arrive when ZexCore is closed: that would need e-mail or push, which this does not do.
 */
import { html, mount } from './html';
import { ic } from './icons';
import { api } from './api';
import { current } from './session';
import { loadSettings } from './store';
import { addDays, expand, startMs, timeLabel, type Appointment, type Occurrence } from './appointments';
import { ymd } from './format';

const FIRED_KEY = 'zx.reminded';
let started = false;
let cache: Appointment[] = [];
let off = 60;

const read = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as Record<string, number>; } catch { return {}; } };
const write = (v: Record<string, number>): void => { try { localStorage.setItem(FIRED_KEY, JSON.stringify(v)); } catch { /* reminders still show this session */ } };
const keyOf = (o: Occurrence): string => `${current()?.tenant.id}:${o.id}:${o.occurrenceDate}:${o.startMin}:${o.reminderMin}`;

async function refresh(): Promise<void> {
  if (!current()) return;
  try {
    off = (await loadSettings()).utcOffsetMinutes;
    const today = ymd(new Date().toISOString(), off);
    cache = (await api<{ appointments: Appointment[] }>(`/api/appointments?from=${addDays(today, -1)}&to=${addDays(today, 2)}`)).appointments;
  } catch { /* try again on the next refresh */ }
}

/** Reminders now due: starts in the future (or began under 5 minutes ago), reminder time reached, not shown before, not marked done. */
export function dueNow(list: Appointment[], now: number, offsetMin: number, fired: Record<string, number>, tenantId = ''): Occurrence[] {
  const today = ymd(new Date(now).toISOString(), offsetMin);
  const out: Occurrence[] = [];
  for (const occs of expand(list, addDays(today, -1), addDays(today, 2)).values()) {
    for (const o of occs) {
      if (o.reminderMin === null || o.done) continue;
      const start = startMs(o.occurrenceDate, o.startMin, offsetMin);
      if (now >= start - o.reminderMin * 60_000 && now <= start + 5 * 60_000 && !fired[`${tenantId}:${o.id}:${o.occurrenceDate}:${o.startMin}:${o.reminderMin}`]) out.push(o);
    }
  }
  return out;
}

function tick(): void {
  if (!current()) return;
  const fired = read(); const now = Date.now();
  for (const k of Object.keys(fired)) if (now - fired[k]! > 3 * 86_400_000) delete fired[k];
  for (const o of dueNow(cache, now, off, fired, current()!.tenant.id)) { fired[keyOf(o)] = now; show(o, now); }
  write(fired);
}

function show(o: Occurrence, now: number): void {
  const mins = Math.round((startMs(o.occurrenceDate, o.startMin, off) - now) / 60_000);
  const when = mins > 0 ? `in ${mins} minute${mins === 1 ? '' : 's'}` : 'now';
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`${o.title} ${when}`, { body: `${timeLabel(o.startMin)}${o.notes ? ` · ${o.notes}` : ''}`, tag: keyOf(o) }); } catch { /* the on-screen card still shows */ }
  }
  let stack = document.getElementById('zx-reminders');
  if (!stack) { stack = document.createElement('div'); stack.id = 'zx-reminders'; stack.setAttribute('aria-live', 'assertive'); stack.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:1000;display:grid;gap:10px;max-width:min(360px,calc(100vw - 32px))'; document.body.appendChild(stack); }
  const card = document.createElement('div');
  card.className = 'card card-pad';
  card.style.cssText = 'box-shadow:0 8px 28px rgba(0,0,0,.18);border-left:4px solid var(--primary)';
  mount(card, html`<div class="row between" style="align-items:flex-start;gap:10px"><div><div class="small muted">${ic('bell', 'ico-sm')} Reminder, ${when}</div><b>${o.title}</b>
    <div class="small muted">${timeLabel(o.startMin)}${o.notes ? ` · ${o.notes.slice(0, 80)}` : ''}</div></div>
    <button class="btn btn-ghost btn-sm btn-icon" data-x aria-label="Dismiss reminder">${ic('x', 'ico-sm')}</button></div>
    <div class="row" style="gap:8px;margin-top:10px"><a class="btn btn-secondary btn-sm" href="/app/calendar?date=${o.occurrenceDate}" data-link>Open</a><button class="btn btn-ghost btn-sm" data-snooze>Remind me in 10 min</button></div>`);
  card.querySelector('[data-x]')!.addEventListener('click', () => card.remove());
  card.querySelector('[data-snooze]')!.addEventListener('click', () => { card.remove(); setTimeout(() => show(o, Date.now()), 10 * 60_000); });
  card.querySelector('a')!.addEventListener('click', () => card.remove());
  stack.appendChild(card);
}

export function startReminders(): void {
  if (started) return;
  started = true;
  void refresh().then(tick);
  setInterval(tick, 20_000);
  setInterval(() => void refresh(), 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh().then(tick); });
}
/** Called after the calendar page changes an appointment so the next tick sees it. */
export const reloadReminders = (): Promise<void> => refresh();
