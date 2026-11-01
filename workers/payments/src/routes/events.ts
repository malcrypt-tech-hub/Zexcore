import { requireMember } from '../auth';
import { fireEvent, ownerEmail } from '../automation';
import type { Ctx } from '../env';
import { FsConflict, fsCommit, fsGet } from '../fs';
import { sendMail } from '../mail';
import { HttpError, ID_RE, json, readJson } from '../util';

const BOOKING_RE = /^\d{6}_\d{1,6}$/;

async function bookingPayload(c: Ctx, wid: string, id: string): Promise<{ payload: Record<string, unknown>; source: string; createdAt: number } | null> {
  const b = await fsGet(c.env, c.d, `workspaces/${wid}/bookings/${id}`);
  if (!b) return null;
  const svc = await fsGet(c.env, c.d, `workspaces/${wid}/services/${String(b.data.serviceId)}`);
  const startsAt = b.data.startsAt instanceof Date ? b.data.startsAt.toISOString() : '';
  return {
    payload: { booking: { id, ref: `ZX-${id.replace('_', '-')}`, status: b.data.status, customerName: b.data.customerName, customerPhone: b.data.customerPhone, service: svc?.data.name ?? '', priceMinor: svc?.data.priceMinor ?? 0, startsAt, source: b.data.source } },
    source: String(b.data.source ?? ''), createdAt: b.data.createdAt instanceof Date ? b.data.createdAt.getTime() : 0,
  };
}

/** POST /api/events { workspaceId, event, id }  — a signed-in member reports something they just did. The Worker re-reads the record. */
export async function memberEvent(c: Ctx): Promise<Response> {
  const b = await readJson(c.req);
  const { wid } = await requireMember(c, b.workspaceId);
  const id = String(b.id ?? ''); const event = String(b.event ?? '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid record');
  if (event === 'bookings.booking.created') {
    const r = await bookingPayload(c, wid, id);
    if (!r) throw new HttpError(404, 'Booking not found');
    return json({ ok: true, ran: await fireEvent(c, wid, event, r.payload) }, 200, c.headers);
  }
  if (event === 'crm.lead.created') {
    const l = await fsGet(c.env, c.d, `workspaces/${wid}/leads/${id}`);
    if (!l) throw new HttpError(404, 'Lead not found');
    return json({ ok: true, ran: await fireEvent(c, wid, event, { lead: { id, title: l.data.title, value: l.data.value ?? 0, stageId: l.data.stageId } }) }, 200, c.headers);
  }
  throw new HttpError(400, 'Unknown event');
}

/** POST /api/public/booked { slug, bookingId } — the booking page tells us a visitor just booked. Once per booking, ever. */
export async function publicBooked(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const slug = String(b.slug ?? ''); const bookingId = String(b.bookingId ?? '');
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || !BOOKING_RE.test(bookingId)) throw new HttpError(400, 'Invalid request');
  const s = await fsGet(c.env, c.d, `slugs/${slug}`);
  const wid = String(s?.data.wid ?? '');
  if (!wid) throw new HttpError(404, 'Not found');
  const r = await bookingPayload(c, wid, bookingId);
  if (!r || r.source !== 'public' || c.d.now().getTime() - r.createdAt > 15 * 60_000) throw new HttpError(404, 'Not found');
  try {
    await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/automationMarkers/${bookingId}`, fields: { at: c.d.now() }, precondition: { exists: false } }]);
  } catch (e) { if (e instanceof FsConflict) return json({ ok: true, duplicate: true }, 200, c.headers); throw e; }
  const bk = r.payload.booking as Record<string, unknown>;
  await sendMail(c.env, c.d, await ownerEmail(c, wid), `New booking request: ${String(bk.customerName)}`,
    `${String(bk.customerName)} (${String(bk.customerPhone)}) asked to book ${String(bk.service)} on ${String(bk.startsAt)}.\n\nOpen your dashboard to confirm it.`);
  return json({ ok: true, ran: await fireEvent(c, wid, 'bookings.booking.created', r.payload) }, 200, c.headers);
}
