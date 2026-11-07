/**
 * ZexCore Worker (Cloudflare Workers, free plan, no server to run).
 *
 * Firestore security rules forbid browsers from touching plan fields, ledgers and secrets, so something trusted has to.
 * This Worker is that something. It holds the Paystack secret and a service account and never believes amounts,
 * tiers, plans or identities sent by a browser or found in webhook metadata.
 */
import { deleteAccount } from './routes/account';
import { assess } from './routes/risk';
import { joinWaitlist } from './routes/waitlist';
import { adminMe, grantPlan } from './routes/admin';
import { clusterRequest, getClusterRequest, issueLicense, licenseKey, verifyLicenseRoute } from './routes/license';
import { orderStatus, placeOrder, refundOrder, shopPay, signUpload } from './routes/shop';
import { whatsappConfigured } from './whatsapp';
import { createKey, revokeKey, v1Bookings, v1Customers } from './routes/apikeys';
import { paymentsEnabled, realDeps, type Ctx, type Deps, type Env } from './env';
import { HttpError, cors, json } from './util';
import { checkout, webhook } from './routes/billing';
import { audit, verifyAudit } from './routes/audit';
import { ingest } from './routes/iot';
import { banks, depositLink, depositStatus, payoutSetup, publicDeposit, refundDeposit } from './routes/deposits';
import { memberEvent, publicBooked } from './routes/events';
import { certificate, download, runNow, scheduledBackups } from './routes/backups';
import { welcome } from './routes/welcome';
import { insights, scheduledDigests } from './routes/insights';
import { accept, invite, inviteInfo, remove, revoke, setRole } from './routes/team';
import { whatsappConnect, whatsappDisconnect, whatsappStatus } from './routes/whatsapp';
import { manageWhatsAppSequences, setWhatsAppConsent, scheduledWhatsApp } from './routes/whatsappAutomation';
import { whatsappWebhook, whatsappWebhookVerify } from './routes/whatsappWebhook';
import { scheduledDepositExpiry } from './routes/expiry';
import { drainOutbox } from './outbox';
import { scheduledCustomerEmails } from './routes/reminders';
import { listDevices, recordSignIn, revokeAll } from './routes/security';

export type { Env, Deps } from './env';
export { scheduledBackups } from './routes/backups';
export { scheduledDepositExpiry, expireUnpaidDeposits } from './routes/expiry';
export { scheduledDigests, sendDigest, weekKey, digestDue } from './routes/insights';
export { summarize } from './insights';
export { amountMinor, isTier, PLANS, planAfterPayment } from './routes/billing';
export { paystackSignature } from './util';
export { toFs, fromFs } from './fs';
export { resetTokenCache } from './google';
export { resetJwksCache } from './auth';

import { getLiveRates } from './rates';

type Handler = (c: Ctx) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  'GET /api/whatsapp/webhook': whatsappWebhookVerify,
  'POST /api/whatsapp/webhook': whatsappWebhook,
  'GET /api/health': async (c) => json({ status: 'ok', whatsapp: whatsappConfigured(c.env) }, 200, c.headers),
  'GET /api/rates': async (c) => {
    const t = await getLiveRates(c.env, c.d);
    return json({ base: 'USD', target: 'NGN', rate: t.rates.NGN, rates: t.rates, live: t.live, updatedAt: t.updatedAt }, 200, c.headers);
  },
  'POST /api/checkout': (c) => checkout(c.req, c.env, c.d, c.headers),
  'POST /api/paystack-webhook': (c) => webhook(c.req, c.env, c.d),
  'POST /api/audit': audit,
  'GET /api/audit/verify': verifyAudit,
  'POST /api/iot/ingest': ingest,
  'GET /api/banks': banks,
  'POST /api/payout/setup': payoutSetup,
  'POST /api/public/deposit': publicDeposit,
  'POST /api/deposit/link': depositLink,
  'POST /api/deposit/refund': refundDeposit,
  'GET /api/public/shop-pay': shopPay,
  'GET /api/public/order-status': orderStatus,
  'POST /api/order/refund': refundOrder,
  'GET /api/admin/me': adminMe,
  'POST /api/admin/grant-plan': grantPlan,
  'POST /api/license': issueLicense,
  'GET /api/public/license-key': licenseKey,
  'POST /api/public/license-verify': verifyLicenseRoute,
  'GET /api/cluster/request': getClusterRequest,
  'POST /api/cluster/request': clusterRequest,
  'GET /api/public/deposit-status': depositStatus,
  'POST /api/events': memberEvent,
  'POST /api/public/booked': publicBooked,
  'POST /api/backups/run': runNow,
  'GET /api/backups/download': download,
  'GET /api/backups/certificate': certificate,
  'POST /api/welcome': welcome,
  'POST /api/team/invite': invite,
  'GET /api/team/invite-info': inviteInfo,
  'POST /api/team/accept': accept,
  'POST /api/team/revoke': revoke,
  'POST /api/team/role': setRole,
  'POST /api/team/remove': remove,
  'POST /api/whatsapp/status': whatsappStatus,
  'POST /api/whatsapp/connect': whatsappConnect,
  'POST /api/whatsapp/disconnect': whatsappDisconnect,
  'POST /api/whatsapp/sequences': manageWhatsAppSequences,
  'POST /api/whatsapp/consent': setWhatsAppConsent,
  'POST /api/account/delete': deleteAccount,
  'POST /api/security/signin': recordSignIn,
  'GET /api/security/devices': listDevices,
  'POST /api/security/revoke-all': revokeAll,
  'POST /api/risk/assess': assess,
  'POST /api/public/waitlist': joinWaitlist,
  'POST /api/public/order': placeOrder,
  'POST /api/uploads/sign': signUpload,
  'POST /api/insights': insights,
  'POST /api/keys/create': createKey,
  'POST /api/keys/revoke': revokeKey,
  'GET /api/v1/bookings': v1Bookings,
  'GET /api/v1/customers': v1Customers,
};

