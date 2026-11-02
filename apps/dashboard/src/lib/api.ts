// The dashboard talks to Firebase (Auth + Firestore) through this one function. The route table in ./fb/router.ts keeps the
// original endpoint names so every view stays unchanged; there is no application server behind it.
import { ApiError } from './errors';

export { ApiError };
const KEY = 'zx.session';

// A synchronous "was signed in" hint so route guards do not wait on Firebase; loadMe() confirms it against Firebase Auth.
let token: string | null = null;
try { token = localStorage.getItem(KEY); } catch { /* storage unavailable: session lasts for this tab only */ }

export const getToken = (): string | null => token;
export function setToken(t: string | null): void {
  token = t ? '1' : null;
  try { token ? localStorage.setItem(KEY, token) : localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** The data layer (and Firebase with it) loads the first time the app needs it, not on every marketing page. */
let routerP: Promise<typeof import('./fb/router')> | null = null;
export const loadRouter = (): Promise<typeof import('./fb/router')> => (routerP ??= import('./fb/router'));

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void): void => { onUnauthorized = fn; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  try {
    const { dispatch } = await loadRouter();
    return (await dispatch(path, method, body)) as T;
  } catch (e) {
    if (e instanceof ApiError && e.status === 402 && (e.code === 'plan_limit' || e.code === 'plan_feature' || e.code === 'seat_limit')) void showUpgrade(e.message);
    if (e instanceof ApiError && e.status === 401 && auth && token && !path.startsWith('/api/auth/')) { setToken(null); onUnauthorized(); }
    throw e;
  }
}

let lastUpgrade = 0;
/** A plan limit was hit: say so plainly and offer the plans, instead of leaving the person with a button that seems broken. */
async function showUpgrade(message: string): Promise<void> {
  if (Date.now() - lastUpgrade < 1500) return;
  lastUpgrade = Date.now();
  const [{ openModal }, { html }, { navigate }] = await Promise.all([import('./ui'), import('./html'), import('../router')]);
  openModal({
    title: 'Upgrade to unlock more',
    body: html`<p>${message}</p><p class="muted small" style="margin-top:8px">Nothing you have already added is removed. You can upgrade at any time from Plan & billing.</p>`,
    footer: html`<button class="btn btn-secondary" data-close>Not now</button><button class="btn btn-primary" data-upgrade>See plans</button>`,
    onMount: (el, close) => el.querySelector('[data-upgrade]')!.addEventListener('click', () => { close(); navigate('/app/billing'); }),
  });
}
