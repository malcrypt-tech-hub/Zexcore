import { assessBooking } from './risk';
import { backfillSlot, markWaitlistBooked } from './waitlist';
import { DOERS, requireMember } from '../auth';
import { fireEvent, ownerContact } from '../automation';
import type { Ctx } from '../env';
import { FsConflict, fsCommit, fsGet } from '../fs';
import { sendFormal } from '../mail';
import { sendBookingAlert, waNumber, whatsappConfigured } from '../whatsapp';
import { HttpError, ID_RE, json, localWhen, readJson } from '../util';

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
  const { wid } = await requireMember(c, b.workspaceId, DOERS);
  const id = String(b.id ?? ''); const event = String(b.event ?? '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid record');
  if (event === 'bookings.booking.created') {
    const r = await bookingPayload(c, wid, id);
    if (!r) throw new HttpError(404, 'Booking not found');
    return json({ ok: true, ran: await fireEvent(c, wid, event, r.payload) }, 200, c.headers);
  }
  if (event === 'bookings.booking.cancelled') {
    return json({ ok: true, told: await backfillSlot(c, wid, id) }, 200, c.headers);
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
  await markWaitlistBooked(c, wid, bookingId).catch((e) => console.error('waitlist match failed', e instanceof Error ? e.message : e));
  const bk = r.payload.booking as Record<string, unknown>;
  const risk = await assessBooking(c, wid, bookingId).catch(() => null);   // Enterprise only; a failure must not lose the booking email
  const owner = await ownerContact(c, wid);
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const off = Number((ws?.data.settings as Record<string, unknown> | undefined)?.utcOffsetMinutes ?? 60);
  const wsSettings = ws?.data.settings as Record<string, unknown> | undefined;
  const emailEnabled = wsSettings?.notifyOwnerEmail !== false; // default: on
  const waEnabled = Boolean(wsSettings?.notifyOwnerWhatsApp);
  const waPhone = waNumber(String(wsSettings?.notifyWhatsAppPhone ?? '')) ?? '';
  const customerWaPhone = String(bk.customerPhone ?? '').replace(/\D/g, '');
  const price = Number(bk.priceMinor ?? 0);
  // A real WhatsApp message to the owner (only when ZexCore's WhatsApp Business account is set up and the owner gave a number).
  if (waEnabled && waPhone && whatsappConfigured(c.env)) {
    await sendBookingAlert(c.env, c.d, waPhone, [String(ws?.data.name ?? 'your business'), String(bk.customerName), String(bk.service || 'a service'), localWhen(String(bk.startsAt), off)]);
  }
  if (emailEnabled) {
    await sendFormal(c.env, c.d, owner.email, `New booking request: ${String(bk.customerName)}`, {
      heading: 'You have a new booking request', preheader: `${String(bk.customerName)} wants to book ${String(bk.service)}`, greeting: `Hello ${owner.name},`,
      paragraphs: [`${String(bk.customerName)} has asked to book through your ZexCore booking page. Please review it and confirm or decline from your dashboard.`],
      details: [['Customer', String(bk.customerName)], ['Phone', String(bk.customerPhone)], ['Service', String(bk.service || 'Service')], ['When', localWhen(String(bk.startsAt), off)], ['Reference', String(bk.ref)], ...(price > 0 ? [['Price', `$${(price / 100).toFixed(2)}`] as [string, string]] : []), ...(risk ? [['No-show risk', `${risk.level[0]!.toUpperCase()}${risk.level.slice(1)} (${risk.score}/100)`] as [string, string]] : [])],
      button: { text: 'Open dashboard', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/bookings` },
      ...(waEnabled && customerWaPhone ? { note: `Reply to this customer on WhatsApp: https://wa.me/${customerWaPhone}${waPhone ? ` · Your WhatsApp: https://wa.me/${waPhone}` : ''}` } : {}),
    });
  }
  return json({ ok: true, ran: await fireEvent(c, wid, 'bookings.booking.created', r.payload) }, 200, c.headers);
}
