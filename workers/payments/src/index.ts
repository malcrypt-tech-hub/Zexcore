/**
 * ZexCore Worker (Cloudflare Workers, free plan, no server to run).
 *
 * Firestore security rules forbid browsers from touching plan fields, ledgers and secrets, so something trusted has to.
 * This Worker is that something. It holds the Paystack secret and a service account and never believes amounts,
 * tiers, plans or identities sent by a browser or found in webhook metadata.
 */
import { realDeps, type Ctx, type Deps, type Env } from './env';
import { HttpError, cors, json } from './util';
import { checkout, webhook } from './routes/billing';
import { audit, verifyAudit } from './routes/audit';
import { ingest } from './routes/iot';
import { banks, depositLink, depositStatus, payoutSetup, publicDeposit } from './routes/deposits';
import { memberEvent, publicBooked } from './routes/events';
import { certificate, download, runNow, scheduledBackups } from './routes/backups';
import { accept, invite, inviteInfo, remove, revoke, setRole } from './routes/team';

export type { Env, Deps } from './env';
export { scheduledBackups } from './routes/backups';
export { amountMinor, isTier, PLANS } from './routes/billing';
export { paystackSignature } from './util';
export { toFs, fromFs } from './fs';
export { resetTokenCache } from './google';
export { resetJwksCache } from './auth';

import { getLiveNgnRate } from './rates';

type Handler = (c: Ctx) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  'GET /api/health': async (c) => json({ status: 'ok' }, 200, c.headers),
  'GET /api/rates': async (c) => {
    const rate = await getLiveNgnRate(c.env, c.d);
    return json({ base: 'USD', target: 'NGN', rate, updatedAt: c.d.now().toISOString() }, 200, c.headers);
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
  'GET /api/public/deposit-status': depositStatus,
  'POST /api/events': memberEvent,
  'POST /api/public/booked': publicBooked,
  'POST /api/backups/run': runNow,
  'GET /api/backups/download': download,
  'GET /api/backups/certificate': certificate,
  'POST /api/team/invite': invite,
  'GET /api/team/invite-info': inviteInfo,
  'POST /api/team/accept': accept,
  'POST /api/team/revoke': revoke,
  'POST /api/team/role': setRole,
  'POST /api/team/remove': remove,
};

/** Routes that take or confirm money. They stay off unless a live Paystack key is set (or the Worker is explicitly marked staging). */
const PUBLIC_ROUTES = new Set(['POST /api/public/deposit', 'GET /api/public/deposit-status', 'POST /api/public/booked', 'GET /api/banks', 'GET /api/team/invite-info']);
const MONEY_ROUTES = new Set(['POST /api/checkout', 'POST /api/paystack-webhook', 'GET /api/banks', 'POST /api/payout/setup', 'POST /api/public/deposit', 'POST /api/deposit/link', 'GET /api/public/deposit-status']);
export function paymentsEnabled(env: Env): boolean {
  const k = (env.PAYSTACK_SECRET_KEY ?? '').trim();
  if (!k) return false;
  if (k.startsWith('sk_live_')) return true;
  return k.startsWith('sk_test_') && env.ALLOW_TEST_PAYMENTS === 'true';
}

export async function handle(req: Request, env: Env, d: Deps = realDeps()): Promise<Response> {
  const url = new URL(req.url);
  const headers = cors(env, req);
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const h = ROUTES[`${req.method} ${url.pathname}`];
    if (!h) return json({ error: 'Not found' }, 404, headers);
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
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => { ctx.waitUntil(scheduledBackups(env, realDeps()).catch((e) => console.error('scheduled backups', e instanceof Error ? e.message : e))); },
};
