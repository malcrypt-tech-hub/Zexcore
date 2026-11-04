// Plan limits and prices. These MUST match firestore.rules (limits) and workers/payments/src/index.ts (prices).
import type { LimitKey, Limits, Labels } from '../limits';

export type Tier = 'free' | 'starter' | 'growth' | 'agency' | 'enterprise' | 'dedicated';
const UNLIMITED = null;

// Everything the database rules enforce per plan. Must match firestore.rules.
export const LIMITS: Record<Tier, Record<'bookingsPerMonth' | 'staff' | 'services' | 'cmsPages' | 'crmContacts' | 'devices' | 'rules', number | null>> = {
  free:       { bookingsPerMonth: 50,   staff: 1,   services: 3,   cmsPages: 3,   crmContacts: 50, devices: 0, rules: 0 },
  starter:    { bookingsPerMonth: 200,  staff: 3,   services: 10,  cmsPages: 10,  crmContacts: 500, devices: 0, rules: 0 },
  growth:     { bookingsPerMonth: 1000, staff: 10,  services: 30,  cmsPages: 50,  crmContacts: 5000, devices: 25, rules: 25 },
  agency:     { bookingsPerMonth: 5000, staff: 50,  services: 100, cmsPages: 200, crmContacts: 50000, devices: 100, rules: 100 },
  enterprise: { bookingsPerMonth: UNLIMITED, staff: UNLIMITED, services: UNLIMITED, cmsPages: 1000, crmContacts: UNLIMITED, devices: 250, rules: 250 },
  dedicated:  { bookingsPerMonth: UNLIMITED, staff: UNLIMITED, services: UNLIMITED, cmsPages: UNLIMITED, crmContacts: UNLIMITED, devices: UNLIMITED, rules: UNLIMITED },
};
/** The rules treat "unlimited" as this many slots. */
export const UNLIMITED_SLOTS = 999_999;

/** Naira list prices, charged as listed; annual is ten months. approxUsd is only a guide for people paying from abroad. */
export const PRICES: Record<'starter' | 'growth' | 'agency', { monthlyNgn: number; annualNgn: number; approxUsd: number }> = {
  starter: { monthlyNgn: 12_000, annualNgn: 120_000, approxUsd: 8 },
  growth: { monthlyNgn: 65_000, annualNgn: 650_000, approxUsd: 43 },
  agency: { monthlyNgn: 200_000, annualNgn: 2_000_000, approxUsd: 133 },
};

import { getCachedNgnRate, DEFAULT_FALLBACK_RATE } from '../fx';

export const getPlatformNgnRate = (): number => getCachedNgnRate();
export const NGN_PER_USD = DEFAULT_FALLBACK_RATE;

export const LABELS: Labels = {
  bookingsPerMonth: { one: 'booking a month', many: 'bookings a month' },
  staff: { one: 'team member', many: 'team members' },
  services: { one: 'service', many: 'services' },
  cmsPages: { one: 'website page', many: 'website pages' },
  crmContacts: { one: 'CRM contact', many: 'CRM contacts' },
  devices: { one: 'device', many: 'devices' },
  rules: { one: 'automation', many: 'automations' },
};

const GRACE_MS = 3 * 86_400_000;
/** Same grace rule as the security rules: 3 days after expiry the workspace is on the free plan again. */
export function effectiveTier(plan: string | undefined, expiresAtMs: number | null, nowMs = Date.now()): Tier {
  const t = (plan && plan in LIMITS ? plan : 'free') as Tier;
  if (t === 'free' || expiresAtMs === null) return t;
  return nowMs < expiresAtMs + GRACE_MS ? t : 'free';
}

export type EnforcedKey = keyof (typeof LIMITS)['free'];
export const slotLimit = (tier: Tier, key: EnforcedKey): number => LIMITS[tier][key] ?? UNLIMITED_SLOTS;

export type FeatureKey = 'branding' | 'compliance' | 'automations' | 'devices' | 'export' | 'backups' | 'risk' | 'api';

export const FEATURE_TIERS: Record<FeatureKey, Tier> = {
  branding: 'starter',
  compliance: 'starter',
  automations: 'growth',
  devices: 'growth',
  export: 'enterprise',
  backups: 'enterprise',
  risk: 'enterprise',
  api: 'enterprise',
};

const TIER_ORDER: Record<Tier, number> = {
  free: 0,
  starter: 1,
  growth: 2,
  agency: 3,
  enterprise: 4,
  dedicated: 5,
};

export function hasFeatureAccess(tier: string | undefined, feature: FeatureKey): boolean {
  const t = (tier && tier in TIER_ORDER ? tier : 'free') as Tier;
  const req = FEATURE_TIERS[feature];
  return (TIER_ORDER[t] ?? 0) >= (TIER_ORDER[req] ?? 0);
}

export function featureRequiredTier(feature: FeatureKey): Tier {
  return FEATURE_TIERS[feature];
}

export function toLimits(tier: Tier): Limits {
  const l = LIMITS[tier];
  return { ...l } as Record<LimitKey, number | null>;
}

