/**
 * The online shop: a business lists goods, customers send an order request from the booking page.
 *
 *   POST /api/public/order          a customer sends name, phone, delivery address and the goods they want. Prices come from the
 *                                   products on the server, never from the browser. Nothing is charged: the business confirms
 *                                   the order and agrees payment with the customer. The customer gets a receipt-of-request email
 *                                   (if they gave an address) and the owner is told.
 *   GET  /api/public/shop-pay        can this shop take payment online (does it have a payout account, and are payments on)?
 *   GET  /api/public/order-status    the customer came back from Paystack: verify the payment and report it
 *   POST /api/order/refund           owner/admin: refund a paid order through Paystack
 *   POST /api/events                 `orders.order.status` — the owner changed an order's status; the customer is emailed once per status.
 *   POST /api/uploads/sign           a signed-in editor gets a short-lived Cloudinary upload signature for product photos.
 *
 * Pay now: an order can be paid online. Money goes straight to the business through its Paystack subaccount (the same payout
 * account as booking deposits). The order stays `awaiting_payment`, invisible to the owner, until Paystack confirms the payment
 * in full; then it becomes a `new` paid order and both sides are emailed. The webhook settles it too.
 * Prices are list prices in USD minor units, like services; Paystack charges naira at the business's rate.
 */
