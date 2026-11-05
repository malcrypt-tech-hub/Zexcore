/**
 * Tenant WhatsApp follow-up sequences.
 *
 * Only opted-in recipients are queued. Every outbound message uses a Meta-approved
 * template, which is valid both inside and outside the 24-hour customer-service window.
 * Jobs are persisted in Firestore and claimed with updateTime preconditions by the cron worker.
 */
import type { Ctx, Deps, Env } from '../env';
import { requireMember, DOERS } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { tenantWhatsAppToken } from './whatsapp';
import { HttpError, json, readJson, randomHex } from '../util';

const ID = /^[A-Za-z0-9_-]{1,48}$/;
const PHONE = /^\+?[1-9]\d{7,14}$/;
const MAX_STEPS = 12;
const MAX_DELAY = 365 * 86400000;
type Step = { delayMinutes: number; templateName: string; language: string; bodyParameters: string[] };
type Sequence = { name: string; enabled: boolean; trigger: string; steps: Step[] };

function cleanSequence(v: any): Sequence {
  const name = String(v?.name ?? '').trim();
  const trigger = String(v?.trigger ?? '').trim();
  if (!name || name.length > 80 || !/^[a-z][a-z0-9_.-]{2,80}$/.test(trigger)) throw new HttpError(400, 'Enter a sequence name and a valid event trigger.');
  if (!Array.isArray(v?.steps) || v.steps.length < 1 || v.steps.length > MAX_STEPS) throw new HttpError(400, 'A sequence needs 1–12 steps.');
  let total = 0;
  const steps = v.steps.map((s: any) => {
    const delayMinutes = Number(s?.delayMinutes);
    const templateName = String(s?.templateName ?? '').trim();
    const language = String(s?.language ?? 'en').trim();
    const bodyParameters = Array.isArray(s?.bodyParameters) ? s.bodyParameters.map((x: unknown) => String(x).slice(0, 500)) : [];
    total += delayMinutes * 60000;
    if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || total > MAX_DELAY ||
        !/^[a-z0-9_]{2,128}$/.test(templateName) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) || bodyParameters.length > 10) {
      throw new HttpError(400, 'Check each step delay, approved template name, language and parameters.');
    }
    return { delayMinutes, templateName, language, bodyParameters };
  });
  return { name, trigger, enabled: v.enabled === true, steps };
}

const consentPath = (wid: string, phone: string) => `workspaces/${wid}/whatsappConsents/${phone.replace(/\D/g, '')}`;
const seqPath = (wid: string, id: string) => `workspaces/${wid}/whatsappSequences/${id}`;

export async function manageWhatsAppSequences(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 20_000);
  const { wid, caller } = await requireMember(c, b.workspaceId, ['owner', 'admin']);
  const action = String(b.action ?? 'list');
  if (action === 'list') {
    const rows = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'whatsappSequences', limit: 100 });
    return json({ sequences: rows.map(x => ({ id: x.id, ...x.data })) }, 200, c.headers);
  }
  if (action === 'save') {
    const id = String(b.id ?? randomHex(12));
    if (!ID.test(id)) throw new HttpError(400, 'Invalid sequence ID.');
    const sequence = cleanSequence(b.sequence);
    await fsCommit(c.env, c.d, [{ path: seqPath(wid, id), fields: { ...sequence, updatedBy: caller.uid, updatedAt: c.d.now() } }]);
    return json({ ok: true, id }, 200, c.headers);
  }
  if (action === 'delete') {
    const id = String(b.id ?? '');
    if (!ID.test(id)) throw new HttpError(400, 'Invalid sequence ID.');
    await fsCommit(c.env, c.d, [{ path: seqPath(wid, id), delete: true }]);
    return json({ ok: true }, 200, c.headers);
  }
  throw new HttpError(400, 'Unknown sequence action.');
}

/** Workspace staff can record consent only after receiving it through their own customer interaction. */
export async function setWhatsAppConsent(c: Ctx): Promise<Response> {
  const b = await readJson(c.req, 2048);
  const { wid, caller } = await requireMember(c, b.workspaceId, DOERS);
  const phone = String(b.phone ?? '').replace(/[\s().-]/g, '');
  if (!PHONE.test(phone)) throw new HttpError(400, 'Enter a phone number in international format.');
  const optedIn = b.optedIn === true;
  const path = consentPath(wid, phone);
  const prior = await fsGet(c.env, c.d, path);
  await fsCommit(c.env, c.d, [{ path, fields: { phone, optedIn, source: String(b.source ?? 'dashboard').slice(0, 40),
    updatedBy: caller.uid, updatedAt: c.d.now(), ...(optedIn ? { optedInAt: c.d.now() } : { optedOutAt: c.d.now() }) },
    ...(prior ? { precondition: { updateTime: prior.updateTime } } : { precondition: { exists: false } }) }]);
  return json({ ok: true, optedIn }, 200, c.headers);
}

