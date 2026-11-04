import { scoreRisk } from '../../workers/payments/src/risk';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { creditDays } from '../../workers/payments/src/routes/billing.js';
import { SEATS } from '../../workers/payments/src/routes/team.js';
import { KEEP, backupId, gunzip, open as openBackup, scheduledBackups } from '../../workers/payments/src/routes/backups.js';
import { LIMITS } from '../../apps/dashboard/src/lib/fb/plan';
import { handle, paystackSignature, amountMinor, planAfterPayment, throttled, toFs, fromFs, resetTokenCache, resetJwksCache, type Env } from '../../workers/payments/src/index.js';

const PROJECT = 'zexcore-5d6c0';
const SECRET = 'sk_test_worker_secret';
const WID = 'ws1';
const NOW = new Date('2026-11-02T10:00:00Z');

let saPem = ''; let idKey: CryptoKeyPair; let idJwk: any;
let env: Env;

const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
async function pkcs8Pem(key: CryptoKey) {
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', key)).toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
}
async function idToken(over: Record<string, unknown> = {}, key = idKey.privateKey) {
  const head = b64(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })));
  const claims = { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'owner1', email: 'sade@example.com', email_verified: true,
    exp: Math.floor(NOW.getTime() / 1000) + 3000, iat: Math.floor(NOW.getTime() / 1000), ...over };
  const body = b64(Buffer.from(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

// ── in-memory Firestore + Google + Paystack ──
type Doc = { fields: Record<string, any>; v: number };
let emails: any[] = [];
let deletedLogins: string[] = [];
let store: Map<string, Doc>; let commits: any[]; let paystackInit: any[]; let paystackVerify: Record<string, any>; let paystackSub: any[];
const fsPath = (u: string) => decodeURIComponent(u.split('/documents/')[1]!.split('?')[0]!);
function mockFetch(): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('/service_accounts/v1/jwk/securetoken')) return Response.json({ keys: [{ ...idJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (url.endsWith(':commit')) {
      const writes = JSON.parse(init.body).writes as any[];
      for (const w of writes) {   // validate every precondition first = atomic
        const p = fsPath((w.update ?? { name: w.delete }).name); const cur = store.get(p);
        if (w.currentDocument?.exists === false && cur) return new Response('{}', { status: 409 });
        if (w.currentDocument?.exists === true && !cur) return new Response('{}', { status: 404 });
        if (w.currentDocument?.updateTime && String(cur?.v) !== w.currentDocument.updateTime) return new Response('{}', { status: 409 });
      }
      for (const w of writes) {
        if (w.delete) { store.delete(fsPath(w.delete)); continue; }
        const p = fsPath(w.update.name); const cur = store.get(p);
        const next = w.updateMask ? { ...(cur?.fields ?? {}), ...Object.fromEntries(w.updateMask.fieldPaths.map((k: string) => [k, w.update.fields[k]])) } : w.update.fields;
        store.set(p, { fields: next, v: (cur?.v ?? 0) + 1 });
      }
      commits.push(writes);
      return Response.json({});
    }
    if (url.includes('identitytoolkit.googleapis.com') && url.endsWith('/accounts:delete')) { deletedLogins.push(JSON.parse(init.body).localId); return Response.json({}); }
    if (url === 'https://api.resend.com/emails') { emails.push(JSON.parse(init.body)); return Response.json({ id: 'e1' }); }
    if (url.endsWith(':runQuery')) {   // lists a collection under a parent; filters are not evaluated (tests seed only what they need)
      const parent = decodeURIComponent(url.split('/documents')[1]!.replace(/:runQuery$/, '')).replace(/^\//, '');
      const col = JSON.parse(init.body).structuredQuery.from[0].collectionId;
      const prefix = `${parent ? parent + '/' : ''}${col}/`;
      return Response.json([...store.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(([k, d]) => ({ document: { name: `projects/${PROJECT}/databases/(default)/documents/${k}`, fields: d.fields, updateTime: String(d.v) } })));
    }
    if (url.includes('firestore.googleapis.com')) {
      const d = store.get(fsPath(url));
      return d ? Response.json({ name: `projects/${PROJECT}/databases/(default)/documents/${fsPath(url)}`, fields: d.fields, updateTime: String(d.v) }) : new Response('{}', { status: 404 });
    }
    if (url.endsWith('/transaction/initialize')) { paystackInit.push(JSON.parse(init.body)); return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc' } }); }
    if (url.includes('/transaction/verify/')) { const ref = decodeURIComponent(url.split('/verify/')[1]!); return Response.json(paystackVerify[ref] ?? { status: false }); }
    if (url.includes('/bank/resolve')) return url.includes('account_number=0000000000') ? Response.json({ status: false }, { status: 422 }) : Response.json({ status: true, data: { account_name: 'SADE SALON LTD' } });
    if (url.endsWith('/subaccount') || url.includes('/subaccount/')) { paystackSub.push(JSON.parse(init.body)); return Response.json({ status: true, data: { subaccount_code: 'ACCT_test123' } }); }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}
const seedDoc = (path: string, data: Record<string, unknown>) => store.set(path, { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])), v: 1 });
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  handle(new Request(`https://pay.example.workers.dev${path}`, { method: 'POST', ...init }), env, { fetch: mockFetch(), now: () => NOW });
const checkoutBody = (o: object = {}) => JSON.stringify({ workspaceId: WID, tier: 'growth', cycle: 'monthly', currency: 'NGN', ...o });
const authed = async (over?: Record<string, unknown>) => ({ authorization: `Bearer ${await idToken(over)}`, 'content-type': 'application/json', origin: 'https://zexcore.com.ng' });

beforeAll(async () => {
  const sa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  saPem = await pkcs8Pem(sa.privateKey);
  idKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  idJwk = await crypto.subtle.exportKey('jwk', idKey.publicKey);
});
beforeEach(() => {
  resetTokenCache(); resetJwksCache();
  emails = []; store = new Map(); commits = []; paystackInit = []; paystackVerify = {}; paystackSub = [];
  env = { PAYSTACK_SECRET_KEY: SECRET, ALLOW_TEST_PAYMENTS: 'true', FIREBASE_PROJECT_ID: PROJECT, APP_URL: 'https://zexcore.com.ng', ALLOWED_ORIGINS: 'https://zexcore.com.ng,https://zexcore-5d6c0.web.app', NGN_PER_USD: '1500',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'w@x.iam.gserviceaccount.com', private_key: saPem }) };
  seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'free', ownerUid: 'owner1', slug: 'sade-salon' });
  seedDoc(`workspaces/${WID}/members/owner1`, { role: 'owner' });
  seedDoc(`workspaces/${WID}/members/staff1`, { role: 'staff' });
});

describe('public route rate limit', () => {
  it('returns 429 when the optional limiter says no, and ignores it when absent', async () => {
    const limited = { ...env, PUBLIC_RL: { limit: async () => ({ success: false }) } } as Env;
    const r = await handle(new Request('https://pay.example.workers.dev/api/public/deposit', { method: 'POST', body: '{}' }), limited, { fetch: mockFetch(), now: () => NOW });
    expect(r.status).toBe(429);
    const open = { ...env, PUBLIC_RL: { limit: async () => ({ success: true }) } } as Env;
    const r2 = await handle(new Request('https://pay.example.workers.dev/api/public/deposit', { method: 'POST', body: '{}' }), open, { fetch: mockFetch(), now: () => NOW });
    expect(r2.status).not.toBe(429);
    const r3 = await handle(new Request('https://pay.example.workers.dev/api/public/deposit', { method: 'POST', body: '{}' }), env, { fetch: mockFetch(), now: () => NOW });
    expect(r3.status).not.toBe(429);
  });
});

