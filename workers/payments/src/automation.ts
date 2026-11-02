/** Runs approved automation rules for an event, records what happened, and never lets one bad rule stop the others. */
import { evaluate, render, safeWebhookUrl, sourceOf, type RuleDef } from '../../../shared/rules-engine';
import type { Ctx } from './env';
import { fsCommit, fsGet, fsQuery } from './fs';
import { sendFormal } from './mail';
import { firstName, randomHex } from './util';

const DAY = 86_400_000;

export async function ownerEmail(c: Ctx, wid: string): Promise<string> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const uid = ws?.data.ownerUid as string | undefined;
  const m = uid ? await fsGet(c.env, c.d, `workspaces/${wid}/members/${uid}`) : null;
  return String(m?.data.email ?? '');
}

export async function ownerContact(c: Ctx, wid: string): Promise<{ email: string; name: string }> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  const uid = ws?.data.ownerUid as string | undefined;
  const m = uid ? await fsGet(c.env, c.d, `workspaces/${wid}/members/${uid}`) : null;
  const u = uid ? await fsGet(c.env, c.d, `users/${uid}`) : null;
  const email = String(m?.data.email ?? '');
  return { email, name: firstName(u?.data.name ?? m?.data.name, email) };
}

export async function fireEvent(c: Ctx, wid: string, event: string, payload: Record<string, unknown>): Promise<number> {
  const rules = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'rules', where: [{ field: 'enabled', op: 'EQUAL', value: true }, { field: 'approved', op: 'EQUAL', value: true }], limit: 50 });
  const noisy = event.startsWith('iot.');
  let ran = 0;
  for (const r of rules) {
    const def: RuleDef = { trigger: r.data.trigger, conditions: r.data.conditions ?? null, actions: Array.isArray(r.data.actions) ? r.data.actions : [] };
    if (sourceOf(def.trigger) !== event || !evaluate(def, event, payload).wouldExecute) continue;
    const last = r.data.lastRunAt instanceof Date ? r.data.lastRunAt.getTime() : 0;
    if (noisy && c.d.now().getTime() - last < 60_000) continue;     // a chatty sensor must not flood the team
    const notes: string[] = []; let failed = 0;
    for (const a of def.actions) {
      try {
        if (a.type === 'notify') {
          const text = render(a.message, payload);
          notes.push(`Notified: ${text}`);
          const owner = await ownerContact(c, wid);
          await sendFormal(c.env, c.d, owner.email, `ZexCore: ${String(r.data.name ?? 'Automation')}`, {
            heading: String(r.data.name ?? 'Automation'), greeting: `Hello ${owner.name},`, paragraphs: [text],
            details: [['Triggered by', event], ['Time', c.d.now().toISOString().replace('T', ' ').slice(0, 16) + ' UTC']],
            button: { text: 'Open dashboard', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/automations` }, note: 'You are receiving this because an automation in your workspace is set to notify you.' });
        } else if (a.type === 'webhook') {
          if (!safeWebhookUrl(a.url)) { failed += 1; notes.push('Webhook skipped: address not allowed'); continue; }
          const res = await c.d.fetch(a.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'user-agent': 'ZexCore-Automations/1' },
            body: JSON.stringify({ event, workspaceId: wid, rule: r.data.name, at: c.d.now().toISOString(), data: payload }) });
          if (res.ok) notes.push(`Webhook called (${res.status})`); else { failed += 1; notes.push(`Webhook failed (${res.status})`); }
        }
      } catch { failed += 1; notes.push(`${a.type} failed`); }
    }
    const now = c.d.now();
    await fsCommit(c.env, c.d, [
      { path: `workspaces/${wid}/automationRuns/${randomHex(10)}`, fields: { ruleId: r.id, ruleName: String(r.data.name ?? ''), event, outcome: failed ? (failed === def.actions.length ? 'failed' : 'partial') : 'ok', detail: notes.join(' · ').slice(0, 500), at: now, expireAt: new Date(now.getTime() + 30 * DAY) } },
      { path: r.path, fields: { lastRunAt: now }, mask: ['lastRunAt'] },
    ]).catch(() => undefined);
    ran += 1;
  }
  return ran;
}
