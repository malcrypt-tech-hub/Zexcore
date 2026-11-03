/**
 * No-show risk (Enterprise and Dedicated).
 *   POST /api/risk/assess { workspaceId, bookingId }   a team member asks for a booking's score (also stored on the booking)
 * assessBooking() is shared with the booking-page flow so a score exists before any deposit decision is made.
 */
import { DOERS, requireMember } from '../auth';
import type { Ctx } from '../env';
import { fsCommit, fsGet, fsQuery } from '../fs';
import { scoreRisk, type Past, type Risk } from '../risk';
import { HttpError, json, readJson } from '../util';
import { RANK, activePlan } from './billing';

const BOOKING_RE = /^\d{6}_\d{1,6}$/;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

export const riskPlanOk = (ws: Record<string, unknown> | undefined, now: Date): boolean => (RANK[activePlan(ws, now).tier] ?? 0) >= (RANK.enterprise ?? 4);

/** Scores a booking from the same customer's earlier bookings. Returns null when the workspace's plan does not include it. */
export async function assessBooking(c: Ctx, wid: string, bookingId: string): Promise<Risk | null> {
  const [ws, booking] = await Promise.all([fsGet(c.env, c.d, `workspaces/${wid}`), fsGet(c.env, c.d, `workspaces/${wid}/bookings/${bookingId}`)]);
  if (!ws || !booking || !riskPlanOk(ws.data, c.d.now())) return null;
  const d = booking.data;
  if (typeof d.riskScore === 'number' && Array.isArray(d.riskReasons)) return { score: d.riskScore, level: d.riskLevel as Risk['level'], reasons: d.riskReasons as string[] };
  const phone = String(d.customerPhone ?? '');
  const rows = phone ? await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'bookings', where: [{ field: 'customerPhone', op: 'EQUAL', value: phone }], limit: 80 }) : [];
  const history: Past[] = rows.map((r) => ({ id: r.id, status: String(r.data.status ?? ''), startsAt: ms(r.data.startsAt), depositStatus: r.data.depositStatus as string | undefined }));
  const risk = scoreRisk(history, { id: bookingId, startsAt: ms(d.startsAt), createdAt: ms(d.createdAt) || c.d.now().getTime(), hasEmail: !!String(d.customerEmail ?? '').trim() });
  await fsCommit(c.env, c.d, [{ path: booking.path, fields: { riskScore: risk.score, riskLevel: risk.level, riskReasons: risk.reasons, riskAt: c.d.now() }, mask: ['riskScore', 'riskLevel', 'riskReasons', 'riskAt'], precondition: { exists: true } }]);
  return risk;
}

export async function assess(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid } = await requireMember(c, b.workspaceId, DOERS);
  const id = String(b.bookingId ?? '');
  if (!BOOKING_RE.test(id)) throw new HttpError(400, 'Invalid booking');
  const risk = await assessBooking(c, wid, id);
  if (!risk) throw new HttpError(402, 'No-show risk scoring is part of the Enterprise and Dedicated plans.', 'plan_feature');
  return json({ ok: true, ...risk }, 200, c.headers);
}
