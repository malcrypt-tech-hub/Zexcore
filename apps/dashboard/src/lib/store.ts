import { api } from './api';

export interface Settings {
  businessType: string; businessSubtype?: string | null; publicName: string | null; phone: string | null; address: string | null; currency: string;
  exchangeRate?: number; depositEnabled: boolean; depositMinor: number; openMinutes: number; closeMinutes: number; slotMinutes: number;
  daysOpen: number[]; utcOffsetMinutes: number; leadMinutes: number; maxDaysAhead: number; onboarded: boolean;
  logoUrl?: string | null;
  riskDepositEnabled?: boolean; riskDepositLevel?: 'medium' | 'high'; riskDepositMinor?: number; waitlistEnabled?: boolean; exchangeRateMode?: 'auto' | 'manual'; weeklyDigest?: boolean;
  notifyOwnerEmail?: boolean; notifyOwnerWhatsApp?: boolean; notifyWhatsAppPhone?: string | null;
}
export interface Service { id: string; name: string; description: string | null; durationMin: number; priceMinor: number; active: boolean; bookingMode?: 'appointment' | 'enquiry'; intakeFields?: { key: string; label: string; type: 'text'|'textarea'|'select'|'number'|'url'; required: boolean; options?: string[] }[]; consultationEnabled?: boolean }
export interface Staff { id: string; name: string; title: string | null; active: boolean }
export interface Booking {
  id: string; ref: string; status: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  serviceId: string; serviceName?: string; durationMin?: number; staffId: string | null; staffName: string | null;
  customerName: string; customerPhone: string; customerEmail: string | null; startsAt: string; endsAt: string;
  currency: string; priceMinor: number; depositMinor: number; depositStatus: 'none' | 'unpaid' | 'paid' | 'refunded' | 'mismatch';
  paymentReference: string | null; notes: string | null; source: string;
  risk?: { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] } | null;
}

let settings: Settings | null = null;
let slug = '';
export async function loadSettings(force = false): Promise<Settings> {
  if (settings && !force) return settings;
  const r = await api<{ settings: Settings; tenant: { slug: string } }>('/api/bookings/settings');
  settings = r.settings; slug = r.tenant.slug;
  return settings;
}
export const tenantSlug = (): string => slug;
export const offset = (): number => settings?.utcOffsetMinutes ?? 60;
export const clearStore = (): void => { settings = null; slug = ''; };

/** The public address of the site. Every link we show or send uses this, never the *.web.app hosting address. */
export const SITE_URL: string = (import.meta.env?.VITE_SITE_URL || 'https://zexcore.com.ng').replace(/\/$/, '');
export const bookingUrl = (): string => `${SITE_URL}/${slug}`;