describe('test-key guard', () => {
  it('switches money routes off for a Paystack test key unless staging, and for a missing key', async () => {
    for (const e of [{ ...env, ALLOW_TEST_PAYMENTS: undefined }, { ...env, PAYSTACK_SECRET_KEY: '' }, { ...env, PAYSTACK_SECRET_KEY: 'pk_live_x' }]) {
      const r = await handle(new Request('https://pay.example.workers.dev/api/checkout', { method: 'POST', body: '{}' }), e as Env, { fetch: mockFetch(), now: () => NOW });
      expect(r.status).toBe(503);
      expect((await r.json() as any).code).toBe('unavailable');
    }
    const w = await handle(new Request('https://pay.example.workers.dev/api/paystack-webhook', { method: 'POST', body: '{}' }), { ...env, ALLOW_TEST_PAYMENTS: undefined } as Env, { fetch: mockFetch(), now: () => NOW });
    expect(w.status).toBe(200);
    expect((await w.json() as any).ignored).toBe(true);
  });
  it('lets a live key through to normal handling', async () => {
    const r = await handle(new Request('https://pay.example.workers.dev/api/checkout', { method: 'POST', body: '{}' }), { ...env, PAYSTACK_SECRET_KEY: 'sk_live_abc', ALLOW_TEST_PAYMENTS: undefined } as Env, { fetch: mockFetch(), now: () => NOW });
    expect(r.status).toBe(401);   // reaches the handler, which wants a signed-in user
  });
  it('health and rates keep working with a test key', async () => {
    const r = await handle(new Request('https://pay.example.workers.dev/api/health'), { ...env, ALLOW_TEST_PAYMENTS: undefined } as Env, { fetch: mockFetch(), now: () => NOW });
    expect(r.status).toBe(200);
  });
});

describe('pricing', () => {
  it('computes prices on the server in minor units', () => {
    expect(amountMinor('growth', 'monthly', 'NGN')).toBe(6_500_000);
    expect(amountMinor('starter', 'annual', 'NGN')).toBe(12_000_000);            // ten months: two free
    expect(amountMinor('agency', 'annual', 'NGN')).toBe(200_000_000);
    expect(amountMinor('agency', 'annual', 'NGN')).toBe(amountMinor('agency', 'monthly', 'NGN') * 10);
    expect(amountMinor('starter', 'annual', 'USD')).toBe(8_000);
  });
  it('round-trips Firestore values', () => {
    const v = { a: 'x', n: 5, d: new Date('2026-01-01T00:00:00Z'), arr: [1, 'b'], nested: { ok: true } };
    expect(fromFs(toFs(v))).toEqual(v);
  });
});

describe('POST /api/checkout', () => {
  it('rejects missing, forged, expired and wrong-project tokens', async () => {
    expect((await call('/api/checkout', { body: checkoutBody() })).status).toBe(401);
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])) as CryptoKeyPair;
    for (const t of [await idToken({}, other.privateKey), await idToken({ exp: 10 }), await idToken({ aud: 'other-project' }), 'not.a.jwt']) {
      expect((await call('/api/checkout', { body: checkoutBody(), headers: { authorization: `Bearer ${t}` } })).status).toBe(401);
    }
    expect(paystackInit).toHaveLength(0);
  });
  it('requires an email on the account', async () => {
    const r = await call('/api/checkout', { body: checkoutBody(), headers: await authed({ email: '' }) });
    expect(r.status).toBe(400); expect((await r.json()).code).toBe('email_missing');
  });
  it('only lets owners and admins of that workspace upgrade it', async () => {
    expect((await call('/api/checkout', { body: checkoutBody(), headers: await authed({ sub: 'staff1' }) })).status).toBe(403);
    expect((await call('/api/checkout', { body: checkoutBody(), headers: await authed({ sub: 'stranger' }) })).status).toBe(403);
    expect(paystackInit).toHaveLength(0);
  });
  it('prices the order itself and ignores any amount the browser sends', async () => {
    const r = await call('/api/checkout', { body: checkoutBody({ amount: 1, amountMinor: 1, price: 0 }), headers: await authed() });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.authorizationUrl).toBe('https://checkout.paystack.com/abc');
    expect(paystackInit[0].amount).toBe(6_500_000);
    expect(paystackInit[0].currency).toBe('NGN');
    const pay = [...store.entries()].find(([k]) => k.startsWith(`workspaces/${WID}/payments/`))!;
    expect(fromFs(pay[1].fields.status)).toBe('pending');
    expect(fromFs(pay[1].fields.amountMinor)).toBe(6_500_000);
  });
  it('validates plan, cycle, currency and workspace id', async () => {
    for (const bad of [{ tier: 'free' }, { tier: 'platinum' }, { cycle: 'weekly' }, { currency: 'GBP' }, { workspaceId: '../x' }]) {
      expect((await call('/api/checkout', { body: checkoutBody(bad), headers: await authed() })).status).toBe(400);
    }
  });
  it('answers CORS only for allowed origins', async () => {
    const ok = await call('/api/checkout', { method: 'OPTIONS', headers: { origin: 'https://zexcore.com.ng' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://zexcore.com.ng');
    const evil = await call('/api/checkout', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /api/paystack-webhook', () => {
  const REF = 'zx_ws1_test_ref';
  const event = (over: Record<string, unknown> = {}) => JSON.stringify({ event: 'charge.success', data: { reference: REF, metadata: { workspaceId: WID, tier: 'enterprise' }, ...over } });
  const send = async (body: string, sig?: string) => call('/api/paystack-webhook', { body, headers: { 'x-paystack-signature': sig ?? (await paystackSignature(body, SECRET)) } });
  const pending = (over: Record<string, unknown> = {}) => seedDoc(`workspaces/${WID}/payments/${REF}`, { reference: REF, tier: 'growth', cycle: 'monthly', currency: 'NGN', amountMinor: 6_500_000, status: 'pending', ...over });
  const ok = (amount = 6_500_000, currency = 'NGN') => { paystackVerify[REF] = { status: true, data: { status: 'success', amount, currency, reference: REF } }; };
  const plan = () => fromFs(store.get(`workspaces/${WID}`)!.fields.plan);

  it('rejects bad or missing signatures and changes nothing', async () => {
    pending(); ok();
    expect((await send(event(), 'deadbeef')).status).toBe(401);
    expect((await call('/api/paystack-webhook', { body: event() })).status).toBe(401);
    expect(plan()).toBe('free');
  });
  it('activates the plan Paystack confirmed, using OUR record not the posted metadata', async () => {
    pending(); ok();
    const r = await send(event());                                  // metadata claims "enterprise"; our record says growth
    expect(r.status).toBe(200); expect((await r.json()).activated).toBe('growth');
    expect(plan()).toBe('growth');
    const exp = fromFs(store.get(`workspaces/${WID}`)!.fields.planExpiresAt) as Date;
    expect(exp.toISOString()).toBe(new Date(NOW.getTime() + 31 * 86400000).toISOString());
    expect(fromFs(store.get(`workspaces/${WID}/payments/${REF}`)!.fields.status)).toBe('paid');
  });
  it('is idempotent: a replayed webhook does not extend the plan again', async () => {
    pending(); ok();
    await send(event()); const first = commits.length;
    const r = await send(event());
    expect((await r.json()).duplicate).toBe(true);
    expect(commits.length).toBe(first);
  });
  it('refuses underpayment and wrong currency', async () => {
    pending(); ok(100);
    expect((await (await send(event())).json()).ignored).toBe('amount_mismatch');
    expect(plan()).toBe('free');
    pending(); ok(6_500_000, 'USD');
    await send(event());
    expect(plan()).toBe('free');
  });
  it('ignores references we never issued and payments Paystack does not confirm', async () => {
    ok(); expect((await (await send(event())).json()).ignored).toBe('unknown_reference');
    pending(); paystackVerify[REF] = { status: true, data: { status: 'failed', amount: 6_500_000, currency: 'NGN', reference: REF } };
    expect((await (await send(event())).json()).ignored).toBe('not_successful');
    expect(plan()).toBe('free');
  });
  it('ignores other events', async () => {
    pending(); ok();
    expect((await (await send(JSON.stringify({ event: 'charge.failed', data: { reference: REF } }))).json()).ignored).toBe(true);
    expect(plan()).toBe('free');
  });
  it('moving up a plan credits the unused time of the old one', async () => {
    seedDoc(`workspaces/${WID}`, { plan: 'starter', ownerUid: 'owner1', planExpiresAt: new Date(NOW.getTime() + 30 * 86400000) });
    pending(); ok();
    await send(event());
    expect(plan()).toBe('growth');
    const exp = fromFs(store.get(`workspaces/${WID}`)!.fields.planExpiresAt) as Date;
    expect(exp.getTime()).toBe(NOW.getTime() + (31 + Math.floor(30 * 12 / 65)) * 86400000);
  });
  it('renewing early keeps the time already paid for', async () => {
    seedDoc(`workspaces/${WID}`, { plan: 'growth', ownerUid: 'owner1', planExpiresAt: new Date(NOW.getTime() + 10 * 86400000) });
    pending(); ok();
    await send(event());
    const exp = fromFs(store.get(`workspaces/${WID}`)!.fields.planExpiresAt) as Date;
    expect(exp.getTime()).toBe(NOW.getTime() + 41 * 86400000);
  });
});

describe('plan changes while a plan is running', () => {
  it('refuses a cheaper plan while a dearer one is still paid for', async () => {
    seedDoc(`workspaces/${WID}`, { plan: 'growth', ownerUid: 'owner1', planExpiresAt: new Date(NOW.getTime() + 10 * 86400000) });
    const r = await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'starter' }) });
    expect(r.status).toBe(409);
    expect((await r.json() as any).code).toBe('downgrade_blocked');
  });
  it('allows the same plan or a dearer one', async () => {
    seedDoc(`workspaces/${WID}`, { plan: 'starter', ownerUid: 'owner1', planExpiresAt: new Date(NOW.getTime() + 10 * 86400000) });
    expect((await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'starter' }) })).status).toBe(201);
    expect((await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'growth' }) })).status).toBe(201);
  });
  it('turns unused time on the old plan into extra days when moving up', () => {
    expect(creditDays('starter', 30 * 86_400_000, 'growth')).toBe(Math.floor(30 * 12 / 65));
    expect(creditDays('starter', 0, 'growth')).toBe(0);
    expect(creditDays('free', 30 * 86_400_000, 'growth')).toBe(0);
  });
});

