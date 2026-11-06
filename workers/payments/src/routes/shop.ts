/**
 * The online shop: a business lists goods, customers send an order request from the booking page.
 *
 *   POST /api/public/order          a customer sends name, phone, delivery address and the goods they want. Prices come from the
 *                                   products on the server, never from the browser. Nothing is charged: the business confirms
 *                                   the order and agrees payment with the customer. The customer gets a receipt-of-request email
 *                                   (if they gave an address) and the owner is told.
 *   POST /api/events                 `orders.order.status` — the owner changed an order's status; the customer is emailed once per status.
 *   POST /api/uploads/sign           a signed-in editor gets a short-lived Cloudinary upload signature for product photos.
 *
 * Prices are list prices in USD minor units, like services.
 */
import type { Ctx } from '../env';
import { requireMember, DOERS } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { ownerContact } from '../automation';
import { sendFormal } from '../mail';
import { queueFormal } from '../outbox';
import { HttpError, ID_RE, firstName, json, randomHex, readJson, sha256Hex } from '../util';
import { normalizePhone } from './waitlist';

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_LINES = 20, MAX_QTY = 99, MAX_OPEN_ORDERS = 500, MAX_OPEN_PER_PHONE = 3;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
const usd = (minor: number): string => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clean = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

export async function placeOrder(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 8192);
  const slug = String(b.slug ?? '');
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  if (!wid) throw new HttpError(404, 'Not found');
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if (!ws || ws.data.status === 'closing' || ws.data.status === 'deleted') throw new HttpError(404, 'Not found');
  const name = clean(b.name, 120), phone = normalizePhone(String(b.phone ?? '')), address = clean(b.address, 400), notes = clean(b.notes, 500);
  const email = clean(b.email, 160).toLowerCase();
  if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
  if (!phone) throw new HttpError(400, 'Enter a valid phone number, for example 0803 123 4567.');
  if (address.length < 8) throw new HttpError(400, 'Enter the address the goods should be sent to.');
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'That email address does not look right. Leave it empty or correct it.');
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) throw new HttpError(400, 'Choose at least one item.');
  if (lines.length > MAX_LINES) throw new HttpError(400, `Please order at most ${MAX_LINES} different items at once.`);
  const seen = new Set<string>(); const items: { productId: string; name: string; unitMinor: number; qty: number }[] = [];
  for (const l of lines as Record<string, unknown>[]) {
    const id = String(l?.id ?? ''); const qty = Number(l?.qty);
    if (!ID_RE.test(id) || seen.has(id)) throw new HttpError(400, 'Something in your order is not valid. Please refresh and try again.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, `Choose a quantity from 1 to ${MAX_QTY}.`);
    seen.add(id);
    const p = await fsGet(c.env, c.d, `workspaces/${wid}/products/${id}`);
    if (!p || p.data.active === false || p.data.inStock === false) throw new HttpError(409, `${p ? String(p.data.name) : 'An item'} is no longer available. Please refresh and try again.`, 'unavailable');
    items.push({ productId: id, name: String(p.data.name ?? 'Item'), unitMinor: Math.max(0, Math.round(Number(p.data.priceMinor) || 0)), qty });
  }
  // One person cannot fill the queue: a few waiting orders per phone number, and a generous cap for the whole shop.
  const mine = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'orders', where: [{ field: 'customerPhone', op: 'EQUAL', value: phone }], limit: 25 });
  const requestId = String(b.requestId ?? '');
  const id = REQUEST_ID_RE.test(requestId) ? (await sha256Hex(`${wid}:${requestId}`)).slice(0, 16) : randomHex(8);
  const again = mine.find((o) => o.id === id);
  if (again) return json({ ok: true, ref: String(again.data.ref), totalMinor: Number(again.data.totalMinor) || 0, duplicate: true }, 200, c.headers);   // same order sent twice
  if (mine.filter((o) => o.data.customerPhone === phone && o.data.status === 'new').length >= MAX_OPEN_PER_PHONE) throw new HttpError(429, 'You already have orders waiting for this business to confirm. Please wait for them to contact you.', 'busy');
  const open = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'orders', where: [{ field: 'status', op: 'EQUAL', value: 'new' }], limit: MAX_OPEN_ORDERS + 1 });
  if (open.filter((o) => o.data.status === 'new').length >= MAX_OPEN_ORDERS) throw new HttpError(429, 'This shop has a lot of waiting orders right now. Please try again later.', 'busy');
  const totalMinor = items.reduce((n, i) => n + i.unitMinor * i.qty, 0);
  const ref = `ZO-${(await sha256Hex(id)).slice(0, 6).toUpperCase()}`;
  try {
    await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/orders/${id}`, precondition: { exists: false },
      fields: { ref, customerName: name, customerPhone: phone, customerEmail: email || null, address, notes: notes || null, items, totalMinor, status: 'new', createdAt: c.d.now() } }]);
  } catch (e) { if (e instanceof FsConflict) return json({ ok: true, ref, totalMinor, duplicate: true }, 200, c.headers); throw e; }

  const st = ws.data.settings as Record<string, unknown> | undefined;
  const biz = String(st?.publicName ?? ws.data.name ?? 'the business');
  const lineText = items.map((i) => `${i.qty} × ${i.name} (${usd(i.unitMinor)} each)`).join('; ');
  if (email) {
    await queueFormal(c.env, c.d, `orderack:${wid}:${id}`, email, `We received your order request (${ref})`, {
      heading: 'Your order request was received', greeting: `Hello ${firstName(name, email)},`,
      paragraphs: [`Thank you. ${biz} has received your order request. Nothing has been charged. The business will contact you to confirm the order, the final price and how to pay.`],
      details: [['Business', biz], ['Reference', ref], ['Items', lineText], ['List total', usd(totalMinor)], ['Delivery address', address]],
      note: 'Prices shown are list prices in US dollars. The business will confirm the amount you pay.',
    }).catch((e) => console.error('order ack email failed', e instanceof Error ? e.message : e));
  }
  if (st?.notifyOwnerEmail !== false) {
    const owner = await ownerContact(c, wid);
    if (owner.email) await queueFormal(c.env, c.d, `orderowner:${wid}:${id}`, owner.email, `New order request ${ref}: ${name}`, {
      heading: 'You have a new order request', greeting: `Hello ${owner.name},`,
      paragraphs: [`${name} sent an order request from your booking page. Please confirm it, the final price and payment with them.`],
      details: [['Customer', name], ['Phone', phone], ...(email ? [['Email', email] as [string, string]] : []), ['Items', lineText], ['List total', usd(totalMinor)], ['Delivery address', address], ...(notes ? [['Notes', notes] as [string, string]] : []), ['Reference', ref]],
      button: { text: 'Open orders', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/shop#orders` },
      note: `Reply on WhatsApp: https://wa.me/${phone.replace(/\D/g, '')}`,
    }).catch((e) => console.error('order owner email failed', e instanceof Error ? e.message : e));
  }
  return json({ ok: true, ref, totalMinor }, 201, c.headers);
}

