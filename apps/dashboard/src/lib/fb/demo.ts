/**
 * The /demo booking page: a clearly labelled sample business that runs entirely in the browser.
 * Nothing is read from or written to the database, no message is sent and no payment is taken.
 */
import { ApiError } from './core';
import { generateSlotStarts, type SlotSettings } from './slots';

export const DEMO_SLUG = 'demo';
const SETTINGS: SlotSettings = { openMinutes: 540, closeMinutes: 1020, slotMinutes: 30, daysOpen: [1, 2, 3, 4, 5, 6], utcOffsetMinutes: 60, leadMinutes: 60, maxDaysAhead: 30 };
const SERVICES = [
  { id: 's_0', name: 'Haircut & style', description: 'Wash, cut and finish.', durationMin: 30, priceMinor: 1200 },
  { id: 's_1', name: 'Manicure', description: 'Shape, cuticle care and polish.', durationMin: 45, priceMinor: 1500 },
  { id: 's_2', name: 'Facial treatment', description: 'Deep cleanse and mask.', durationMin: 60, priceMinor: 3000 },
  { id: 's_3', name: 'Braids', description: 'Price depends on the style you choose.', durationMin: 90, priceMinor: 4500 },
];
const STAFF = [{ id: 'p_0', name: 'Ada', title: 'Stylist' }, { id: 'p_1', name: 'Tolu', title: 'Beauty therapist' }];

export function demoProfile(): unknown {
  return {
    business: { slug: DEMO_SLUG, name: 'Demo Studio', type: 'business', phone: null, address: 'Sample business. This is a demo: nothing you enter is saved or sent.' },
    currency: 'USD', deposit: { enabled: false, amountMinor: 0 },
    hours: { openMinutes: SETTINGS.openMinutes, closeMinutes: SETTINGS.closeMinutes, daysOpen: SETTINGS.daysOpen, utcOffsetMinutes: SETTINGS.utcOffsetMinutes, maxDaysAhead: SETTINGS.maxDaysAhead },
    paystackPublicKey: null, services: SERVICES, staff: STAFF,
  };
}

export function demoSlots(params: URLSearchParams): { slots: { startsAt: string; available: boolean }[] } {
  const service = SERVICES.find((s) => s.id === params.get('serviceId'));
  if (!service) throw new ApiError(400, 'Choose a service.');
  const starts = generateSlotStarts(params.get('date') ?? '', service.durationMin, SETTINGS);
  // A fixed pattern marks some times as taken so the page looks like a working calendar. It is not real data.
  return { slots: starts.map((ms) => ({ startsAt: new Date(ms).toISOString(), available: Math.floor(ms / 900_000) % 5 !== 2 })) };
}

export function demoBook(b: Record<string, unknown>): unknown {
  const service = SERVICES.find((s) => s.id === b.serviceId);
  if (!service) throw new ApiError(400, 'Choose a service.');
  const when = new Date(String(b.startsAt));
  if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Pick a time.');
  return { booking: { ref: 'DEMO-0000', status: 'pending', startsAt: when.toISOString(), serviceName: service.name }, payment: null };
}
