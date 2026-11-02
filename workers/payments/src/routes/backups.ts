/**
 * Encrypted workspace backups for Enterprise and Dedicated.
 *
 * A scheduled run (hourly tick, a few workspaces at a time, oldest backup first) reads a workspace through the service
 * account, gzips it, encrypts it with AES-256-GCM (key = BACKUP_KEY secret, bound to this workspace and backup id) and stores
 * it in R2. It then reads the object back, decrypts it and compares the hash, so a backup is only marked "verified" once it
 * has been proven readable. The last 30 are kept. Owners and admins can run one on demand, download a decrypted copy and get
 * a PDF certificate.
 */
import type { Ctx, Deps, Env } from '../env';
import { requireMember } from '../auth';
import { FsConflict, fsCommit, fsGet, fsQuery } from '../fs';
import { sendMail } from '../mail';
import { activePlan, RANK } from './billing';
import { simplePdf } from '../pdf';
import { HttpError, enc, hex, json, sha256Hex } from '../util';

export const KEEP = 30;
const DUE_MS = 23 * 3_600_000;
const PER_TICK = 5;
const PAGE = 300;
const MAX_PAGES = 100;     // per workspace; beyond this the backup is marked incomplete rather than silently cut
const ID_RE = /^b_[0-9]{8}_[0-9]{6}$/;
const MAGIC = new Uint8Array([0x5a, 0x58, 0x42, 0x31]);   // "ZXB1"

/** Collections copied into a backup. `locks` (derived from bookings) and live alerts are left out. */
export const BACKUP_COLLECTIONS = ['members', 'services', 'staff', 'bookings', 'customers', 'contacts', 'leads', 'stages', 'pages', 'messages', 'conversations',
  'rules', 'consents', 'retention', 'erasure', 'payments', 'depositPayments', 'payout', 'devices', 'auditChain', 'auditMeta'] as const;

// ── crypto ──
function keyBytes(env: Env): Uint8Array {
  let raw: Uint8Array;
  try { raw = Uint8Array.from(atob(env.BACKUP_KEY ?? ''), (c) => c.charCodeAt(0)); } catch { raw = new Uint8Array(0); }
  if (raw.length !== 32) throw new HttpError(503, 'Backups are not switched on yet.', 'unavailable');
  return raw;
}
const aesKey = (env: Env, use: 'encrypt' | 'decrypt') => crypto.subtle.importKey('raw', keyBytes(env), 'AES-GCM', false, [use]);
export async function seal(env: Env, wid: string, id: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${wid}/${id}`) }, await aesKey(env, 'encrypt'), plain));
  const out = new Uint8Array(MAGIC.length + 12 + ct.length);
  out.set(MAGIC, 0); out.set(iv, MAGIC.length); out.set(ct, MAGIC.length + 12);
  return out;
}
export async function open(env: Env, wid: string, id: string, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 33 || MAGIC.some((b, i) => blob[i] !== b)) throw new HttpError(500, 'Backup file is not in a known format.');
  const iv = blob.slice(4, 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${wid}/${id}`) }, await aesKey(env, 'decrypt'), blob.slice(16)));
}
const pipe = async (bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(t)).arrayBuffer());
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream('gzip'));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream('gzip'));

// ── reading a workspace ──
async function readAll(env: Env, d: Deps, wid: string, collection: string, budget: { pages: number; partial: boolean }): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []; let after: string | undefined;
  for (;;) {
    if (budget.pages <= 0) { budget.partial = true; break; }
    budget.pages -= 1;
    const docs = await fsQuery(env, d, { parent: `workspaces/${wid}`, collection, orderBy: [{ field: '__name__' }], limit: PAGE, startAfterId: after });
    for (const x of docs) {
      const row: Record<string, unknown> = { id: x.id, ...x.data };
      if (collection === 'devices') delete row.tokenHash;   // device secrets are never copied
      out.push(row);
    }
    if (docs.length < PAGE) break;
    after = docs[docs.length - 1]!.id;
  }
  return out;
}

