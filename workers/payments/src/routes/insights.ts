/**
 * Business insights (Enterprise and Dedicated).
 *   POST /api/insights { workspaceId, days }   owners, admins and viewers (money is visible to them): this period and the one before it
 *   scheduledDigests()                          Monday morning (Lagos) email to the owner with last week's numbers; once per week, can be switched off
 * Both read the same bookings through summarize(), so the page and the email can never disagree.
 */
import type { Ctx, Deps, Env } from '../env';
import { requireMember, type Role } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { sendFormal } from '../mail';
import { peak, summarize, weekdayName, type B, type Period, type Svc } from '../insights';
import { HttpError, json, readJson } from '../util';
import { RANK, activePlan } from './billing';
import { riskPlanOk } from './risk';

const PAGE = 300;
const MAX_PAGES = 7;      // 2,100 bookings across both periods; beyond that the page says so instead of quietly under-counting
const DAY = 86_400_000;
const OFFSET_MIN = 60;
const READERS: Role[] = ['owner', 'admin', 'viewer'];
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

async function load(c: { env: Env; d: Deps }, wid: string, from: number, to: number): Promise<{ rows: B[]; svcs: Svc[]; truncated: boolean }> {
  const rows: B[] = []; let after: string | undefined; let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) { truncated = true; break; }
    const docs = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'bookings', where: [{ field: 'startsAt', op: 'GREATER_THAN_OR_EQUAL', value: new Date(from) }, { field: 'startsAt', op: 'LESS_THAN', value: new Date(to) }],
      orderBy: [{ field: 'startsAt' }], limit: PAGE, ...(after ? { startAfterId: after } : {}) });
    for (const d of docs) rows.push({ id: d.id, status: String(d.data.status ?? ''), serviceId: String(d.data.serviceId ?? ''), phone: String(d.data.customerPhone ?? ''), startsAt: ms(d.data.startsAt),
      depositPaidMinor: d.data.depositStatus === 'paid' ? Number(d.data.depositMinor) || 0 : 0, recovered: d.data.recoveredFromWaitlist === true });
    if (docs.length < PAGE) break;
    after = docs[docs.length - 1]!.id;
  }
  const svcs = (await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'services', limit: 500 })).map((s) => ({ id: s.id, name: String(s.data.name ?? ''), priceMinor: Number(s.data.priceMinor) || 0 }));
  return { rows, svcs, truncated };
}

export async function insights(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid } = await requireMember(c, b.workspaceId, READERS);
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!riskPlanOk(ws?.data, c.d.now())) throw new HttpError(402, 'Business insights are part of the Enterprise and Dedicated plans.', 'plan_feature');
  const days = [7, 30, 90].includes(Number(b.days)) ? Number(b.days) : 30;
  const now = c.d.now().getTime();
  const to = now + 14 * DAY;                 // includes what is booked ahead, so "upcoming" is real
  const thisFrom = now - days * DAY, prevFrom = now - 2 * days * DAY;
  const { rows, svcs, truncated } = await load(c, wid, prevFrom, to);
  const current = summarize(rows, svcs, thisFrom, to, now, OFFSET_MIN);
  const previous = summarize(rows, svcs, prevFrom, thisFrom, now, OFFSET_MIN);
  return json({ days, current, previous, truncated, busiestDay: peak(current.byWeekday) < 0 ? null : weekdayName(peak(current.byWeekday)), busiestHour: peak(current.byHour) < 0 ? null : peak(current.byHour),
    note: 'Revenue is the current list price of completed bookings. Customers are counted by phone number.' }, 200, c.headers);
}

