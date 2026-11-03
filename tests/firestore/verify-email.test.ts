// The email confirmation link works once. A link that was already used must never be reported as "invalid" to someone who is confirmed.
import { describe, expect, it, vi } from 'vitest';
import { installWorker } from './worker-harness';

vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-zexcore');
vi.stubEnv('VITE_FIREBASE_API_KEY', 'demo-key');
vi.stubEnv('VITE_FIREBASE_APP_ID', '1:1:web:demo');
installWorker();

describe('email confirmation link', () => {
  it('confirms once, treats a reused link as already confirmed, and only calls a dead link "used" while unconfirmed', async () => {
    const fbm = await import('../../apps/dashboard/src/lib/fb/firebase');
    fbm.useEmulators();
    const auth = await import('../../apps/dashboard/src/lib/fb/auth');
    const email = `verify${Date.now()}@example.com`;
    await auth.register({ tenantName: 'Verify Salon', name: 'Ada Obi', email, password: 'a-long-password-1' });

    // not confirmed yet: a dead link is "already used", with a way forward (never "invalid")
    await expect(auth.verifyEmail('not-a-real-code')).rejects.toMatchObject({ code: 'link_used' });

    // the real link, as the emulator recorded it
    const r = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-zexcore/oobCodes');
    const codes = ((await r.json()) as { oobCodes: { email: string; requestType: string; oobCode: string }[] }).oobCodes;
    const code = codes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL').pop()!.oobCode;
    await expect(auth.verifyEmail(code)).resolves.toBeUndefined();
    expect((await auth.emailStatus()).verified).toBe(true);

    // the same page rendering twice, or a scanner using the link first: still fine
    await expect(auth.verifyEmail(code)).resolves.toBeUndefined();
    await expect(auth.verifyEmail('another-used-code')).resolves.toBeUndefined();   // confirmed in this browser, so nothing to complain about
  });
});