describe('deposits', () => {
  const DW = 'wsdeposit0000000000a';
  beforeEach(() => { seedDoc(`workspaces/${DW}`, { name: 'Sade Salon', plan: 'free', ownerUid: 'owner1', slug: 'sade-salon' }); seedDoc(`workspaces/${DW}/members/owner1`, { role: 'owner' }); seedDoc(`workspaces/${DW}/members/staff1`, { role: 'staff' }); });
  const BOOKING = '202611_7';
  const seedDeposit = (over: Record<string, unknown> = {}) => {
    seedDoc(`workspaces/${DW}`, { name: 'Sade Salon', plan: 'growth', ownerUid: 'owner1', slug: 'sade-salon', settings: { depositEnabled: true, depositMinor: 500, exchangeRate: 1500 } });
    seedDoc('slugs/sade-salon', { wid: DW, ownerUid: 'owner1' });
    seedDoc(`workspaces/${DW}/payout/main`, { subaccountCode: 'ACCT_test123', bankName: 'Test Bank', accountName: 'SADE SALON LTD', last4: '1234' });
    seedDoc(`workspaces/${DW}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
    seedDoc(`workspaces/${DW}/bookings/${BOOKING}`, { status: 'pending', source: 'public', serviceId: 's_0', customerName: 'Ada', createdAt: new Date(NOW.getTime() - 60_000), startsAt: new Date(NOW.getTime() + 86_400_000), ...over });
  };
  const start = (over: Record<string, unknown> = {}) => call('/api/public/deposit', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'sade-salon', bookingId: BOOKING, email: 'ada@example.com', ...over }) });

  it('verifies the bank account with Paystack before creating a payout account; owner only', async () => {
    const body = (o: object = {}) => JSON.stringify({ workspaceId: DW, bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', ...o });
    expect((await call('/api/payout/setup', { body: body(), headers: { ...(await authed({ sub: 'staff1' })) } })).status).toBe(403);
    expect((await call('/api/payout/setup', { body: body({ accountNumber: '0000000000' }), headers: await authed() })).status).toBe(422);
    expect(paystackSub).toHaveLength(0);
    const r = await call('/api/payout/setup', { body: body(), headers: await authed() });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, accountName: 'SADE SALON LTD', last4: '6789' });
    expect(paystackSub[0]).toMatchObject({ settlement_bank: '058', account_number: '0123456789', percentage_charge: 0 });
    expect(fromFs(store.get(`workspaces/${DW}/payout/main`)!.fields.subaccountCode)).toBe('ACCT_test123');
    // the full account number is never stored
    expect(JSON.stringify(store.get(`workspaces/${DW}/payout/main`))).not.toContain('0123456789');
  });

  it('converts the dollar deposit at the business own exchange rate and pays it out to their account, ignoring the browser', async () => {
    seedDeposit();
    const r = await start({ amount: 1 });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ authorizationUrl: 'https://checkout.paystack.com/abc', amountMinor: 750_000 });
    expect(paystackInit[0]).toMatchObject({ amount: 750_000, subaccount: 'ACCT_test123', bearer: 'subaccount', currency: 'NGN', metadata: { kind: 'deposit', bookingId: BOOKING } });
    expect(paystackInit[0].callback_url).toMatch(/^https:\/\/zexcore\.com\.ng\/sade-salon\?pay=zx_/);
  });

  it('refuses when deposits are off, payouts are missing, the booking is old, cancelled or already paid', async () => {
    seedDeposit({ createdAt: new Date(NOW.getTime() - 3_600_000) }); expect((await start()).status).toBe(404);
    seedDeposit({ status: 'cancelled' }); expect((await start()).status).toBe(409);
    seedDeposit({ depositStatus: 'paid' }); expect((await start()).status).toBe(409);
    seedDeposit(); store.delete(`workspaces/${DW}/payout/main`); expect((await start()).status).toBe(409);
    seedDeposit(); seedDoc(`workspaces/${DW}`, { name: 'x', plan: 'growth', ownerUid: 'owner1', slug: 'sade-salon', settings: { depositEnabled: false, depositMinor: 0 } }); expect((await start()).status).toBe(409);
    expect(paystackInit).toHaveLength(0);
  });

  it('confirms the booking only when Paystack verifies the full amount, and is idempotent', async () => {
    seedDeposit();
    const { reference } = (await (await start()).json()) as { reference: string };
    const status = () => call(`/api/public/deposit-status?slug=sade-salon&reference=${reference}`, { method: 'GET' });
    expect(((await (await status()).json()) as any).depositStatus).toBe('unpaid');
    paystackVerify[reference] = { status: true, data: { status: 'success', amount: 100, currency: 'NGN', reference } };
    expect(((await (await status()).json()) as any).depositStatus).toBe('mismatch');
    expect(fromFs(store.get(`workspaces/${DW}/bookings/${BOOKING}`)!.fields.status)).toBe('pending');
    seedDoc(`workspaces/${DW}/depositPayments/${reference}`, { reference, bookingId: BOOKING, amountMinor: 750_000, usdMinor: 500, rate: 1500, currency: 'NGN', status: 'pending' });
    paystackVerify[reference] = { status: true, data: { status: 'success', amount: 750_000, currency: 'NGN', reference } };
    const j = (await (await status()).json()) as any;
    expect(j).toMatchObject({ depositStatus: 'paid', status: 'confirmed', amountMinor: 500, currency: 'USD', chargedNgnMinor: 750_000, serviceName: 'Braids' });
    const b = store.get(`workspaces/${DW}/bookings/${BOOKING}`)!.fields;
    expect(fromFs(b.depositStatus)).toBe('paid'); expect(fromFs(b.depositMinor)).toBe(500); expect(fromFs(b.status)).toBe('confirmed'); expect(fromFs(b.paymentReference)).toBe(reference);
    expect(((await (await status()).json()) as any).depositStatus).toBe('paid');
  });

  it('settles a deposit from the webhook too, so closing the tab never loses a payment', async () => {
    seedDeposit();
    const { reference } = (await (await start()).json()) as { reference: string };
    paystackVerify[reference] = { status: true, data: { status: 'success', amount: 750_000, currency: 'NGN', reference } };
    const body = JSON.stringify({ event: 'charge.success', data: { reference, metadata: { kind: 'deposit', workspaceId: DW, bookingId: BOOKING } } });
    expect((await call('/api/paystack-webhook', { body, headers: { 'x-paystack-signature': await paystackSignature(body, SECRET) } })).status).toBe(200);
    expect(fromFs(store.get(`workspaces/${DW}/bookings/${BOOKING}`)!.fields.depositStatus)).toBe('paid');
  });

  it('lets team members (not outsiders) create a payment link for any booking', async () => {
    seedDeposit({ source: 'staff', createdAt: new Date(NOW.getTime() - 9 * 86_400_000) });
    const body = JSON.stringify({ workspaceId: DW, bookingId: BOOKING, email: 'ada@example.com' });
    expect((await call('/api/deposit/link', { body, headers: await authed({ sub: 'stranger' }) })).status).toBe(403);
    const r = await call('/api/deposit/link', { body, headers: await authed({ sub: 'staff1' }) });
    expect(r.status).toBe(201);
  });
});

describe('plan time is never lost', () => {
  const day = 86_400_000;
  it('starts a fresh period when nothing is active, and adds to the same plan', () => {
    expect(planAfterPayment('free', null, 'growth', 'monthly', NOW)).toEqual({ plan: 'growth', expires: new Date(NOW.getTime() + 31 * day) });
    const left = new Date(NOW.getTime() + 10 * day);
    expect(planAfterPayment('growth', left, 'growth', 'monthly', NOW).expires.getTime()).toBe(NOW.getTime() + 41 * day);
  });
  it('converts what is left on a cheaper plan into time on the new one when upgrading', () => {
    const left = new Date(NOW.getTime() + 49 * day);                 // 49 days of Starter (₦12,000) = 9 days of Growth (₦65,000)
    const r = planAfterPayment('starter', left, 'growth', 'monthly', NOW);
    expect(r.plan).toBe('growth');
    expect(Math.round((r.expires.getTime() - NOW.getTime()) / day)).toBe(Math.round(49 * 12 / 65 + 31));
  });
  it('keeps the higher plan, and extends it, if a lower plan is paid for while it is active', () => {
    const left = new Date(NOW.getTime() + 20 * day);
    const r = planAfterPayment('growth', left, 'starter', 'monthly', NOW);
    expect(r.plan).toBe('growth');
    expect(r.expires.getTime()).toBeGreaterThan(left.getTime());
  });
  it('refuses to start a checkout for a lower plan while a higher one is active', async () => {
    seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'agency', ownerUid: 'owner1', slug: 'sade-salon', planExpiresAt: new Date(NOW.getTime() + 20 * day) });
    const r = await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'starter' }) });
    expect(r.status).toBe(409);
    expect((await r.json() as any).code).toBe('downgrade_blocked');
    // Enterprise and Dedicated are arranged with the team, never started online
    const big = await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'enterprise' }) });
    expect(big.status).toBe(409);
    expect((await big.json() as any).code).toBe('contact_us');
    seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'starter', ownerUid: 'owner1', slug: 'sade-salon', planExpiresAt: new Date(NOW.getTime() + 20 * day) });
    const up = await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'agency' }) });
    expect(up.status).toBe(201);
  });
});

describe('public route throttle', () => {
  it('allows 20 calls a minute per visitor and route, then says to wait', () => {
    const t = Date.now();
    for (let i = 0; i < 20; i++) expect(throttled('1.2.3.4 POST /x', t + i)).toBe(false);
    expect(throttled('1.2.3.4 POST /x', t + 21)).toBe(true);
    expect(throttled('5.6.7.8 POST /x', t + 21)).toBe(false);
    expect(throttled('1.2.3.4 POST /x', t + 61_000)).toBe(false);
  });
});

describe('team access', () => {
  const body = (o: object) => JSON.stringify({ wid: WID_T, ...o });
  const WID_T = 'abcdefghij0123456789';
  const asUser = (sub: string, email: string, verified = true) => authed({ sub, email, email_verified: verified });
  const inviteReq = async (sub: string, email: string, role: string, to = 'new@example.com') =>
    call('/api/team/invite', { body: body({ email: to, role }), headers: await asUser(sub, email) });
  const tokenOf = (link: string) => new URL(link).searchParams.get('t')!;
  beforeEach(() => {
    seedDoc(`workspaces/${WID_T}`, { name: 'Team Salon', plan: 'growth', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'team-salon' });
    seedDoc(`workspaces/${WID_T}/members/owner1`, { role: 'owner', email: 'sade@example.com' });
    seedDoc(`workspaces/${WID_T}/members/adm1`, { role: 'admin', email: 'adm@example.com' });
    seedDoc(`workspaces/${WID_T}/members/ed1`, { role: 'editor', email: 'ed@example.com' });
  });

  it('seat limits per plan match the pricing page limits', () => {
    for (const t of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const n = LIMITS[t].staff;
      expect(SEATS[t]).toBe(n === null || n > 1000 ? 1000 : n);
    }
  });

  it('owner invites an editor, the invitee accepts once, and becomes a member of that workspace', async () => {
    const r = await inviteReq('owner1', 'sade@example.com', 'editor');
    expect(r.status).toBe(200);
    const { link } = (await r.json()) as { link: string };
    const token = tokenOf(link);
    const info = await call(`/api/team/invite-info?w=${WID_T}&t=${token}`, { method: 'GET', headers: { origin: 'https://zexcore.com.ng' } });
    expect(await info.json()).toMatchObject({ workspace: 'Team Salon', role: 'editor', email: 'new@example.com' });
    const acc = await call('/api/team/accept', { body: body({ token }), headers: await asUser('new1', 'New@Example.com') });
    expect(acc.status).toBe(200);
    expect(fromFs(store.get(`workspaces/${WID_T}/members/new1`)!.fields.role)).toBe('editor');
    expect(fromFs(store.get('users/new1')!.fields.workspaceIds)).toEqual([WID_T]);
    expect([...store.keys()].some((k) => k.startsWith(`workspaces/${WID_T}/invites/`))).toBe(false);
    expect((await call('/api/team/accept', { body: body({ token }), headers: await asUser('new1', 'new@example.com') })).status).toBe(410);
  });

  it('only the invited, verified email can accept', async () => {
    const { link } = (await (await inviteReq('owner1', 'sade@example.com', 'editor')).json()) as { link: string };
    const token = tokenOf(link);
    expect((await call('/api/team/accept', { body: body({ token }), headers: await asUser('x1', 'other@example.com') })).status).toBe(403);
    expect((await call('/api/team/accept', { body: body({ token }), headers: await asUser('new1', 'new@example.com', false) })).status).toBe(403);
    expect((await call('/api/team/accept', { body: body({ token }), headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await call('/api/team/accept', { body: body({ token: 'f'.repeat(48) }), headers: await asUser('new1', 'new@example.com') })).status).toBe(410);
    expect(store.has(`workspaces/${WID_T}/members/new1`)).toBe(false);
  });

  it('expired invitations stop working', async () => {
    const { link } = (await (await inviteReq('owner1', 'sade@example.com', 'editor')).json()) as { link: string };
    const key = [...store.keys()].find((k) => k.startsWith(`workspaces/${WID_T}/invites/`))!;
    store.get(key)!.fields.expiresAt = toFs(new Date(NOW.getTime() - 1000));
    const r = await call('/api/team/accept', { body: body({ token: tokenOf(link) }), headers: await asUser('new1', 'new@example.com') });
    expect(r.status).toBe(410);
  });

  it('enforces who may invite or remove whom', async () => {
    expect((await inviteReq('ed1', 'ed@example.com', 'editor')).status).toBe(403);
    expect((await inviteReq('adm1', 'adm@example.com', 'admin')).status).toBe(403);
    expect((await inviteReq('adm1', 'adm@example.com', 'editor')).status).toBe(200);
    expect((await inviteReq('owner1', 'sade@example.com', 'owner')).status).toBe(400);
    const remove = async (sub: string, email: string, uid: string) => call('/api/team/remove', { body: body({ uid }), headers: await asUser(sub, email) });
    expect((await remove('adm1', 'adm@example.com', 'owner1')).status).toBe(403);
    expect((await remove('ed1', 'ed@example.com', 'adm1')).status).toBe(403);
    expect((await remove('adm1', 'adm@example.com', 'ed1')).status).toBe(200);
    expect(store.has(`workspaces/${WID_T}/members/ed1`)).toBe(false);
  });

  it('only the owner changes roles, and never the owner', async () => {
    const setRole = async (sub: string, email: string, uid: string, role: string) => call('/api/team/role', { body: body({ uid, role }), headers: await asUser(sub, email) });
    expect((await setRole('adm1', 'adm@example.com', 'ed1', 'admin')).status).toBe(403);
    expect((await setRole('owner1', 'sade@example.com', 'owner1', 'editor')).status).toBe(403);
    expect((await setRole('owner1', 'sade@example.com', 'ed1', 'admin')).status).toBe(200);
    expect(fromFs(store.get(`workspaces/${WID_T}/members/ed1`)!.fields.role)).toBe('admin');
  });

  it('refuses invitations beyond the plan\'s team logins', async () => {
    seedDoc(`workspaces/${WID_T}`, { name: 'Team Salon', plan: 'starter', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'team-salon' });
    const r = await inviteReq('owner1', 'sade@example.com', 'editor');    // starter = 3 logins, already 3 members
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).code).toBe('seat_limit');
    seedDoc(`workspaces/${WID_T}`, { name: 'Team Salon', plan: 'free', ownerUid: 'owner1', slug: 'team-salon' });
    expect((await inviteReq('owner1', 'sade@example.com', 'editor')).status).toBe(402);
  });

  it('viewer logins are Enterprise and Dedicated only, and cannot act', async () => {
    expect((await inviteReq('owner1', 'sade@example.com', 'viewer')).status).toBe(402);   // growth plan
    seedDoc(`workspaces/${WID_T}`, { name: 'Team Salon', plan: 'enterprise', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'team-salon' });
    const r = await inviteReq('owner1', 'sade@example.com', 'viewer');
    expect(r.status).toBe(200);
    expect((await inviteReq('adm1', 'adm@example.com', 'viewer', 'acct@example.com')).status).toBe(200);
    seedDoc(`workspaces/${WID_T}/members/view1`, { role: 'viewer', email: 'view@example.com' });
    const v = await asUser('view1', 'view@example.com');
    expect((await call('/api/team/invite', { body: body({ email: 'x@example.com', role: 'editor' }), headers: v })).status).toBe(403);
    expect((await call('/api/events', { body: JSON.stringify({ workspaceId: WID_T, event: 'booking.created', payload: {} }), headers: v })).status).toBe(403);
    expect((await call('/api/audit', { body: JSON.stringify({ workspaceId: WID_T, action: 'x.y', entity: 'x' }), headers: v })).status).toBe(403);
  });

  it('rejects duplicates of someone already on the team', async () => {
    expect((await inviteReq('owner1', 'sade@example.com', 'editor', 'ED@example.com')).status).toBe(409);
  });
});

describe('encrypted backups', () => {
  const BW = 'bkpworkspace01234567';
  const store2 = () => new Map<string, Uint8Array>();
  let r2data: Map<string, Uint8Array>;
  const r2 = () => ({
    put: async (k: string, v: Uint8Array) => { r2data.set(k, v); },
    get: async (k: string) => (r2data.has(k) ? { arrayBuffer: async () => { const v = r2data.get(k)!; return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer; } } : null),
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...r2data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    delete: async (keys: string | string[]) => { for (const k of [].concat(keys as never)) r2data.delete(k); },
  });
  const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const run = async (sub = 'owner1', email = 'sade@example.com') => call('/api/backups/run', { body: JSON.stringify({ workspaceId: BW }), headers: await authed({ sub, email }) });
  const get = async (path: string, sub = 'owner1') => call(path, { method: 'GET', headers: await authed({ sub, email: 'sade@example.com' }) });
  beforeEach(() => {
    r2data = store2();
    env = { ...env, BACKUPS: r2() as never, BACKUP_KEY: KEY };
    seedDoc(`workspaces/${BW}`, { name: 'Ade & Sons (Ltd)', slug: 'ade', plan: 'enterprise', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1' });
    seedDoc(`workspaces/${BW}/members/owner1`, { role: 'owner', email: 'sade@example.com' });
    seedDoc(`workspaces/${BW}/members/view1`, { role: 'viewer', email: 'v@example.com' });
    seedDoc(`workspaces/${BW}/bookings/202611_0`, { customerName: 'Ada Obi', customerPhone: '+2348031234567', status: 'confirmed' });
    seedDoc(`workspaces/${BW}/devices/d_0`, { name: 'Cold room', tokenHash: 'SECRETHASH' });
  });

  it('makes an encrypted, verified backup that holds the data but not device secrets', async () => {
    const r = await run();
    expect(r.status).toBe(201);
    const j = (await r.json()) as { id: string; verified: boolean; records: number; complete: boolean };
    expect(j).toMatchObject({ verified: true, complete: true });
    expect(j.id).toBe(backupId(NOW));
    const raw = r2data.get(`backups/${BW}/${j.id}.zxb`)!;
    expect(Buffer.from(raw).includes(Buffer.from('Ada Obi'))).toBe(false);            // not readable at rest
    const text = new TextDecoder().decode(await gunzip(await openBackup(env, BW, j.id, raw)));
    expect(text).toContain('Ada Obi'); expect(text).not.toContain('SECRETHASH');
    const meta = store.get(`workspaces/${BW}/backups/${j.id}`)!.fields;
    expect(fromFs(meta.verified)).toBe(true); expect(fromFs(meta.sha256)).toHaveLength(64);
  });

  it('a backup cannot be opened as a different workspace or backup id', async () => {
    const j = (await (await run()).json()) as { id: string };
    const raw = r2data.get(`backups/${BW}/${j.id}.zxb`)!;
    await expect(openBackup(env, 'otherworkspace012345', j.id, raw)).rejects.toBeTruthy();
    await expect(openBackup(env, BW, 'b_20200101_000000', raw)).rejects.toBeTruthy();
  });

  it('downloads a decrypted copy and a PDF certificate for owners, not viewers; Enterprise only', async () => {
    const j = (await (await run()).json()) as { id: string };
    const dl = await get(`/api/backups/download?workspaceId=${BW}&id=${j.id}`);
    expect(dl.status).toBe(200);
    expect(JSON.parse(await dl.text()).collections.bookings[0].customerName).toBe('Ada Obi');
    const cert = await get(`/api/backups/certificate?workspaceId=${BW}&id=${j.id}`);
    expect(cert.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await cert.arrayBuffer()).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true); expect(pdf).toContain('Backup Certificate'); expect(pdf).toContain('Ade & Sons \\(Ltd\\)'); expect(pdf).toContain('Verified: Yes');
    expect((await get(`/api/backups/download?workspaceId=${BW}&id=${j.id}`, 'view1')).status).toBe(403);
    seedDoc(`workspaces/${BW}`, { name: 'x', plan: 'growth', planExpiresAt: new Date(NOW.getTime() + 86_400_000), ownerUid: 'owner1', slug: 'ade' });
    expect((await run()).status).toBe(402);
  });

  it('is off without the bucket or key, and throttles repeat runs', async () => {
    const first = await run(); expect(first.status).toBe(201);
    expect((await run()).status).toBe(429);
    env = { ...env, BACKUPS: undefined };
    r2data.clear();
    expect((await run()).status).toBe(503);
  });

  it('the scheduler backs up only paid workspaces that are due, then leaves them alone', async () => {
    const dep = { fetch: mockFetch(), now: () => NOW };
    const first = await scheduledBackups(env, dep);
    expect(first.done).toEqual([BW]);                 // the free workspaces are skipped
    expect((await scheduledBackups(env, dep)).done).toEqual([]);
    const later = { fetch: mockFetch(), now: () => new Date(NOW.getTime() + 24 * 3_600_000) };
    expect((await scheduledBackups(env, later)).done).toEqual([BW]);
  });

  it('keeps only the newest backups', () => { expect(KEEP).toBe(30); });
});

describe('formal e-mails', () => {
  beforeEach(() => { env = { ...env, RESEND_API_KEY: 're_test' }; seedDoc('users/owner1', { name: 'Sade Bello', email: 'sade@example.com', workspaceIds: [WID] }); });
  const welcomeReq = async (over?: Record<string, unknown>) => call('/api/welcome', { body: '{}', headers: await authed(over) });

  it('welcomes a verified new user once, by name, as a plain formal message', async () => {
    const r = await welcomeReq();
    expect(await r.json()).toMatchObject({ ok: true, sent: true });
    expect(emails).toHaveLength(1);
    const m = emails[0];
    expect(m.to).toEqual(['sade@example.com']); expect(m.subject).toBe('Welcome to ZexCore, Sade');
    expect(m.html).toContain('https://zexcore.com.ng/app'); expect(m.html).toContain('Sade Salon'); expect(m.html).toContain('Dear Sade');
    expect(m.html).not.toContain('<table'); expect(m.html).not.toContain('background:#c8102e');   // no card, no button
    expect(m.text).toContain('https://zexcore.com.ng/app'); expect(m.text).toContain('Kind regards,'); expect(m.reply_to).toBe('hello@zexcore.com.ng');
    expect(await (await welcomeReq()).json()).toMatchObject({ sent: false });      // never twice
    expect(emails).toHaveLength(1);
  });
  it('does not mail an address that has not been verified, and does not use up the welcome', async () => {
    expect(await (await welcomeReq({ email_verified: false })).json()).toMatchObject({ sent: false, reason: 'unverified' });
    expect(emails).toHaveLength(0);
    expect(await (await welcomeReq()).json()).toMatchObject({ sent: true });
  });
  it('booking requests carry the details and escape anything a customer typed', async () => {
    seedDoc(`slugs/sade-salon`, { wid: WID });
    seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'free', ownerUid: 'owner1', slug: 'sade-salon', settings: { utcOffsetMinutes: 60 } });
    seedDoc(`workspaces/${WID}/members/owner1`, { role: 'owner', email: 'sade@example.com', name: 'Sade Bello' });
    seedDoc(`workspaces/${WID}/services/s_0`, { name: 'Braids', priceMinor: 5000 });
    const id = `${NOW.toISOString().slice(0, 7).replace('-', '')}_1`;
    seedDoc(`workspaces/${WID}/bookings/${id}`, { customerName: '<img src=x onerror=alert(1)>', customerPhone: '+2348031234567', serviceId: 's_0', status: 'pending', source: 'public', startsAt: new Date('2026-11-07T15:00:00Z'), createdAt: new Date(NOW.getTime() - 60_000) });
    const r = await call('/api/public/booked', { body: JSON.stringify({ slug: 'sade-salon', bookingId: id }), headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' } });
    expect(r.status).toBe(200);
    const m = emails.find((x) => String(x.subject).startsWith('New booking request'))!;
    expect(m.html).not.toContain('<img src=x'); expect(m.html).toContain('&lt;img');
    expect(m.html).toContain('Sat, 7 Nov 2026 at 4:00 PM'); expect(m.html).toContain('Open dashboard'); expect(m.html).toContain('Hello Sade');
  });
});

describe('team changes and account deletion are audited', () => {
  const W = 'abcdefghij0123456789';
  const auditOf = (wid = W) => [...store.entries()].filter(([k]) => k.startsWith(`workspaces/${wid}/auditChain/`)).sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => ({ action: fromFs(d.fields.action), actor: fromFs(d.fields.actor), detail: fromFs(d.fields.detail) }));
  const nowS = () => Math.floor(NOW.getTime() / 1000);
  const as = (sub: string, email: string, authTime = nowS()) => authed({ sub, email, email_verified: true, auth_time: authTime });
  beforeEach(() => {
    deletedLogins = [];
    seedDoc(`workspaces/${W}`, { name: 'Audit Salon', plan: 'enterprise', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'audit-salon' });
    seedDoc(`workspaces/${W}/members/owner1`, { role: 'owner', email: 'sade@example.com' });
    seedDoc(`workspaces/${W}/members/ed1`, { role: 'editor', email: 'ed@example.com' });
    seedDoc('users/owner1', { workspaceIds: [W] });
    seedDoc('users/ed1', { workspaceIds: [W] });
    seedDoc('slugs/audit-salon', { wid: W });
    seedDoc(`workspaces/${W}/bookings/b1`, { customerName: 'Tunde' });
    seedDoc(`workspaces/${W}/customers/c1`, { name: 'Tunde' });
    seedDoc(`workspaces/${W}/devices/d1`, { name: 'Sensor' });
    seedDoc(`workspaces/${W}/devices/d1/readings/r1`, { v: 1 });
  });

  it('invite, role change and removal each leave a log entry naming who did it', async () => {
    const inv = await call('/api/team/invite', { body: JSON.stringify({ wid: W, email: 'new@example.com', role: 'admin' }), headers: await as('owner1', 'sade@example.com') });
    expect(inv.status).toBe(200);
    expect((await call('/api/team/role', { body: JSON.stringify({ wid: W, uid: 'ed1', role: 'viewer' }), headers: await as('owner1', 'sade@example.com') })).status).toBe(200);
    expect((await call('/api/team/remove', { body: JSON.stringify({ wid: W, uid: 'ed1' }), headers: await as('owner1', 'sade@example.com') })).status).toBe(200);
    const log = auditOf();
    expect(log.map((e) => e.action)).toEqual(['team.invite', 'team.role', 'team.remove']);
    expect(log.every((e) => e.actor === 'owner1')).toBe(true);
    expect(log[0]!.detail).toBe('new@example.com as admin');
    expect(log[1]!.detail).toContain('editor to viewer');
  });

  it('a member deleting their account leaves the workspace and is logged', async () => {
    const r = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'ED@example.com' }), headers: await as('ed1', 'ed@example.com') });
    expect(r.status).toBe(200);
    expect(store.has(`workspaces/${W}/members/ed1`)).toBe(false);
    expect(store.has('users/ed1')).toBe(false);
    expect(store.has(`workspaces/${W}/bookings/b1`)).toBe(true);   // the workspace itself is untouched
    expect(deletedLogins).toEqual(['ed1']);
    expect(auditOf().map((e) => [e.action, e.actor])).toEqual([['account.delete', 'ed1']]);
  });

  it('an owner deleting their account logs it first, then erases the workspace but keeps the log', async () => {
    const r = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'sade@example.com' }), headers: await as('owner1', 'sade@example.com') });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ workspacesClosed: 1 });
    for (const k of ['bookings/b1', 'customers/c1', 'devices/d1', 'devices/d1/readings/r1', 'members/owner1', 'members/ed1']) expect(store.has(`workspaces/${W}/${k}`)).toBe(false);
    expect(store.has('slugs/audit-salon')).toBe(false);
    expect(store.has('users/owner1')).toBe(false);
    expect(fromFs(store.get('users/ed1')!.fields.workspaceIds)).toEqual([]);   // teammates lose the workspace
    expect(fromFs(store.get(`workspaces/${W}`)!.fields.status)).toBe('deleted');
    expect(auditOf().map((e) => [e.action, e.actor])).toEqual([['account.delete', 'owner1']]);
    expect(deletedLogins).toEqual(['owner1']);
  });

  it('needs a recent sign-in and the exact email', async () => {
    const stale = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'sade@example.com' }), headers: await as('owner1', 'sade@example.com', nowS() - 3600) });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { code: string }).code).toBe('reauth');
    const wrong = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'someone@else.com' }), headers: await as('owner1', 'sade@example.com') });
    expect(wrong.status).toBe(400);
    expect((await call('/api/account/delete', { body: JSON.stringify({ confirm: 'sade@example.com' }), headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(store.has(`workspaces/${W}/bookings/b1`)).toBe(true);
    expect(auditOf()).toEqual([]);
    expect(deletedLogins).toEqual([]);
  });
});

describe('no-show risk', () => {
  const RW = 'wsrisk0000000000000a';
  const BK = '202611_3';
  const PHONE = '+2348011112222';
  const past = (i: number, status: string, over: Record<string, unknown> = {}) =>
    seedDoc(`workspaces/${RW}/bookings/20260${i}_1`, { status, customerPhone: PHONE, startsAt: new Date(NOW.getTime() - (40 - i) * 86_400_000), ...over });
  const setup = (settings: Record<string, unknown> = {}, plan = 'enterprise') => {
    seedDoc(`workspaces/${RW}`, { name: 'Risk Salon', plan, planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'risk-salon',
      settings: { depositEnabled: false, depositMinor: 0, exchangeRate: 1500, riskDepositEnabled: true, riskDepositLevel: 'high', riskDepositMinor: 500, ...settings } });
    seedDoc('slugs/risk-salon', { wid: RW, ownerUid: 'owner1' });
    seedDoc(`workspaces/${RW}/members/owner1`, { role: 'owner' });
    seedDoc(`workspaces/${RW}/payout/main`, { subaccountCode: 'ACCT_test123' });
    seedDoc(`workspaces/${RW}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
    seedDoc(`workspaces/${RW}/bookings/${BK}`, { status: 'pending', source: 'public', serviceId: 's_0', customerName: 'Ada', customerPhone: PHONE, customerEmail: 'ada@example.com',
      createdAt: new Date(NOW.getTime() - 60_000), startsAt: new Date(NOW.getTime() + 86_400_000) });
  };
  const start = () => call('/api/public/deposit', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'risk-salon', bookingId: BK, email: 'ada@example.com' }) });
  const bookingField = (k: string) => fromFs(store.get(`workspaces/${RW}/bookings/${BK}`)!.fields[k]);

  it('scores from history with a reason for every point, ignoring itself and later bookings', () => {
    const base = { id: 'x', startsAt: NOW.getTime() + 86_400_000, createdAt: NOW.getTime(), hasEmail: true };
    const nos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, status: 'no_show', startsAt: NOW.getTime() - (i + 1) * 86_400_000 }));
    expect(scoreRisk([], base)).toMatchObject({ score: 15, level: 'low' });
    expect(scoreRisk([], { ...base, hasEmail: false }).score).toBe(20);
    expect(scoreRisk(nos(1), base)).toMatchObject({ score: 35, level: 'medium' });
    expect(scoreRisk(nos(3), base)).toMatchObject({ score: 80, level: 'high' });
    const good = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, status: 'completed', startsAt: NOW.getTime() - (i + 1) * 86_400_000 }));
    expect(scoreRisk(good, base)).toMatchObject({ score: 0, level: 'low' });
    // itself and anything that starts after it are not "history"
    expect(scoreRisk([...nos(3), { id: 'x', status: 'no_show', startsAt: NOW.getTime() - 1 }, { id: 'later', status: 'no_show', startsAt: NOW.getTime() + 9 * 86_400_000 }], base).score).toBe(80);
    expect(scoreRisk(nos(1), base).reasons.every((r) => /^[+-]\d+ /.test(r))).toBe(true);
  });

  it('a customer who keeps missing visits is asked for the risk deposit, even though deposits are off for everyone', async () => {
    setup(); past(1, 'no_show'); past(2, 'no_show'); past(3, 'no_show');
    const r = await start();
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ amountMinor: 750_000 });   // $5 at 1,500
    expect(bookingField('riskLevel')).toBe('high');
    expect(bookingField('depositStatus')).toBe('unpaid');
    expect(bookingField('depositMinor')).toBe(500);
    expect(bookingField('riskDeposit')).toBe(true);
    expect(paystackInit[0]).toMatchObject({ subaccount: 'ACCT_test123', metadata: { kind: 'deposit', bookingId: BK } });
  });

  it('a reliable customer is not asked for anything', async () => {
    setup(); for (const i of [1, 2, 3, 4]) past(i, 'completed');
    expect((await start()).status).toBe(409);
    expect(bookingField('riskLevel')).toBe('low');
    expect(bookingField('depositStatus')).toBeNull();
    expect(paystackInit).toHaveLength(0);
  });

  it('the owner chooses the threshold', async () => {
    setup({ riskDepositLevel: 'high' }); past(1, 'no_show');            // 35: medium
    expect((await start()).status).toBe(409);
    setup({ riskDepositLevel: 'medium' }); past(1, 'no_show');
    expect((await start()).status).toBe(201);
  });

  it('does nothing when switched off, without payouts, or when the plan is not Enterprise', async () => {
    setup({ riskDepositEnabled: false }); past(1, 'no_show'); past(2, 'no_show'); past(3, 'no_show');
    expect((await start()).status).toBe(409);
    setup(); past(1, 'no_show'); past(2, 'no_show'); past(3, 'no_show'); store.delete(`workspaces/${RW}/payout/main`);
    expect((await start()).status).toBe(409);
    setup({}, 'growth'); past(1, 'no_show'); past(2, 'no_show'); past(3, 'no_show');
    expect((await start()).status).toBe(409);
    expect(bookingField('riskScore')).toBeNull();   // a plan without the feature is never scored
    expect(paystackInit).toHaveLength(0);
  });

  it('team members can ask for a score; non-Enterprise workspaces are told to upgrade', async () => {
    setup(); past(1, 'no_show');
    const ok = await call('/api/risk/assess', { body: JSON.stringify({ workspaceId: RW, bookingId: BK }), headers: await authed() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ level: 'medium', score: 35 });
    setup({}, 'growth');
    const no = await call('/api/risk/assess', { body: JSON.stringify({ workspaceId: RW, bookingId: BK }), headers: await authed() });
    expect(no.status).toBe(402);
    expect(((await no.json()) as { code: string }).code).toBe('plan_feature');
  });
});

