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

export async function fetchLiveRates(): Promise<Record<SupportedCurrency, number>> {
  const current = inMemoryMultiFx;
  const now = Date.now();
  if (current && now - current.updatedAt < CACHE_TTL_MS) {
    return current.rates;
  }
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { rates?: Record<string, number> };
      if (data?.rates) {
        const rates: Record<SupportedCurrency, number> = {
          USD: 1,
          NGN: Number(data.rates.NGN) || DEFAULT_RATES_FROM_USD.NGN,
          GBP: Number(data.rates.GBP) || DEFAULT_RATES_FROM_USD.GBP,
          EUR: Number(data.rates.EUR) || DEFAULT_RATES_FROM_USD.EUR,
          GHS: Number(data.rates.GHS) || DEFAULT_RATES_FROM_USD.GHS,
          KES: Number(data.rates.KES) || DEFAULT_RATES_FROM_USD.KES,
          ZAR: Number(data.rates.ZAR) || DEFAULT_RATES_FROM_USD.ZAR,
        };
        const record = { rates, updatedAt: now };
        inMemoryMultiFx = record;
        try { localStorage.setItem(MULTI_FX_STORAGE_KEY, JSON.stringify(record)); } catch { /* ignore */ }
        writeStorage(rates.NGN);
        return rates;
      }
    }
  } catch { /* fallback */ }
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
  return `${sym}${amount.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: 2 })}`;
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
  const now = Date.now();
  if (current && now - current.updatedAt < CACHE_TTL_MS) {
    return current.rate;
  }

  // 1. Try ExchangeRate-API v4 (free, instant, no key)
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { rates?: { NGN?: number } };
      const rate = Number(data?.rates?.NGN);
      if (Number.isFinite(rate) && rate > 100 && rate < 100000) {
        const rounded = Math.round(rate * 100) / 100;
        writeStorage(rounded);
        return rounded;
      }
    }
  } catch {
    // try fallback
  }

  // 2. Secondary fallback: Floatrates
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://www.floatrates.com/daily/usd.json', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as { ngn?: { rate?: string | number } };
      const rate = Number(data?.ngn?.rate);
      if (Number.isFinite(rate) && rate > 100 && rate < 100000) {
        const rounded = Math.round(rate * 100) / 100;
        writeStorage(rounded);
        return rounded;
      }
    }
  } catch {
    // ignore
  }

  return current?.rate ?? DEFAULT_FALLBACK_RATE;
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
