import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile, sendEmailVerification, sendPasswordResetEmail,
  confirmPasswordReset, applyActionCode, GoogleAuthProvider, signInWithPopup, type User, EmailAuthProvider, reauthenticateWithCredential, updatePassword, deleteUser,
} from 'firebase/auth';
import { collection, doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { fb } from './firebase';
import { worker } from './worker';
import { ApiError, DEFAULT_SETTINGS, clearCtx, loadCtx, toApiError, claimSlot, type Ctx } from './core';
import { syncBookingCap } from './catalog';

const RESERVED = new Set(['admin', 'api', 'app', 'www', 'signin', 'signup', 'login', 'pricing', 'security', 'contact', 'privacy', 'terms', 'docs', 'about', 'console', 'dashboard',
  'platform', 'solutions', 'modules', 'architecture', 'resources', 'book', 'b', 'static', 'assets', 'zexcore', 'demo', 'mail', 'support', 'help', 'status', 'product', 'home', 'forgot-password', 'reset-password', 'verify-email', 'multi-tenancy', 'automation']);
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$/;

/** Returns the canonical app origin — uses the real domain in production, localhost in development. */
const appOrigin = (): string => {
  if (typeof window === 'undefined') return 'https://zexcore.com.ng';
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return window.location.origin;
  return 'https://zexcore.com.ng';
};

export const slugify = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/g, '');
const rand = (n: number): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

async function freeSlug(wanted: string, allowSuffix = false): Promise<string> {
  const { db } = fb();
  const base = slugify(wanted);
  for (let i = 0; i < 6; i++) {
    const s = (i === 0 && !allowSuffix && base.length >= 3 && !RESERVED.has(base)) ? base : `${base.length >= 2 ? base : 'biz'}-${rand(4)}`;
    if (!SLUG_RE.test(s) || RESERVED.has(s)) continue;
    if (!(await getDoc(doc(db, 'slugs', s))).exists()) return s;
    if (i === 0 && wanted && wanted === base && !allowSuffix) throw new ApiError(409, 'That web address is already taken. Choose another.', 'slug_taken');
  }
  throw new ApiError(409, 'Could not find a free web address. Try a different business name.', 'slug_taken');
}

const authMessage = (e: unknown): ApiError => {
  const code = (e as { code?: string })?.code ?? '';
  const map: Record<string, [number, string]> = {
    'auth/invalid-credential': [401, 'Incorrect email or password.'], 'auth/wrong-password': [401, 'Incorrect email or password.'], 'auth/user-not-found': [401, 'Incorrect email or password.'],
    'auth/invalid-email': [400, 'Enter a valid email address.'], 'auth/missing-email': [400, 'Enter a valid email address.'], 'auth/email-already-in-use': [409, 'An account with this email already exists. Try signing in.'],
    'auth/weak-password': [400, 'Use a stronger password (at least 10 characters).'], 'auth/too-many-requests': [429, 'Too many attempts. Please wait a few minutes and try again.'],
    'auth/user-disabled': [403, 'This account has been disabled.'], 'auth/expired-action-code': [400, 'This reset link has expired. Please request a new one.'],
    'auth/invalid-action-code': [400, 'This reset link is invalid or has already been used. Please request a new one.'], 'auth/requires-recent-login': [401, 'Sign in again, then retry.'],
    'auth/operation-not-allowed': [503, 'Email sign-in is not switched on yet. Please contact support.'],
    'auth/unauthorized-domain': [403, 'Google sign-in is not authorised for this domain. Please contact support.'],
    'auth/internal-error': [500, 'An authentication error occurred. Please try again.'],
  };
  const hit = map[code];
  return hit ? new ApiError(hit[0], hit[1], code) : toApiError(e);
};