export interface BackupMeta {
  id: string; createdAt: Date; key: string; bytes: number; sha256: string; counts: Record<string, number>; records: number;
  verified: boolean; partial: boolean; trigger: 'schedule' | 'manual'; by: string | null; algorithm: string;
}

const stamp = (n: Date): string => n.toISOString().replace(/[-:T]/g, '').slice(0, 14);
export const backupId = (n: Date): string => `b_${stamp(n).slice(0, 8)}_${stamp(n).slice(8, 14)}`;

export async function runBackup(env: Env, d: Deps, wid: string, trigger: 'schedule' | 'manual', by: string | null): Promise<BackupMeta> {
  if (!env.BACKUPS) throw new HttpError(503, 'Backups are not switched on yet.', 'unavailable');
  keyBytes(env);
  const ws = await fsGet(env, d, `workspaces/${wid}`);
  if (!ws) throw new HttpError(404, 'Workspace not found');
  const now = d.now(); const id = backupId(now);
  const budget = { pages: MAX_PAGES, partial: false };
  const collections: Record<string, Record<string, unknown>[]> = {};
  for (const name of BACKUP_COLLECTIONS) collections[name] = await readAll(env, d, wid, name, budget);
  const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
  const plain = enc.encode(JSON.stringify({ format: 'zexcore-backup/1', createdAt: now.toISOString(), workspace: { id: wid, slug: ws.data.slug, name: ws.data.name, plan: ws.data.plan }, complete: !budget.partial, collections }));
  const sha = await sha256Hex(new TextDecoder().decode(plain));
  const key = `backups/${wid}/${id}.zxb`;
  const sealed = await seal(env, wid, id, await gzip(plain));
  await env.BACKUPS.put(key, sealed);
  // prove it: read it back, decrypt, unzip, compare
  let verified = false;
  try {
    const back = await env.BACKUPS.get(key);
    const again = back ? await gunzip(await open(env, wid, id, new Uint8Array(await back.arrayBuffer()))) : null;
    verified = !!again && await sha256Hex(new TextDecoder().decode(again)) === sha;
  } catch { verified = false; }
  const meta: BackupMeta = { id, createdAt: now, key, bytes: sealed.length, sha256: sha, counts, records: Object.values(counts).reduce((a, b) => a + b, 0),
    verified, partial: budget.partial, trigger, by, algorithm: 'AES-256-GCM' };
  const { id: _omit, ...fields } = meta; void _omit;
  try { await fsCommit(env, d, [{ path: `workspaces/${wid}/backups/${id}`, fields, precondition: { exists: false } }]); }
  catch (e) { if (!(e instanceof FsConflict)) throw e; }
  await prune(env, d, wid);
  if (!verified) await warnOwner(env, d, wid, ws.data.name, id);
  return meta;
}

