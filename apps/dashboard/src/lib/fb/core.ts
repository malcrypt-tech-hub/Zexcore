import { worker } from './worker';
import { doc, getDoc, getDocs, collection, query, orderBy, limit as qLimit, runTransaction, serverTimestamp, Timestamp, type DocumentData } from 'firebase/firestore';
import { fb, isConfigured } from './firebase';
import { effectiveTier, hasFeatureAccess, slotLimit, FEATURE_TIERS, UNLIMITED_SLOTS, type EnforcedKey, type FeatureKey, type Tier } from './plan';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
export const unavailable = (what: string): ApiError => new ApiError(501, `${what} is not part of this release yet.`, 'unavailable');

export interface WorkspaceSettings {
  businessType: string; publicName: string | null; phone: string | null; address: string | null; currency: string; exchangeRate: number;
  depositEnabled: boolean; depositMinor: number; openMinutes: number; closeMinutes: number; slotMinutes: number;
  daysOpen: number[]; utcOffsetMinutes: number; leadMinutes: number; maxDaysAhead: number; onboarded: boolean;
  logoUrl?: string | null; rules?: any[];
}
import { getCachedNgnRate } from '../fx';

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  businessType: 'other', publicName: null, phone: null, address: null, currency: 'USD', exchangeRate: getCachedNgnRate(), depositEnabled: false, depositMinor: 0,
  openMinutes: 540, closeMinutes: 1020, slotMinutes: 30, daysOpen: [1, 2, 3, 4, 5, 6], utcOffsetMinutes: 60, leadMinutes: 60, maxDaysAhead: 60, onboarded: false,
  logoUrl: null, rules: [],
};

export type Role = 'owner' | 'admin' | 'editor' | 'staff';
export interface Ctx {
  uid: string; email: string | null; name: string | null; emailVerified: boolean;
  wid: string; slug: string; wsName: string; plan: string; planCycle: string | null; planExpiresAt: string | null;
  tier: Tier; role: Role; settings: WorkspaceSettings;
}

let cached: Ctx | null = null;
export const clearCtx = (): void => { cached = null; };

/** Which workspace to open when the account belongs to more than one (a teammate can be in several). Remembered on this device only. */
const WS_KEY = 'zx.workspace';
export const preferredWorkspace = (): string | null => { try { return localStorage.getItem(WS_KEY); } catch { return null; } };
export const setPreferredWorkspace = (id: string): void => { try { localStorage.setItem(WS_KEY, id); } catch { /* ignore */ } cached = null; };

export const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : typeof v === 'string' ? v : null);

/** Firestore/Auth failures -> messages a business owner can act on. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const code = (e as { code?: string })?.code ?? '';
  const msg = (e as { message?: string })?.message ?? '';
  if (msg === 'not-configured') return new ApiError(503, 'ZexCore is not connected to its database yet. Please try again later.', 'not_configured');
  if (code === 'permission-denied' || code === 'firestore/permission-denied') return new ApiError(403, 'You do not have permission to do that.', 'forbidden');
  if (code === 'unavailable' || code === 'auth/network-request-failed' || code === 'deadline-exceeded') return new ApiError(0, 'Cannot reach ZexCore. Check your connection and try again.', 'network');
  if (code === 'resource-exhausted') return new ApiError(429, 'ZexCore is busy right now. Please try again in a moment.', 'busy');
  if (code === 'unauthenticated') return new ApiError(401, 'Please sign in again.', 'unauthenticated');
  return new ApiError(500, 'Something went wrong. Please try again.', code || undefined);
}

export async function loadCtx(force = false): Promise<Ctx> {
  if (cached && !force) return cached;
  if (!isConfigured()) throw new ApiError(503, 'ZexCore is not connected to its database yet. Please try again later.', 'not_configured');
  const { auth, db } = fb();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'Please sign in.', 'unauthenticated');
  if (force) await user.reload().catch(() => undefined);
  try {
    const u = await getDoc(doc(db, 'users', user.uid));
    const ids = (u.data()?.workspaceIds as string[] | undefined) ?? [];
    const wid = ids.includes(preferredWorkspace() ?? '') ? preferredWorkspace()! : ids[0];
    if (!wid) throw new ApiError(403, 'This account has no workspace.', 'no_workspace');
    const [ws, mem] = await Promise.all([getDoc(doc(db, 'workspaces', wid)), getDoc(doc(db, 'workspaces', wid, 'members', user.uid))]);
    if (!ws.exists() || !mem.exists()) throw new ApiError(403, 'This account has no access to its workspace.', 'no_workspace');
    const w = ws.data();
    const exp = w.planExpiresAt instanceof Timestamp ? w.planExpiresAt.toMillis() : null;
    const tier = effectiveTier(w.plan as string, exp);
    cached = {
      uid: user.uid, email: user.email, name: user.displayName ?? (mem.data().name as string | undefined) ?? null,
      emailVerified: user.emailVerified,
      wid, slug: w.slug as string, wsName: w.name as string,
      plan: (w.plan as string) ?? 'free',
      planCycle: (w.planCycle as string | undefined) ?? null,
      planExpiresAt: iso(w.planExpiresAt),
      tier,
      role: mem.data().role as Role,
      settings: { ...DEFAULT_SETTINGS, ...(w.settings as Partial<WorkspaceSettings> | undefined) },
    };
    void flushAudit();
    return cached;
  } catch (e) { throw toApiError(e); }
}

export const wsDoc = (c: Ctx, ...path: string[]) => doc(fb().db, 'workspaces', c.wid, ...path as [string, ...string[]]);
export const wsCol = (c: Ctx, name: string) => collection(fb().db, 'workspaces', c.wid, name);

export const canWrite = (c: Ctx): boolean => c.role === 'owner' || c.role === 'admin';
export const canEditContent = (c: Ctx): boolean => c.role === 'owner' || c.role === 'admin' || c.role === 'editor';
/** Services, staff calendars and website pages: owners, admins and editors. */
export function requireEditor(c: Ctx): void { if (!canEditContent(c)) throw new ApiError(403, 'Your role cannot change this.', 'forbidden'); }
export function requireAdmin(c: Ctx): void { if (!canWrite(c)) throw new ApiError(403, 'Only a workspace owner or admin can do that.', 'forbidden'); }

