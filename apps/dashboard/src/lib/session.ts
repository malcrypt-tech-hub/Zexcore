import { api, getToken, setToken, ApiError } from './api';

export interface Me {
  user: { id: string; email: string | null; name: string | null; emailVerified?: boolean };
  tenant: { id: string; slug: string; name: string; tier: string; plan_cycle: string | null; plan_expires_at: string | null };
  role: 'owner' | 'admin' | 'editor' | 'member' | 'viewer' | null;
  isPlatformAdmin: boolean;
}

const SS_ME = 'zx.me_v1';
const ssRead = (): Me | null => { try { const s = sessionStorage.getItem(SS_ME); return s ? (JSON.parse(s) as Me) : null; } catch { return null; } };
const ssWrite = (v: Me | null): void => { try { v ? sessionStorage.setItem(SS_ME, JSON.stringify(v)) : sessionStorage.removeItem(SS_ME); } catch { /* ignore */ } };

// Hydrate from sessionStorage immediately — no async, no Firebase, no network.
// This means navigating back to /app after a refresh paints the shell in <50 ms instead of 1-2 s.
let me: Me | null = getToken() ? ssRead() : null;

export const current = (): Me | null => me;
export const isSignedIn = (): boolean => !!getToken();
export const canManage = (): boolean => !!me && (me.role === 'owner' || me.role === 'admin' || me.role === 'editor' || me.role === 'member' || me.isPlatformAdmin);
/** Services, staff calendars and website pages. */
export const canEdit = (): boolean => !!me && (me.role === 'owner' || me.role === 'admin' || me.role === 'editor' || me.isPlatformAdmin);
export const canAdmin = (): boolean => !!me && (me.role === 'owner' || me.role === 'admin' || me.isPlatformAdmin);

// Tracks whether we've revalidated against Firebase in this page session.
let _validated = false;

export async function loadMe(force = false): Promise<Me | null> {
  if (!getToken()) { me = null; ssWrite(null); return null; }
  // Return the cached/hydrated value immediately if we have one and aren't forced.
  // We still revalidate once per page session in the background to keep data fresh.
  if (me && !force) {
    if (!_validated) {
      _validated = true;
      // Revalidate in background — updates the cache but doesn't block rendering.
      void api<Me>('/api/auth/me').then((fresh) => {
        // The cached copy belonged to someone else (another account signed in on this device): never keep showing it.
        const other = !!me && me.user.id !== fresh.user.id;
        me = fresh; ssWrite(fresh);
        if (other) location.reload();
      }).catch(() => undefined);
    }
    return me;
  }
  try {
    me = await api<Me>('/api/auth/me');
    _validated = true;
    ssWrite(me);
    greetOnce(); recordSignInOnce();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 400 || e.status === 403)) {
      setToken(null); me = null; ssWrite(null); return null;
    }
    throw e;
  }
  return me;
}

export type LoginResult = { ok: true } | { ok: false; workspaces: { slug: string; name: string }[] };

export async function login(email: string, password: string, tenantSlug?: string): Promise<LoginResult> {
  const r = await api<{ token?: string; workspaces?: { slug: string; name: string }[] }>('/api/auth/login', {
    method: 'POST', auth: false, body: { email, password, ...(tenantSlug ? { tenantSlug } : {}) },
  });
  if (!r.token) return { ok: false, workspaces: r.workspaces ?? [] };
  setToken(r.token); me = null; _validated = false; ssWrite(null);
  await loadMe(true);
  return { ok: true };
}

export async function register(input: { tenantName: string; name: string; email: string; password: string; tenantSlug?: string }): Promise<void> {
  const r = await api<{ token: string }>('/api/auth/register', { method: 'POST', auth: false, body: input });
  setToken(r.token); me = null; _validated = false; ssWrite(null);
  await loadMe(true);
}

/** Forget the remembered identity (used when a different account signs in). */
export function resetSession(): void { me = null; _validated = false; ssWrite(null); }

export function logout(): void {
  // Revoke the session on the server first (best effort), so a copied token stops working immediately.
  if (getToken()) void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  setToken(null); me = null; _validated = false; ssWrite(null);
}

/** Tells the Worker this device signed in (once per browser session), so Security Watch can list it and flag a new one. Failures are ignored. */
function recordSignInOnce(): void {
  try { if (sessionStorage.getItem('zx.signin')) return; } catch { /* still try once */ }
  void import('./fb/worker').then(({ worker }) => worker('/api/security/signin', { method: 'POST', body: {} }))
    .then(() => { try { sessionStorage.setItem('zx.signin', '1'); } catch { /* ignore */ } }).catch(() => undefined);
}

/** Asks the Worker to send the one-time welcome e-mail. It decides whether this person is due one; failures are ignored. */
function greetOnce(): void {
  try { if (sessionStorage.getItem('zx.greeted')) return; } catch { /* still try once */ }
  void import('./fb/worker').then(({ worker }) => worker<{ reason?: string }>('/api/welcome', { method: 'POST', body: {} }))
    .then((r) => { if (r.reason !== 'unverified') { try { sessionStorage.setItem('zx.greeted', '1'); } catch { /* ignore */ } } }).catch(() => undefined);
}
