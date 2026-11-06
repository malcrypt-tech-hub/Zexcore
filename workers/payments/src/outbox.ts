/**
 * A durable outbox for email that must not be lost.
 *
 * Instead of sending and hoping, a message is first written to Firestore (`emailOutbox/{id}`) and then sent. If the
 * provider is down, rate-limits us, or the Worker dies halfway, the message is still there and the hourly job
 * retries it with growing waits (1 min, 5 min, 30 min, 2 h, 12 h; then it is marked dead after 6 tries).
 *
 *  - Duplicates: the document id comes from a caller-supplied key (for example `ack:<workspace>:<booking>`), so asking
 *    twice queues once. The same id is sent to Resend as an Idempotency-Key, so a retry after a crash that happened
 *    *after* the provider accepted the message does not send it twice (the provider remembers keys for about a day).
 *  - Crash recovery: a worker takes a message by writing `sending` plus a 5-minute lease, guarded by the document's
 *    update time so two workers cannot both take it. If it dies, the lease runs out and the next run takes over.
 *  - Privacy: once sent, the subject and body are erased; the record is deleted after 7 days (dead ones after 30).
 *
 * Only the Worker can read or write this collection (no Firestore rule opens it).
 */
import type { Deps, Env } from './env';
import { FsConflict, fsCommit, fsGet, fsQuery, type FsDoc } from './fs';
import { createEmailProvider } from './email-provider';
import { renderEmail, type EmailSpec } from './mail';
import { sha256Hex } from './util';

export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = 6;
const LEASE_MS = 5 * 60_000;
const KEEP_SENT_MS = 7 * 86_400_000, KEEP_DEAD_MS = 30 * 86_400_000;
const NOT_CONFIGURED_WAIT_MS = 60 * 60_000;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

export type QueueResult = 'sent' | 'queued' | 'duplicate' | 'dead';

export async function outboxId(key: string): Promise<string> { return (await sha256Hex(`email:${key}`)).slice(0, 32); }

/** Queue one email and try to send it right away. Safe to call twice with the same key. */
export async function queueEmail(env: Env, d: Deps, o: { key: string; to: string; subject: string; text: string; html?: string; wid?: string }): Promise<QueueResult> {
  const id = await outboxId(o.key);
  const now = d.now();
  try {
    await fsCommit(env, d, [{ path: `emailOutbox/${id}`, precondition: { exists: false },
      fields: { key: o.key, to: o.to, subject: o.subject, text: o.text, html: o.html ?? null, wid: o.wid ?? null, status: 'pending', attempts: 0, nextAttemptAt: now, lockedUntil: null, lastError: null, createdAt: now, sentAt: null } }]);
  } catch (e) { if (e instanceof FsConflict) return 'duplicate'; throw e; }
  const r = await attemptDelivery(env, d, id);
  return r === 'sent' ? 'sent' : r === 'dead' ? 'dead' : 'queued';
}

/** Render a formal message and queue it. */
export async function queueFormal(env: Env, d: Deps, key: string, to: string, subject: string, spec: EmailSpec, wid?: string): Promise<QueueResult> {
  const { text, html } = renderEmail(spec, env.APP_URL.replace(/\/$/, ''));
  return queueEmail(env, d, { key, to, subject, text, html, ...(wid ? { wid } : {}) });
}

export type AttemptResult = 'sent' | 'retry' | 'dead' | 'busy' | 'wait' | 'done';

/** Take a due message and send it once. Never throws for provider trouble; that becomes a retry. */
export async function attemptDelivery(env: Env, d: Deps, id: string): Promise<AttemptResult> {
  const doc = await fsGet(env, d, `emailOutbox/${id}`);
  if (!doc) return 'done';
  return attemptDoc(env, d, doc);
}