describe('read-only API keys', () => {
  const KW = 'wskeys00000000000001';
  const setup = (plan = 'enterprise') => {
    seedDoc(`workspaces/${KW}`, { name: 'Keys Salon', plan, planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'keys-salon' });
    seedDoc(`workspaces/${KW}/members/owner1`, { role: 'owner', email: 'sade@example.com' });
    seedDoc(`workspaces/${KW}/members/ed1`, { role: 'editor', email: 'ed@example.com' });
    seedDoc(`workspaces/${KW}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
    seedDoc(`workspaces/${KW}/bookings/202611_1`, { status: 'completed', serviceId: 's_0', customerName: 'Ada', customerPhone: '+2348011112222', customerEmail: 'ada@example.com', notes: 'private note', startsAt: new Date('2026-11-01T10:00:00Z'), endsAt: new Date('2026-11-01T11:00:00Z') });
    seedDoc(`workspaces/${KW}/bookings/202611_2`, { status: 'no_show', serviceId: 's_0', customerName: 'Ada', customerPhone: '+2348011112222', startsAt: new Date('2026-11-05T10:00:00Z'), endsAt: new Date('2026-11-05T11:00:00Z') });
    seedDoc(`workspaces/${KW}/bookings/202611_3`, { status: 'confirmed', serviceId: 's_0', customerName: 'Tunde', customerPhone: '+2348033334444', startsAt: new Date('2026-11-09T10:00:00Z'), endsAt: new Date('2026-11-09T11:00:00Z') });
  };
  const make = async (name = 'Accountant sheet', as = 'owner1') => call('/api/keys/create', { body: JSON.stringify({ workspaceId: KW, name }), headers: await authed({ sub: as }) });
  const get = (path: string, key?: string) => call(path, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {} });
  const keyDocs = () => [...store.keys()].filter((k) => k.startsWith(`workspaces/${KW}/apiKeys/`));

  it('owners and admins make keys on Enterprise; the secret is shown once and only its fingerprint is stored', async () => {
    setup();
    const r = await make();
    expect(r.status).toBe(201);
    const { key } = (await r.json()) as { key: string };
    expect(key).toMatch(new RegExp(`^zxk_${KW}\\.[a-f0-9]{48}$`));
    const secret = key.split('.')[1]!;
    expect(JSON.stringify([...store.entries()].filter(([k]) => k.startsWith(`workspaces/${KW}/apiKeys/`)))).not.toContain(secret);
    expect([...store.entries()].some(([k, d]) => k.includes('/auditChain/') && fromFs(d.fields.action) === 'apikey.create')).toBe(true);
    expect((await make('x', 'ed1')).status).toBe(403);                     // editors cannot
    setup('growth'); expect((await make()).status).toBe(402);              // other plans cannot
    setup(); expect((await make('a')).status).toBe(400);                   // needs a real name
  });

  it('at most five keys at a time', async () => {
    setup();
    for (let i = 0; i < 5; i++) expect((await make(`Key ${i + 1}`)).status).toBe(201);
    expect((await make('Sixth')).status).toBe(409);
  });

  it('reads bookings and customers with a key, and never exposes notes', async () => {
    setup();
    const { key } = (await (await make()).json()) as { key: string };
    const b = await get('/api/v1/bookings', key);
    expect(b.status).toBe(200);
    const body = (await b.json()) as { data: Record<string, any>[]; nextCursor: string | null };
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({ id: '202611_1', status: 'completed', service: { id: 's_0', name: 'Braids' }, customerName: 'Ada', startsAt: '2026-11-01T10:00:00.000Z' });
    expect(JSON.stringify(body)).not.toContain('private note');
    expect(body.nextCursor).toBeNull();
    const c = (await (await get('/api/v1/customers', key)).json()) as { data: Record<string, any>[]; truncated: boolean };
    expect(c.truncated).toBe(false);
    expect(c.data.find((x) => x.phone === '+2348011112222')).toMatchObject({ name: 'Ada', email: 'ada@example.com', bookings: 2, completed: 1, noShows: 1 });
    expect(c.data).toHaveLength(2);
    expect((await get('/api/v1/bookings?status=bogus', key)).status).toBe(400);
    expect(keyDocs().some((k) => fromFs(store.get(k)!.fields.lastUsedAt) instanceof Date)).toBe(true);
  });

  it('bad, missing, foreign and revoked keys all get the same refusal; the plan is checked on every call', async () => {
    setup();
    const { key } = (await (await make()).json()) as { key: string };
    for (const k of [undefined, 'zxk_nonsense', key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'), key.replace(KW, 'otherwsid0000000000')]) {
      const r = await get('/api/v1/bookings', k);
      expect(r.status).toBe(401);
      expect(((await r.json()) as { code: string }).code).toBe('invalid_key');
    }
    setup('growth'); expect((await get('/api/v1/bookings', key)).status).toBe(402);   // downgraded: the key stops working
    setup();
    const id = keyDocs()[0]!.split('/').pop()!;
    expect((await call('/api/keys/revoke', { body: JSON.stringify({ workspaceId: KW, id }), headers: await authed() })).status).toBe(200);
    expect((await get('/api/v1/bookings', key)).status).toBe(401);
  });

  it('a key can only read: there is no way to write with it', async () => {
    setup();
    const { key } = (await (await make()).json()) as { key: string };
    for (const [m, p] of [['POST', '/api/v1/bookings'], ['PUT', '/api/v1/bookings'], ['DELETE', '/api/v1/bookings'], ['GET', '/api/v1/payments']] as const) {
      const r = await handle(new Request(`https://pay.example.workers.dev${p}`, { method: m, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' }), env, { fetch: mockFetch(), now: () => NOW });
      expect(r.status).toBe(404);
    }
    // and a key is not a sign-in: member routes refuse it
    expect((await call('/api/backups/run', { body: JSON.stringify({ workspaceId: KW }), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })).status).toBe(401);
  });
});