const STATUS_TEXT: Record<string, [string, string]> = {
  confirmed: ['Your order was confirmed', 'The business has confirmed your order and will be in touch about payment and delivery.'],
  shipped: ['Your order is on its way', 'The business has sent your order out for delivery.'],
  delivered: ['Your order was marked as delivered', 'The business has marked your order as delivered. If anything is wrong, please contact them.'],
  cancelled: ['Your order was cancelled', 'The business has cancelled this order. If you were not expecting this, please contact them.'],
};

/** The owner moved an order along; tell the customer, once per status. */
export async function orderStatusEmail(c: Ctx, wid: string, id: string): Promise<{ ok: true; emailed: boolean; reason?: string }> {
  const o = await fsGet(c.env, c.d, `workspaces/${wid}/orders/${id}`);
  if (!o) throw new HttpError(404, 'Order not found');
  const status = String(o.data.status ?? '');
  const text = STATUS_TEXT[status];
  if (!text) return { ok: true, emailed: false, reason: 'no_message' };
  const email = String(o.data.customerEmail ?? '');
  if (!EMAIL_RE.test(email)) return { ok: true, emailed: false, reason: 'no_email' };
  try { await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/automationMarkers/order_${id}_${status}`, fields: { at: c.d.now() }, precondition: { exists: false } }]); }
  catch (e) { if (e instanceof FsConflict) return { ok: true, emailed: false, reason: 'duplicate' }; throw e; }
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const st = ws?.data.settings as Record<string, unknown> | undefined;
  const biz = String(st?.publicName ?? ws?.data.name ?? 'the business');
  const items = (Array.isArray(o.data.items) ? o.data.items : []) as { name: string; qty: number }[];
  const sent = await queueFormal(c.env, c.d, `orderstatus:${wid}:${id}:${status}`, email, `${text[0]} (${String(o.data.ref)})`, {
    heading: text[0], greeting: `Hello ${firstName(String(o.data.customerName ?? ''), email)},`, paragraphs: [text[1]],
    details: [['Business', biz], ['Reference', String(o.data.ref)], ['Items', items.map((i) => `${i.qty} × ${i.name}`).join('; ')]],
  });
  return { ok: true, emailed: sent !== 'dead', ...(sent !== 'dead' ? {} : { reason: 'send_failed' }) };
}

/** Cloudinary upload signature for one product photo. Signed on the server so the secret never reaches the browser and each upload is limited. */
export async function signUpload(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid } = await requireMember(c, b.workspaceId, DOERS);
  const cloud = c.env.CLOUDINARY_CLOUD_NAME, key = c.env.CLOUDINARY_API_KEY, secret = c.env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) throw new HttpError(503, 'Photo upload is not switched on yet.', 'unavailable');
  const params: Record<string, string> = { allowed_formats: 'jpg,jpeg,png,webp', folder: `zexcore/${wid}/products`, timestamp: String(Math.floor(c.d.now().getTime() / 1000)) };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign + secret));
  const signature = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return json({ cloudName: cloud, apiKey: key, signature, ...params }, 200, c.headers);
}