async function prune(env: Env, d: Deps, wid: string): Promise<void> {
  const keys: string[] = []; let cursor: string | undefined;
  do {
    const r = await env.BACKUPS!.list({ prefix: `backups/${wid}/`, cursor });
    keys.push(...r.objects.map((o) => o.key)); cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  keys.sort();
  const old = keys.slice(0, Math.max(0, keys.length - KEEP));
  if (!old.length) return;
  await env.BACKUPS!.delete(old);
  await Promise.all(old.map((k) => {
    const id = k.split('/').pop()!.replace(/\.zxb$/, '');
    return fsCommit(env, d, [{ path: `workspaces/${wid}/backups/${id}`, delete: true }]).catch(() => undefined);
  }));
}

async function warnOwner(env: Env, d: Deps, wid: string, name: unknown, id: string): Promise<void> {
  const ws = await fsGet(env, d, `workspaces/${wid}`);
  const uid = ws?.data.ownerUid as string | undefined;
  const m = uid ? await fsGet(env, d, `workspaces/${wid}/members/${uid}`) : null;
  await sendMail(env, d, String(m?.data.email ?? ''), `ZexCore backup needs attention: ${String(name)}`, `Backup ${id} for ${String(name)} was written but could not be verified. We will try again at the next run. If this keeps happening, contact support.`);
}

/** Cron entry: back up the Enterprise and Dedicated workspaces that are due, oldest backup first. */
export async function scheduledBackups(env: Env, d: Deps): Promise<{ done: string[]; failed: string[] }> {
  const out = { done: [] as string[], failed: [] as string[] };
  if (!env.BACKUPS || !env.BACKUP_KEY) return out;
  const now = d.now();
  const spaces = (await Promise.all(['enterprise', 'dedicated'].map((plan) => fsQuery(env, d, { collection: 'workspaces', where: [{ field: 'plan', op: 'EQUAL', value: plan }], limit: 500 })))).flat()
    .filter((w, i, all) => all.findIndex((x) => x.id === w.id) === i)
    .filter((w) => (RANK[activePlan(w.data, now).tier] ?? 0) >= (RANK.enterprise ?? 4));
  const withLast = await Promise.all(spaces.map(async (w) => {
    const last = (await fsQuery(env, d, { parent: `workspaces/${w.id}`, collection: 'backups', orderBy: [{ field: 'createdAt', desc: true }], limit: 1 }))[0];
    const at = last?.data.createdAt instanceof Date ? last.data.createdAt.getTime() : 0;
    return { id: w.id, at };
  }));
  const due = withLast.filter((x) => now.getTime() - x.at >= DUE_MS).sort((a, b) => a.at - b.at).slice(0, PER_TICK);
  for (const w of due) {
    try { await runBackup(env, d, w.id, 'schedule', null); out.done.push(w.id); }
    catch (e) { console.error('backup failed', w.id, e instanceof Error ? e.message : e); out.failed.push(w.id); }
  }
  return out;
}

// ── HTTP routes ──
const ADMINS = ['owner', 'admin'] as never;
async function enterprise(c: Ctx, wid: string): Promise<{ name: string }> {
  const ws = await fsGet(c.env, c.d, `workspaces/${wid}`);
  if ((RANK[activePlan(ws?.data, c.d.now()).tier] ?? 0) < (RANK.enterprise ?? 4)) throw new HttpError(402, 'Backups are part of the Enterprise and Dedicated plans.', 'plan_feature');
  return { name: String(ws?.data.name ?? '') };
}

// POST /api/backups/run { workspaceId }
export async function runNow(c: Ctx): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { caller, wid } = await requireMember(c, b.workspaceId, ADMINS);
  await enterprise(c, wid);
  if (!c.env.BACKUPS) throw new HttpError(503, 'Backups are not switched on yet.', 'unavailable');
  keyBytes(c.env);
  const last = (await fsQuery(c.env, c.d, { parent: `workspaces/${wid}`, collection: 'backups', orderBy: [{ field: 'createdAt', desc: true }], limit: 1 }))[0];
  if (last?.data.createdAt instanceof Date && c.d.now().getTime() - last.data.createdAt.getTime() < 10 * 60_000)
    throw new HttpError(429, 'A backup was made a few minutes ago. Try again shortly.', 'rate_limited');
  const m = await runBackup(c.env, c.d, wid, 'manual', caller.uid);
  return json({ ok: true, id: m.id, verified: m.verified, records: m.records, bytes: m.bytes, complete: !m.partial }, 201, c.headers);
}

async function loadMeta(c: Ctx, wid: string, id: unknown) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'Invalid backup');
  const m = await fsGet(c.env, c.d, `workspaces/${wid}/backups/${id}`);
  if (!m) throw new HttpError(404, 'That backup no longer exists.');
  return m;
}

// GET /api/backups/download?workspaceId=&id=   -> decrypted JSON
export async function download(c: Ctx): Promise<Response> {
  const { wid } = await requireMember(c, c.url.searchParams.get('workspaceId'), ADMINS);
  await enterprise(c, wid);
  const m = await loadMeta(c, wid, c.url.searchParams.get('id'));
  const obj = await c.env.BACKUPS?.get(String(m.data.key));
  if (!obj) throw new HttpError(404, 'The backup file is no longer in storage.');
  const body = await gunzip(await open(c.env, wid, m.id, new Uint8Array(await obj.arrayBuffer())));
  return new Response(body, { status: 200, headers: { ...c.headers, 'content-type': 'application/json', 'content-disposition': `attachment; filename="zexcore-backup-${m.id}.json"`, 'cache-control': 'no-store' } });
}

