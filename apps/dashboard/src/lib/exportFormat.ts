/** Pure helpers for turning records into CSV / JSON files. No Firebase here so they can be unit tested. */

export type Row = Record<string, unknown>;

/** Timestamps and dates become ISO strings; everything else is left as it is. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const t = v as { toDate?: () => Date };
    if (typeof t.toDate === 'function') return t.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(plain);
    return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

/** A spreadsheet runs any cell that starts with = + - @ as a formula, and customers type some of these fields. Neutralise them. */
export function safeCell(s: string): string {
  if (/^\+[0-9]{8,15}$/.test(s)) return s;   // an international phone number is not a formula
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvCell(v: unknown): string {
  const p = plain(v);
  let s = p === null || p === undefined ? '' : typeof p === 'object' ? JSON.stringify(p) : String(p);
  s = safeCell(s);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Columns are the id first, then every field seen in any row, in first-seen order. */
export function toCsv(rows: Row[], preferred: string[] = []): string {
  const cols: string[] = [];
  for (const k of [...preferred, ...rows.flatMap((r) => Object.keys(r))]) if (!cols.includes(k)) cols.push(k);
  const keep = cols.filter((k) => rows.some((r) => k in r) || preferred.includes(k));
  const lines = [keep.map(csvCell).join(',')];
  for (const r of rows) lines.push(keep.map((k) => csvCell(r[k])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';   // BOM so Excel reads UTF-8 names correctly
}

export const toJson = (data: unknown): string => JSON.stringify(plain(data), null, 2);
