/** Appointments (the owner's own calendar entries): types, repeat rules and validation. No Firebase here, so it is unit tested. */

export type Priority = 'low' | 'normal' | 'high';
export type Freq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export const MAX_PER_DAY = 15;
export const REMINDER_CHOICES: { min: number | null; label: string }[] = [
  { min: null, label: 'No reminder' }, { min: 5, label: '5 minutes before' }, { min: 10, label: '10 minutes before' }, { min: 15, label: '15 minutes before' },
  { min: 30, label: '30 minutes before' }, { min: 60, label: '1 hour before' }, { min: 120, label: '2 hours before' }, { min: 1440, label: '1 day before' },
];
export const DEFAULT_REMINDER_MIN = 30;

export interface Recur { freq: Freq; interval: number; until: string | null }
export interface Appointment {
  id: string; title: string; date: string; startMin: number; durationMin: number; notes: string | null;
  priority: Priority; pinned: boolean; reminderMin: number | null; recur: Recur; done: boolean;
}
export interface Occurrence extends Appointment { occurrenceDate: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const dayNum = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const parts = (d: string): [number, number, number] => [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
export const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** Does this appointment (or one of its repeats) fall on `date`? Months without the day (31st, 29 Feb) use their last day. */
export function occursOn(a: Pick<Appointment, 'date' | 'recur'>, date: string): boolean {
  if (date < a.date) return false;
  if (date === a.date) return true;
  const r = a.recur;
  if (r.freq === 'none') return false;
  if (r.until && date > r.until) return false;
  const n = Math.max(1, r.interval || 1);
  const diff = dayNum(date) - dayNum(a.date);
  if (r.freq === 'daily') return diff % n === 0;
  if (r.freq === 'weekly') return diff % (7 * n) === 0;
  const [y0, m0, d0] = parts(a.date), [y, m, d] = parts(date);
  const months = (y - y0) * 12 + (m - m0);
  if (r.freq === 'monthly') return months % n === 0 && d === Math.min(d0, lastDay(y, m));
  return months % (12 * n) === 0 && m === m0 && d === Math.min(d0, lastDay(y, m));   // yearly
}

export const dateRange = (from: string, to: string): string[] => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

/** Every appointment and repeat that lands on each day in [from, to], sorted by time, pinned and high priority first on ties. */
export function expand(list: Appointment[], from: string, to: string): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const rank: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
  for (const day of dateRange(from, to)) {
    const here = list.filter((a) => occursOn(a, day)).map((a) => ({ ...a, occurrenceDate: day }));
    if (here.length) out.set(day, here.sort((a, b) => a.startMin - b.startMin || rank[a.priority] - rank[b.priority] || Number(b.pinned) - Number(a.pinned)));
  }
  return out;
}

/** The most important priority on a day, for colouring the date. */
export const dayPriority = (occ: Occurrence[] | undefined): Priority | null => (!occ?.length ? null : occ.some((o) => o.priority === 'high') ? 'high' : occ.some((o) => o.priority === 'normal') ? 'normal' : 'low');

/** Days (from `dates`) that already hold 15 appointments, counting repeats. Used before saving. */
export function fullDays(existing: Appointment[], dates: string[]): string[] {
  return dates.filter((d) => existing.filter((a) => occursOn(a, d)).length >= MAX_PER_DAY);
}

/** Every date the new appointment would land on within `horizonDays` of its start (the start day itself if it does not repeat). */
export function landingDates(a: Pick<Appointment, 'date' | 'recur'>, horizonDays = 1100): string[] {
  if (a.recur.freq === 'none') return [a.date];
  const end = a.recur.until && a.recur.until < addDays(a.date, horizonDays) ? a.recur.until : addDays(a.date, horizonDays);
  return dateRange(a.date, end).filter((d) => occursOn(a, d));
}

export interface Draft { title?: unknown; date?: unknown; startMin?: unknown; durationMin?: unknown; notes?: unknown; priority?: unknown; pinned?: unknown; reminderMin?: unknown; recur?: unknown; done?: unknown }
export class Invalid extends Error {}

/** Checks what the form sent and returns exactly what is stored. Throws Invalid with a sentence the owner can act on. */
export function clean(d: Draft): Omit<Appointment, 'id'> {
  const title = String(d.title ?? '').trim();
  if (title.length < 1 || title.length > 120) throw new Invalid('Give the appointment a title (up to 120 characters).');
  if (!isDate(d.date)) throw new Invalid('Choose a valid date.');
  if (d.date < '1990-01-01' || d.date > '2100-12-31') throw new Invalid('Choose a date between 1990 and 2100.');
  const startMin = Number(d.startMin ?? 540);
  if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1439) throw new Invalid('Choose a valid time.');
  const durationMin = Number(d.durationMin ?? 30);
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 1440) throw new Invalid('Duration must be between 5 minutes and 24 hours.');
  const notes = String(d.notes ?? '').trim();
  if (notes.length > 1000) throw new Invalid('Keep notes under 1,000 characters.');
  const priority = (['low', 'normal', 'high'] as const).find((p) => p === d.priority) ?? 'normal';
  const rm = d.reminderMin === null || d.reminderMin === undefined || d.reminderMin === '' ? null : Number(d.reminderMin);
  if (rm !== null && (!Number.isInteger(rm) || rm < 0 || rm > 10_080)) throw new Invalid('Choose a valid reminder time.');
  const rr = (d.recur ?? {}) as Partial<Recur>;
  const freq = (['none', 'daily', 'weekly', 'monthly', 'yearly'] as const).find((f) => f === rr.freq) ?? 'none';
  const interval = Number(rr.interval ?? 1);
  if (freq !== 'none' && (!Number.isInteger(interval) || interval < 1 || interval > 52)) throw new Invalid('Repeat interval must be between 1 and 52.');
  const until = freq === 'none' || !rr.until ? null : String(rr.until);
  if (until !== null && (!isDate(until) || until < d.date)) throw new Invalid('The repeat end date must be on or after the first date.');
  return { title, date: d.date, startMin, durationMin, notes: notes || null, priority, pinned: d.pinned === true, reminderMin: rm, recur: { freq, interval: freq === 'none' ? 1 : interval, until }, done: d.done === true };
}

export const timeLabel = (min: number): string => { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/** The instant an occurrence starts, as epoch ms, given the business's UTC offset in minutes. */
export const startMs = (date: string, startMin: number, offsetMin: number): number => { const [y, m, d] = parts(date); return Date.UTC(y, m - 1, d, 0, startMin) - offsetMin * 60_000; };

export const REPEAT_TEXT = (r: Recur): string => {
  if (r.freq === 'none') return 'Does not repeat';
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  return `Repeats every ${r.interval > 1 ? `${r.interval} ${unit}s` : unit}${r.until ? ` until ${r.until}` : ''}`;
};
