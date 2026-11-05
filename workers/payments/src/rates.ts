import type { Deps, Env } from './env';

const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedRate: { rate: number; timestamp: number } | null = null;
export const DEFAULT_FALLBACK_RATE = 1350;

/**
 * Fetches real-time USD to NGN exchange rate from open market exchange APIs.
 * Cached in memory for 1 hour with instant fallback so network hiccups never break checkout.
 */
export async function getLiveNgnRate(env?: Env, d?: Deps): Promise<number> {
  const envVal = env?.NGN_PER_USD?.trim();
  if (envVal && envVal !== 'auto') {
    const custom = Number(envVal);
    if (Number.isFinite(custom) && custom > 0) return custom;
  }

  const now = d ? d.now().getTime() : Date.now();
  if (cachedRate && now - cachedRate.timestamp < RATE_CACHE_TTL_MS) {
    return cachedRate.rate;
  }

  const fetcher = d?.fetch ?? fetch;

  // 1. Primary: api.exchangerate-api.com/v4/latest/USD (ultra-fast, free, no key)
  try {
    const res = await fetcher('https://api.exchangerate-api.com/v4/latest/USD', {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { rates?: { NGN?: number } };
      const rate = Number(data?.rates?.NGN);
      if (Number.isFinite(rate) && rate > 100 && rate < 100000) {
        cachedRate = { rate: Math.round(rate * 100) / 100, timestamp: now };
        return cachedRate.rate;
      }
    }
  } catch {
    // try secondary fallback
  }

  // 2. Secondary: floatrates.com
  try {
    const res = await fetcher('https://www.floatrates.com/daily/usd.json', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const data = (await res.json()) as { ngn?: { rate?: string | number } };
      const rate = Number(data?.ngn?.rate);
      if (Number.isFinite(rate) && rate > 100 && rate < 100000) {
        cachedRate = { rate: Math.round(rate * 100) / 100, timestamp: now };
        return cachedRate.rate;
      }
    }
  } catch {
    // fallback
  }

  // If cached value exists even if expired, use it
  if (cachedRate) return cachedRate.rate;

  return DEFAULT_FALLBACK_RATE;
}

// ───────────── every supported currency, from one cached fetch ─────────────
export const CURRENCIES = ['USD', 'NGN', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'] as const;
export type Rates = Record<(typeof CURRENCIES)[number], number>;
/** Only used when no market source answers; callers are told (live: false) so nothing pretends these are current. */
export const FALLBACK_RATES: Rates = { USD: 1, NGN: DEFAULT_FALLBACK_RATE, GBP: 0.78, EUR: 0.92, GHS: 15.5, KES: 130, ZAR: 18.2 };
let cachedTable: { rates: Rates; at: number } | null = null;
const sane = (n: unknown, lo: number, hi: number): number | null => { const v = Number(n); return Number.isFinite(v) && v > lo && v < hi ? v : null; };
const BOUNDS: Record<string, [number, number]> = { NGN: [100, 100_000], GBP: [0.1, 5], EUR: [0.1, 5], GHS: [1, 500], KES: [20, 1000], ZAR: [3, 200] };

/** Units of each currency per 1 USD, refreshed at most hourly, with the date it was fetched. */
export async function getLiveRates(env?: Env, d?: Deps): Promise<{ rates: Rates; live: boolean; updatedAt: string }> {
  const now = d ? d.now().getTime() : Date.now();
  const fetcher = d?.fetch ?? fetch;
  const override = Number(env?.NGN_PER_USD?.trim());
  const withOverride = (r: Rates): Rates => (env?.NGN_PER_USD && env.NGN_PER_USD.trim() !== 'auto' && Number.isFinite(override) && override > 0 ? { ...r, NGN: override } : r);
  if (cachedTable && now - cachedTable.at < RATE_CACHE_TTL_MS) return { rates: withOverride(cachedTable.rates), live: true, updatedAt: new Date(cachedTable.at).toISOString() };
  const build = (get: (c: string) => unknown): Rates | null => {
    const out: Record<string, number> = { USD: 1 };
    for (const c of CURRENCIES) { if (c === 'USD') continue; const v = sane(get(c), BOUNDS[c]![0], BOUNDS[c]![1]); if (v === null) return null; out[c] = Math.round(v * 10_000) / 10_000; }
    return out as Rates;
  };
  try {
    const res = await fetcher('https://api.exchangerate-api.com/v4/latest/USD', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (res.ok) { const data = (await res.json()) as { rates?: Record<string, number> }; const r = build((c) => data.rates?.[c]); if (r) { cachedTable = { rates: r, at: now }; return { rates: withOverride(r), live: true, updatedAt: new Date(now).toISOString() }; } }
  } catch { /* try the second source */ }
  try {
    const res = await fetcher('https://www.floatrates.com/daily/usd.json', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (res.ok) { const data = (await res.json()) as Record<string, { rate?: number }>; const r = build((c) => data[c.toLowerCase()]?.rate); if (r) { cachedTable = { rates: r, at: now }; return { rates: withOverride(r), live: true, updatedAt: new Date(now).toISOString() }; } }
  } catch { /* fall through */ }
  if (cachedTable) return { rates: withOverride(cachedTable.rates), live: false, updatedAt: new Date(cachedTable.at).toISOString() };   // stale, and honest about it
  return { rates: withOverride(FALLBACK_RATES), live: false, updatedAt: new Date(now).toISOString() };
}
