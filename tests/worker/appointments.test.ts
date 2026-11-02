import { describe, it, expect } from 'vitest';
import { MAX_PER_DAY, addDays, clean, expand, fullDays, landingDates, occursOn, startMs, Invalid, type Appointment } from '../../apps/dashboard/src/lib/appointments';

const ap = (o: Partial<Appointment> = {}): Appointment => ({ id: 'x', title: 'T', date: '2026-01-31', startMin: 540, durationMin: 30, notes: null, priority: 'normal', pinned: false, reminderMin: 30, recur: { freq: 'none', interval: 1, until: null }, done: false, ...o });

describe('appointment repeats', () => {
  it('does not repeat by default and never lands before it starts', () => {
    expect(occursOn(ap(), '2026-01-31')).toBe(true); expect(occursOn(ap(), '2026-02-01')).toBe(false); expect(occursOn(ap({ recur: { freq: 'daily', interval: 1, until: null } }), '2026-01-30')).toBe(false);
  });
  it('daily and weekly with an interval', () => {
    const d = ap({ date: '2026-11-02', recur: { freq: 'daily', interval: 3, until: null } });
    expect(['2026-11-05', '2026-11-08'].every((x) => occursOn(d, x))).toBe(true); expect(occursOn(d, '2026-11-04')).toBe(false);
    const w = ap({ date: '2026-11-02', recur: { freq: 'weekly', interval: 2, until: null } });
    expect(occursOn(w, '2026-11-16')).toBe(true); expect(occursOn(w, '2026-11-09')).toBe(false);
  });
  it('monthly on the 31st uses the last day of shorter months; yearly handles 29 Feb', () => {
    const m = ap({ date: '2026-01-31', recur: { freq: 'monthly', interval: 1, until: null } });
    expect(occursOn(m, '2026-02-28')).toBe(true); expect(occursOn(m, '2026-04-30')).toBe(true); expect(occursOn(m, '2026-03-31')).toBe(true); expect(occursOn(m, '2026-02-27')).toBe(false);
    const y = ap({ date: '2028-02-29', recur: { freq: 'yearly', interval: 1, until: null } });
    expect(occursOn(y, '2029-02-28')).toBe(true); expect(occursOn(y, '2032-02-29')).toBe(true); expect(occursOn(y, '2029-03-01')).toBe(false);
  });
  it('stops at its end date and works years ahead', () => {
    const r = ap({ date: '2026-11-02', recur: { freq: 'weekly', interval: 1, until: '2026-12-01' } });
    expect(occursOn(r, '2026-11-30')).toBe(true); expect(occursOn(r, '2026-12-07')).toBe(false);
    expect(occursOn(ap({ date: '2026-11-02', recur: { freq: 'yearly', interval: 1, until: null } }), '2041-11-02')).toBe(true);
  });
  it('expands a range sorted by time and finds the busiest priority', () => {
    const list = [ap({ id: 'a', date: '2026-11-02', startMin: 600 }), ap({ id: 'b', date: '2026-11-02', startMin: 480, priority: 'high' })];
    const m = expand(list, '2026-11-01', '2026-11-03');
    expect(m.get('2026-11-02')!.map((o) => o.id)).toEqual(['b', 'a']); expect(m.has('2026-11-01')).toBe(false);
  });
});

describe('fifteen a day', () => {
  it('flags full days, counting repeats, and lists where a repeat would land', () => {
    const many = Array.from({ length: MAX_PER_DAY }, (_, i) => ap({ id: `e${i}`, date: '2026-11-02' }));
    expect(fullDays(many, ['2026-11-02', '2026-11-03'])).toEqual(['2026-11-02']);
    const daily = ap({ date: '2026-11-02', recur: { freq: 'daily', interval: 1, until: addDays('2026-11-02', 3) } });
    expect(landingDates(daily)).toHaveLength(4);
    expect(fullDays([...many.slice(0, 14), daily], ['2026-11-02'])).toEqual(['2026-11-02']);
  });
});

describe('checking what the form sends', () => {
  const good = { title: ' Meet accountant ', date: '2027-03-01', startMin: 600, durationMin: 45, notes: ' bring files ', priority: 'high', pinned: true, reminderMin: 30, recur: { freq: 'monthly', interval: 1, until: '2028-03-01' } };
  it('normalises a good draft', () => expect(clean(good)).toMatchObject({ title: 'Meet accountant', notes: 'bring files', priority: 'high', pinned: true, reminderMin: 30 }));
  it('defaults the reminder to none unless one is chosen, and allows dates years away or long ago', () => {
    expect(clean({ ...good, reminderMin: null }).reminderMin).toBeNull();
    expect(clean({ ...good, date: '2099-12-31', recur: undefined }).date).toBe('2099-12-31'); expect(clean({ ...good, date: '1995-06-01', recur: undefined }).date).toBe('1995-06-01');
  });
  it('rejects bad input with a sentence', () => {
    for (const bad of [{ title: '' }, { date: '2026-02-30' }, { date: '2101-01-01' }, { startMin: 1500 }, { durationMin: 1 }, { notes: 'x'.repeat(1001) }, { reminderMin: -5 }, { recur: { freq: 'daily', interval: 0, until: null } }, { recur: { freq: 'daily', interval: 1, until: '2020-01-01' } }])
      expect(() => clean({ ...good, ...bad })).toThrow(Invalid);
  });
  it('turns a business-local time into the right instant', () => expect(new Date(startMs('2026-11-07', 960, 60)).toISOString()).toBe('2026-11-07T15:00:00.000Z'));
});
