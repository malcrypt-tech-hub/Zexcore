import { paymentsUrl } from './fb/firebase';
const FX_STORAGE_KEY = 'zx.fx_ngn_v1';
const MULTI_FX_STORAGE_KEY = 'zx.fx_multi_v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache
export const DEFAULT_FALLBACK_RATE = 1350;

export type SupportedCurrency = 'USD' | 'NGN' | 'GBP' | 'EUR' | 'GHS' | 'KES' | 'ZAR';

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  USD: '$',
  NGN: '₦',
  GBP: '£',
  EUR: '€',
  GHS: 'GH₵',
  KES: 'KSh',
  ZAR: 'R',
};

export const DEFAULT_RATES_FROM_USD: Record<SupportedCurrency, number> = {
  USD: 1,
  NGN: 1350,
  GBP: 0.78,
  EUR: 0.92,
  GHS: 15.5,
  KES: 130,
  ZAR: 18.2,
};

interface CachedMultiFx {
  rates: Record<SupportedCurrency, number>;
  updatedAt: number;
}

let inMemoryMultiFx: CachedMultiFx | null = null;

export function getCachedRates(): Record<SupportedCurrency, number> {
  if (inMemoryMultiFx) return inMemoryMultiFx.rates;
  try {
    const raw = localStorage.getItem(MULTI_FX_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as CachedMultiFx;
      if (p?.rates && typeof p.rates.NGN === 'number') {
        inMemoryMultiFx = p;
        return p.rates;
      }
    }
  } catch { /* ignore */ }
  const ngn = getCachedNgnRate();
  return { ...DEFAULT_RATES_FROM_USD, NGN: ngn };
}

/** Whether the last table came from a market source, and when. false means the numbers are stored defaults. */
export const ratesMeta: { live: boolean; updatedAt: string | null } = { live: false, updatedAt: null };

/**
 * Every supported currency per US dollar. The browser asks our own Worker, which fetches the market rate and caches it for an
 * hour (the site's security policy does not let pages call rate providers directly, and one source keeps every page consistent).
 */
async function fetchWorkerRates(): Promise<{ rates: Record<SupportedCurrency, number>; live: boolean; updatedAt: string } | null> {
  try {
    const res = await fetch(`${paymentsUrl()}/api/rates`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, number>; live?: boolean; updatedAt?: string };
    if (!data?.rates || !(Number(data.rates.NGN) > 100)) return null;
    const rates = { USD: 1 } as Record<SupportedCurrency, number>;
    for (const c of Object.keys(DEFAULT_RATES_FROM_USD) as SupportedCurrency[]) if (c !== 'USD') rates[c] = Number(data.rates[c]) > 0 ? Number(data.rates[c]) : DEFAULT_RATES_FROM_USD[c];
    return { rates, live: data.live === true, updatedAt: String(data.updatedAt ?? new Date().toISOString()) };
  } catch { return null; }
}

export async function fetchLiveRates(): Promise<Record<SupportedCurrency, number>> {
  const current = inMemoryMultiFx;
  const now = Date.now();
  if (current && now - current.updatedAt < CACHE_TTL_MS && ratesMeta.live) return current.rates;
  const got = await fetchWorkerRates();
  if (got) {
    const record = { rates: got.rates, updatedAt: now };
    inMemoryMultiFx = record;
    ratesMeta.live = got.live; ratesMeta.updatedAt = got.updatedAt;
    try { localStorage.setItem(MULTI_FX_STORAGE_KEY, JSON.stringify(record)); } catch { /* ignore */ }
    if (got.live) writeStorage(got.rates.NGN);
    return got.rates;
  }
  return getCachedRates();
}

/** Converts an amount in USD cents (minor) to the target currency formatted string */
export function formatInCurrency(
  usdMinor: number,
  targetCurrency: SupportedCurrency,
  rates: Record<SupportedCurrency, number> = getCachedRates(),
  workspaceNgnRate?: number
): string {
  const sym = CURRENCY_SYMBOLS[targetCurrency] || `${targetCurrency} `;
  let rate = rates[targetCurrency] ?? 1;
  // If merchant has a custom NGN exchange rate in settings, use that for NGN conversion
  if (targetCurrency === 'NGN' && workspaceNgnRate && workspaceNgnRate > 100) {
    rate = workspaceNgnRate;
  }
  const amount = (usdMinor / 100) * rate;
  const frac = ['NGN', 'KES', 'GHS', 'ZAR'].includes(targetCurrency) && amount >= 100 ? 0 : 2;
  return `${sym}${amount.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
}

interface CachedFx {
  rate: number;
  updatedAt: number;
}

let inMemoryRate: CachedFx | null = null;

function readStorage(): CachedFx | null {
  try {
    const raw = localStorage.getItem(FX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFx;
    if (parsed && typeof parsed.rate === 'number' && Number.isFinite(parsed.rate) && parsed.rate > 100) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeStorage(rate: number): void {
  try {
    const data: CachedFx = { rate, updatedAt: Date.now() };
    inMemoryRate = data;
    localStorage.setItem(FX_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

/** Synchronous getter returning the best available rate immediately (no await needed). */
export function getCachedNgnRate(): number {
  if (inMemoryRate && Number.isFinite(inMemoryRate.rate) && inMemoryRate.rate > 100) {
    return inMemoryRate.rate;
  }
  const stored = readStorage();
  if (stored) {
    inMemoryRate = stored;
    return stored.rate;
  }
  return DEFAULT_FALLBACK_RATE;
}

/**
 * Returns current live USD to NGN exchange rate from real-time market API.
 * Uses localStorage cache so it never delays UI rendering, updating in background when stale.
 */
export async function getLiveNgnRate(): Promise<number> {
  const current = inMemoryRate ?? readStorage();
  if (current && Date.now() - current.updatedAt < CACHE_TTL_MS) return current.rate;
  const rates = await fetchLiveRates();
  return rates.NGN > 100 ? rates.NGN : current?.rate ?? DEFAULT_FALLBACK_RATE;
}

/** Converts a US-dollar amount (minor units) into a number of a currency's major units at the given table. */
export function usdToMajor(usdMinor: number, cur: SupportedCurrency, rates: Record<SupportedCurrency, number>, ngnOverride?: number | null): number {
  const rate = cur === 'NGN' && ngnOverride && ngnOverride > 100 ? ngnOverride : rates[cur] ?? 1;
  return (usdMinor / 100) * rate;
}

// Background prefetch on idle
if (typeof window !== 'undefined') {
  const prefetch = () => { void getLiveNgnRate(); };
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(prefetch, { timeout: 3000 });
  } else {
    setTimeout(prefetch, 500);
  }
}
