/** One welcome e-mail per person, sent the first time a signed-in, verified address reaches the app. */
import type { Ctx } from '../env';
import { verifyFirebaseIdToken } from '../auth';
import { FsConflict, fsCommit, fsGet } from '../fs';
import { sendFormal } from '../mail';
import { firstName, json } from '../util';

// POST /api/welcome   (signed in; takes no input)
export async function welcome(c: Ctx): Promise<Response> {
  const bearer = /^Bearer (.+)$/.exec(c.req.headers.get('authorization') ?? '')?.[1];
  const caller = bearer ? await verifyFirebaseIdToken(c.env, c.d, bearer) : null;
  if (!caller?.email) return json({ ok: false }, 401, c.headers);
  // Only to an address that proved it is theirs, so nobody can use ZexCore to send mail to someone else's address.
  if (!caller.emailVerified) return json({ ok: true, sent: false, reason: 'unverified' }, 200, c.headers);
  const u = await fsGet(c.env, c.d, `users/${caller.uid}`);
  if (!u || u.data.welcomedAt) return json({ ok: true, sent: false }, 200, c.headers);
  const wsId = Array.isArray(u.data.workspaceIds) ? String(u.data.workspaceIds[0] ?? '') : '';
  const ws = wsId ? await fsGet(c.env, c.d, `workspaces/${wsId}`) : null;
  // Mark first so a retry or a second tab cannot send it twice.
  try { await fsCommit(c.env, c.d, [{ path: u.path, fields: { welcomedAt: c.d.now() }, mask: ['welcomedAt'], precondition: { updateTime: u.updateTime } }]); }
  catch (e) { if (e instanceof FsConflict) return json({ ok: true, sent: false }, 200, c.headers); throw e; }
  const name = firstName(u.data.name, caller.email);
  const app = c.env.APP_URL.replace(/\/$/, '');
  const bizName = String(ws?.data.name ?? '');
  const sent = await sendFormal(c.env, c.d, caller.email, `Welcome to ZexCore, ${name}`, {
    heading: `Welcome to ZexCore, ${name}`, preheader: 'Your workspace is ready. Here is how to get your first booking.', greeting: `Dear ${name},`,
    paragraphs: [
      `Thank you for creating your ZexCore account${bizName ? ` and your workspace, ${bizName}` : ''}. ZexCore brings your booking page, customers, deposits and WhatsApp replies together in one place.`,
      `To begin taking bookings, please add your services and opening hours, then share your booking link with your customers. You can sign in to your dashboard at ${app}/app.`,
      'If you need any help, reply to this email and a member of our team will respond.',
    ],
  });
  return json({ ok: true, sent }, 200, c.headers);
}
