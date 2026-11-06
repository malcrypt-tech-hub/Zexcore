/** The online shop: products the business sells, photos on Cloudinary, and the order requests customers send. */
import { deleteDoc, getDocs, limit as qLimit, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { ApiError, audit, claimSlot, iso, loadCtx, requireEditor, toApiError, wsCol, wsDoc, type Ctx } from './core';
import { worker } from './worker';

/** Orders can be handled by anyone on the team except read-only viewers. */
function requireWorker(c: Ctx): void { if (c.role === 'viewer') throw new ApiError(403, 'Your role cannot change this.', 'forbidden'); }

export interface ProductDto { id: string; name: string; description: string | null; priceMinor: number; active: boolean; inStock: boolean; imageUrl: string | null }
export interface OrderItem { productId: string; name: string; unitMinor: number; qty: number }
export interface OrderDto { id: string; ref: string; customerName: string; customerPhone: string; customerEmail: string | null; address: string; notes: string | null; items: OrderItem[]; totalMinor: number; status: string; createdAt: string | null }
export const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
const IMG_RE = /^https:\/\/res\.cloudinary\.com\//;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const toProduct = (id: string, x: Record<string, any>): ProductDto => ({ id, name: String(x.name ?? ''), description: x.description ?? null, priceMinor: Number(x.priceMinor) || 0, active: x.active !== false, inStock: x.inStock !== false, imageUrl: typeof x.imageUrl === 'string' && IMG_RE.test(x.imageUrl) ? x.imageUrl : null });

/** A smaller, compressed copy of a Cloudinary picture. Anything that is not ours is dropped. */
export const thumb = (url: string | null, w = 480): string | null => (url && IMG_RE.test(url) ? url.replace('/upload/', `/upload/c_fill,w_${w},h_${w},q_auto,f_auto/`) : null);

function check(b: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) { const n = String(b.name ?? '').trim(); if (!n || n.length > 120) throw new ApiError(400, 'Give the product a name (up to 120 characters).'); out.name = n; }
  if (!partial || b.priceMinor !== undefined) { const p = Number(b.priceMinor ?? 0); if (!Number.isInteger(p) || p < 0 || p > 10_000_000_000) throw new ApiError(400, 'Enter a valid price.'); out.priceMinor = p; }
  if (b.description !== undefined) { const d = String(b.description ?? '').trim(); if (d.length > 500) throw new ApiError(400, 'Keep the description under 500 characters.'); out.description = d || null; }
  if (b.active !== undefined) out.active = b.active === true;
  if (b.inStock !== undefined) out.inStock = b.inStock === true;
  if (b.imageUrl !== undefined) { const u = b.imageUrl === null ? null : String(b.imageUrl); if (u !== null && (!IMG_RE.test(u) || u.length > 400)) throw new ApiError(400, 'That picture link is not valid.'); out.imageUrl = u; }
  return out;
}

export async function listProducts(): Promise<{ products: ProductDto[] }> {
  const c = await loadCtx(); requireWorker(c);
  const s = await getDocs(query(wsCol(c, 'products'), orderBy('seq'), qLimit(1000)));
  return { products: s.docs.map((d) => toProduct(d.id, d.data())) };
}
export async function createProduct(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireEditor(c);
  const id = await claimSlot(c, 'products', 'g', 'products', { description: null, active: true, inStock: true, imageUrl: null, ...check(b, false) });
  void audit(c, 'product.create', 'product', id);
  return { id };
}
export async function patchProduct(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx(); requireEditor(c);
  await updateDoc(wsDoc(c, 'products', id), check(b, true)).catch((e) => { throw toApiError(e); });
  void audit(c, 'product.update', 'product', id);
  return { ok: true };
}
export async function removeProduct(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireEditor(c);
  await deleteDoc(wsDoc(c, 'products', id)).catch((e) => { throw toApiError(e); });
  void audit(c, 'product.delete', 'product', id);
  return { ok: true };
}

/** Sends one picture to Cloudinary with a signature from our server, and returns its address. */
export async function uploadPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new ApiError(400, 'Choose a JPG, PNG or WebP picture.');
  if (file.size > MAX_PHOTO_BYTES) throw new ApiError(400, 'That picture is over 5 MB. Choose a smaller one.');
  const c = await loadCtx(); requireEditor(c);
  const s = await worker<{ cloudName: string; apiKey: string; signature: string; timestamp: string; folder: string; allowed_formats: string }>('/api/uploads/sign', { body: { workspaceId: c.wid } });
  const f = new FormData();
  f.set('file', file); f.set('api_key', s.apiKey); f.set('timestamp', s.timestamp); f.set('signature', s.signature); f.set('folder', s.folder); f.set('allowed_formats', s.allowed_formats);
  let r: Response;
  try { r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(s.cloudName)}/image/upload`, { method: 'POST', body: f }); }
  catch { throw new ApiError(0, 'Could not reach the photo service. Check your connection.', 'network'); }
  const j = (await r.json().catch(() => ({}))) as { secure_url?: string; error?: { message?: string } };
  if (!r.ok || !j.secure_url || !IMG_RE.test(j.secure_url)) throw new ApiError(502, 'The picture could not be uploaded. Please try again.');
  return j.secure_url;
}

export async function listOrders(): Promise<{ orders: OrderDto[] }> {
  const c = await loadCtx(); requireWorker(c);
  const s = await getDocs(query(wsCol(c, 'orders'), orderBy('createdAt', 'desc'), qLimit(200)));
  return { orders: s.docs.map((d) => { const x = d.data(); return { id: d.id, ref: String(x.ref ?? ''), customerName: String(x.customerName ?? ''), customerPhone: String(x.customerPhone ?? ''), customerEmail: x.customerEmail ?? null, address: String(x.address ?? ''), notes: x.notes ?? null, items: (Array.isArray(x.items) ? x.items : []) as OrderItem[], totalMinor: Number(x.totalMinor) || 0, status: String(x.status ?? 'new'), createdAt: iso(x.createdAt) }; }) };
}
/** Moves an order along and asks the Worker to email the customer. Reports whether that email went out (null: no address on the order). */
export async function setOrderStatus(id: string, status: string, hasEmail: boolean): Promise<{ ok: true; customerEmailed: boolean | null }> {
  const c = await loadCtx(); requireWorker(c);
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, 'Unknown order status.');
  await updateDoc(wsDoc(c, 'orders', id), { status, updatedAt: serverTimestamp() }).catch((e) => { throw toApiError(e); });
  void audit(c, `order.${status}`, 'order', id);
  if (!hasEmail) return { ok: true, customerEmailed: null };
  try { return { ok: true, customerEmailed: (await worker<{ emailed?: boolean }>('/api/events', { body: { workspaceId: c.wid, event: 'orders.order.status', id } })).emailed === true }; }
  catch { return { ok: true, customerEmailed: false }; }
}