const NOUN: Record<EnforcedKey, string> = { bookingsPerMonth: 'bookings a month', staff: 'team members', services: 'services', cmsPages: 'website pages', crmContacts: 'contacts', devices: 'devices', rules: 'automations' };
const FEATURE_NAME: Record<FeatureKey, string> = { branding: 'Custom branding', compliance: 'Data protection', automations: 'Automations', devices: 'Device monitoring' };
/** Stops a paid feature up front with a clear upgrade message, instead of the database refusing it with a bare "no permission". */
export function requireFeature(c: Ctx, f: FeatureKey): void {
  if (!hasFeatureAccess(c.tier, f)) throw new ApiError(402, `${FEATURE_NAME[f]} is part of the ${FEATURE_TIERS[f][0]!.toUpperCase()}${FEATURE_TIERS[f].slice(1)} plan and above. Upgrade to unlock it.`, 'plan_feature');
}
export const limitError = (c: Ctx, key: EnforcedKey): ApiError =>
  new ApiError(402, `Your ${c.tier} plan includes ${slotLimit(c.tier, key).toLocaleString('en-NG')} ${NOUN[key]}. Upgrade your plan to add more.`, 'plan_limit');

/**
 * Numbered documents (s_0, s_1 ...): the security rules only accept ids below the plan limit, which is how limits are
 * enforced without a server. `seq` lets us find the next free number with one query; a transaction makes sure two
 * tabs never claim the same one.
 */
export async function claimSlot(c: Ctx, name: string, prefix: string, key: EnforcedKey, data: DocumentData): Promise<string> {
  const { db } = fb();
  const max = Math.min(slotLimit(c.tier, key), UNLIMITED_SLOTS);
  const col = wsCol(c, name);
  const top = await getDocs(query(col, orderBy('seq', 'desc'), qLimit(1)));
  let n = top.empty ? 0 : Number(top.docs[0]!.data().seq) + 1;
  const used = (): Promise<Set<number>> => getDocs(col).then((s) => new Set(s.docs.map((d) => Number(d.data().seq))));
  let free: number[] | null = null;
  for (let attempts = 0; attempts < 8; attempts++) {
    if (n >= max) { // top of the range reached: reuse a hole left by a deleted document, if any
      if (!free) { const u = await used(); free = []; for (let i = 0; i < max && free.length < 50; i++) if (!u.has(i)) free.push(i); }
      const next = free.shift();
      if (next === undefined) throw limitError(c, key);
      n = next;
    }
    const ref = doc(col, `${prefix}_${n}`);
    const ok = await runTransaction(db, async (tx) => {
      if ((await tx.get(ref)).exists()) return false;
      tx.set(ref, { ...data, seq: n, createdAt: serverTimestamp() });
      return true;
    });
    if (ok) return ref.id;
    n += 1;
  }
  throw new ApiError(409, 'Another change was saved at the same time. Please try again.', 'conflict');
}

const AUDIT_Q = 'zx.auditq';
const readQ = (): { wid: string; action: string; target: string; detail: string }[] => { try { return JSON.parse(localStorage.getItem(AUDIT_Q) ?? '[]'); } catch { return []; } };
const writeQ = (q: unknown[]): void => { try { localStorage.setItem(AUDIT_Q, JSON.stringify(q.slice(-50))); } catch { /* storage unavailable */ } };
let flushing = false;
/** Sends queued entries to the Worker, oldest first; anything that fails stays queued for the next attempt. */
export async function flushAudit(): Promise<void> {
  if (flushing) return; flushing = true;
  try {
    let q = readQ();
    while (q.length) {
      const e = q[0]!;
      try { await worker('/api/audit', { body: { workspaceId: e.wid, action: e.action, target: e.target, detail: e.detail } }); }
      catch (err) { if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) { q = readQ().slice(1); writeQ(q); continue; } break; }
      q = readQ().slice(1); writeQ(q);
    }
  } finally { flushing = false; }
}
/** Tamper-evident audit trail: the Worker chains and signs each entry. Queued locally if the Worker is unreachable. Never blocks the action it describes. */
export async function audit(c: Ctx, action: string, entity: string, entityId: string | null): Promise<void> {
  writeQ([...readQ(), { wid: c.wid, action: action.replace(/[^a-z0-9_.]/g, '_'), target: `${entity}${entityId ? ':' + entityId : ''}`, detail: '' }]);
  void flushAudit();
}

export const monthPrefix = (ms = Date.now()): string => { const d = new Date(ms); return String(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1); };
