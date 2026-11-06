import { scoreRisk } from '../../workers/payments/src/risk';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { creditDays } from '../../workers/payments/src/routes/billing.js';
import { getLiveRates, FALLBACK_RATES } from '../../workers/payments/src/rates.js';
import { SEATS } from '../../workers/payments/src/routes/team.js';
import { KEEP, backupId, gunzip, open as openBackup, scheduledBackups } from '../../workers/payments/src/routes/backups.js';
import { LIMITS } from '../../apps/dashboard/src/lib/fb/plan';
import { queueEmail, drainOutbox, outboxId, MAX_ATTEMPTS } from '../../workers/payments/src/outbox.js';
import { sendCustomerEmails, scheduledCustomerEmails } from '../../workers/payments/src/routes/reminders.js';
import { scheduledDepositExpiry } from '../../workers/payments/src/index.js';
import { handle, summarize, sendDigest, weekKey, digestDue, paystackSignature, amountMinor, planAfterPayment, throttled, toFs, fromFs, resetTokenCache, resetJwksCache, type Env } from '../../workers/payments/src/index.js';

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
let resendMode: 'ok' | 'down' | 'reject' | 'throw' = 'ok';
let resendKeys: (string | undefined)[] = [];
let revokedLogins: any[] = [];
let waSent: any[] = [];
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
    if (url.includes('identitytoolkit.googleapis.com') && url.endsWith('/accounts:update')) { revokedLogins.push(JSON.parse(init.body)); return Response.json({}); }
    if (url.includes('identitytoolkit.googleapis.com') && url.endsWith('/accounts:delete')) { deletedLogins.push(JSON.parse(init.body).localId); return Response.json({}); }
    if (url.startsWith('https://graph.facebook.com/')) { waSent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return Response.json({ messages: [{ id: 'wamid.1' }] }); }
    if (url === 'https://api.resend.com/emails') {
      if (resendMode === 'throw') throw new TypeError('network down');
      if (resendMode === 'down') return new Response('{}', { status: 503 });
      if (resendMode === 'reject') return new Response('{}', { status: 422 });
      resendKeys.push(init.headers['idempotency-key']); emails.push(JSON.parse(init.body)); return Response.json({ id: 'e1' });
    }
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
  emails = []; resendMode = 'ok'; resendKeys = []; revokedLogins = []; waSent = []; store = new Map(); commits = []; paystackInit = []; paystackVerify = {}; paystackSub = [];
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

describe('checkout ceiling', () => {
  it('sends very large card charges to us instead of Paystack, and lets everything under it through', async () => {
    const big = await call('/api/checkout', { body: checkoutBody({ tier: 'agency', cycle: 'annual' }), headers: await authed() });
    expect(big.status).toBe(409); expect(await big.json()).toMatchObject({ code: 'contact_us' });
    expect(paystackInit).toHaveLength(0);
    expect([...store.keys()].some((k) => k.includes('/payments/'))).toBe(false);   // no order left behind
    expect((await call('/api/checkout', { body: checkoutBody({ tier: 'agency', cycle: 'monthly' }), headers: await authed() })).status).toBe(201);
    env = { ...env, MAX_CHECKOUT_NGN: '3000000' };
    expect((await call('/api/checkout', { body: checkoutBody({ tier: 'agency', cycle: 'annual' }), headers: await authed() })).status).toBe(201);
  });
});