// ── weekly digest ──
const money = (minor: number): string => `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (v: number | null): string => (v === null ? 'not enough data' : `${v}%`);
const change = (cur: number, prev: number): string => (prev === 0 ? (cur === 0 ? 'no change' : 'none the week before') : `${cur >= prev ? 'up' : 'down'} ${Math.round(Math.abs(cur - prev) / prev * 100)}% on the week before`);
const hour12 = (h: number): string => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
/** Year and ISO-ish week number of a Lagos-local instant, used only to make "once per week" markers. */
export function weekKey(nowMs: number): string {
  const d = new Date(nowMs + OFFSET_MIN * 60_000); const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7;                       // Monday = 0
  const thursday = t - dow * DAY + 3 * DAY; const y = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(y, 0, 1)) / (7 * DAY)) + 1;
  return `${y}w${String(week).padStart(2, '0')}`;
}
export const digestDue = (nowMs: number): boolean => { const l = new Date(nowMs + OFFSET_MIN * 60_000); return l.getUTCDay() === 1 && l.getUTCHours() >= 7; };

export async function sendDigest(env: Env, d: Deps, wid: string): Promise<boolean> {
  const ws = await fsGet(env, d, `workspaces/${wid}`);
  if (!ws || ws.data.status === 'closing' || ws.data.status === 'deleted' || !riskPlanOk(ws.data, d.now())) return false;
  const st = (ws.data.settings ?? {}) as Record<string, unknown>;
  if (st.weeklyDigest === false) return false;
  const now = d.now().getTime();
  try { await fsCommit(env, d, [{ path: `workspaces/${wid}/automationMarkers/digest_${weekKey(now)}`, fields: { at: d.now() }, precondition: { exists: false } }]); }
  catch (e) { if (e instanceof FsConflict) return false; throw e; }
  const { rows, svcs } = await load({ env, d }, wid, now - 14 * DAY, now);
  const cur = summarize(rows, svcs, now - 7 * DAY, now, now, OFFSET_MIN); const prev = summarize(rows, svcs, now - 14 * DAY, now - 7 * DAY, now, OFFSET_MIN);
  const uid = String(ws.data.ownerUid ?? '');
  const [m, u] = await Promise.all([fsGet(env, d, `workspaces/${wid}/members/${uid}`), fsGet(env, d, `users/${uid}`)]);
  const to = String(m?.data.email ?? u?.data.email ?? '');
  if (!to) return false;
  const biz = String(st.publicName ?? ws.data.name ?? 'your business'); const hello = String(u?.data.name ?? m?.data.name ?? '').trim().split(/\s+/)[0] || 'there';
  const day = peak(cur.byWeekday); const hr = peak(cur.byHour); const top = cur.topServices[0];
  const app = env.APP_URL.replace(/\/$/, '');
  const lines: string[] = [
    `Here is how ${biz} did over the last 7 days.`,
    `Bookings: ${cur.bookings} (${change(cur.bookings, prev.bookings)}). Completed: ${cur.completed}. Cancelled: ${cur.cancelled}. No-shows: ${cur.noShows}.`,
    `Revenue from completed bookings, at list price: ${money(cur.revenueMinor)} (${change(cur.revenueMinor, prev.revenueMinor)}). Deposits paid: ${money(cur.depositsMinor)}.`,
    `No-show rate: ${pct(cur.noShowRate)}. Cancellation rate: ${pct(cur.cancelRate)}.`,
    ...(day >= 0 && hr >= 0 ? [`Busiest day: ${weekdayName(day)}. Busiest hour: ${hour12(hr)}.`] : []),
    ...(top ? [`Most booked service: ${top.name} (${top.bookings}).`] : []),
    ...(cur.recoveredBookings ? [`Won back from the waitlist: ${cur.recoveredBookings} booking${cur.recoveredBookings === 1 ? '' : 's'}, about ${money(cur.recoveredMinor)} at list price.`] : []),
    `Full details, with 30 and 90 day views, are at ${app}/app/insights.`,
  ];
  return sendFormal(env, d, to, `Your week at ${biz}`, { heading: `Your week at ${biz}`, greeting: `Dear ${hello},`, paragraphs: lines,
    note: 'You receive this every Monday morning because you are on an Enterprise or Dedicated plan. To stop it, switch off the weekly summary in Settings.' });
}

export async function scheduledDigests(env: Env, d: Deps): Promise<{ sent: string[] }> {
  const out = { sent: [] as string[] };
  const now = d.now();
  if (!digestDue(now.getTime())) return out;
  const spaces = (await Promise.all(['enterprise', 'dedicated'].map((plan) => fsQuery(env, d, { collection: 'workspaces', where: [{ field: 'plan', op: 'EQUAL', value: plan }], limit: 500 })))).flat()
    .filter((w, i, all) => all.findIndex((x) => x.id === w.id) === i).filter((w) => (RANK[activePlan(w.data, now).tier] ?? 0) >= (RANK.enterprise ?? 4));
  for (const w of spaces.slice(0, 40)) {
    try { if (await sendDigest(env, d, w.id)) out.sent.push(w.id); } catch (e) { console.error('digest failed', w.id, e instanceof Error ? e.message : e); }
  }
  return out;
}
