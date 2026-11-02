// A Google account signs up: real data layer against the real rules, in the emulators.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installWorker } from './worker-harness';

vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-zexcore');
vi.stubEnv('VITE_FIREBASE_API_KEY', 'demo-key');
vi.stubEnv('VITE_FIREBASE_APP_ID', '1:1:web:demo');
installWorker();

describe('Google sign-up', () => {
  it('a new Google account creates its workspace, then is recognised on the next sign-in', async () => {
    const fbm = await import('../../apps/dashboard/src/lib/fb/firebase');
    fbm.useEmulators();
    const auth = await import('../../apps/dashboard/src/lib/fb/auth');
    const core = await import('../../apps/dashboard/src/lib/fb/core');
    const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth');
    const email = `ada${Date.now()}@gmail.com`;
    const cred = GoogleAuthProvider.credential(JSON.stringify({ sub: `g${Date.now()}`, email, email_verified: true, display_name: 'Ada Obi' }));
    await signInWithCredential(fbm.fb().auth, cred);
    core.clearCtx();
    await auth.googleCreateWorkspace('Ada Beauty Lounge');
    const me: any = await auth.me();
    expect(me.tenant.name).toBe('Ada Beauty Lounge');
    expect(me.role).toBe('owner');
    expect(me.user.email).toBe(email);
  });
});
