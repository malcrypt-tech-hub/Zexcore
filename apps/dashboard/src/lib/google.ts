import { ApiError, setToken } from './api';
import { googleCreateWorkspace, googleSignIn } from './fb/auth';
import { isConfigured } from './fb/firebase';
import { loadMe, resetSession } from './session';

export type GoogleOutcome =
  | { kind: 'signed-in' }
  | { kind: 'choose'; workspaces: { slug: string; name: string }[]; credential: string }
  | { kind: 'needs-signup'; email: string; name: string; credential: string };

const G_LOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

/** Renders a "Continue with Google" button into `host` (Firebase Authentication does the sign-in). */
export async function mountGoogleButton(host: HTMLElement, onResult: (o: GoogleOutcome) => void, onError: (m: string) => void): Promise<void> {
  if (!isConfigured()) { host.classList.add('hidden'); host.previousElementSibling?.classList.add('hidden'); return; }
  host.innerHTML = `<button type="button" class="btn btn-secondary btn-lg btn-block" style="gap:10px;max-width:400px">${G_LOGO}<span>Continue with Google</span></button>`;
  const btn = host.querySelector('button')!;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await googleSignIn();
      resetSession();
      setToken('1');
      if (r.hasWorkspace) { await loadMe(true); onResult({ kind: 'signed-in' }); }
      else onResult({ kind: 'needs-signup', email: r.email, name: r.name, credential: '' });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) onError(e instanceof ApiError ? e.message : 'Google sign-in failed');
    } finally { btn.disabled = false; }
  });
}

export async function googleExchange(_credential: string, extra: { tenantName?: string; workspace?: string } = {}): Promise<GoogleOutcome> {
  if (extra.tenantName) await googleCreateWorkspace(extra.tenantName);
  resetSession();
  setToken('1');
  await loadMe(true);
  return { kind: 'signed-in' };
}