export async function ensureUserWorkspace(user: { uid: string; displayName?: string | null; email?: string | null }): Promise<string> {
  const { db } = fb();
  const u = await getDoc(doc(db, 'users', user.uid));
  const wid = (u.data()?.workspaceIds as string[] | undefined)?.[0];
  if (wid) return wid;

  const baseName = (user.displayName || user.email?.split('@')[0] || 'My Business').trim();
  const tenantName = (baseName.charAt(0).toUpperCase() + baseName.slice(1)).slice(0, 100) || 'My Business';
  const slug = await freeSlug(tenantName, true);
  const newWid = doc(collection(db, 'workspaces')).id;
  const batch = writeBatch(db);
  batch.set(doc(db, 'workspaces', newWid), { name: tenantName, slug, ownerUid: user.uid, plan: 'free', createdAt: serverTimestamp(), settings: { ...DEFAULT_SETTINGS, publicName: tenantName } });
  batch.set(doc(db, 'workspaces', newWid, 'members', user.uid), { role: 'owner', name: user.displayName || tenantName, email: user.email || '', createdAt: serverTimestamp() });
  batch.set(doc(db, 'slugs', slug), {
    wid: newWid, ownerUid: user.uid, name: tenantName, timezone: 'Africa/Lagos', currency: 'USD', bookingEnabled: true, slotMinutes: DEFAULT_SETTINGS.slotMinutes,
    openMinutes: DEFAULT_SETTINGS.openMinutes, closeMinutes: DEFAULT_SETTINGS.closeMinutes, closedWeekdays: [0], bookingCap: 30,
    leadMinutes: DEFAULT_SETTINGS.leadMinutes, maxDaysAhead: DEFAULT_SETTINGS.maxDaysAhead,
  });
  batch.set(doc(db, 'users', user.uid), { name: user.displayName || tenantName, email: user.email || '', workspaceIds: [newWid], createdAt: serverTimestamp() }, { merge: true });
  await batch.commit();
  clearCtx();
  const ctx = await loadCtx(true).catch(() => null);
  if (ctx) {
    await claimSlot(ctx, 'staff', 'p', 'staff', { name: user.displayName || tenantName, title: 'Owner', active: true, auto: true }).catch(() => undefined);
  }
  return newWid;
}

export async function register(b: { tenantName: string; name: string; email: string; password: string; tenantSlug?: string }): Promise<void> {
  const { auth } = fb();
  const tenantName = String(b.tenantName ?? '').trim(), name = String(b.name ?? '').trim(), email = String(b.email ?? '').trim().toLowerCase();
  if (tenantName.length < 2 || tenantName.length > 120) throw new ApiError(400, 'Enter your business name.');
  if (name.length < 2) throw new ApiError(400, 'Enter your name.');
  if (String(b.password ?? '').length < 10) throw new ApiError(400, 'Use at least 10 characters for your password.');
  let cred;
  try { cred = await createUserWithEmailAndPassword(auth, email, b.password); } catch (e) { throw authMessage(e); }
  await createWorkspaceFor(cred.user, tenantName, name, b.tenantSlug, true);
  void sendEmailVerification(cred.user, { url: `${appOrigin()}/verify-email`, handleCodeInApp: false }).catch(() => undefined);
}

/** Creates the workspace, owner row, public slug and first calendar for a signed-in user. Rolls the account back if `rollback` and it fails. */
async function createWorkspaceFor(user: User, tenantName: string, name: string, wantedSlug: string | undefined, rollback: boolean): Promise<void> {
  const { db } = fb();
  try {
    const slug = await freeSlug(wantedSlug || tenantName);
    const wid = doc(collection(db, 'workspaces')).id;
    const batch = writeBatch(db);
    batch.set(doc(db, 'workspaces', wid), { name: tenantName, slug, ownerUid: user.uid, plan: 'free', createdAt: serverTimestamp(), settings: { ...DEFAULT_SETTINGS, publicName: tenantName } });
    batch.set(doc(db, 'workspaces', wid, 'members', user.uid), { role: 'owner', name, email: user.email ?? '', createdAt: serverTimestamp() });
    batch.set(doc(db, 'slugs', slug), {
      wid, ownerUid: user.uid, name: tenantName, timezone: 'Africa/Lagos', currency: 'USD', bookingEnabled: true, slotMinutes: DEFAULT_SETTINGS.slotMinutes,
      openMinutes: DEFAULT_SETTINGS.openMinutes, closeMinutes: DEFAULT_SETTINGS.closeMinutes, closedWeekdays: [0], bookingCap: 30,
      leadMinutes: DEFAULT_SETTINGS.leadMinutes, maxDaysAhead: DEFAULT_SETTINGS.maxDaysAhead,
    });
    batch.set(doc(db, 'users', user.uid), { name, email: user.email ?? '', workspaceIds: [wid], createdAt: serverTimestamp() });
    await batch.commit();
  } catch (e) {
    clearCtx();
    if (rollback) await deleteUser(user).catch(() => undefined); // do not leave a half-created account behind
    throw e instanceof ApiError ? e : authMessage(e);
  }
  clearCtx();
  await updateProfile(user, { displayName: name }).catch(() => undefined);
  // Every business needs one bookable calendar. It is replaced if the owner adds their own team member (see staff handler).
  // The workspace now exists. The first calendar is a convenience: if it cannot be made right now the owner can add one under Bookable staff,
  // and it must never turn a successful sign-up into an error.
  try {
    const ctx = await loadCtx(true);
    await claimSlot(ctx, 'staff', 'p', 'staff', { name, title: 'Owner', active: true, auto: true });
  } catch { /* the owner can add a calendar under Bookable staff */ }
}

