/**
 * Business insights: plain counting over a workspace's own bookings. No estimates, no benchmarks, nothing invented.
 * Revenue is the list price of COMPLETED bookings (what the service currently costs), and deposits are what customers paid;
 * both are in US dollars minor units like every price in the app. Local time is a fixed UTC offset (60 for Lagos).
 */
export interface B { id: string; status: string; serviceId: string; phone: string; startsAt: number; depositPaidMinor: number; recovered: boolean }
export interface Svc { id: string; name: string; priceMinor: number }
export interface Period {
  bookings: number; completed: number; cancelled: number; noShows: number; pending: number; upcoming: number;
  noShowRate: number | null; cancelRate: number | null;
  revenueMinor: number; depositsMinor: number; repeatCustomers: number; customers: number; recoveredBookings: number; recoveredMinor: number;
  byWeekday: number[]; byHour: number[];
  topServices: { id: string; name: string; bookings: number; revenueMinor: number }[];
}
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (i: number): string => WEEKDAY[i] ?? '';
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);   // one decimal, or null when there is nothing to divide

export function summarize(rows: B[], svcs: Svc[], from: number, to: number, nowMs: number, offsetMin = 60): Period {
  const by = new Map(svcs.map((s) => [s.id, s]));
  const p: Period = { bookings: 0, completed: 0, cancelled: 0, noShows: 0, pending: 0, upcoming: 0, noShowRate: null, cancelRate: null, revenueMinor: 0, depositsMinor: 0,
    repeatCustomers: 0, customers: 0, recoveredBookings: 0, recoveredMinor: 0, byWeekday: Array(7).fill(0), byHour: Array(24).fill(0), topServices: [] };
  const perPhone = new Map<string, number>(); const perSvc = new Map<string, { bookings: number; revenueMinor: number }>();
  for (const b of rows) {
    if (b.startsAt < from || b.startsAt >= to) continue;
    p.bookings++;
    if (b.status === 'cancelled') { p.cancelled++; continue; }
    const price = by.get(b.serviceId)?.priceMinor ?? 0;
    if (b.status === 'completed') { p.completed++; p.revenueMinor += price; }
    else if (b.status === 'no_show') p.noShows++;
    else if (b.status === 'pending' || b.status === 'confirmed') { if (b.status === 'pending') p.pending++; if (b.startsAt >= nowMs) p.upcoming++; }
    p.depositsMinor += b.depositPaidMinor;
    if (b.recovered) { p.recoveredBookings++; p.recoveredMinor += price; }
    const local = new Date(b.startsAt + offsetMin * 60_000);
    p.byWeekday[local.getUTCDay()]!++; p.byHour[local.getUTCHours()]!++;
    if (b.phone) perPhone.set(b.phone, (perPhone.get(b.phone) ?? 0) + 1);
    const s = perSvc.get(b.serviceId) ?? { bookings: 0, revenueMinor: 0 }; s.bookings++; if (b.status === 'completed') s.revenueMinor += price; perSvc.set(b.serviceId, s);
  }
  p.noShowRate = rate(p.noShows, p.completed + p.noShows);
  p.cancelRate = rate(p.cancelled, p.bookings);
  p.customers = perPhone.size; p.repeatCustomers = [...perPhone.values()].filter((n) => n > 1).length;
  p.topServices = [...perSvc.entries()].map(([id, v]) => ({ id, name: by.get(id)?.name ?? 'Removed service', ...v })).sort((a, b) => b.bookings - a.bookings || b.revenueMinor - a.revenueMinor).slice(0, 5);
  return p;
}
/** Index of the largest value, or -1 when everything is zero (so we never name a "busiest day" that does not exist). */
export const peak = (xs: number[]): number => { const m = Math.max(...xs); return m > 0 ? xs.indexOf(m) : -1; };
