/**
 * Meta WhatsApp webhook: verify subscription challenges and signed event payloads.
 * Inbound STOP requests revoke consent; status callbacks update durable send jobs.
 */
import type { Ctx } from '../env';
import { fsCommit, fsGet, fsQuery } from '../fs';
import { json } from '../util';

const enc = new TextEncoder();
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const digits = (s: string) => s.replace(/\\D/g, '');
const integrationPath = (wid: string) => `workspaces/${wid}/integrations/whatsapp`;
const consentPath = (wid: string, phone: string) => `workspaces/${wid}/whatsappConsents/${digits(phone)}`;

async function signatureValid(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const expected = 'sha256=' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  const a = enc.encode(expected.toLowerCase()), b = enc.encode(signature.toLowerCase());
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function whatsappWebhookVerify(c: Ctx): Promise<Response> {
  const mode = c.url.searchParams.get('hub.mode');
  const token = c.url.searchParams.get('hub.verify_token');
  const challenge = c.url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && c.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
      token === c.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && challenge && challenge.length <= 256) {
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain', ...c.headers } });
  }
  return json({ error: 'Webhook verification failed.' }, 403, c.headers);
}

export async function whatsappWebhook(c: Ctx): Promise<Response> {
  const raw = await c.req.text();
  if (raw.length > 1_000_000) return json({ error: 'Payload too large.' }, 413, c.headers);
  const secret = c.env.WHATSAPP_APP_SECRET;
  if (!secret || !(await signatureValid(raw, c.req.headers.get('x-hub-signature-256'), secret))) {
    return json({ error: 'Invalid webhook signature.' }, 401, c.headers);
  }
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON.' }, 400, c.headers); }
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return json({ ok: true, ignored: true }, 200, c.headers);
  }

  let cursor: string | undefined;
  do {
    const workspaces = await fsQuery(c.env, c.d, { collection: 'workspaces', orderBy: [{ field: '__name__' }], limit: 50, ...(cursor ? { startAfterId: cursor } : {}) });
    for (const ws of workspaces) {
      const wid = ws.id;
      const connection = await fsGet(c.env, c.d, integrationPath(wid));
      const phoneId = String(connection?.data.phoneNumberId ?? '');
      if (!connection?.data.enabled || !phoneId) continue;
      for (const entry of payload.entry) for (const change of entry.changes ?? []) {
        const value = change?.value;
        if (String(value?.metadata?.phone_number_id ?? '') !== phoneId) continue;

        for (const message of value.messages ?? []) {
          const phone = digits(String(message?.from ?? ''));
          const text = String(message?.text?.body ?? '').trim().toUpperCase();
          if (!phone || !STOP_WORDS.has(text)) continue;
          const path = consentPath(wid, phone);
          const prior = await fsGet(c.env, c.d, path);
          await fsCommit(c.env, c.d, [{ path, fields: {
            phone: '+' + phone, optedIn: false, source: 'whatsapp_keyword',
            optedOutAt: c.d.now(), updatedAt: c.d.now(),
          }, ...(prior ? { precondition: { updateTime: prior.updateTime } } : { precondition: { exists: false } }) }]);

          // Cancel queued work immediately. The sender also re-checks consent immediately before sending.
          for (const status of ['queued', 'sending']) {
            const jobs = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'whatsappJobs',
              where: [{ field: 'phone', op: 'EQUAL', value: '+' + phone }, { field: 'status', op: 'EQUAL', value: status }], limit: 100 });
            for (const job of jobs) {
              try { await fsCommit(c.env, c.d, [{ path: job.path, fields: {
                status: 'cancelled', reason: 'customer_opted_out', completedAt: c.d.now(), leaseUntil: null,
              }, mask: ['status', 'reason', 'completedAt', 'leaseUntil'], precondition: { updateTime: job.updateTime } }]); }
              catch (e) { if (!(e instanceof Error) || !e.message.includes('firestore commit')) throw e; }
            }
          }
        }

        for (const status of value.statuses ?? []) {
          const messageId = String(status?.id ?? '');
          const state = String(status?.status ?? '');
          if (!messageId || !['sent', 'delivered', 'read', 'failed'].includes(state)) continue;
          const jobs = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'whatsappJobs',
            where: [{ field: 'providerMessageId', op: 'EQUAL', value: messageId }], limit: 5 });
          for (const job of jobs) {
            const fields: Record<string, unknown> = { deliveryStatus: state, deliveryUpdatedAt: c.d.now() };
            if (state === 'delivered') fields.deliveredAt = c.d.now();
            if (state === 'read') fields.readAt = c.d.now();
            if (state === 'failed') { fields.deliveryError = JSON.stringify(status.errors ?? []).slice(0, 1000); fields.failedAt = c.d.now(); }
            await fsCommit(c.env, c.d, [{ path: job.path, fields }]);
          }
        }
      }
    }
    if (!workspaces.length) break;
    cursor = workspaces[workspaces.length - 1]!.id;
    if (workspaces.length < 50) break;
  } while (cursor);
  return json({ ok: true }, 200, c.headers);
}
