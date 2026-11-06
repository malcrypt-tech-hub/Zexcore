/**
 * Unpaid risk-deposit bookings are not held forever.
 *
 * When a booking was flagged high-risk and the business asked for a deposit, the time is held for
 * HOLD_HOURS. If the deposit is still unpaid after that, the booking is cancelled so the time goes
 * back on sale, the customer is told by email, and any waitlist is offered the freed time.
 * Runs from the hourly cron. Enterprise and Dedicated workspaces only (the plans that have deposits).
 */
import type { Ctx, Deps, Env } from '../env';
import { fsCommit, fsGet, fsQuery } from '../fs';
import { sendFormal } from '../mail';
import { queueFormal } from '../outbox';
import { localWhen } from '../util';
import { activePlan } from './billing';
import { backfillSlot } from './waitlist';

export const HOLD_HOURS = 24;
const MAX_PER_WORKSPACE = 200;
const MAX_WORKSPACES = 40;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

export async function expireUnpaidDeposits(env: Env, d: Deps, wid: string): Promise<number> {
  const now = d.now().getTime();
  const ws = await fsGet(env, d, `workspaces/${wid}`);
  if (!ws) return 0;
  const off = Number((ws.data.settings as Record<string, unknown> | undefined)?.utcOffsetMinutes ?? 60);
  const biz = String((ws.data.settings as Record<string, unknown> | undefined)?.publicName ?? ws.data.name ?? 'the business');
  const slug = String(ws.data.slug ?? '');
  const c: Ctx = { req: new Request(env.APP_URL), env, d, url: new URL(env.APP_URL), headers: {} };
  const rows = await fsQuery(env, d, { parent: `workspaces/${wid}`, collection: 'bookings', where: [{ field: 'depositStatus', op: 'EQUAL', value: 'unpaid' }], limit: MAX_PER_WORKSPACE });
  let expired = 0;
  for (const b of rows) {
    const created = ms(b.data.createdAt), starts = ms(b.data.startsAt);
    if (b.data.depositStatus !== 'unpaid' || b.data.riskDeposit !== true) continue;
    if (b.data.status === 'cancelled' || b.data.status === 'completed' || b.data.status === 'no_show') continue;
    if (!created || created + HOLD_HOURS * 3_600_000 > now) continue;
    if (!starts || starts <= now) continue;                         // already past: leave it for the owner
    await fsCommit(env, d, [{ path: b.path, fields: { status: 'cancelled', cancelledReason: 'deposit_unpaid', cancelledAt: d.now() }, mask: ['status', 'cancelledReason', 'cancelledAt'], precondition: { exists: true } }]);
    expired++;
    const email = String(b.data.customerEmail ?? '').trim();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      const first = String(b.data.customerName ?? '').trim().split(/\s+/)[0] || 'there';
      await queueFormal(env, d, `expire:${wid}:${b.id}`, email, `Your booking with ${biz} was released`, {
        heading: 'Your booking was released', preheader: `The deposit was not paid within ${HOLD_HOURS} hours.`, greeting: `Hello ${first},`,
        paragraphs: [`Your booking with ${biz} needed a deposit to be held, and it was not paid within ${HOLD_HOURS} hours, so the time has been released.`, 'You are welcome to book again and pay the deposit to keep your time.'],
        details: [['Business', biz], ['Service', String(b.data.service ?? 'Service')], ['Time', localWhen(new Date(starts).toISOString(), off)]],
        ...(slug ? { button: { text: 'Book again', url: `${env.APP_URL.replace(/\/$/, '')}/${slug}` } } : {}),
      }).catch((e) => console.error('expiry email failed', wid, e instanceof Error ? e.message : e));
    }
    await backfillSlot(c, wid, b.id).catch((e) => console.error('backfill after expiry failed', wid, e instanceof Error ? e.message : e));
  }
  return expired;
}

export async function scheduledDepositExpiry(env: Env, d: Deps): Promise<{ expired: number }> {
  const now = d.now();
  const spaces = (await Promise.all(['enterprise', 'dedicated'].map((plan) => fsQuery(env, d, { collection: 'workspaces', where: [{ field: 'plan', op: 'EQUAL', value: plan }], limit: 500 })))).flat()
    .filter((w, i, all) => all.findIndex((x) => x.id === w.id) === i).filter((w) => ['enterprise', 'dedicated'].includes(activePlan(w.data, now).tier));
  let expired = 0;
  for (const w of spaces.slice(0, MAX_WORKSPACES)) {
    try { expired += await expireUnpaidDeposits(env, d, w.id); } catch (e) { console.error('deposit expiry failed', w.id, e instanceof Error ? e.message : e); }
  }
  return { expired };
}