/** Google sign-in through Firebase Authentication. Returns whether the person already has a workspace. */
export async function googleSignIn(): Promise<{ hasWorkspace: boolean; email: string; name: string }> {
  const { auth, db } = fb();
  let user: User;
  try { user = (await signInWithPopup(auth, new GoogleAuthProvider())).user; }
  catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new ApiError(0, 'Google sign-in was cancelled.', code);
    if (code === 'auth/popup-blocked') throw new ApiError(400, 'Your browser blocked the Google window. Allow pop-ups for this site and try again.', code);
    if (code === 'auth/operation-not-allowed') throw new ApiError(503, 'Google sign-in is not switched on yet.', code);
    if (code === 'auth/unauthorized-domain') throw new ApiError(403, 'Google sign-in is not authorised for this domain. Please contact support.', code);
    throw authMessage(e);
  }
  clearCtx();
  // No workspace is created here: a new Google user is asked for their business name first (googleCreateWorkspace).
  const u = await getDoc(doc(db, 'users', user.uid));
  const has = Array.isArray(u.data()?.workspaceIds) && (u.data()!.workspaceIds as unknown[]).length > 0;
  return { hasWorkspace: has, email: user.email ?? '', name: user.displayName ?? (user.email ?? '').split('@')[0] ?? 'there' };
}

/** Second step of Google sign-up: the Google account becomes the owner of a new workspace. */
export async function googleCreateWorkspace(tenantName: string): Promise<void> {
  const user = fb().auth.currentUser;
  if (!user) throw new ApiError(401, 'Please sign in with Google again.');
  const n = String(tenantName ?? '').trim();
  if (n.length < 2 || n.length > 120) throw new ApiError(400, 'Enter your business name.');
  await createWorkspaceFor(user, n, user.displayName ?? n, undefined, false);
}

/** How this account signs in, so the app knows whether to ask for a password or the Google window to confirm it is really them. */
export function signInMethod(): 'password' | 'google' {
  const u = fb().auth.currentUser;
  return u?.providerData.some((p) => p.providerId === 'password') ? 'password' : 'google';
}

/** Permanently deletes the signed-in account (and every workspace it owns). Password accounts re-enter their password; Google accounts only type their email. */
export async function deleteAccount(password: string | undefined, confirmEmail: string): Promise<void> {
  const { auth } = fb();
  const user = auth.currentUser;
  if (!user || !user.email) throw new ApiError(401, 'Please sign in again.', 'unauthenticated');
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) throw new ApiError(400, 'Type your sign-in email exactly to confirm.');
  try {
    if (signInMethod() === 'password') {
      if (!password) throw new ApiError(400, 'Enter your password to confirm.');
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    }
    // Google accounts: typing the email above is the confirmation. No second Google pop-up.
    await user.getIdToken(true);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') throw new ApiError(400, 'That password is not right.', code);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new ApiError(0, 'Confirmation was cancelled.', code);
    throw authMessage(e);
  }
  await worker('/api/account/delete', { body: { confirm: confirmEmail } });
  clearCtx();
  try { await signOut(auth); } catch { /* the login is already gone */ }
}

export async function login(email: string, password: string): Promise<void> {
  const { auth } = fb();
  const cleanEmail = String(email).trim().toLowerCase();
  let cred;
  try { cred = await signInWithEmailAndPassword(auth, cleanEmail, password); } catch (e) { throw authMessage(e); }
  clearCtx();
  // An older account with no workspace gets one now; if that fails, say so instead of landing on a broken page.
  await ensureUserWorkspace(cred.user).catch((e) => { throw e instanceof ApiError ? e : new ApiError(500, 'We could not set up your workspace. Please try again.', 'workspace_failed'); });
}

export async function logout(): Promise<void> {
  clearCtx();
  try { await signOut(fb().auth); } catch { /* already signed out */ }
}

