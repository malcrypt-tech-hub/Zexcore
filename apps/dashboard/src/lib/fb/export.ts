/** Whole-workspace data export for owners and admins on plans that include it. Read straight from the database with the user's own permissions. */
import { documentId, getDocs, limit as qLimit, orderBy, query, startAfter, type QueryDocumentSnapshot } from 'firebase/firestore';
import { ApiError, loadCtx, requireAdmin, wsCol, audit } from './core';
import { hasFeatureAccess } from './plan';
import { plain, toCsv, toJson, type Row } from '../exportFormat';

export const DATASETS = {
  bookings: { label: 'Bookings', collection: 'bookings' },
  customers: { label: 'Customers', collection: 'customers' },
  services: { label: 'Services', collection: 'services' },
  staff: { label: 'Bookable staff', collection: 'staff' },
  payments: { label: 'Payments', collection: 'payments' },
  audit: { label: 'Audit log', collection: 'auditChain' },
} as const;
export type DatasetKey = keyof typeof DATASETS;

const PAGE = 400, HARD_CAP = 100_000;

async function readAll(c: Awaited<ReturnType<typeof loadCtx>>, key: DatasetKey): Promise<Row[]> {
  const out: Row[] = [];
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    const q = query(wsCol(c, DATASETS[key].collection), orderBy(documentId()), ...(last ? [startAfter(last)] : []), qLimit(PAGE));
    const s = await getDocs(q);
    for (const d of s.docs) out.push({ id: d.id, ...(plain(d.data()) as Row) });
    if (s.size < PAGE) break;
    last = s.docs[s.docs.length - 1];
    if (out.length >= HARD_CAP) throw new ApiError(413, 'This workspace is too large to export in one go. Contact support for a full data handover.', 'too_large');
  }
  return out;
}

export interface Exported { filename: string; mime: string; text: string; rows: number }

export async function exportDataset(key: DatasetKey, format: 'csv' | 'json'): Promise<Exported> {
  const c = await loadCtx(); requireAdmin(c);
  if (!hasFeatureAccess(c.tier, 'export')) throw new ApiError(402, 'Data export is part of the Enterprise and Dedicated plans.', 'plan_feature');
  const rows = await readAll(c, key);
  const day = new Date().toISOString().slice(0, 10);
  void audit(c, 'data.export', 'export', key);
  const name = `zexcore-${c.slug}-${key}-${day}`;
  return format === 'csv'
    ? { filename: `${name}.csv`, mime: 'text/csv;charset=utf-8', text: toCsv(rows, ['id']), rows: rows.length }
    : { filename: `${name}.json`, mime: 'application/json', text: toJson({ workspace: c.slug, dataset: key, exportedAt: new Date().toISOString(), count: rows.length, records: rows }), rows: rows.length };
}

/** Everything in one JSON file: the handover file for leaving ZexCore or giving a copy to an auditor. */
export async function exportEverything(): Promise<Exported> {
  const c = await loadCtx(); requireAdmin(c);
  if (!hasFeatureAccess(c.tier, 'export')) throw new ApiError(402, 'Data export is part of the Enterprise and Dedicated plans.', 'plan_feature');
  const data: Record<string, Row[]> = {};
  for (const k of Object.keys(DATASETS) as DatasetKey[]) data[k] = await readAll(c, k);
  void audit(c, 'data.export', 'export', 'all');
  const day = new Date().toISOString().slice(0, 10);
  return { filename: `zexcore-${c.slug}-all-${day}.json`, mime: 'application/json', rows: Object.values(data).reduce((n, r) => n + r.length, 0),
    text: toJson({ workspace: { slug: c.slug, name: c.wsName }, exportedAt: new Date().toISOString(), ...data }) };
}
