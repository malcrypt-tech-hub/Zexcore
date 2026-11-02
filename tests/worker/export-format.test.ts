import { describe, it, expect } from 'vitest';
import { csvCell, plain, safeCell, toCsv, toJson } from '../../apps/dashboard/src/lib/exportFormat';

describe('data export formatting', () => {
  it('neutralises spreadsheet formulas typed by customers', () => {
    expect(safeCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    for (const s of ['+1', '-2', '@SUM(A1)']) expect(safeCell(s).startsWith("'")).toBe(true);
    expect(safeCell('Ada Obi')).toBe('Ada Obi');
    expect(safeCell('+2348031234567')).toBe('+2348031234567');
    expect(safeCell('+1+1')).toBe("'+1+1");
  });
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it('turns timestamps into ISO strings, also when nested', () => {
    const ts = { toDate: () => new Date('2026-11-02T10:00:00Z') };
    expect(plain({ at: ts, deep: { list: [ts] } })).toEqual({ at: '2026-11-02T10:00:00.000Z', deep: { list: ['2026-11-02T10:00:00.000Z'] } });
  });
  it('builds a CSV with id first and every field seen', () => {
    const csv = toCsv([{ id: 'b1', name: 'Ada', note: '=1+1' }, { id: 'b2', name: 'Tunde', phone: '+2348031234567' }], ['id']);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('id,name,note,phone');
    expect(lines[1]).toBe("b1,Ada,'=1+1,");
    expect(lines[2]).toBe('b2,Tunde,,+2348031234567');
  });
  it('JSON keeps structure', () => {
    expect(JSON.parse(toJson({ n: 1, when: { toDate: () => new Date(0) } }))).toEqual({ n: 1, when: '1970-01-01T00:00:00.000Z' });
  });
});
