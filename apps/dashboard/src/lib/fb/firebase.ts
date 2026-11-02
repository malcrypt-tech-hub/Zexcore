import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';

const env = import.meta.env as Record<string, string | undefined>;
// A Firebase web config is a public identifier, not a secret: access is decided by firestore.rules and Auth.
// Defaults are the production project; override with VITE_FIREBASE_* for a staging project.
// When running on the custom domain, use that hostname as authDomain so the Firebase
// auth popup is served from the same origin — this avoids third-party cookie blocks
// (Safari ITP, Chrome partitioned storage) that otherwise drop the popup token.
const _defaultAuthDomain = (() => {
  if (typeof window !== 'undefined') {
    const h = window.location.hostname;
    // Custom production domain — must also be in Google Cloud Console's Authorized redirect URIs
    if (h === 'zexcore.com.ng' || h === 'www.zexcore.com.ng') return h;
  }
  return 'zexcore-5d6c0.firebaseapp.com';
})();

const cfg = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyD_g3SVv0zBlKyUsvgVV58sqiI-9BJot9g',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || _defaultAuthDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'zexcore-5d6c0',
  appId: env.VITE_FIREBASE_APP_ID || '1:683742152729:web:a1c4842d3c28b013464288',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '683742152729',
};

export const isConfigured = (): boolean => Boolean(cfg.apiKey && cfg.projectId && cfg.appId);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

/** Lazily initialised so the marketing pages load even when the Firebase settings are missing. */
export function fb(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  if (!isConfigured()) throw new Error('not-configured');
  if (!app) {
    app = initializeApp(cfg);
    // Bot protection: when a reCAPTCHA v3 site key is configured, every Firestore call carries an App Check token, and the
    // Firebase console can then be set to reject calls without one (stops scripts from filling booking slots).
    const siteKey = env.VITE_APPCHECK_SITE_KEY;
    if (siteKey && typeof window !== 'undefined') {
      try { initializeAppCheck(app, { provider: new ReCaptchaV3Provider(siteKey), isTokenAutoRefreshEnabled: true }); } catch { /* app check unavailable: carry on without it */ }
    }
  }
  auth ??= getAuth(app);
  db ??= getFirestore(app);
  return { app, auth, db };
}

/** URL of the payments Worker (Cloudflare). */
export const paymentsUrl = (): string => (env.VITE_PAYMENTS_URL || 'https://zexcore-payments.mal4crypt404.workers.dev').replace(/\/$/, '');

/** Test hook: points the app at the local Firebase emulators (used by tests/firestore/e2e.test.ts only). */
export function useEmulators(host = '127.0.0.1'): void {
  const { auth, db } = fb();
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
}
