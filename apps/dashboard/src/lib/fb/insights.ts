/** Business insights (Enterprise and Dedicated). The Worker does the counting so the page and the weekly email always agree. */
import { loadCtx, requireFeature } from './core';
import { worker } from './worker';

export interface Period {
  bookings: number; completed: number; cancelled: number; noShows: number; pending: number; upcoming: number; noShowRate: number | null; cancelRate: number | null;
  revenueMinor: number; depositsMinor: number; repeatCustomers: number; customers: number; recoveredBookings: number; recoveredMinor: number;
  byWeekday: number[]; byHour: number[]; topServices: { id: string; name: string; bookings: number; revenueMinor: number }[];
}
export interface InsightsView { days: number; current: Period; previous: Period; truncated: boolean; busiestDay: string | null; busiestHour: number | null; note: string }

export async function get(days: number): Promise<InsightsView> {
  const c = await loadCtx(); requireFeature(c, 'insights');
  return worker<InsightsView>('/api/insights', { body: { workspaceId: c.wid, days } });
}
