/**
 * Device ingest. A device proves who it is with a long random token that is shown once and stored only as a SHA-256 hash.
 *   POST /api/iot/ingest   headers: x-tenant-id (workspace id), x-device-token   body: { metrics: { temperature: 4.2 } }
 */
import { alertHit, ALERT_OPS, type AlertOp } from '../../../../shared/rules-engine';
import { fireEvent, ownerContact } from '../automation';
import type { Ctx } from '../env';
import { fsCommit, fsQuery } from '../fs';
import { sendFormal } from '../mail';
import { HttpError, WID_RE, json, randomHex, readJson, sha256Hex, timingSafeEqual } from '../util';

const DAY = 86_400_000;
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const TOKEN_RE = /^[a-f0-9]{48,128}$/;

export async function ingest(c: Ctx): Promise<Response> {
  const wid = c.req.headers.get('x-tenant-id') ?? '';
  const token = c.req.headers.get('x-device-token') ?? '';
  if (!WID_RE.test(wid) || !TOKEN_RE.test(token)) throw new HttpError(401, 'Invalid device credentials', 'unauthenticated');
  const body = await readJson(c.req, 4096);
  const raw = body.metrics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Send {"metrics":{"name":value}}');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > 20) throw new HttpError(400, 'Send between 1 and 20 readings');
  const metrics: Record<string, number | string | boolean> = {};
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) throw new HttpError(400, `Invalid reading name "${k.slice(0, 20)}"`);
    if (typeof v === 'number' ? !Number.isFinite(v) : typeof v === 'string' ? v.length > 100 : typeof v !== 'boolean') throw new HttpError(400, `Invalid value for ${k}`);
    metrics[k] = v as never;
  }

  const hash = await sha256Hex(token);
  const [dev] = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'devices', where: [{ field: 'tokenHash', op: 'EQUAL', value: hash }], limit: 1 });
  if (!dev || !timingSafeEqual(String(dev.data.tokenHash), hash)) throw new HttpError(401, 'Invalid device credentials', 'unauthenticated');

  const now = c.d.now();
  const prev = dev.data.latestAt instanceof Date ? dev.data.latestAt.getTime() : 0;
  if (now.getTime() - prev < 1000) throw new HttpError(429, 'Too many readings. Send at most one per second.', 'rate_limited');

  await fsCommit(c.env, c.d, [
    { path: `workspaces/${wid}/devices/${dev.id}/readings/${randomHex(10)}`, fields: { metrics, recordedAt: now, expireAt: new Date(now.getTime() + 30 * DAY) } },
    { path: dev.path, fields: { latest: metrics, latestAt: now, lastSeenAt: now }, mask: ['latest', 'latestAt', 'lastSeenAt'], precondition: { exists: true } },
  ]);

  const device = { id: dev.id, name: String(dev.data.name ?? ''), key: String(dev.data.deviceKey ?? '') };
  const alerts = await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'alertRules', where: [{ field: 'enabled', op: 'EQUAL', value: true }], limit: 100 });
  let fired = 0;
  for (const a of alerts) {
    const d = a.data;
    if ((d.deviceId && d.deviceId !== dev.id) || !ALERT_OPS.includes(d.op as AlertOp) || !(String(d.metric) in metrics)) continue;
    if (!alertHit(d.op as AlertOp, metrics[String(d.metric)], Number(d.threshold))) continue;
    const last = d.lastFiredAt instanceof Date ? d.lastFiredAt.getTime() : 0;
    if (now.getTime() - last < 10 * 60_000) continue;                 // one alert per rule per ten minutes
    const message = String(d.message || `${device.name}: ${d.metric} is ${metrics[String(d.metric)]}`);
    const alert = { deviceId: dev.id, deviceName: device.name, ruleId: a.id, metric: d.metric, value: metrics[String(d.metric)], op: d.op, threshold: d.threshold, severity: d.severity ?? 'medium', message };
    await fsCommit(c.env, c.d, [
      { path: `workspaces/${wid}/alerts/${randomHex(10)}`, fields: { ...alert, at: now, expireAt: new Date(now.getTime() + 90 * DAY) } },
      { path: a.path, fields: { lastFiredAt: now }, mask: ['lastFiredAt'] },
    ]);
    fired += 1;
    const owner = await ownerContact(c, wid);
    await sendFormal(c.env, c.d, owner.email, `ZexCore alert: ${message}`, {
      heading: 'Device alert', greeting: `Hello ${owner.name},`, paragraphs: [message],
      details: [['Device', String(device.name)], ['Severity', String(alert.severity)], ['Reading', `${String(d.metric)} is ${String(metrics[String(d.metric)])}`], ['Time', now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC']],
      button: { text: 'Open dashboard', url: `${c.env.APP_URL.replace(/\/$/, '')}/app/devices` }, note: 'You receive this because an alert rule on this device fired. Repeats are limited to one every ten minutes.' });
    await fireEvent(c, wid, 'iot.alert', { device, alert });
  }
  await fireEvent(c, wid, 'iot.reading', { device, metrics });
  return json({ ok: true, alertsFired: fired }, 201, c.headers);
}