async function attemptDoc(env: Env, d: Deps, doc: FsDoc): Promise<AttemptResult> {
  const now = d.now().getTime();
  const status = String(doc.data.status);
  if (status === 'sent' || status === 'dead') return 'done';
  if (status === 'sending' && ms(doc.data.lockedUntil) > now) return 'busy';
  if (status === 'pending' && ms(doc.data.nextAttemptAt) > now) return 'wait';
  const attempts = Number(doc.data.attempts ?? 0) + 1;
  try {
    await fsCommit(env, d, [{ path: doc.path, fields: { status: 'sending', lockedUntil: new Date(now + LEASE_MS), attempts }, mask: ['status', 'lockedUntil', 'attempts'], precondition: { updateTime: doc.updateTime } }]);
  } catch (e) { if (e instanceof FsConflict) return 'busy'; throw e; }      // another worker took it

  let result;
  try {
    result = await createEmailProvider(env, d).send({ to: String(doc.data.to), subject: String(doc.data.subject), text: String(doc.data.text), ...(doc.data.html ? { html: String(doc.data.html) } : {}), idempotencyKey: doc.id });
  } catch (e) { result = { ok: false as const, provider: 'resend' as const, reason: 'network_error' as const, retryable: true, _e: e }; }

  const at = d.now();
  if (result.ok) {
    await fsCommit(env, d, [{ path: doc.path, fields: { status: 'sent', sentAt: at, lockedUntil: null, lastError: null, subject: null, text: null, html: null, messageId: result.messageId ?? null }, mask: ['status', 'sentAt', 'lockedUntil', 'lastError', 'subject', 'text', 'html', 'messageId'] }]);
    return 'sent';
  }
  if (result.reason === 'not_configured') {   // no provider yet: wait, and do not use up a try
    await fsCommit(env, d, [{ path: doc.path, fields: { status: 'pending', lockedUntil: null, attempts: attempts - 1, nextAttemptAt: new Date(at.getTime() + NOT_CONFIGURED_WAIT_MS), lastError: 'not_configured' }, mask: ['status', 'lockedUntil', 'attempts', 'nextAttemptAt', 'lastError'] }]);
    return 'retry';
  }
  if (!result.retryable || attempts >= MAX_ATTEMPTS) {
    await fsCommit(env, d, [{ path: doc.path, fields: { status: 'dead', lockedUntil: null, lastError: result.reason, subject: null, text: null, html: null, deadAt: at }, mask: ['status', 'lockedUntil', 'lastError', 'subject', 'text', 'html', 'deadAt'] }]);
    console.error('email gave up', doc.id, result.reason, `after ${attempts} tries`);
    return 'dead';
  }
  const wait = (BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 720) * 60_000;
  await fsCommit(env, d, [{ path: doc.path, fields: { status: 'pending', lockedUntil: null, nextAttemptAt: new Date(at.getTime() + wait), lastError: result.reason }, mask: ['status', 'lockedUntil', 'nextAttemptAt', 'lastError'] }]);
  return 'retry';
}

/** Hourly: retry what is due, take over messages whose worker died, and clear out old records. */
export async function drainOutbox(env: Env, d: Deps, max = 50): Promise<{ sent: number; retried: number; dead: number; purged: number }> {
  const now = d.now().getTime();
  const [pending, sending, sent, dead] = await Promise.all(['pending', 'sending', 'sent', 'dead'].map((status) =>
    fsQuery(env, d, { collection: 'emailOutbox', where: [{ field: 'status', op: 'EQUAL', value: status }], limit: 100 })));
  const due = [
    ...pending!.filter((x) => x.data.status === 'pending' && ms(x.data.nextAttemptAt) <= now),
    ...sending!.filter((x) => x.data.status === 'sending' && ms(x.data.lockedUntil) <= now),      // crash recovery
  ].slice(0, max);
  const out = { sent: 0, retried: 0, dead: 0, purged: 0 };
  for (const x of due) {
    try {
      const r = await attemptDoc(env, d, x);
      if (r === 'sent') out.sent++; else if (r === 'retry') out.retried++; else if (r === 'dead') out.dead++;
    } catch (e) { console.error('outbox attempt failed', x.id, e instanceof Error ? e.message : e); }
  }
  const old = [
    ...sent!.filter((x) => x.data.status === 'sent' && now - ms(x.data.sentAt) > KEEP_SENT_MS),
    ...dead!.filter((x) => x.data.status === 'dead' && now - ms(x.data.deadAt) > KEEP_DEAD_MS),
  ];
  for (const x of old.slice(0, 100)) { await fsCommit(env, d, [{ path: x.path, delete: true }]).catch(() => undefined); out.purged++; }
  return out;
}