/** Called by trusted event handlers after re-reading the underlying business event. */
export async function enqueueWhatsAppEvent(c: { env: Env; d: Deps }, wid: string, event: string, payload: Record<string, unknown>, eventId: string): Promise<number> {
  if (!ID.test(eventId) || !event || event.length > 100) return 0;
  const phoneRaw = String((payload.customer as any)?.phone ?? (payload.booking as any)?.customerPhone ?? '');
  const phone = phoneRaw.replace(/[\s().-]/g, '');
  if (!PHONE.test(phone)) return 0;
  const consent = await fsGet(c.env, c.d, consentPath(wid, phone));
  if (consent?.data.optedIn !== true) return 0;
  const sequences = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'whatsappSequences',
    where: [{ field: 'enabled', op: 'EQUAL', value: true }, { field: 'trigger', op: 'EQUAL', value: event }], limit: 30 });
  const now = c.d.now(); const writes = [];
  for (const seq of sequences) {
    const steps = Array.isArray(seq.data.steps) ? seq.data.steps as Step[] : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const id = `${eventId}_${seq.id}_${i}`.slice(0, 48);
      writes.push({ path: `workspaces/${wid}/whatsappJobs/${id}`, fields: {
        sequenceId: seq.id, sequenceName: String(seq.data.name ?? ''), eventId, event, step: i,
        phone, templateName: step.templateName, language: step.language, bodyParameters: step.bodyParameters ?? [],
        status: 'queued', runAt: new Date(now.getTime() + Math.max(0, step.delayMinutes) * 60000),
        attempts: 0, createdAt: now,
      }, precondition: { exists: false } as const });
    }
  }
  if (writes.length) {
    for (let i = 0; i < writes.length; i += 450) {
      try { await fsCommit(c.env, c.d, writes.slice(i, i + 450)); } catch (e) { if (!(e instanceof FsConflict)) throw e; }
    }
  }
  return writes.length;
}

/** One cron pass. A lease is the Firestore updateTime precondition; duplicate cron invocations cannot send the same job. */
export async function scheduledWhatsApp(env: Env, d: Deps): Promise<number> {
  const workspaces = await fsQuery(env, d, { collection: 'workspaces', limit: 50 });
  let sent = 0;
  for (const ws of workspaces) {
    const wid = ws.id;
    const due = await fsQuery(env, d, { parent: `workspaces/${wid}`, collection: 'whatsappJobs',
      where: [{ field: 'status', op: 'EQUAL', value: 'queued' }, { field: 'runAt', op: 'LESS_THAN_OR_EQUAL', value: d.now() }],
      orderBy: [{ field: 'runAt' }], limit: 10 });
    for (const job of due) {
      const leaseUntil = new Date(d.now().getTime() + 90_000);
      try {
        await fsCommit(env, d, [{ path: job.path, fields: { status: 'sending', leaseUntil, attempts: Number(job.data.attempts ?? 0) + 1 },
          mask: ['status', 'leaseUntil', 'attempts'], precondition: { updateTime: job.updateTime } }]);
      } catch (e) { if (e instanceof FsConflict) continue; throw e; }
      const consent = await fsGet(env, d, consentPath(wid, String(job.data.phone)));
      if (consent?.data.optedIn !== true) {
        await fsCommit(env, d, [{ path: job.path, fields: { status: 'cancelled', reason: 'consent_revoked', completedAt: d.now() }, mask: ['status', 'reason', 'completedAt'] }]);
        continue;
      }
      const connection = await tenantWhatsAppToken({ env, d } as any, wid);
      if (!connection) {
        await fsCommit(env, d, [{ path: job.path, fields: { status: 'failed', reason: 'whatsapp_not_connected', completedAt: d.now() }, mask: ['status', 'reason', 'completedAt'] }]);
        continue;
      }
      const components = job.data.bodyParameters && (job.data.bodyParameters as string[]).length
        ? [{ type: 'body', parameters: (job.data.bodyParameters as string[]).map(text => ({ type: 'text', text })) }] : [];
      const response = await d.fetch(`https://graph.facebook.com/v21.0/${connection.phoneNumberId}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(job.data.phone).replace(/^\+/, ''),
          type: 'template', template: { name: job.data.templateName, language: { code: job.data.language }, ...(components.length ? { components } : {}) } }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (response?.ok) {
        const result = await response.json().catch(() => ({})) as any;
        await fsCommit(env, d, [{ path: job.path, fields: { status: 'sent', providerMessageId: result?.messages?.[0]?.id ?? null, sentAt: d.now() }, mask: ['status', 'providerMessageId', 'sentAt'] }]);
        sent++;
      } else {
        const attempts = Number(job.data.attempts ?? 0) + 1;
        const retry = attempts < 5;
        await fsCommit(env, d, [{ path: job.path, fields: { status: retry ? 'queued' : 'failed',
          runAt: new Date(d.now().getTime() + Math.min(6 * 3600000, 60_000 * 2 ** attempts)),
          lastError: response ? `meta_http_${response.status}` : 'network_error', leaseUntil: null }, mask: ['status', 'runAt', 'lastError', 'leaseUntil'] }]);
      }
    }
  }
  return sent;
}