describe('pricing', () => {
  it('computes prices on the server in minor units', () => {
    expect(amountMinor('growth', 'monthly', 'NGN', 1500)).toBe(6_450_000);        // $43 at 1,500
    expect(amountMinor('agency', 'annual', 'NGN', 1500)).toBe(amountMinor('agency', 'monthly', 'NGN', 1500) * 10);   // ten months: two free
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
    expect(paystackInit[0].amount).toBe(6_450_000);
    expect(paystackInit[0].currency).toBe('NGN');
    const pay = [...store.entries()].find(([k]) => k.startsWith(`workspaces/${WID}/payments/`))!;
    expect(fromFs(pay[1].fields.status)).toBe('pending');
    expect(fromFs(pay[1].fields.amountMinor)).toBe(6_450_000);
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
  const pending = (over: Record<string, unknown> = {}) => seedDoc(`workspaces/${WID}/payments/${REF}`, { reference: REF, tier: 'growth', cycle: 'monthly', currency: 'NGN', amountMinor: 6_450_000, status: 'pending', ...over });
  const ok = (amount = 6_450_000, currency = 'NGN') => { paystackVerify[REF] = { status: true, data: { status: 'success', amount, currency, reference: REF } }; };
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
    pending(); ok(6_450_000, 'USD');
    await send(event());
    expect(plan()).toBe('free');
  });
  it('ignores references we never issued and payments Paystack does not confirm', async () => {
    ok(); expect((await (await send(event())).json()).ignored).toBe('unknown_reference');
    pending(); paystackVerify[REF] = { status: true, data: { status: 'failed', amount: 6_450_000, currency: 'NGN', reference: REF } };
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
    expect(exp.getTime()).toBe(NOW.getTime() + (31 + Math.floor(30 * 8 / 43)) * 86400000);
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
    expect(creditDays('starter', 30 * 86_400_000, 'growth')).toBe(Math.floor(30 * 8 / 43));
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
    const left = new Date(NOW.getTime() + 49 * day);                 // 49 days of Starter ($8) = 9 days of Growth ($43)
    const r = planAfterPayment('starter', left, 'growth', 'monthly', NOW);
    expect(r.plan).toBe('growth');
    expect(Math.round((r.expires.getTime() - NOW.getTime()) / day)).toBe(Math.round(49 * 8 / 43 + 31));
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
  describe('owner WhatsApp alert', () => {
    const bookingId = () => `${NOW.toISOString().slice(0, 7).replace('-', '')}_1`;
    const setup = (settings: Record<string, unknown>) => {
      seedDoc(`slugs/sade-salon`, { wid: WID });
      seedDoc(`workspaces/${WID}`, { name: 'Sade Salon', plan: 'free', ownerUid: 'owner1', slug: 'sade-salon', settings: { utcOffsetMinutes: 60, ...settings } });
      seedDoc(`workspaces/${WID}/members/owner1`, { role: 'owner', email: 'sade@example.com', name: 'Sade Bello' });
      seedDoc(`workspaces/${WID}/services/s_0`, { name: 'Braids', priceMinor: 5000 });
      seedDoc(`workspaces/${WID}/bookings/${bookingId()}`, { customerName: 'Ada Obi', customerPhone: '+2348031234567', serviceId: 's_0', status: 'pending', source: 'public', startsAt: new Date(NOW.getTime() + 86_400_000), createdAt: new Date(NOW.getTime() - 60_000) });
    };
    const booked = () => call('/api/public/booked', { body: JSON.stringify({ slug: 'sade-salon', bookingId: bookingId() }), headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' } });
    beforeEach(() => { env = { ...env, RESEND_API_KEY: 're_test' }; });

    it('sends the approved template to the number the owner gave, with the booking details, when WhatsApp is set up', async () => {
      env = { ...env, WHATSAPP_TOKEN: 'wa_tok', WHATSAPP_PHONE_ID: '12345' };
      setup({ notifyOwnerWhatsApp: true, notifyWhatsAppPhone: '0803 000 1111' });
      expect((await booked()).status).toBe(200);
      expect(waSent).toHaveLength(1);
      expect(waSent[0].url).toContain('/12345/messages'); expect(waSent[0].auth).toBe('Bearer wa_tok');
      expect(waSent[0].body).toMatchObject({ to: '2348030001111', type: 'template', template: { name: 'new_booking_request', language: { code: 'en' } } });
      expect(waSent[0].body.template.components[0].parameters.map((x: any) => x.text).slice(0, 3)).toEqual(['Sade Salon', 'Ada Obi', 'Braids']);
    });
    it('sends nothing when the owner has not turned it on, gave no valid number, or ZexCore has no WhatsApp account configured', async () => {
      env = { ...env, WHATSAPP_TOKEN: 'wa_tok', WHATSAPP_PHONE_ID: '12345' };
      setup({ notifyOwnerWhatsApp: false, notifyWhatsAppPhone: '08030001111' }); await booked();
      store.delete(`workspaces/${WID}/automationMarkers/${bookingId()}`);
      setup({ notifyOwnerWhatsApp: true, notifyWhatsAppPhone: '123' }); await booked();
      store.delete(`workspaces/${WID}/automationMarkers/${bookingId()}`);
      env = { ...env, WHATSAPP_TOKEN: undefined };
      setup({ notifyOwnerWhatsApp: true, notifyWhatsAppPhone: '08030001111' });
      expect((await booked()).status).toBe(200);
      expect(waSent).toHaveLength(0);
    });
    it('can switch the email off and the booking still goes through when WhatsApp refuses', async () => {
      env = { ...env, WHATSAPP_TOKEN: 'wa_tok', WHATSAPP_PHONE_ID: '12345' };
      setup({ notifyOwnerEmail: false, notifyOwnerWhatsApp: true, notifyWhatsAppPhone: '08030001111' });
      expect((await booked()).status).toBe(200);
      expect(emails.filter((m) => String(m.subject).startsWith('New booking request'))).toHaveLength(0);
      expect(waSent).toHaveLength(1);
    });
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

  it('needs the exact email and a valid sign-in, but not a fresh one', async () => {
    const wrong = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'someone@else.com' }), headers: await as('owner1', 'sade@example.com') });
    expect(wrong.status).toBe(400);
    expect((await call('/api/account/delete', { body: JSON.stringify({ confirm: 'sade@example.com' }), headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(store.has(`workspaces/${W}/bookings/b1`)).toBe(true);
    expect(auditOf()).toEqual([]);
    expect(deletedLogins).toEqual([]);
  });

  it('does not ask for a fresh sign-in, and sends a confirmation email', async () => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    const r = await call('/api/account/delete', { body: JSON.stringify({ confirm: 'sade@example.com' }), headers: await as('owner1', 'sade@example.com', nowS() - 7 * 86_400) });
    expect(r.status).toBe(200);
    expect(deletedLogins).toEqual(['owner1']);
    expect(emails.some((m) => m.subject === 'Your ZexCore account was deleted' && (m.to[0] ?? m.to) === 'sade@example.com')).toBe(true);
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

describe('revenue protection: waitlist and backfill', () => {
  const W = 'wswait0000000000000a';
  const START = new Date(NOW.getTime() + 2 * 86_400_000);                  // two days out
  const DAY = new Date(START.getTime() + 3_600_000).toISOString().slice(0, 10);   // Lagos local date of START
  const join = (over: Record<string, unknown> = {}) => call('/api/public/waitlist', { headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'wait-salon', serviceId: 's_0', date: DAY, name: 'Ada Obi', phone: '0803 111 2222', email: 'ada@example.com', ...over }) });
  const entries = () => [...store.keys()].filter((k) => k.startsWith(`workspaces/${W}/waitlist/`));
  const field = (path: string, k: string) => fromFs(store.get(path)!.fields[k]);
  beforeEach(() => { env = { ...env, RESEND_API_KEY: 're_test' }; });
  const setup = (settings: Record<string, unknown> = {}, plan = 'enterprise') => {
    seedDoc(`workspaces/${W}`, { name: 'Wait Salon', plan, planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'wait-salon',
      settings: { waitlistEnabled: true, publicName: 'Wait Salon', ...settings } });
    seedDoc('slugs/wait-salon', { wid: W, ownerUid: 'owner1' });
    seedDoc(`workspaces/${W}/members/owner1`, { role: 'owner' });
    seedDoc(`workspaces/${W}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
  };
  const waiting = (id: string, over: Record<string, unknown> = {}) => seedDoc(`workspaces/${W}/waitlist/${id}`,
    { serviceId: 's_0', date: DAY, name: `Person ${id}`, phone: `+23480000000${id.length}${id.charCodeAt(0) % 10}`, email: `${id}@example.com`, status: 'waiting', createdAt: new Date(NOW.getTime() - 1000), ...over });
  const cancelled = (startsAt = START) => seedDoc(`workspaces/${W}/bookings/202611_9`, { status: 'cancelled', serviceId: 's_0', customerName: 'Gone', customerPhone: '+2348099999999', startsAt });
  const cancelEvent = async () => call('/api/events', { headers: await authed(), body: JSON.stringify({ workspaceId: W, event: 'bookings.booking.cancelled', id: '202611_9' }) });

  it('adds a visitor to the waitlist with a normalised number, and says so plainly when it already has them', async () => {
    setup();
    const r = await join();
    expect(r.status).toBe(201);
    const [path] = entries();
    expect(field(path!, 'phone')).toBe('+2348031112222');
    expect(field(path!, 'status')).toBe('waiting');
    expect(await (await join()).json()).toMatchObject({ already: true });
    expect(entries()).toHaveLength(1);
  });

  it('refuses when the waitlist is off, the plan is too low, or the details are wrong', async () => {
    setup({ waitlistEnabled: false }); expect((await join()).status).toBe(409);
    setup({}, 'growth'); expect((await join()).status).toBe(409);
    setup();
    for (const bad of [{ email: 'nope' }, { phone: '123' }, { name: '' }, { date: '2020-01-01' }, { date: 'tomorrow' }, { serviceId: 'missing' }]) expect((await join(bad)).status).toBe(400);
    expect(entries()).toHaveLength(0);
  });

  it('a cancellation offers the time to the three people who waited longest for that service and day, and no one else', async () => {
    setup(); cancelled();
    waiting('aa', { createdAt: new Date(NOW.getTime() - 5000) }); waiting('bb', { createdAt: new Date(NOW.getTime() - 4000) }); waiting('cc', { createdAt: new Date(NOW.getTime() - 3000) });
    waiting('dd', { createdAt: new Date(NOW.getTime() - 2000) });
    waiting('ee', { date: '2031-01-01' }); waiting('ff', { serviceId: 's_9' }); waiting('gg', { status: 'booked' });
    const r = await cancelEvent();
    expect(await r.json()).toMatchObject({ ok: true, told: 3 });
    expect(emails.map((m) => m.to[0] ?? m.to).sort()).toEqual(['aa@example.com', 'bb@example.com', 'cc@example.com']);
    expect(field(`workspaces/${W}/waitlist/aa`, 'status')).toBe('offered');
    expect(field(`workspaces/${W}/waitlist/dd`, 'status')).toBe('waiting');
    expect(emails[0].html).toContain(`wait-salon?service=s_0&amp;date=${DAY}`);
    expect(emails[0].html).toMatch(/first come, first served/i);
  });

  it('never offers the same cancellation twice, and ignores one that is too close to start or not cancelled', async () => {
    setup(); cancelled(); waiting('aa');
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 1 });
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 0 });
    expect(emails).toHaveLength(1);
    store.delete(`workspaces/${W}/automationMarkers/backfill_202611_9`); cancelled(new Date(NOW.getTime() + 10 * 60_000));
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 0 });
    cancelled(); store.get(`workspaces/${W}/bookings/202611_9`)!.fields.status = { stringValue: 'confirmed' };
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 0 });
  });

  it('does nothing below Enterprise or with the waitlist switched off', async () => {
    setup({}, 'growth'); cancelled(); waiting('aa');
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 0 });
    setup({ waitlistEnabled: false }); store.delete(`workspaces/${W}/automationMarkers/backfill_202611_9`);
    expect(await (await cancelEvent()).json()).toMatchObject({ told: 0 });
    expect(emails).toHaveLength(0);
  });
});

describe('business insights and the weekly summary', () => {
  const IW = 'wsinsight00000000000';
  const DAYMS = 86_400_000;
  const T = NOW.getTime();
  const book = (n: number, over: Record<string, unknown>) => seedDoc(`workspaces/${IW}/bookings/202611_${n}`, { status: 'completed', serviceId: 's_0', customerPhone: `+23480100000${n}`, startsAt: new Date(T - 2 * DAYMS), ...over });
  const setup = (plan = 'enterprise', settings: Record<string, unknown> = {}) => {
    seedDoc(`workspaces/${IW}`, { name: 'Insight Salon', plan, planExpiresAt: new Date(T + 20 * DAYMS), ownerUid: 'owner1', slug: 'insight-salon', settings: { publicName: 'Insight Salon', ...settings } });
    seedDoc(`workspaces/${IW}/members/owner1`, { role: 'owner', email: 'sade@example.com', name: 'Sade Bello' });
    seedDoc(`workspaces/${IW}/members/editor1`, { role: 'editor' });
    seedDoc(`workspaces/${IW}/members/viewer1`, { role: 'viewer' });
    seedDoc(`workspaces/${IW}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
    seedDoc(`workspaces/${IW}/services/s_1`, { name: 'Wash', priceMinor: 500 });
    seedDoc(`workspaces/${IW}/bookings/202610_0`, { status: 'completed', serviceId: 's_0', customerPhone: '+2348010000000', startsAt: new Date(T - 2 * DAYMS) });
    book(1, { customerPhone: '+2348010000000' }); book(2, { status: 'no_show' }); book(3, { status: 'cancelled' }); book(4, { serviceId: 's_1', depositStatus: 'paid', depositMinor: 100 });
    book(5, { customerPhone: '+2348010000000', startsAt: new Date(T - 10 * DAYMS) });                       // earlier period
    book(6, { startsAt: new Date(T + 3 * DAYMS), status: 'confirmed' });                                   // booked ahead
  };
  const ask = async (sub = 'owner1', days = 7) => call('/api/insights', { headers: await authed({ sub }), body: JSON.stringify({ workspaceId: IW, days }) });

  it('counts only what happened: statuses, list-price revenue, deposits, rates, repeat customers', async () => {
    setup();
    const r = await ask(); expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.current).toMatchObject({ bookings: 6, completed: 3, cancelled: 1, noShows: 1, upcoming: 1, revenueMinor: 2000 * 2 + 500, depositsMinor: 100, noShowRate: 25, cancelRate: 16.7, repeatCustomers: 1 });
    expect(j.previous).toMatchObject({ bookings: 1, completed: 1, revenueMinor: 2000 });
    expect(j.truncated).toBe(false);
  });
  it('says null rather than inventing a rate or a busiest day when there is nothing to divide', () => {
    const p = summarize([], [], 0, 10, 5);
    expect(p).toMatchObject({ bookings: 0, noShowRate: null, cancelRate: null, topServices: [] });
    expect(p.byWeekday.every((n) => n === 0)).toBe(true);
  });
  it('is for Enterprise, readable by owners, admins and viewers, and by nobody else', async () => {
    setup('growth'); expect((await ask()).status).toBe(402);
    setup(); expect((await ask('viewer1')).status).toBe(200);
    expect((await ask('editor1')).status).toBe(403); expect((await ask('stranger')).status).toBe(403);
  });
  it('emails the owner a plain summary once a week, and never when switched off, on a lower plan or already sent', async () => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    setup();
    expect(await sendDigest(env, { fetch: mockFetch(), now: () => NOW }, IW)).toBe(true);
    const m = emails[0];
    expect(m.subject).toBe('Your week at Insight Salon');
    expect(m.text).toContain('Bookings: 5'); expect(m.text).toContain('Dear Sade,'); expect(m.text).toContain('/app/insights'); expect(m.html).not.toContain('<table');
    expect(await sendDigest(env, { fetch: mockFetch(), now: () => NOW }, IW)).toBe(false);      // same week
    expect(emails).toHaveLength(1);
    store.delete(`workspaces/${IW}/automationMarkers/digest_${weekKey(T)}`);
    setup('enterprise', { weeklyDigest: false }); expect(await sendDigest(env, { fetch: mockFetch(), now: () => NOW }, IW)).toBe(false);
    setup('growth'); expect(await sendDigest(env, { fetch: mockFetch(), now: () => NOW }, IW)).toBe(false);
    expect(emails).toHaveLength(1);
  });
  it('only runs on Monday mornings in Lagos, and week markers change every week', () => {
    expect(digestDue(Date.UTC(2026, 10, 2, 6, 30))).toBe(true);     // Mon 2 Nov 07:30 Lagos
    expect(digestDue(Date.UTC(2026, 10, 2, 5, 30))).toBe(false);    // 06:30 Lagos
    expect(digestDue(Date.UTC(2026, 10, 3, 9, 0))).toBe(false);     // Tuesday
    expect(weekKey(Date.UTC(2026, 10, 2, 9, 0))).not.toBe(weekKey(Date.UTC(2026, 10, 9, 9, 0)));
    expect(weekKey(Date.UTC(2026, 10, 2, 9, 0))).toBe(weekKey(Date.UTC(2026, 10, 8, 9, 0)));
  });
});

describe('live currency rates', () => {
  const table = { USD: 1, NGN: 1612.5, GBP: 0.77, EUR: 0.91, GHS: 12.4, KES: 129.2, ZAR: 17.9 };
  const dep = (fetcher: (url: string) => Promise<Response>, t = NOW) => ({ fetch: fetcher as never, now: () => t });
  it('returns every supported currency from one market fetch and says it is live', async () => {
    const urls: string[] = [];
    const r = await getLiveRates({} as Env, dep(async (u) => { urls.push(u); return Response.json({ rates: table }); }, new Date(NOW.getTime() + 10 * 3_600_000 * 24)));
    expect(r.live).toBe(true); expect(r.rates.NGN).toBe(1612.5); expect(r.rates.GBP).toBe(0.77);
    expect(urls[0]).toContain('exchangerate-api');
    const again = await getLiveRates({} as Env, dep(async () => { throw new Error('should be cached'); }, new Date(NOW.getTime() + 10 * 3_600_000 * 24 + 60_000)));
    expect(again.rates.NGN).toBe(1612.5);
  });
  it('tries the second source, then reports stored defaults as not live instead of pretending', async () => {
    const later = new Date(NOW.getTime() + 40 * 86_400_000);
    const second = await getLiveRates({} as Env, dep(async (u) => u.includes('floatrates') ? Response.json(Object.fromEntries(Object.entries(table).map(([k, v]) => [k.toLowerCase(), { rate: v }]))) : new Response('no', { status: 500 }), later));
    expect(second.live).toBe(true); expect(second.rates.KES).toBe(129.2);
    const dead = await getLiveRates({} as Env, dep(async () => new Response('no', { status: 500 }), new Date(later.getTime() + 3 * 3_600_000)));
    expect(dead.live).toBe(false); expect(dead.rates.NGN).toBe(1612.5);   // stale but real, flagged
  });
  it('refuses nonsense numbers and honours a fixed NGN_PER_USD override', async () => {
    const t = new Date(NOW.getTime() + 90 * 86_400_000);
    const bad = await getLiveRates({} as Env, dep(async () => Response.json({ rates: { ...table, NGN: 5 } }), t));
    expect(bad.rates.NGN).not.toBe(5);
    const fixed = await getLiveRates({ NGN_PER_USD: '1500' } as Env, dep(async () => Response.json({ rates: table }), new Date(t.getTime() + 5 * 3_600_000)));
    expect(fixed.rates.NGN).toBe(1500); expect(FALLBACK_RATES.USD).toBe(1);
  });
  it('/api/rates serves the whole table with live and updatedAt', async () => {
    const r = await handle(new Request('https://pay.example.workers.dev/api/rates'), env, { fetch: (async () => Response.json({ rates: table })) as never, now: () => new Date(NOW.getTime() + 200 * 86_400_000) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ base: 'USD', live: true, rates: { USD: 1, GBP: 0.77 } });
  });
});

describe('unpaid risk-deposit bookings expire', () => {
  const X = 'wsexpire000000000001';
  const START = new Date(NOW.getTime() + 2 * 86_400_000);
  const DAY = new Date(START.getTime() + 3_600_000).toISOString().slice(0, 10);
  const bk = (id: string, over: Record<string, unknown> = {}) => seedDoc(`workspaces/${X}/bookings/${id}`, { status: 'pending', serviceId: 's_0', service: 'Braids', customerName: 'Ada Obi', customerEmail: 'ada@example.com', customerPhone: '+2348031112222',
    depositStatus: 'unpaid', riskDeposit: true, createdAt: new Date(NOW.getTime() - 25 * 3_600_000), startsAt: START, ...over });
  const status = (id: string) => fromFs(store.get(`workspaces/${X}/bookings/${id}`)!.fields.status);
  beforeEach(() => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    seedDoc(`workspaces/${X}`, { name: 'Expire Salon', plan: 'enterprise', planExpiresAt: new Date(NOW.getTime() + 20 * 86_400_000), ownerUid: 'owner1', slug: 'expire-salon', settings: { waitlistEnabled: true, publicName: 'Expire Salon' } });
    seedDoc(`workspaces/${X}/services/s_0`, { name: 'Braids', priceMinor: 2000 });
  });

  it('cancels a booking whose deposit is unpaid after 24 hours, tells the customer and offers the time to the waitlist', async () => {
    bk('202611_1');
    seedDoc(`workspaces/${X}/waitlist/w1`, { serviceId: 's_0', date: DAY, name: 'Wendy Ade', phone: '+2348000000001', email: 'wendy@example.com', status: 'waiting', createdAt: new Date(NOW.getTime() - 1000) });
    const r = await scheduledDepositExpiry(env, { fetch: mockFetch(), now: () => NOW });
    expect(r.expired).toBe(1);
    expect(status('202611_1')).toBe('cancelled');
    expect(fromFs(store.get(`workspaces/${X}/bookings/202611_1`)!.fields.cancelledReason)).toBe('deposit_unpaid');
    expect(emails.map((m) => m.to[0] ?? m.to).sort()).toEqual(['ada@example.com', 'wendy@example.com']);
    expect(emails.find((m) => (m.to[0] ?? m.to) === 'ada@example.com').subject).toMatch(/released/);
  });

  it('leaves paid, recent, past, already-cancelled and non-risk bookings alone, and does not run twice', async () => {
    bk('202611_2', { depositStatus: 'paid' });
    bk('202611_3', { createdAt: new Date(NOW.getTime() - 3_600_000) });
    bk('202611_4', { startsAt: new Date(NOW.getTime() - 3_600_000) });
    bk('202611_5', { status: 'cancelled' });
    bk('202611_6', { riskDeposit: false });
    expect((await scheduledDepositExpiry(env, { fetch: mockFetch(), now: () => NOW })).expired).toBe(0);
    for (const id of ['202611_2', '202611_3', '202611_4', '202611_6']) expect(status(id)).toBe('pending');
    bk('202611_7');
    expect((await scheduledDepositExpiry(env, { fetch: mockFetch(), now: () => NOW })).expired).toBe(1);
    expect((await scheduledDepositExpiry(env, { fetch: mockFetch(), now: () => NOW })).expired).toBe(0);
  });
});

describe('Security Watch', () => {
  const signin = async (ua: string, country = 'NG', over: Record<string, unknown> = {}, t = NOW) =>
    handle(new Request('https://pay.example.workers.dev/api/security/signin', { method: 'POST', body: '{}', headers: { ...(await authed(over)), 'user-agent': ua, 'cf-ipcountry': country } }), { ...env, RESEND_API_KEY: 're_test' }, { fetch: mockFetch(), now: () => t });
  const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
  const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1';
  const devices = async () => (await (await handle(new Request('https://pay.example.workers.dev/api/security/devices', { headers: await authed() }), env, { fetch: mockFetch(), now: () => NOW })).json() as any).devices;

  it('records the first device quietly, then emails when a different device signs in', async () => {
    expect(await (await signin(CHROME_WIN)).json()).toMatchObject({ ok: true, newDevice: false });
    expect(emails).toHaveLength(0);
    expect(await (await signin(SAFARI_IOS, 'GB')).json()).toMatchObject({ ok: true, newDevice: true });
    expect(emails).toHaveLength(1);
    expect(emails[0].to[0] ?? emails[0].to).toBe('sade@example.com');
    expect(emails[0].subject).toBe('New sign-in to your ZexCore account');
    expect(emails[0].html ?? emails[0].text).toMatch(/Safari on iOS/);
    expect((await devices()).map((d: any) => d.label).sort()).toEqual(['Chrome on Windows', 'Safari on iOS']);
  });

  it('does not email again for a device it already knows, and counts repeat visits only every ten minutes', async () => {
    await signin(CHROME_WIN); await signin(SAFARI_IOS);
    emails = [];
    expect(await (await signin(SAFARI_IOS)).json()).toMatchObject({ newDevice: false });
    await signin(SAFARI_IOS, 'GB', {}, new Date(NOW.getTime() + 11 * 60_000));
    expect(emails).toHaveLength(0);
    expect((await devices()).find((d: any) => d.label === 'Safari on iOS').count).toBe(2);
  });

  it('needs a valid sign-in, and sign out everywhere needs a recent one', async () => {
    expect((await handle(new Request('https://pay.example.workers.dev/api/security/signin', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' } }), env, { fetch: mockFetch(), now: () => NOW })).status).toBe(401);
    const stale = await call('/api/security/revoke-all', { headers: await authed({ auth_time: Math.floor(NOW.getTime() / 1000) - 3600 }), body: '{}' });
    expect(stale.status).toBe(401);
    expect(revokedLogins).toHaveLength(0);
    const ok = await call('/api/security/revoke-all', { headers: await authed({ auth_time: Math.floor(NOW.getTime() / 1000) - 30 }), body: '{}' });
    expect(ok.status).toBe(200);
    expect(revokedLogins[0]).toMatchObject({ localId: 'owner1', validSince: String(Math.floor(NOW.getTime() / 1000)) });
  });
});

describe('reschedule email', () => {
  const X = 'wsresched0000000001a';
  const NEW = new Date(NOW.getTime() + 3 * 86_400_000), OLD = new Date(NOW.getTime() + 86_400_000);
  const seedBk = (id: string, over: Record<string, unknown> = {}) => seedDoc(`workspaces/${X}/bookings/${id}`, { status: 'confirmed', serviceId: 's_0', customerName: 'Ada Obi', customerEmail: 'ada@example.com', customerPhone: '+2348031112222', startsAt: NEW, createdAt: new Date(NOW.getTime() - 60_000), ...over });
  const fire = async (id: string, previousStartsAt = OLD.toISOString()) => (await (await call('/api/events', { headers: await authed(), body: JSON.stringify({ workspaceId: X, event: 'bookings.booking.rescheduled', id, previousStartsAt }) })).json()) as any;
  beforeEach(() => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    seedDoc(`workspaces/${X}`, { name: 'Moves Salon', plan: 'free', ownerUid: 'owner1', slug: 'moves-salon', settings: { publicName: 'Moves Salon' } });
    seedDoc(`workspaces/${X}/members/owner1`, { role: 'owner' });
    seedDoc(`workspaces/${X}/services/s_0`, { name: 'Braids' });
  });

  it('emails the customer the old and new time, once per move', async () => {
    seedBk('202611_9');
    expect(await fire('202611_9')).toMatchObject({ ok: true, emailed: true });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toMatch(/has been moved/);
    expect(emails[0].text).toMatch(/Previous time/); expect(emails[0].text).toMatch(/New time/);
    expect(await fire('202611_9')).toMatchObject({ emailed: false, reason: 'duplicate' });
    expect(emails).toHaveLength(1);
  });

  it('says so when there is no email address, and ignores cancelled, old or forged moves', async () => {
    seedBk('202611_10', { customerEmail: null });
    expect(await fire('202611_10')).toMatchObject({ emailed: false, reason: 'no_email' });
    seedBk('202611_11', { status: 'cancelled' });
    expect(await fire('202611_11')).toMatchObject({ emailed: false, reason: 'not_active' });
    seedBk('202611_12', { createdAt: new Date(NOW.getTime() - 3_600_000) });
    expect(await fire('202611_12')).toMatchObject({ emailed: false, reason: 'stale' });
    expect(emails).toHaveLength(0);
  });
});

describe('shop orders', () => {
  const X = 'wsshop00000000000001';
  beforeEach(() => {
    env = { ...env, RESEND_API_KEY: 're_test', CLOUDINARY_CLOUD_NAME: 'democloud', CLOUDINARY_API_KEY: '123456', CLOUDINARY_API_SECRET: 'shh-secret' };
    seedDoc('slugs/shop-biz', { wid: X });
    seedDoc(`workspaces/${X}`, { name: 'Shop Biz', plan: 'free', ownerUid: 'owner1', slug: 'shop-biz', settings: { publicName: 'Shop Biz' } });
    seedDoc(`workspaces/${X}/members/owner1`, { role: 'owner', email: 'sade@example.com', name: 'Sade' });
    seedDoc(`workspaces/${X}/products/g_0`, { name: 'Ankara bag', priceMinor: 2500, active: true, inStock: true });
    seedDoc(`workspaces/${X}/products/g_1`, { name: 'Sold out hat', priceMinor: 900, active: true, inStock: false });
    seedDoc(`workspaces/${X}/products/g_2`, { name: 'Hidden', priceMinor: 100, active: false, inStock: true });
  });
  const order = (over: Record<string, unknown> = {}) => call('/api/public/order', { headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' }, body: JSON.stringify({ slug: 'shop-biz', name: 'Ada Obi', phone: '0803 111 2222', email: 'ada@example.com', address: '12 Allen Avenue, Ikeja', items: [{ id: 'g_0', qty: 2 }], ...over }) });
  const orders = () => [...store.keys()].filter((k) => k.startsWith(`workspaces/${X}/orders/`));

  it('creates an order priced by the server, and emails the customer and the owner', async () => {
    const r = await order({ items: [{ id: 'g_0', qty: 2, priceMinor: 1 }] });   // a price sent by the browser is ignored
    expect(r.status).toBe(201);
    const j = (await r.json()) as { ref: string; totalMinor: number };
    expect(j.totalMinor).toBe(5000); expect(j.ref).toMatch(/^ZO-[0-9A-F]{6}$/);
    const doc = store.get(orders()[0]!)!.fields;
    expect(fromFs(doc.status)).toBe('new'); expect(fromFs(doc.totalMinor)).toBe(5000);
    expect(emails.map((m) => m.to[0] ?? m.to).sort()).toEqual(['ada@example.com', 'sade@example.com']);
  });

  it('falls back to the owner user profile when the workspace member email is missing', async () => {
    seedDoc(`workspaces/${X}/members/owner1`, { role: 'owner', name: 'Sade' });
    seedDoc('users/owner1', { name: 'Sade Obi', email: 'profile-owner@example.com' });
    // Use a separate phone bucket so this regression test does not consume the
    // per-phone waiting-order quota used by the neighboring rate-limit tests.
    const r = await order({ phone: '0803 999 0001' });
    expect(r.status).toBe(201);
    expect(emails.map((m) => m.to[0] ?? m.to).sort()).toEqual(['ada@example.com', 'profile-owner@example.com']);
  });

  it('rejects hidden, out-of-stock and unknown goods, bad quantities, missing address and duplicates', async () => {
    for (const items of [[{ id: 'g_1', qty: 1 }], [{ id: 'g_2', qty: 1 }], [{ id: 'g_9', qty: 1 }]]) expect((await order({ items })).status).toBe(409);
    for (const items of [[{ id: 'g_0', qty: 0 }], [{ id: 'g_0', qty: 100 }], [{ id: 'g_0', qty: 1.5 }], [{ id: 'g_0', qty: 1 }, { id: 'g_0', qty: 1 }], []]) expect((await order({ items })).status).toBe(400);
    expect((await order({ address: 'short' })).status).toBe(400);
    expect((await order({ phone: 'abc' })).status).toBe(400);
    expect((await order({ email: 'nope' })).status).toBe(400);
    expect((await order({ slug: 'no-such-shop' })).status).toBe(404);
    expect(orders()).toHaveLength(0); expect(emails).toHaveLength(0);
  });

  it('does not create the order twice when the same request is sent again, and limits waiting orders per phone', async () => {
    const a = await order({ requestId: 'req-12345678', items: [{ id: 'g_0', qty: 1 }] });
    expect(a.status).toBe(201);
    const ref = ((await a.json()) as { ref: string }).ref;
    emails.length = 0;
    const again = await order({ requestId: 'req-12345678', items: [{ id: 'g_0', qty: 1 }] });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ref, duplicate: true });
    expect(orders()).toHaveLength(1); expect(emails).toHaveLength(0);
    expect((await order({ requestId: 'req-22222222', items: [{ id: 'g_0', qty: 1 }] })).status).toBe(201);
    expect((await order({ requestId: 'req-33333333', items: [{ id: 'g_0', qty: 1 }] })).status).toBe(201);
    expect((await order({ requestId: 'req-44444444', items: [{ id: 'g_0', qty: 1 }] })).status).toBe(429);   // three waiting orders for one phone
    expect(orders()).toHaveLength(3);
  });

  it('works without an email address, and tells the customer once per status change', async () => {
    // Keep both requests off the shared default phone bucket; this test is about email behavior.
    const r = await order({ email: '', phone: '0803 777 0002' }); expect(r.status).toBe(201);
    expect(emails.map((m) => m.to[0] ?? m.to)).toEqual(['sade@example.com']);
    const path = orders()[0]!; const id = path.split('/').pop()!;
    const ev = async () => (await (await call('/api/events', { headers: await authed(), body: JSON.stringify({ workspaceId: X, event: 'orders.order.status', id }) })).json()) as any;
    store.set(path, { ...store.get(path)!, fields: { ...store.get(path)!.fields, status: toFs('confirmed') } });
    expect(await ev()).toMatchObject({ emailed: false, reason: 'no_email' });
    // The Firestore test mock returns the whole collection without applying where filters.
    // Remove this fixture so the next request tests customer-email behavior, not the phone quota.
    store.delete(path);
    // with an address on the order the customer is emailed once
    const r2 = await order({ phone: '0803 777 0003' }); expect(r2.status).toBe(201);
    const p2 = orders().find((k) => k !== path)!; const id2 = p2.split('/').pop()!;
    store.set(p2, { ...store.get(p2)!, fields: { ...store.get(p2)!.fields, status: toFs('shipped') } });
    emails = [];
    const ev2 = async () => (await (await call('/api/events', { headers: await authed(), body: JSON.stringify({ workspaceId: X, event: 'orders.order.status', id: id2 }) })).json()) as any;
    expect(await ev2()).toMatchObject({ emailed: true });
    expect(emails[0].subject).toMatch(/on its way/);
    expect(await ev2()).toMatchObject({ emailed: false, reason: 'duplicate' });
    expect(emails).toHaveLength(1);
  });

  it('signs a Cloudinary upload for members only, limited to the workspace folder and image types', async () => {
    const r = await call('/api/uploads/sign', { headers: await authed(), body: JSON.stringify({ workspaceId: X }) });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, string>;
    expect(j).toMatchObject({ cloudName: 'democloud', apiKey: '123456', folder: `zexcore/${X}/products`, allowed_formats: 'jpg,jpeg,png,webp' });
    const toSign = `allowed_formats=jpg,jpeg,png,webp&folder=zexcore/${X}/products&timestamp=${j.timestamp}shh-secret`;
    const sha1 = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(j.signature).toBe(sha1);
    expect(JSON.stringify(j)).not.toContain('shh-secret');
    expect((await call('/api/uploads/sign', { headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' }, body: JSON.stringify({ workspaceId: X }) })).status).toBe(401);
    env = { ...env, CLOUDINARY_API_SECRET: undefined };
    expect((await call('/api/uploads/sign', { headers: await authed(), body: JSON.stringify({ workspaceId: X }) })).status).toBe(503);
  });
});

describe('public booking owner notification', () => {
  const X = 'wsbooknotify000000001';
  it('uses the owner profile email when the owner member row has no email', async () => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    seedDoc('slugs/book-biz', { wid: X });
    seedDoc(`workspaces/${X}`, { name: 'Book Biz', plan: 'free', ownerUid: 'owner1', slug: 'book-biz', settings: {} });
    seedDoc(`workspaces/${X}/members/owner1`, { role: 'owner', name: 'Sade' });
    seedDoc('users/owner1', { name: 'Sade Obi', email: 'profile-owner@example.com' });
    seedDoc(`workspaces/${X}/services/s_0`, { name: 'Consultation', priceMinor: 0 });
    seedDoc(`workspaces/${X}/bookings/202611_9`, {
      source: 'public', status: 'pending', serviceId: 's_0', customerName: 'Ada Obi',
      customerPhone: '+2348031112222', customerEmail: null,
      startsAt: new Date(NOW.getTime() + 86_400_000), createdAt: new Date(NOW.getTime() - 60_000),
    });

    const r = await call('/api/public/booked', {
      headers: { 'content-type': 'application/json', origin: 'https://zexcore.com.ng' },
      body: JSON.stringify({ slug: 'book-biz', bookingId: '202611_9' }),
    });
    expect(r.status).toBe(200);
    expect(emails.map((m) => m.to[0] ?? m.to)).toContain('profile-owner@example.com');
    expect(emails.find((m) => (m.to[0] ?? m.to) === 'profile-owner@example.com')?.subject).toMatch(/New booking request/);
  });
});

describe('email outbox', () => {
  const MIN = 60_000;
  const at = (ms: number) => ({ fetch: mockFetch(), now: () => new Date(NOW.getTime() + ms) });
  const mail = { key: 'ack:ws1:b1', to: 'ada@example.com', subject: 'Hello', text: 'Dear Ada, your booking was received.', html: '<p>Dear Ada</p>' };
  const row = async (key = mail.key) => store.get(`emailOutbox/${await outboxId(key)}`)!.fields;
  const f = async (k: string, key?: string) => fromFs((await row(key))[k]);
  beforeEach(() => { env = { ...env, RESEND_API_KEY: 're_test' }; });

  it('sends right away, once, with an idempotency key, and erases the body afterwards', async () => {
    expect(await queueEmail(env, at(0), mail)).toBe('sent');
    expect(emails).toHaveLength(1); expect(resendKeys[0]).toBe(await outboxId(mail.key));
    expect(await f('status')).toBe('sent'); expect(await f('text')).toBeNull(); expect(await f('subject')).toBeNull();
  });

  it('queues the same key once, even when asked twice', async () => {
    await queueEmail(env, at(0), mail);
    expect(await queueEmail(env, at(1), mail)).toBe('duplicate');
    expect(emails).toHaveLength(1);
  });

  it('keeps the message when the provider is down and delivers it on a later run, once', async () => {
    resendMode = 'down';
    expect(await queueEmail(env, at(0), mail)).toBe('queued');
    expect(await f('status')).toBe('pending'); expect(await f('attempts')).toBe(1); expect(await f('lastError')).toBe('provider_rejected');
    resendMode = 'ok';
    expect(await drainOutbox(env, at(30_000))).toMatchObject({ sent: 0 });            // not due yet (wait is 1 minute)
    expect(emails).toHaveLength(0);
    expect(await drainOutbox(env, at(2 * MIN))).toMatchObject({ sent: 1 });
    expect(emails).toHaveLength(1); expect(await f('status')).toBe('sent');
    expect(await drainOutbox(env, at(10 * MIN))).toMatchObject({ sent: 0 });          // nothing left to send
    expect(emails).toHaveLength(1);
  });

  it('treats a network failure as a retry, and a permanent rejection as final', async () => {
    resendMode = 'throw';
    expect(await queueEmail(env, at(0), mail)).toBe('queued');
    expect(await f('status')).toBe('pending');
    resendMode = 'reject';
    expect(await queueEmail(env, at(0), { ...mail, key: 'bad:1' })).toBe('dead');
    expect(await f('status', 'bad:1')).toBe('dead'); expect(await f('text', 'bad:1')).toBeNull();
    expect(emails).toHaveLength(0);
  });

  it('backs off and gives up after the maximum number of tries', async () => {
    resendMode = 'down';
    await queueEmail(env, at(0), mail);
    let t = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) { t += 13 * 60 * MIN; await drainOutbox(env, at(t)); }
    expect(await f('attempts')).toBe(MAX_ATTEMPTS); expect(await f('status')).toBe('dead');
    const before = await f('attempts'); await drainOutbox(env, at(t + 100 * 60 * MIN));
    expect(await f('attempts')).toBe(before);
    expect(emails).toHaveLength(0);
  });

  it('recovers a message whose worker died: a live lease is left alone, an expired one is taken over', async () => {
    resendMode = 'down';
    await queueEmail(env, at(0), mail);                                              // creates the row
    const id = await outboxId(mail.key);
    resendMode = 'ok';
    const lock = (ms: number) => seedDoc(`emailOutbox/${id}`, { key: mail.key, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, status: 'sending', attempts: 1, nextAttemptAt: NOW, lockedUntil: new Date(NOW.getTime() + ms), createdAt: NOW, sentAt: null });
    lock(4 * MIN);
    expect(await drainOutbox(env, at(MIN))).toMatchObject({ sent: 0 }); expect(emails).toHaveLength(0);   // another worker still holds it
    expect(await drainOutbox(env, at(6 * MIN))).toMatchObject({ sent: 1 });                              // lease ran out
    expect(emails).toHaveLength(1); expect(await f('status')).toBe('sent');
  });

  it('waits without using up tries when no email provider is set up', async () => {
    env = { ...env, RESEND_API_KEY: undefined };
    expect(await queueEmail(env, at(0), mail)).toBe('queued');
    expect(await f('attempts')).toBe(0); expect(await f('lastError')).toBe('not_configured');
    env = { ...env, RESEND_API_KEY: 're_test' };
    await drainOutbox(env, at(2 * 60 * MIN));
    expect(emails).toHaveLength(1);
  });

  it('clears out old records', async () => {
    await queueEmail(env, at(0), mail);
    const r = await drainOutbox(env, at(8 * 86_400_000));
    expect(r.purged).toBe(1);
    expect(store.has(`emailOutbox/${await outboxId(mail.key)}`)).toBe(false);
  });
});

describe('appointment reminder and thank-you emails', () => {
  const X = 'wsremind000000000001';
  const H = 3_600_000;
  const run = (kind: 'reminder' | 'followup', ms = 0) => sendCustomerEmails({ ...env, RESEND_API_KEY: 're_test' }, { fetch: mockFetch(), now: () => new Date(NOW.getTime() + ms) }, X, kind);
  const bk = (id: string, over: Record<string, unknown> = {}) => seedDoc(`workspaces/${X}/bookings/${id}`, { status: 'confirmed', serviceId: 's_0', customerName: 'Ada Obi', customerEmail: 'ada@example.com', customerPhone: '+2348031112222',
    startsAt: new Date(NOW.getTime() + 20 * H), createdAt: new Date(NOW.getTime() - 3 * 86_400_000), ...over });
  beforeEach(() => {
    env = { ...env, RESEND_API_KEY: 're_test' };
    seedDoc(`workspaces/${X}`, { name: 'Remind Salon', plan: 'free', ownerUid: 'owner1', slug: 'remind-salon', settings: { publicName: 'Remind Salon', phone: '0803 000 0000', reminderEmails: true, followUpEmails: true, utcOffsetMinutes: 60 } });
    seedDoc(`workspaces/${X}/services/s_0`, { name: 'Braids' });
  });

  it('reminds a confirmed customer about tomorrow once, even if the hourly job runs again', async () => {
    bk('202611_1');
    expect(await run('reminder')).toBe(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('Reminder: your appointment with Remind Salon'); expect(emails[0].text).toMatch(/Braids/); expect(emails[0].text).toMatch(/0803 000 0000/);
    expect(await run('reminder', 30 * 60_000)).toBe(0);
    expect(emails).toHaveLength(1);
  });

  it('skips unconfirmed, cancelled, no-email, too-far, too-soon and short-notice bookings', async () => {
    bk('202611_2', { status: 'pending' }); bk('202611_3', { status: 'cancelled' }); bk('202611_4', { customerEmail: null });
    bk('202611_5', { startsAt: new Date(NOW.getTime() + 40 * H) }); bk('202611_6', { startsAt: new Date(NOW.getTime() + 30 * 60_000) });
    bk('202611_7', { createdAt: new Date(NOW.getTime() - 2 * H) });                       // booked yesterday evening for tomorrow: just told
    expect(await run('reminder')).toBe(0); expect(emails).toHaveLength(0);
  });

  it('does nothing when the owner has not switched it on', async () => {
    seedDoc(`workspaces/${X}`, { name: 'Remind Salon', plan: 'free', ownerUid: 'owner1', slug: 'remind-salon', settings: { reminderEmails: false } });
    bk('202611_8');
    expect(await run('reminder')).toBe(0); expect(emails).toHaveLength(0);
  });

  it('thanks a customer a day after a completed visit, and only completed ones', async () => {
    bk('202611_9', { status: 'completed', startsAt: new Date(NOW.getTime() - 26 * H) });
    bk('202611_10', { status: 'no_show', startsAt: new Date(NOW.getTime() - 26 * H) });
    bk('202611_11', { status: 'completed', startsAt: new Date(NOW.getTime() - 2 * H) });   // too soon
    expect(await run('followup')).toBe(1);
    expect(emails[0].subject).toBe('Thank you for visiting Remind Salon'); expect(emails[0].text).toMatch(/Book again/);
  });

  it('the hourly job runs both kinds and survives a provider outage by keeping the email queued', async () => {
    bk('202611_12');
    resendMode = 'down';
    expect(await scheduledCustomerEmails(env, { fetch: mockFetch(), now: () => NOW })).toMatchObject({ reminders: 1 });
    expect(emails).toHaveLength(0);
    resendMode = 'ok';
    await drainOutbox(env, { fetch: mockFetch(), now: () => new Date(NOW.getTime() + 2 * 60_000) });
    expect(emails).toHaveLength(1);
  });
});