// GET /api/backups/certificate?workspaceId=&id=   -> PDF
export async function certificate(c: Ctx): Promise<Response> {
  const { wid } = await requireMember(c, c.url.searchParams.get('workspaceId'), ADMINS);
  const { name } = await enterprise(c, wid);
  const m = await loadMeta(c, wid, c.url.searchParams.get('id'));
  const pdf = await certificatePdf(c.env, wid, name, m.id, m.data);
  return new Response(pdf, { status: 200, headers: { ...c.headers, 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="zexcore-backup-certificate-${m.id}.pdf"`, 'cache-control': 'no-store' } });
}

export async function certificatePdf(env: Env, wid: string, workspaceName: string, id: string, m: Record<string, any>): Promise<Uint8Array> {
  const at = m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt);
  const mac = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', keyBytes(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(`${wid}:${id}:${m.sha256}`));
  const ref = hex(mac).slice(0, 20).toUpperCase();
  const counts = Object.entries((m.counts ?? {}) as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n.toLocaleString('en-US')}`);
  const lines = [
    { text: 'ZexCore', size: 12, bold: true, color: [0.9, 0.03, 0.12] as [number, number, number] },
    { text: 'Backup Certificate', size: 26, bold: true, gap: 6 },
    { text: `Workspace: ${workspaceName}`, size: 13, gap: 18 },
    { text: `Backup ID: ${id}`, gap: 4 },
    { text: `Created (UTC): ${at}`, gap: 2 },
    { text: `Trigger: ${m.trigger === 'manual' ? 'On demand' : 'Scheduled daily backup'}`, gap: 2 },
    { text: 'What was checked', size: 14, bold: true, gap: 22 },
    { text: `Records saved: ${Number(m.records).toLocaleString('en-US')} in ${counts.length} collections`, gap: 4 },
    { text: `Complete: ${m.partial ? 'No. The workspace was larger than one backup run can hold; contact support' : 'Yes, every record was read'}`, gap: 2 },
    { text: `Verified: ${m.verified ? 'Yes. The stored file was read back, decrypted and matched its fingerprint' : 'No. The stored file could not be verified'}`, gap: 2 },
    { text: `Encryption: ${m.algorithm ?? 'AES-256-GCM'}, bound to this workspace and backup`, gap: 2 },
    { text: `Size stored: ${Number(m.bytes).toLocaleString('en-US')} bytes (compressed and encrypted)`, gap: 2 },
    { text: 'Fingerprint (SHA-256 of the backup contents)', size: 14, bold: true, gap: 22 },
    { text: String(m.sha256).slice(0, 32), size: 10, gap: 4 },
    { text: String(m.sha256).slice(32), size: 10, gap: 0 },
    { text: `Certificate reference: ${ref}`, size: 11, bold: true, gap: 12 },
    { text: 'Contents by collection', size: 14, bold: true, gap: 22 },
    ...counts.reduce<string[]>((rows, c, i) => { if (i % 3 === 0) rows.push(c); else rows[rows.length - 1] += `    ${c}`; return rows; }, []).map((t) => ({ text: t, size: 9, gap: 2 })),
    { text: 'About this certificate', size: 14, bold: true, gap: 22 },
    { text: 'Backups are stored in Cloudflare R2 and kept for the last 30 runs. The encryption key is held by ZexCore as a protected', size: 9, gap: 4 },
    { text: 'server secret, so ZexCore can decrypt a backup to restore it or to hand it to you; storage alone cannot read it.', size: 9, gap: 0 },
    { text: 'This certificate records what ZexCore did and checked. It is not a legal guarantee or a regulator-issued document.', size: 9, gap: 0 },
  ];
  return simplePdf(lines as never, `ZexCore backup certificate ${id}`);
}
