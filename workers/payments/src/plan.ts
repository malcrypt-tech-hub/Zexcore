/** A workspace's effective plan today, with the same 3-day grace as the rest of the platform (after it, the workspace is Free again). */
const GRACE_MS = 3 * 86_400_000;
const ORDER = ['free', 'starter', 'growth', 'agency', 'enterprise', 'dedicated'];

export function effectivePlan(ws: Record<string, any> | undefined, now: Date): { plan: string; expires: Date | null } {
  const plan = ORDER.includes(String(ws?.plan)) ? String(ws?.plan) : 'free';
  const expires = ws?.planExpiresAt instanceof Date ? (ws.planExpiresAt as Date) : null;
  const live = plan !== 'free' && (!expires || now.getTime() < expires.getTime() + GRACE_MS);
  return { plan: live ? plan : 'free', expires };
}
/** True when the plan is `min` or above. */
export const atLeast = (plan: string, min: string): boolean => ORDER.indexOf(plan) >= ORDER.indexOf(min);
/** The plan from which customers can pay for shop orders online. Keep in step with FEATURE_TIERS.shopPay in the dashboard. */
export const SHOP_PAY_MIN = 'starter';
