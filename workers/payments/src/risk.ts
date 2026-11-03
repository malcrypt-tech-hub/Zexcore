/**
 * No-show risk: a plain, explainable score from what this business already knows about the customer. No guesswork and
 * no outside data. Every point comes with a reason the owner can read. Matching is by phone number, inside one workspace.
 *
 *   0-29 low   30-59 medium   60+ high
 */
export interface Past { id: string; status: string; startsAt: number; depositStatus?: string }
export interface Subject { id: string; startsAt: number; createdAt: number; hasEmail: boolean }
export interface Risk { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] }

export const levelOf = (score: number): Risk['level'] => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');
const DAY = 86_400_000;

export function scoreRisk(history: Past[], s: Subject): Risk {
  const past = history.filter((h) => h.id !== s.id && h.startsAt < s.startsAt);   // only what was known before this booking
  const noShows = past.filter((h) => h.status === 'no_show').length;
  const completed = past.filter((h) => h.status === 'completed').length;
  const cancelled = past.filter((h) => h.status === 'cancelled').length;
  const finished = noShows + completed;
  const reasons: string[] = []; let score = 0;
  const add = (n: number, why: string): void => { score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };

  if (noShows >= 1) add(35, noShows === 1 ? 'missed 1 earlier booking' : `missed ${noShows} earlier bookings`);
  if (noShows >= 2) add(Math.min(30, (noShows - 1) * 20), 'repeated no-shows');
  if (finished >= 3 && noShows / finished >= 0.4) add(15, `missed ${Math.round((noShows / finished) * 100)}% of past visits`);
  if (cancelled >= 2) add(10, `cancelled ${cancelled} earlier bookings`);
  if (past.length === 0) add(15, 'first booking with you');
  if (past.some((h) => h.depositStatus === 'unpaid' && h.status !== 'completed' && h.status !== 'cancelled' && h.startsAt < s.createdAt)) add(10, 'left an earlier deposit unpaid');
  const lead = s.startsAt - s.createdAt;
  if (lead > 30 * DAY) add(10, 'booked more than 30 days ahead');
  else if (lead < 3 * 3_600_000) add(-5, 'booked within 3 hours of the visit');
  if (!s.hasEmail) add(5, 'no email for reminders');
  if (completed >= 3 && noShows === 0) add(-25, `${completed} completed visits and no misses`);
  else if (completed >= 1 && noShows === 0) add(-10, 'has completed visits before');

  score = Math.max(0, Math.min(100, score));
  return { score, level: levelOf(score), reasons };
}