/** Routes that take or confirm money. They stay off unless a live Paystack key is set (or the Worker is explicitly marked staging). */
const PUBLIC_ROUTES = new Set(['GET /api/public/license-key', 'POST /api/public/license-verify', 'GET /api/public/shop-pay', 'GET /api/public/order-status', 'POST /api/public/waitlist', 'POST /api/public/order', 'POST /api/public/deposit', 'GET /api/public/deposit-status', 'POST /api/public/booked', 'GET /api/banks', 'GET /api/team/invite-info']);
const MONEY_ROUTES = new Set(['GET /api/public/order-status', 'POST /api/order/refund', 'POST /api/checkout', 'POST /api/paystack-webhook', 'GET /api/banks', 'POST /api/payout/setup', 'POST /api/public/deposit', 'POST /api/deposit/link', 'POST /api/deposit/refund', 'GET /api/public/deposit-status']);
export { paymentsEnabled };

/**
 * Best-effort throttle for the public (signed-out) routes: 20 calls a minute per visitor per route, per Worker instance.
 * It stops casual abuse; for a hard limit add a Cloudflare rate-limiting rule on /api/public/* (see docs/launch-runbook.md).
 */
const PUBLIC_LIMITED = new Set(['GET /api/public/license-key', 'POST /api/public/license-verify', 'GET /api/public/shop-pay', 'GET /api/public/order-status', 'POST /api/public/waitlist', 'POST /api/public/order', 'POST /api/public/deposit', 'GET /api/public/deposit-status', 'POST /api/public/booked']);
const hits = new Map<string, number[]>();
export function throttled(key: string, now: number, max = 20, windowMs = 60_000): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now); hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return recent.length > max;
}

export async function handle(req: Request, env: Env, d: Deps = realDeps()): Promise<Response> {
  const url = new URL(req.url);
  const headers = cors(env, req);
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const h = ROUTES[`${req.method} ${url.pathname}`];
    if (!h) return json({ error: 'Not found' }, 404, headers);
    const rk = `${req.method} ${url.pathname}`;
    if (PUBLIC_LIMITED.has(rk) && throttled(`${req.headers.get('cf-connecting-ip') ?? 'unknown'} ${rk}`, d.now().getTime())) {
      return json({ error: 'Too many requests. Please wait a minute and try again.', code: 'rate_limited' }, 429, { ...headers, 'retry-after': '60' });
    }
    if (env.PUBLIC_RL && PUBLIC_ROUTES.has(`${req.method} ${url.pathname}`)) {
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.PUBLIC_RL.limit({ key: `${ip}:${url.pathname}` }).catch(() => ({ success: true }));
      if (!success) return json({ error: 'Too many requests. Please wait a minute and try again.', code: 'rate_limited' }, 429, headers);
    }
    if (MONEY_ROUTES.has(`${req.method} ${url.pathname}`) && !paymentsEnabled(env)) {
      // A webhook must not be retried forever; everything else tells the user plainly.
      if (url.pathname === '/api/paystack-webhook') return json({ ok: true, ignored: true }, 200, headers);
      return json({ error: 'Online payments are not switched on yet.', code: 'unavailable' }, 503, headers);
    }
    return await h({ req, env, d, url, headers });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status, headers);
    console.error('worker error', e instanceof Error ? e.message : e);
    return json({ error: 'Something went wrong. Please try again.' }, 500, headers);
  }
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
  /** Cron Trigger: hourly tick. Backs up the Enterprise/Dedicated workspaces that are due (see routes/backups.ts). */
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => {
    ctx.waitUntil(scheduledBackups(env, realDeps()).catch((e) => console.error('scheduled backups', e instanceof Error ? e.message : e)));
    ctx.waitUntil(scheduledDigests(env, realDeps()).catch((e) => console.error('scheduled digests', e instanceof Error ? e.message : e)));
    ctx.waitUntil(scheduledDepositExpiry(env, realDeps()).catch((e) => console.error('scheduled deposit expiry', e instanceof Error ? e.message : e)));
    ctx.waitUntil(scheduledCustomerEmails(env, realDeps()).then(() => drainOutbox(env, realDeps())).then((r) => { if (r.sent || r.dead) console.log('email outbox', JSON.stringify(r)); }).catch((e) => console.error('customer emails', e instanceof Error ? e.message : e)));
    ctx.waitUntil(scheduledWhatsApp(env, realDeps()).catch((e) => console.error('scheduled WhatsApp', e instanceof Error ? e.message : e)));
  },
};
