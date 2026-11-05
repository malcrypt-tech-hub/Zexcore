import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// A doubled backslash inside a regex literal (e.g. /\\d/) matches a literal backslash,
// so the pattern silently never matches real input. Guard the files that validate input.
const FILES = [
  'apps/dashboard/src/lib/fb/public.ts',
  'apps/dashboard/src/views/whatsapp.ts',
  'workers/payments/src/routes/events.ts',
  'workers/payments/src/routes/deposits.ts',
  'workers/payments/src/routes/whatsappAutomation.ts',
  'workers/payments/src/routes/whatsappWebhook.ts',
];

describe('regex literals', () => {
  for (const f of FILES) {
    it(`${f} has no doubled-backslash regex classes`, () => {
      const bad = readFileSync(f, 'utf8').split('\n').filter(l => /\/[^/\n]*\\\\[sdDwW.+][^/\n]*\/[.,;)gimsuy]/.test(l) && !/new RegExp|'\^|"\^/.test(l));
      expect(bad).toEqual([]);
    });
  }
  it('email and phone patterns accept real input', () => {
    const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
    expect(email.test('ada@example.com')).toBe(true);
    expect(email.test('not an email')).toBe(false);
    expect(/^\+?[0-9 ()-]{8,20}$/.test('+234 803 111 2222')).toBe(true);
    expect('+2348031112222'.replace(/^\+/, '')).toBe('2348031112222');
  });
});