import type { Ctx, Deps, Env } from '../env';
import { paymentsEnabled } from '../env';
import { requireMember, DOERS } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { ownerContact } from '../automation';
import { sendFormal } from '../mail';
import { queueFormal } from '../outbox';
import { HttpError, ID_RE, firstName, json, randomHex, randomRef, readJson, sha256Hex } from '../util';
import { normalizePhone } from './waitlist';
import { ngnRateFor, ps } from './deposits';
import { maxCheckoutNgn } from './billing';
import { SHOP_PAY_MIN, atLeast, effectivePlan } from '../plan';

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_LINES = 20, MAX_QTY = 99, MAX_OPEN_ORDERS = 500, MAX_OPEN_PER_PHONE = 3;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
const ngn = (minor: number): string => `₦${(minor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const payOnline = b.payOnline === true;
  if (payOnline && !email) throw new HttpError(400, 'Enter your email address so we can send your payment receipt.');
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
  let pay: { subaccount: string; rate: number; amountMinor: number } | null = null;
  if (payOnline) {
    if (!paymentsEnabled(c.env)) throw new HttpError(503, 'Online payment is not available right now. Send the order as a request instead.', 'unavailable');
    if (!atLeast(effectivePlan(ws.data, c.d.now()).plan, SHOP_PAY_MIN)) throw new HttpError(402, 'This business does not take online payment for shop orders. Send the order as a request instead.', 'plan_required');
    const payout = await fsGet(c.env, c.d, `workspaces/${wid}/payout/main`);
    if (!payout?.data.subaccountCode) throw new HttpError(409, 'This business has not finished setting up online payments. Send the order as a request instead.', 'payout_missing');
    if (totalMinor <= 0) throw new HttpError(400, 'This order has no price to pay online. Send it as a request instead.');
    const rate = await ngnRateFor(c, (ws.data.settings ?? {}) as Record<string, any>);
    const amountMinor = Math.round(totalMinor * rate);
    if (amountMinor > maxCheckoutNgn(c.env) * 100) throw new HttpError(409, 'This order is too large to pay online. Send it as a request and the business will arrange payment with you.', 'contact_us');
    pay = { subaccount: String(payout.data.subaccountCode), rate, amountMinor };
  }
  const ref = `ZO-${(await sha256Hex(id)).slice(0, 6).toUpperCase()}`;
  try {
    await fsCommit(c.env, c.d, [{ path: `workspaces/${wid}/orders/${id}`, precondition: { exists: false },
      fields: { ref, customerName: name, customerPhone: phone, customerEmail: email || null, address, notes: notes || null, items, totalMinor, status: pay ? 'awaiting_payment' : 'new', paymentStatus: pay ? 'unpaid' : 'none', createdAt: c.d.now() } }]);
  } catch (e) { if (e instanceof FsConflict) return json({ ok: true, ref, totalMinor, duplicate: true }, 200, c.headers); throw e; }
  if (pay) return json(await startOrderPayment(c, wid, slug, id, ref, email, totalMinor, pay), 201, c.headers);

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


async function startOrderPayment(c: Ctx, wid: string, slug: string, orderId: string, ref: string, email: string, usdMinor: number, p: { subaccount: string; rate: number; amountMinor: number }): Promise<Record<string, unknown>> {
  const reference = randomRef(wid);
  await fsCommit(c.env, c.d, [
    { path: `workspaces/${wid}/orderPayments/${reference}`, precondition: { exists: false }, fields: { reference, orderId, amountMinor: p.amountMinor, usdMinor, rate: p.rate, currency: 'NGN', status: 'pending', createdAt: c.d.now() } },
    { path: `workspaces/${wid}/orders/${orderId}`, fields: { paymentReference: reference }, mask: ['paymentReference'], precondition: { exists: true } },
  ]);
  const fee = Math.max(0, Math.min(Number(c.env.DEPOSIT_FEE_MINOR ?? 0) || 0, Math.floor(p.amountMinor / 2)));
  const r = await ps(c.env, c.d, '/transaction/initialize', { method: 'POST', body: JSON.stringify({
    email, amount: p.amountMinor, currency: 'NGN', reference, subaccount: p.subaccount, bearer: 'subaccount', ...(fee ? { transaction_charge: fee } : {}),
    callback_url: `${c.env.APP_URL}/${slug}?order=${reference}`, metadata: { kind: 'order', workspaceId: wid, orderId },
  }) });
  const j = (await r.json().catch(() => ({}))) as { status?: boolean; data?: { authorization_url?: string } };
  if (!r.ok || !j.status || !j.data?.authorization_url) throw new HttpError(502, 'The payment provider is unavailable. Try again shortly, or send the order as a request.');
  return { ok: true, ref, totalMinor: usdMinor, reference, authorizationUrl: j.data.authorization_url, amountMinor: p.amountMinor };
}

/** Can this shop take payment online? The page asks before offering "Pay now". */
export async function shopPay(c: Ctx): Promise<Response> {
  const slug = c.url.searchParams.get('slug') ?? '';
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  const ws = wid && paymentsEnabled(c.env) ? await fsGet(c.env, c.d, `workspaces/${wid}`) : null;
  const allowed = ws ? atLeast(effectivePlan(ws.data, c.d.now()).plan, SHOP_PAY_MIN) : false;
  const payout = allowed ? await fsGet(c.env, c.d, `workspaces/${wid}/payout/main`) : null;
  return json({ online: Boolean(payout?.data.subaccountCode) }, 200, { ...c.headers, 'cache-control': 'public, max-age=60' });
}

/** Verifies an order payment with Paystack and, if it is genuinely paid in full, turns the order into a paid `new` order. Safe to call repeatedly. */
export async function settleOrder(env: Env, d: Deps, wid: string, reference: string): Promise<'paid' | 'pending' | 'mismatch' | 'unknown'> {
  const path = `workspaces/${wid}/orderPayments/${reference}`;
  const pay = await fsGet(env, d, path);
  if (!pay) return 'unknown';
  if (pay.data.status === 'paid' || pay.data.status === 'refunded') return 'paid';
  const v = await ps(env, d, `/transaction/verify/${encodeURIComponent(reference)}`);
  const vj = (await v.json().catch(() => ({}))) as { status?: boolean; data?: { status?: string; amount?: number; currency?: string; reference?: string } };
  if (!v.ok || !vj.status || vj.data?.status !== 'success' || vj.data.reference !== reference) return 'pending';
  if (vj.data.currency !== pay.data.currency || (vj.data.amount ?? 0) < Number(pay.data.amountMinor)) {
    await fsCommit(env, d, [{ path, fields: { status: 'mismatch', paidMinor: vj.data.amount ?? 0, updatedAt: d.now() }, mask: ['status', 'paidMinor', 'updatedAt'], precondition: { updateTime: pay.updateTime } }]).catch(() => undefined);
    return 'mismatch';
  }
  const now = d.now(); const orderId = String(pay.data.orderId);
  try {
    await fsCommit(env, d, [
      { path, fields: { status: 'paid', paidMinor: vj.data.amount, paidAt: now }, mask: ['status', 'paidMinor', 'paidAt'], precondition: { updateTime: pay.updateTime } },
      { path: `workspaces/${wid}/orders/${orderId}`, fields: { status: 'new', paymentStatus: 'paid', paidMinor: vj.data.amount, paymentReference: reference, paidAt: now }, mask: ['status', 'paymentStatus', 'paidMinor', 'paymentReference', 'paidAt'], precondition: { exists: true } },
    ]);
  } catch (e) { if (!(e instanceof FsConflict)) throw e; return (await fsGet(env, d, path))?.data.status === 'paid' ? 'paid' : 'pending'; }

  // Told only after the verified payment and the order update have committed; the queue keys make a repeat harmless.
  const [order, ws] = await Promise.all([fsGet(env, d, `workspaces/${wid}/orders/${orderId}`), fsGet(env, d, `workspaces/${wid}`)]);
  if (!order || !ws) return 'paid';
  const st = (ws.data.settings ?? {}) as Record<string, unknown>;
  const biz = String(st.publicName ?? ws.data.name ?? 'the business');
  const items = (order.data.items as { name: string; qty: number; unitMinor: number }[] | undefined) ?? [];
  const lineText = items.map((i) => `${i.qty} × ${i.name} (${usd(i.unitMinor)} each)`).join('; ');
  const refText = String(order.data.ref ?? '');
  const customerEmail = String(order.data.customerEmail ?? '').trim();
  const c = { env, d, req: new Request(env.APP_URL), url: new URL(env.APP_URL), headers: {} } as Ctx;
  if (EMAIL_RE.test(customerEmail)) {
    await queueFormal(env, d, `orderpaid:${wid}:${orderId}`, customerEmail, `Payment received for your order (${refText})`, {
      heading: 'Your order payment was received', greeting: `Hello ${firstName(String(order.data.customerName ?? ''), customerEmail)},`,
      paragraphs: [`Thank you. ${biz} has received your payment and will prepare your order. Keep this email as your receipt.`],
      details: [['Business', biz], ['Order reference', refText], ['Items', lineText], ['Order value', usd(Number(order.data.totalMinor) || 0)], ['Amount paid', ngn(Number(vj.data.amount ?? pay.data.amountMinor))], ['Payment reference', reference], ['Delivery address', String(order.data.address ?? '')]],
      note: 'Contact the business directly if you need to change or cancel your order.', card: true,
    }).catch((e) => console.error('order receipt email failed', e instanceof Error ? e.message : e));
  }
  if (st.notifyOwnerEmail !== false) {
    const owner = await ownerContact(c, wid);
    if (owner.email) await queueFormal(env, d, `orderpaidowner:${wid}:${orderId}`, owner.email, `Paid order ${refText}: ${String(order.data.customerName)}`, {
      heading: 'You have a new paid order', greeting: `Hello ${owner.name},`,
      paragraphs: [`${String(order.data.customerName)} paid for an order on your booking page. The money goes to your payout account through Paystack.`],
      details: [['Customer', String(order.data.customerName)], ['Phone', String(order.data.customerPhone)], ['Items', lineText], ['Amount paid', ngn(Number(vj.data.amount ?? pay.data.amountMinor))], ['Delivery address', String(order.data.address ?? '')], ['Order reference', refText]],
      button: { text: 'Open orders', url: `${env.APP_URL.replace(/\/$/, '')}/app/shop#orders` },
    }).catch((e) => console.error('paid order owner email failed', e instanceof Error ? e.message : e));
  }
  return 'paid';
}