let _emailCheckedThisSession = false;
export const me = async (): Promise<unknown> => {
  // Use the in-memory cached ctx — cleared on login/logout so always fresh.
  // Force-reloading on every navigation caused 3 Firestore reads per page view.
  const c: Ctx = await loadCtx();
  void syncBookingCap(c);
  // Only poll Firebase Auth for email verification once per session and only
  // when the user is actually unverified — avoids a network round-trip on every navigation.
  if (!c.emailVerified && !_emailCheckedThisSession) {
    _emailCheckedThisSession = true;
    void emailStatus().catch(() => undefined);
  }
  return {
    user: { id: c.uid, email: c.email, name: c.name, emailVerified: c.emailVerified },
    tenant: { id: c.wid, slug: c.slug, name: c.wsName, tier: c.plan, plan_cycle: c.planCycle, plan_expires_at: c.planExpiresAt },
    role: c.role === 'staff' ? 'member' : c.role,
    isPlatformAdmin: false,
  };
};

export async function forgot(email: string): Promise<void> {
  const clean = String(email ?? '').trim();
  if (!clean) throw new ApiError(400, 'Enter your email address.');
  try {
    const origin = appOrigin();
    try {
      await sendPasswordResetEmail(fb().auth, clean, {
        url: `${origin}/reset-password`,
        handleCodeInApp: true,
      });
    } catch (err: any) {
      if (err?.code === 'auth/unauthorized-continue-uri' || err?.code === 'auth/invalid-continue-uri') {
        await sendPasswordResetEmail(fb().auth, clean);
      } else {
        throw err;
      }
    }
  } catch (e: any) {
    const code = e?.code;
    if (code !== 'auth/user-not-found') throw authMessage(e);
  }
}
export async function reset(token: string, password: string): Promise<void> {
  if (String(password).length < 10) throw new ApiError(400, 'Use at least 10 characters for your password.');
  try { await confirmPasswordReset(fb().auth, token, password); } catch (e) { throw authMessage(e); }
}
/**
 * Confirms an email address from the link. The link works once, and mail apps, security scanners and a second tab can use
 * it before the person does, so "already used" is NOT the same as "broken": if this browser is signed in, ask Firebase whether
 * the address is confirmed and say so. Otherwise report it as used, never as invalid.
 */
const verifying = new Map<string, Promise<void>>();
export function verifyEmail(token: string): Promise<void> {
  const hit = verifying.get(token);
  if (hit) return hit;   // the page can render twice; the code must only be used once
  const p = (async () => {
    const { auth } = fb();
    try { await applyActionCode(auth, token); }
    catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'auth/expired-action-code') throw new ApiError(400, 'This confirmation link has expired. Sign in and ask for a new one.', 'link_expired');
      if (code !== 'auth/invalid-action-code') throw authMessage(e);
      const u = auth.currentUser;
      if (u) { try { await u.reload(); } catch { /* offline */ } }
      if (!u?.emailVerified) throw new ApiError(400, 'This link was already used. If you have confirmed your email, sign in to continue. If not, sign in and ask for a new link.', 'link_used');
    }
    const u = auth.currentUser;
    if (u) { try { await u.reload(); await u.getIdToken(true); } catch { /* the app re-checks on its next load */ } }
    clearCtx();
  })();
  verifying.set(token, p);
  return p;
}
/** Re-reads the account from Firebase (the verification link is opened elsewhere) and refreshes the sign-in token so the Worker sees it. */
export async function emailStatus(): Promise<{ verified: boolean }> {
  const u = fb().auth.currentUser;
  if (!u) return { verified: false };
  if (!u.emailVerified) {
    try { await u.reload(); if (u.emailVerified) { await u.getIdToken(true); clearCtx(); } } catch { /* offline: try again later */ }
  }
  return { verified: u.emailVerified };
}
export async function resendVerification(): Promise<void> {
  const u = fb().auth.currentUser;
  if (!u) throw new ApiError(401, 'Please sign in again.');
  try { await sendEmailVerification(u, { url: `${appOrigin()}/verify-email`, handleCodeInApp: false }); } catch (e) { throw authMessage(e); }
}
export async function changePassword(current: string, next: string): Promise<void> {
  const u = fb().auth.currentUser;
  if (!u?.email) throw new ApiError(401, 'Please sign in again.');
  if (String(next).length < 10) throw new ApiError(400, 'Use at least 10 characters for your new password.');
  try { await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current)); await updatePassword(u, next); }
  catch (e) { throw authMessage(e); }
}
