import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
        const p = fsPath(w.update.name); const cur = store.get(p);
        if (w.currentDocument?.exists === false && cur) return new Response('{}', { status: 409 });
        if (w.currentDocument?.exists === true && !cur) return new Response('{}', { status: 404 });
        if (w.currentDocument?.updateTime && String(cur?.v) !== w.currentDocument.updateTime) return new Response('{}', { status: 409 });
      }
      for (const w of writes) {
        const p = fsPath(w.update.name); const cur = store.get(p);
        const next = w.updateMask ? { ...(cur?.fields ?? {}), ...Object.fromEntries(w.updateMask.fieldPaths.map((k: string) => [k, w.update.fields[k]])) } : w.update.fields;
        store.set(p, { fields: next, v: (cur?.v ?? 0) + 1 });
      }
      commits.push(writes);
      return Response.json({});
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
  store = new Map(); commits = []; paystackInit = []; paystackVerify = {}; paystackSub = [];
  env = { PAYSTACK_SECRET_KEY: SECRET, ALLOW_TEST_PAYMENTS: 'true', FIREBASE_PROJECT_ID: PROJECT, APP_URL: 'https://zexcore.com.ng', ALLOWED_ORIGINS: 'https://zexcore.com.ng,https://zexcore-5d6c0.web.app', NGN_PER_USD: '1500',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'w@x.iam.gserviceaccount.com', private_key: saPem }) };
  seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'free', ownerUid: 'owner1', slug: 'sade-salon' });
  seedDoc(`workspaces/${WID}/members/owner1`, { role: 'owner' });
  seedDoc(`workspaces/${WID}/members/staff1`, { role: 'staff' });
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
    expect(amountMinor('growth', 'monthly', 'NGN', 1500)).toBe(7_350_000);
    expect(amountMinor('starter', 'annual', 'USD')).toBe(19_000);
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
    expect(paystackInit[0].amount).toBe(7_350_000);
    expect(paystackInit[0].currency).toBe('NGN');
    const pay = [...store.entries()].find(([k]) => k.startsWith(`workspaces/${WID}/payments/`))!;
    expect(fromFs(pay[1].fields.status)).toBe('pending');
    expect(fromFs(pay[1].fields.amountMinor)).toBe(7_350_000);
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
  const pending = (over: Record<string, unknown> = {}) => seedDoc(`workspaces/${WID}/payments/${REF}`, { reference: REF, tier: 'growth', cycle: 'monthly', currency: 'NGN', amountMinor: 7_350_000, status: 'pending', ...over });
  const ok = (amount = 7_350_000, currency = 'NGN') => { paystackVerify[REF] = { status: true, data: { status: 'success', amount, currency, reference: REF } }; };
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
    pending(); ok(7_350_000, 'USD');
    await send(event());
    expect(plan()).toBe('free');
  });
  it('ignores references we never issued and payments Paystack does not confirm', async () => {
    ok(); expect((await (await send(event())).json()).ignored).toBe('unknown_reference');
    pending(); paystackVerify[REF] = { status: true, data: { status: 'failed', amount: 7_350_000, currency: 'NGN', reference: REF } };
    expect((await (await send(event())).json()).ignored).toBe('not_successful');
    expect(plan()).toBe('free');
  });
  it('ignores other events', async () => {
    pending(); ok();
    expect((await (await send(JSON.stringify({ event: 'charge.failed', data: { reference: REF } }))).json()).ignored).toBe(true);
    expect(plan()).toBe('free');
  });
  it('renewing early keeps the time already paid for', async () => {
    seedDoc(`workspaces/${WID}`, { plan: 'growth', ownerUid: 'owner1', planExpiresAt: new Date(NOW.getTime() + 10 * 86400000) });
    pending(); ok();
    await send(event());
    const exp = fromFs(store.get(`workspaces/${WID}`)!.fields.planExpiresAt) as Date;
    expect(exp.getTime()).toBe(NOW.getTime() + 41 * 86400000);
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
    const left = new Date(NOW.getTime() + 49 * day);                 // 49 days of Starter ($19) = 19 days of Growth ($49)
    const r = planAfterPayment('starter', left, 'growth', 'monthly', NOW);
    expect(r.plan).toBe('growth');
    expect(Math.round((r.expires.getTime() - NOW.getTime()) / day)).toBe(Math.round(49 * 19 / 49 + 31));
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
    const up = await call('/api/checkout', { headers: await authed(), body: checkoutBody({ tier: 'enterprise' }) });
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
