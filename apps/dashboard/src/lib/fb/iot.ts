import { collection, deleteDoc, getDocs, limit as qLimit, orderBy, query, updateDoc, writeBatch, addDoc, serverTimestamp } from 'firebase/firestore';
import { fb, paymentsUrl } from './firebase';
import { ApiError, audit, claimSlot, iso, loadCtx, requireAdmin, requireFeature, wsCol, wsDoc } from './core';

const ONLINE_MS = 10 * 60_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq'];

/** 32 random bytes, shown to the person once. Only its SHA-256 hash is stored. */
async function newToken(): Promise<{ token: string; hash: string }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return { token, hash: Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('') };
}

const dto = (id: string, x: Record<string, any>) => {
  const seen = iso(x.lastSeenAt);
  return { id, device_key: x.deviceKey, name: x.name, kind: x.kind, status: !seen ? 'unknown' : Date.now() - new Date(seen).getTime() < ONLINE_MS ? 'online' : 'offline',
    firmware_version: null, tags: null, last_seen_at: seen, created_at: iso(x.createdAt) ?? new Date().toISOString() };
};

export async function listDevices(): Promise<{ devices: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'devices'), orderBy('seq'), qLimit(200)));
  return { devices: s.docs.map((d) => dto(d.id, d.data())) };
}
export async function latest(): Promise<{ latest: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(wsCol(c, 'devices'));
  return { latest: s.docs.filter((d) => d.data().latest).map((d) => ({ device_id: d.id, metrics: d.data().latest, recorded_at: iso(d.data().latestAt) })) };
}
export async function createDevice(b: Record<string, unknown>): Promise<{ device: unknown; token: string }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  const name = String(b.name ?? '').trim(), deviceKey = String(b.deviceKey ?? '').trim(), kind = String(b.kind ?? '').trim();
  if (name.length < 1 || name.length > 128) throw new ApiError(400, 'Give the device a name.');
  if (!KEY_RE.test(deviceKey)) throw new ApiError(400, 'The device ID needs 3 to 64 letters, numbers, dashes or underscores.');
  if (kind.length < 1 || kind.length > 64) throw new ApiError(400, 'Say what kind of device it is.');
  const existing = (await getDocs(wsCol(c, 'devices'))).docs.some((d) => d.data().deviceKey === deviceKey);
  if (existing) throw new ApiError(409, 'A device with that ID already exists.', 'conflict');
  const { token, hash } = await newToken();
  const id = await claimSlot(c, 'devices', 'd', 'devices', { name, deviceKey, kind, tokenHash: hash });
  void audit(c, 'device.create', 'device', id);
  return { device: dto(id, { name, deviceKey, kind }), token };
}
export async function patchDevice(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  const name = String(b.name ?? '').trim();
  if (name.length < 1 || name.length > 128) throw new ApiError(400, 'Give the device a name.');
  await updateDoc(wsDoc(c, 'devices', id), { name });
  return { ok: true };
}
export async function rotateToken(id: string): Promise<{ token: string }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  const { token, hash } = await newToken();
  await updateDoc(wsDoc(c, 'devices', id), { tokenHash: hash });
  void audit(c, 'device.rotate_token', 'device', id);
  return { token };
}
export async function removeDevice(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  const { db } = fb();
  for (let i = 0; i < 20; i++) {                       // readings and their rules go with the device
    const r = await getDocs(query(collection(db, 'workspaces', c.wid, 'devices', id, 'readings'), qLimit(400))).catch(() => null);
    if (!r || r.empty) break;
    const batch = writeBatch(db); r.docs.forEach((d) => batch.delete(d.ref)); await batch.commit();
  }
  const rules = await getDocs(wsCol(c, 'alertRules'));
  await Promise.all(rules.docs.filter((d) => d.data().deviceId === id).map((d) => deleteDoc(d.ref)));
  await deleteDoc(wsDoc(c, 'devices', id));
  void audit(c, 'device.remove', 'device', id);
  return { ok: true };
}

// ───────────── alert rules and fired alerts ─────────────
export async function listAlertRules(): Promise<{ alerts: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'alertRules'), orderBy('createdAt', 'desc'), qLimit(200)));
  return { alerts: s.docs.map((d) => ({ id: d.id, device_id: d.data().deviceId ?? null, metric: d.data().metric, op: d.data().op, threshold: d.data().threshold, severity: d.data().severity, message: d.data().message ?? null, enabled: d.data().enabled !== false })) };
}
export async function createAlertRule(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  const metric = String(b.metric ?? '').trim();
  if (!/^[A-Za-z0-9_]{1,40}$/.test(metric)) throw new ApiError(400, 'Use the reading name your device sends, for example temperature.');
  if (!OPS.includes(String(b.op))) throw new ApiError(400, 'Choose when the alert should fire.');
  const threshold = Number(b.threshold);
  if (!Number.isFinite(threshold)) throw new ApiError(400, 'Enter a number for the limit.');
  const severity = String(b.severity ?? 'medium');
  if (!['low', 'medium', 'high', 'critical'].includes(severity)) throw new ApiError(400, 'Choose a severity.');
  const ref = await addDoc(wsCol(c, 'alertRules'), { deviceId: b.deviceId ? String(b.deviceId) : null, metric, op: b.op, threshold, severity, message: String(b.message ?? '').slice(0, 255), enabled: true, createdAt: serverTimestamp(), lastFiredAt: null });
  void audit(c, 'alert_rule.create', 'alert_rule', ref.id);
  return { id: ref.id };
}
export async function removeAlertRule(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'devices');
  await deleteDoc(wsDoc(c, 'alertRules', id));
  return { ok: true };
}
export async function recentAlerts(): Promise<{ alerts: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'alerts'), orderBy('at', 'desc'), qLimit(50)));
  return { alerts: s.docs.map((d) => ({ id: d.id, device_name: d.data().deviceName, severity: d.data().severity, message: d.data().message, at: iso(d.data().at) })) };
}

/** Where devices send readings (the Worker). Shown in the "Add device" instructions. */
export const ingestUrl = (): string => `${paymentsUrl() || 'https://YOUR-WORKER.workers.dev'}/api/iot/ingest`;
