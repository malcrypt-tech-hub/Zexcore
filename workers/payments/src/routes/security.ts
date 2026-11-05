/**
 * Security Watch: a real record of where your account signs in.
 *
 *   POST /api/security/signin       the app calls this once per sign-in. It remembers the device (browser + system, not your
 *                                   password or token) and the country the request came from. The first time a device
 *                                   appears on an account that has signed in before, we email you.
 *   GET  /api/security/devices      the devices recorded for your account.
 *   POST /api/security/revoke-all   ends every session: refresh tokens are revoked, so other devices must sign in again.
 *                                   An access token already issued keeps working until it expires (up to an hour).
 *
 * Stored under users/{uid}/signins/{deviceId}; only the Worker can read or write it.
 */
import type { Ctx } from '../env';
import { verifyFirebaseIdToken, type Caller } from '../auth';
import { fsCommit, fsGet, fsQuery } from '../fs';
import { accessToken } from '../google';
import { sendFormal } from '../mail';
import { HttpError, json, localWhen, sha256Hex } from '../util';

const SEEN_EVERY_MS = 10 * 60_000;
const MAX_DEVICES = 50;

export function deviceLabel(ua: string): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

async function caller(c: Ctx): Promise<Caller> {
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const who = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!who) throw new HttpError(401, 'Sign in again to continue.', 'unauthenticated');
  return who;
}

export async function recordSignIn(c: Ctx): Promise<Response> {
  const who = await caller(c);
  const label = deviceLabel(c.req.headers.get('user-agent') ?? '');
  const country = (c.req.headers.get('cf-ipcountry') ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || null;
  const id = (await sha256Hex(`${who.uid}|${label}`)).slice(0, 24);
  const path = `users/${who.uid}/signins/${id}`;
  const now = c.d.now();
  const known = await fsGet(c.env, c.d, path);
  if (known) {
    const last = known.data.lastSeenAt instanceof Date ? known.data.lastSeenAt.getTime() : 0;
    if (now.getTime() - last < SEEN_EVERY_MS) return json({ ok: true, newDevice: false }, 200, c.headers);
    await fsCommit(c.env, c.d, [{ path, fields: { lastSeenAt: now, lastCountry: country, count: Number(known.data.count ?? 1) + 1 }, mask: ['lastSeenAt', 'lastCountry', 'count'], precondition: { exists: true } }]);
    return json({ ok: true, newDevice: false }, 200, c.headers);
  }
  const others = await fsQuery(c.env, c.d, { parent: `users/${who.uid}`, collection: 'signins', limit: MAX_DEVICES });
  await fsCommit(c.env, c.d, [{ path, fields: { label, firstCountry: country, lastCountry: country, firstSeenAt: now, lastSeenAt: now, count: 1 }, precondition: { exists: false } }]);
  const newDevice = others.length > 0;   // the very first device on an account is just the person signing up
  if (newDevice && who.email) {
    await sendFormal(c.env, c.d, who.email, 'New sign-in to your ZexCore account', {
      heading: 'New sign-in to your account', preheader: `${label} signed in.`, greeting: 'Hello,',
      paragraphs: ['Your ZexCore account was just signed in to from a device we have not seen before.', 'If this was you, no action is needed. If it was not, change your password straight away and sign out everywhere from the Security page.'],
      details: [['Device', label], ['Country', country ?? 'Unknown'], ['Time', localWhen(now.toISOString(), 60)]],
      button: { text: 'Open Security', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/security` },
    }).catch((e) => console.error('new sign-in email failed', e instanceof Error ? e.message : e));
  }
  return json({ ok: true, newDevice }, 200, c.headers);
}

export async function listDevices(c: Ctx): Promise<Response> {
  const who = await caller(c);
  const rows = await fsQuery(c.env, c.d, { parent: `users/${who.uid}`, collection: 'signins', limit: MAX_DEVICES });
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
  const devices = rows.map((r) => ({ id: r.id, label: String(r.data.label ?? 'Unknown device'), country: (r.data.lastCountry as string | null) ?? null, firstSeenAt: iso(r.data.firstSeenAt), lastSeenAt: iso(r.data.lastSeenAt), count: Number(r.data.count ?? 1) }))
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return json({ devices }, 200, c.headers);
}

export async function revokeAll(c: Ctx): Promise<Response> {
  const who = await caller(c);
  const nowS = Math.floor(c.d.now().getTime() / 1000);
  if (!who.authTime || nowS - who.authTime > 300) throw new HttpError(401, 'For your security, sign in again, then sign out everywhere.', 'reauth');
  if (!c.env.FIRESTORE_EMULATOR_HOST) {
    const r = await c.d.fetch(`https://identitytoolkit.googleapis.com/v1/projects/${c.env.FIREBASE_PROJECT_ID}/accounts:update`, {
      method: 'POST', headers: { authorization: `Bearer ${await accessToken(c.env, c.d)}`, 'content-type': 'application/json' }, body: JSON.stringify({ localId: who.uid, validSince: String(nowS) }),
    });
    if (!r.ok) throw new HttpError(502, 'We could not sign your other devices out. Please try again.', 'unavailable');
  }
  return json({ ok: true }, 200, c.headers);
}