export async function orderStatus(c: Ctx): Promise<Response> {
  const slug = c.url.searchParams.get('slug') ?? ''; const reference = c.url.searchParams.get('reference') ?? '';
  if (!SLUG_RE.test(slug) || !ID_RE.test(reference)) throw new HttpError(400, 'Invalid request');
  const wid = String((await fsGet(c.env, c.d, `slugs/${slug}`))?.data.wid ?? '');
  if (!wid || !reference.startsWith(`zx_${wid.slice(0, 12)}_`)) throw new HttpError(404, 'Not found');
  const state = await settleOrder(c.env, c.d, wid, reference);
  if (state === 'unknown') throw new HttpError(404, 'Not found');
  const pay = await fsGet(c.env, c.d, `workspaces/${wid}/orderPayments/${reference}`);
  const order = pay ? await fsGet(c.env, c.d, `workspaces/${wid}/orders/${String(pay.data.orderId)}`) : null;
  return json({ ref: String(order?.data.ref ?? ''), paymentStatus: state === 'paid' ? 'paid' : state === 'mismatch' ? 'mismatch' : 'unpaid', totalMinor: Number(order?.data.totalMinor) || 0, amountMinor: Number(pay?.data.amountMinor) || 0 }, 200, c.headers);
}

/** Refunds a paid order through Paystack and cancels it. Owners and admins only; an order can be refunded once. */
export async function refundOrder(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid, caller } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const orderId = String(b.orderId ?? '');
  if (!ID_RE.test(orderId)) throw new HttpError(400, 'Invalid order');
  const order = await fsGet(c.env, c.d, `workspaces/${wid}/orders/${orderId}`);
  const reference = String(order?.data.paymentReference ?? '');
  const pay = reference ? await fsGet(c.env, c.d, `workspaces/${wid}/orderPayments/${reference}`) : null;
  if (!order || !pay || pay.data.status !== 'paid') throw new HttpError(409, 'There is no paid online payment to refund for this order.', 'nothing_to_refund');
  const r = await ps(c.env, c.d, '/refund', { method: 'POST', body: JSON.stringify({ transaction: reference, customer_note: 'Order refund', merchant_note: `Refund requested by ${caller.uid}` }) });
  const j = (await r.json().catch(() => ({}))) as { status?: boolean; message?: string };
  if (!r.ok || !j.status) throw new HttpError(502, j.message ? `Paystack could not refund this order: ${j.message}` : 'Paystack could not refund this order. Try again shortly.', 'refund_failed');
  const now = c.d.now();
  await fsCommit(c.env, c.d, [
    { path: pay.path, fields: { status: 'refunded', refundedAt: now, refundedBy: caller.uid }, mask: ['status', 'refundedAt', 'refundedBy'], precondition: { exists: true } },
    { path: order.path, fields: { paymentStatus: 'refunded', status: 'cancelled', updatedAt: now }, mask: ['paymentStatus', 'status', 'updatedAt'], precondition: { exists: true } },
  ]);
  const email = String(order.data.customerEmail ?? '').trim();
  if (EMAIL_RE.test(email)) {
    const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
    const biz = String((ws?.data.settings as Record<string, unknown> | undefined)?.publicName ?? ws?.data.name ?? 'the business');
    await queueFormal(c.env, c.d, `orderrefund:${wid}:${orderId}`, email, `Your order payment was refunded (${String(order.data.ref)})`, {
      heading: 'Your order was refunded', greeting: `Hello ${firstName(String(order.data.customerName ?? ''), email)},`,
      paragraphs: [`${biz} has cancelled your order and refunded your payment through Paystack. The money usually reaches your account within a few working days, depending on your bank.`],
      details: [['Order reference', String(order.data.ref)], ['Amount refunded', ngn(Number(pay.data.paidMinor ?? pay.data.amountMinor))]],
    }).catch((e) => console.error('order refund email failed', e instanceof Error ? e.message : e));
  }
  return json({ ok: true }, 200, c.headers);
}
