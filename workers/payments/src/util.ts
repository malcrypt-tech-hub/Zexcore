import type { Env } from './env';

export const enc = new TextEncoder();
export const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (s: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function paystackSignature(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
}
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

export function cors(env: Env, req: Request, methods = 'GET, POST, OPTIONS'): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': methods, vary: 'origin' }
    : { vary: 'origin' };
}

export const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomRef = (wid: string): string => `zx_${wid.slice(0, 12)}_${Date.now().toString(36)}_${randomHex(6)}`;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WID_RE = /^[A-Za-z0-9]{20}$/;

export class HttpError extends Error {
  status: number; code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
export async function readJson(req: Request, maxBytes = 16_384): Promise<Record<string, any>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large');
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* fall through */ }
  throw new HttpError(400, 'Invalid request');
}

/** "Sat, 7 Nov 2026 at 4:00 PM" in the business's own time zone (a fixed UTC offset in minutes, e.g. 60 for Lagos). */
export function localWhen(iso: string, offsetMin: number): string {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60_000);
  if (Number.isNaN(d.getTime())) return iso;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]!;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]!;
  const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()} at ${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}
export const firstName = (name: unknown, email = ''): string => {
  const n = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return n || (email.split('@')[0] ?? '').replace(/[^A-Za-z]/g, ' ').trim().split(' ')[0]?.replace(/^./, (c) => c.toUpperCase()) || 'there';
};
