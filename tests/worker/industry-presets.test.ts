import { describe, it, expect } from 'vitest';
import { INDUSTRIES, industryOf } from '../../apps/dashboard/src/lib/industries';

// The booking page asks these questions for new workspaces; the catalogue rejects anything outside these limits.
describe('industry presets', () => {
  for (const ind of INDUSTRIES) {
    for (const svc of ind.services) {
      it(`${ind.key} / ${svc.name} has valid intake questions`, () => {
        const f = svc.fields ?? [];
        expect(f.length).toBeLessThanOrEqual(12);
        expect(new Set(f.map((x) => x.key)).size).toBe(f.length);
        for (const x of f) {
          expect(x.key).toMatch(/^[a-z0-9_]{1,32}$/);
          expect(x.label.length).toBeGreaterThan(0); expect(x.label.length).toBeLessThanOrEqual(80);
          expect(['text', 'textarea', 'select', 'number', 'url']).toContain(x.type);
          if (x.type === 'select') expect(x.options?.length).toBeGreaterThan(0);
        }
        if (svc.mode === 'enquiry') expect(f.length).toBeGreaterThan(0);   // an enquiry with no questions would be empty
      });
    }
  }
  it('tech and software asks the customer to describe the work, as an enquiry', () => {
    const s = industryOf('technology').services[0]!;
    expect(s.mode).toBe('enquiry');
    expect(s.fields!.some((f) => f.type === 'textarea' && f.required)).toBe(true);
  });
  it('clinics ask for the reason for the visit', () => {
    expect(industryOf('healthcare').services[0]!.fields!.some((f) => f.key === 'reason')).toBe(true);
  });
});
