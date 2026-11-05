/**
 * Per-workspace WhatsApp Cloud API connection.
 * Access tokens are encrypted with a deployment secret before they reach Firestore.
 */
import type { Ctx } from '../env';
import { requireMember } from '../auth';
import { fsCommit, fsGet } from '../fs';
import { HttpError, json, readJson, randomHex } from '../util';

const keyBytes = (raw: string): Uint8Array => {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0)); } catch { throw new HttpError(503, 'WhatsApp credential encryption is not configured correctly.'); }
  if (bytes.length !== 32) throw new HttpError(503, 'WhatsApp credential encryption key must be 32 bytes.');
  return bytes;
};
async function aesKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(raw: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(raw));
  return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(data))), iv: btoa(String.fromCharCode(...iv)) };
}
async function decrypt(ciphertext: string, iv: string, secret: string): Promise<string> {
  const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await aesKey(secret), bytes(ciphertext));
  return new TextDecoder().decode(data);
}
const path = (wid: string) => `workspaces/${wid}/integrations/whatsapp`;

/** GET returns connection metadata only. Secrets are never returned to the browser. */
export async function whatsappStatus(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const row = await fsGet(c.env, c.d, path(wid));
  return json({ connected: Boolean(row?.data.enabled && row.data.phoneNumberId), phoneNumberId: row?.data.phoneNumberId ?? null,
    displayPhoneNumber: row?.data.displayPhoneNumber ?? null, verifiedName: row?.data.verifiedName ?? null,
    connectedAt: row?.data.connectedAt ?? null }, 200, c.headers);
}

/** POST saves a verified Meta Cloud API connection. Token is never persisted in plaintext or returned. */
export async function whatsappConnect(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 8192);
  const { caller, wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const secret = c.env.WHATSAPP_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(503, 'WhatsApp connections are not enabled yet. Ask the ZexCore operator to configure credential encryption.', 'unavailable');
  const token = String(b.accessToken ?? '').trim();
  const phoneId = String(b.phoneNumberId ?? '').trim();
  if (token.length < 30 || token.length > 4096 || !/^\d{5,30}$/.test(phoneId)) throw new HttpError(400, 'Enter a valid Meta access token and phone number ID.');
  // Verify ownership and token validity against the exact phone-number resource before storing anything.
  const check = await c.d.fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
  });
  const meta = await check.json().catch(() => ({})) as Record<string, unknown>;
  if (!check.ok || String(meta.id ?? '') !== phoneId) throw new HttpError(400, 'Meta could not verify this phone number ID and access token. Check the credentials and permissions.');
  const encrypted = await encrypt(token, secret);
  await fsCommit(c.env, c.d, [{ path: path(wid), fields: { enabled: true, phoneNumberId: phoneId, tokenCiphertext: encrypted.ciphertext,
    tokenIv: encrypted.iv, displayPhoneNumber: String(meta.display_phone_number ?? '').slice(0, 40),
    verifiedName: String(meta.verified_name ?? '').slice(0, 100), connectedBy: caller.uid, connectedAt: c.d.now(), updatedAt: c.d.now() } }]);
  return json({ ok: true, connected: true, phoneNumberId: phoneId, displayPhoneNumber: meta.display_phone_number ?? null, verifiedName: meta.verified_name ?? null }, 200, c.headers);
}

export async function whatsappDisconnect(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 1024);
  const { wid } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const row = await fsGet(c.env, c.d, path(wid));
  if (row) await fsCommit(c.env, c.d, [{ path: path(wid), fields: { enabled: false, tokenCiphertext: null, tokenIv: null, disconnectedAt: c.d.now() },
    mask: ['enabled', 'tokenCiphertext', 'tokenIv', 'disconnectedAt'] }]);
  return json({ ok: true, connected: false }, 200, c.headers);
}

/** Internal helper for later queue workers; fails closed if the connection is incomplete. */
export async function tenantWhatsAppToken(c: Ctx, wid: string): Promise<{ token: string; phoneNumberId: string } | null> {
  const secret = c.env.WHATSAPP_ENCRYPTION_KEY;
  if (!secret) return null;
  const row = await fsGet(c.env, c.d, path(wid));
  if (!row?.data.enabled || typeof row.data.tokenCiphertext !== 'string' || typeof row.data.tokenIv !== 'string' || typeof row.data.phoneNumberId !== 'string') return null;
  try { return { token: await decrypt(row.data.tokenCiphertext, row.data.tokenIv, secret), phoneNumberId: row.data.phoneNumberId }; }
  catch { console.error('tenant WhatsApp credential decryption failed', wid); return null; }
}
