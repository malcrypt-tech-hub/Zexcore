/**
 * Revenue protection (Enterprise and Dedicated): a waitlist on the booking page, and when a booking is cancelled the freed
 * time is offered, by email, to the people waiting for that service on that day.
 *
 *   POST /api/public/waitlist   { slug, serviceId, date, name, phone, email }   booking page: join the waitlist
 *   backfillSlot()   called when a team member cancels a booking (event bookings.booking.cancelled)
 *   markWaitlistBooked()   called when a visitor books: closes their waitlist entry and tags the booking as recovered
 *
 * An offer is not a hold. We tell up to three people at once and the first to book gets the time, because the booking page
 * already guarantees nobody can double-book a slot. That is stated plainly in the email.
 */
import type { Ctx } from '../env';
import { FsConflict, fsCommit, fsGet, fsQuery, type FsDoc } from '../fs';
import { sendFormal } from '../mail';
import { queueFormal } from '../outbox';
import { HttpError, json, localWhen, randomHex, readJson } from '../util';
import { riskPlanOk } from './risk';

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MAX_WAITING = 300;
const OFFER_TO = 3;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

/** Same rule the booking page uses, so a waitlist number matches the number on the booking. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s().-]/g, '');
  if (/^0\d{10}$/.test(p)) p = `+234${p.slice(1)}`;
  else if (/^234\d{10}$/.test(p)) p = `+${p}`;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}
const localDate = (startsAt: number, offsetMin: number): string => new Date(startsAt + offsetMin * 60_000).toISOString().slice(0, 10);
const enabled = (ws: Record<string, any> | undefined, now: Date): boolean => !!ws && riskPlanOk(ws, now) && ws.settings?.waitlistEnabled === true;

export async function joinWaitlist(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 2048);
  const slug = String(b.slug ?? '');
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  if (!wid) throw new HttpError(404, 'Not found');
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!enabled(ws?.data, c.d.now())) throw new HttpError(409, 'This business does not have a waitlist.', 'waitlist_off');
  const name = String(b.name ?? '').trim(); const email = String(b.email ?? '').trim().toLowerCase(); const phone = normalizePhone(String(b.phone ?? ''));
  const date = String(b.date ?? ''); const serviceId = String(b.serviceId ?? '');
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Please enter your full name.');
  if (!phone) throw new HttpError(400, 'Enter a valid phone number, for example 0803 123 4567.');
  if (!EMAIL_RE.test(email) || email.length > 160) throw new HttpError(400, 'Enter a valid email so we can tell you when a time opens.');
  if (!DATE_RE.test(date)) throw new HttpError(400, 'Choose a date.');
  const off = Number((ws!.data.settings as Record<string, unknown> | undefined)?.utcOffsetMinutes ?? 60);
  const today = localDate(c.d.now().getTime(), off);
  if (date < today || date > localDate(c.d.now().getTime() + 120 * 86_400_000, off)) throw new HttpError(400, 'Choose a date in the next few months.');
  const svc = await fsGet(c.env, c.d, `workspaces/${wid}/services/${serviceId}`);
  if (!svc || svc.data.active === false) throw new HttpError(400, 'Choose a service.');
  const rows = (await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'waitlist', where: [{ field: 'status', op: 'EQUAL', value: 'waiting' }], limit: MAX_WAITING + 1 })).filter((r) => r.data.status === 'waiting');
  if (rows.some((r) => r.data.phone === phone && r.data.serviceId === serviceId && r.data.date === date)) return json({ ok: true, already: true }, 200, c.headers);
  if (rows.length >= MAX_WAITING) throw new HttpError(409, 'The waitlist is full right now. Please try another day.', 'waitlist_full');
  const id = randomHex(8);
  await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/waitlist/${id}`, precondition: { exists: false }, fields: { serviceId, serviceName: String(svc.data.name ?? ''), date, name, phone, email, status: 'waiting', createdAt: c.d.now() } }]);
  return json({ ok: true }, 201, c.headers);
}

/** Offers a just-cancelled time to the people waiting for it. Safe to call twice: the first call wins. Returns how many were told. */
export async function backfillSlot(c: Ctx, wid: string, bookingId: string): Promise<number> {
  const [ws, booking] = await Promise.all([fsGet(c.env, c.d, `workspaces/${wid}`), fsGet(c.env, c.d, `workspaces/${wid}/bookings/${bookingId}`)]);
  if (!ws || !booking || !enabled(ws.data, c.d.now()) || booking.data.status !== 'cancelled') return 0;
  const startsAt = ms(booking.data.startsAt);
  if (startsAt < c.d.now().getTime() + 30 * 60_000) return 0;   // too late for anyone to make it
  try { await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/automationMarkers/backfill_${bookingId}`, fields: { at: c.d.now() }, precondition: { exists: false } }]); }
  catch (e) { if (e instanceof FsConflict) return 0; throw e; }
  const off = Number((ws.data.settings as Record<string, unknown> | undefined)?.utcOffsetMinutes ?? 60);
  const date = localDate(startsAt, off); const serviceId = String(booking.data.serviceId ?? '');
  const waiting = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'waitlist', where: [{ field: 'status', op: 'EQUAL', value: 'waiting' }], limit: MAX_WAITING });
  const chosen = waiting.filter((w) => w.data.status === 'waiting' && w.data.serviceId === serviceId && w.data.date === date).sort((a, b) => ms(a.data.createdAt) - ms(b.data.createdAt)).slice(0, OFFER_TO);
  if (!chosen.length) return 0;
  const svc = await fsGet(c.env, c.d, `workspaces/${wid}/services/${serviceId}`);
  const slug = String(ws.data.slug ?? ''); const biz = String((ws.data.settings as Record<string, unknown> | undefined)?.publicName ?? ws.data.name ?? 'the business');
  const when = localWhen(startsAt ? new Date(startsAt).toISOString() : '', off);
  const link = `${c.env.APP_URL.replace(/\/$/, '')}/${slug}?service=${encodeURIComponent(serviceId)}&date=${date}`;
  let told = 0;
  for (const w of chosen) {
    await fsCommit(c.env, c.d, [{ path: w.path, fields: { status: 'offered', offeredAt: c.d.now(), offeredStartsAt: new Date(startsAt), offeredFrom: bookingId }, mask: ['status', 'offeredAt', 'offeredStartsAt', 'offeredFrom'], precondition: { exists: true } }]).catch(() => undefined);
    const sent = await queueFormal(c.env, c.d, `offer:${wid}:${bookingId}:${w.id}`, String(w.data.email), `A time has opened up at ${biz}`, {
      heading: 'A time has opened up', preheader: `${String(svc?.data.name ?? 'Your service')} on ${when}`, greeting: `Hello ${String(w.data.name).split(' ')[0]},`,
      paragraphs: [`You asked to be told if a time opened up at ${biz}. One just did.`, 'It is first come, first served: we told up to three people on the waitlist, and the first to book gets the time.'],
      details: [['Business', biz], ['Service', String(svc?.data.name ?? 'Service')], ['When', when]],
      button: { text: 'Book this time', url: link }, note: 'You are receiving this because you joined the waitlist on the booking page. If the time is gone when you open the link, you stay on the list for other cancellations.' }).catch(() => false);
    if (sent !== 'dead') told++;
  }
  return told;
}

/** A visitor has just booked: close their waitlist entry for that service and day, and tag the booking if we had offered them a time. */
export async function markWaitlistBooked(c: Ctx, wid: string, bookingId: string): Promise<void> {
  const [ws, booking] = await Promise.all([fsGet(c.env, c.d, `workspaces/${wid}`), fsGet(c.env, c.d, `workspaces/${wid}/bookings/${bookingId}`)]);
  if (!ws || !booking || !enabled(ws.data, c.d.now())) return;
  const off = Number((ws.data.settings as Record<string, unknown> | undefined)?.utcOffsetMinutes ?? 60);
  const date = localDate(ms(booking.data.startsAt), off); const phone = String(booking.data.customerPhone ?? '');
  const open: FsDoc[] = [];
  for (const status of ['offered', 'waiting']) open.push(...await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'waitlist', where: [{ field: 'status', op: 'EQUAL', value: status }], limit: MAX_WAITING }));
  const seen = new Set<string>();
  const mine = open.filter((w) => !seen.has(w.path) && !!seen.add(w.path) && (w.data.status === 'waiting' || w.data.status === 'offered') && w.data.phone === phone && w.data.serviceId === String(booking.data.serviceId) && w.data.date === date);
  if (!mine.length) return;
  const recovered = mine.some((w) => w.data.status === 'offered');
  await fsCommit(c.env, c.d, [
    ...mine.map((w) => ({ path: w.path, fields: { status: 'booked', bookingId, bookedAt: c.d.now() }, mask: ['status', 'bookingId', 'bookedAt'], precondition: { exists: true } })),
    ...(recovered ? [{ path: booking.path, fields: { recoveredFromWaitlist: true }, mask: ['recoveredFromWaitlist'], precondition: { exists: true } }] : []),
  ]);
}
