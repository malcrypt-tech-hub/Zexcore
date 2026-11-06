/**
 * Emails to customers around their appointment, sent from the hourly job through the durable outbox.
 *
 *  - Reminder: about a day before a confirmed appointment (workspace setting `reminderEmails`). Only for bookings made more than
 *    26 hours ahead; a customer who booked for tomorrow morning was just told and does not need a second email.
 *  - Thank-you: a day after a visit the business marked completed, with a link to book again (setting `followUpEmails`, off unless
 *    the owner switches it on).
 *
 * Only workspaces that switched the setting on are scanned. Each email has a key per booking, so overlapping hourly windows never send twice.
 */
import type { Deps, Env } from '../env';
import { fsGet, fsQuery } from '../fs';
import { queueFormal } from '../outbox';
import { localWhen } from '../util';

const HOUR = 3_600_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_WORKSPACES = 60, MAX_BOOKINGS = 300;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);
const first = (n: unknown): string => String(n ?? '').trim().split(/\s+/)[0] || 'there';

export type Kind = 'reminder' | 'followup';

export async function sendCustomerEmails(env: Env, d: Deps, wid: string, kind: Kind): Promise<number> {
  const now = d.now().getTime();
  const ws = await fsGet(env, d, `workspaces/${wid}`);
  if (!ws || ws.data.status === 'closing' || ws.data.status === 'deleted') return 0;
  const st = (ws.data.settings ?? {}) as Record<string, unknown>;
  if (kind === 'reminder' ? st.reminderEmails !== true : st.followUpEmails !== true) return 0;
  const off = Number(st.utcOffsetMinutes ?? 60);
  const biz = String(st.publicName ?? ws.data.name ?? 'the business');
  const slug = String(ws.data.slug ?? '');
  const phone = typeof st.phone === 'string' && st.phone ? st.phone : '';
  const [from, to] = kind === 'reminder' ? [now + HOUR, now + 25 * HOUR] : [now - 48 * HOUR, now - 20 * HOUR];
  const rows = await fsQuery(env, d, { parent: `workspaces/${wid}`, collection: 'bookings', limit: MAX_BOOKINGS,
    where: [{ field: 'startsAt', op: 'GREATER_THAN_OR_EQUAL', value: new Date(from) }, { field: 'startsAt', op: 'LESS_THAN', value: new Date(to) }] });
  let queued = 0;
  for (const b of rows) {
    const starts = ms(b.data.startsAt), email = String(b.data.customerEmail ?? '').trim();
    if (!EMAIL_RE.test(email) || starts < from || starts >= to) continue;                      // the test mock ignores query filters, so check again
    if (kind === 'reminder' && (b.data.status !== 'confirmed' || starts - ms(b.data.createdAt) <= 26 * HOUR)) continue;
    if (kind === 'followup' && b.data.status !== 'completed') continue;
    const svc = await fsGet(env, d, `workspaces/${wid}/services/${String(b.data.serviceId)}`);
    const service = String(svc?.data.name ?? 'Service');
    const when = localWhen(new Date(starts).toISOString(), off);
    const link = slug ? { button: { text: kind === 'reminder' ? 'View booking page' : 'Book again', url: `${env.APP_URL.replace(/\/$/, '')}/${slug}` } } : {};
    const r = kind === 'reminder'
      ? await queueFormal(env, d, `remind:${wid}:${b.id}`, email, `Reminder: your appointment with ${biz}`, {
        heading: 'Your appointment is coming up', greeting: `Hello ${first(b.data.customerName)},`,
        paragraphs: [`This is a reminder of your appointment with ${biz}.`, `If you need to change or cancel it, please contact the business${phone ? ` on ${phone}` : ''} as soon as you can.`],
        details: [['Business', biz], ['Service', service], ['Time', when], ['Reference', `ZX-${b.id.replace('_', '-')}`]], ...link }, wid)
      : await queueFormal(env, d, `followup:${wid}:${b.id}`, email, `Thank you for visiting ${biz}`, {
        heading: 'Thank you for your visit', greeting: `Hello ${first(b.data.customerName)},`,
        paragraphs: [`Thank you for choosing ${biz}. We hope everything went well.`, 'You are welcome to book your next appointment whenever you are ready.'],
        details: [['Business', biz], ['Service', service], ['Visit', when]], ...link,
        note: 'You are receiving this because you gave your email address when you booked.' }, wid);
    if (r !== 'duplicate' && r !== 'dead') queued++;
  }
  return queued;
}

/** Hourly: reminders and thank-yous for every workspace that switched them on. */
export async function scheduledCustomerEmails(env: Env, d: Deps): Promise<{ reminders: number; followups: number }> {
  const out = { reminders: 0, followups: 0 };
  for (const [kind, field] of [['reminder', 'settings.reminderEmails'], ['followup', 'settings.followUpEmails']] as const) {
    const spaces = await fsQuery(env, d, { collection: 'workspaces', where: [{ field, op: 'EQUAL', value: true }], limit: MAX_WORKSPACES });
    for (const w of spaces) {
      try { const n = await sendCustomerEmails(env, d, w.id, kind); if (kind === 'reminder') out.reminders += n; else out.followups += n; }
      catch (e) { console.error(`${kind} emails failed`, w.id, e instanceof Error ? e.message : e); }
    }
  }
  return out;
}
