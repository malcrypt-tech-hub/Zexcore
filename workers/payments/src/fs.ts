// Firestore over REST, authenticated as the service account (so it bypasses security rules by design).
import type { Deps, Env } from './env';
import { accessToken } from './google';

type FsValue = Record<string, unknown>;
export function toFs(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toFs(x)])) } };
}
export function fromFs(v: any): unknown {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}

export const fsRoot = (env: Env): string =>
  env.FIRESTORE_EMULATOR_HOST
    ? `http://${env.FIRESTORE_EMULATOR_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`
    : `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const fsName = (env: Env, path: string): string => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
const pathOfName = (name: string): string => name.split('/documents/')[1]!;

export interface FsDoc { path: string; id: string; data: Record<string, any>; updateTime: string }
const toDoc = (j: { name: string; fields?: Record<string, unknown>; updateTime: string }): FsDoc => ({
  path: pathOfName(j.name), id: pathOfName(j.name).split('/').pop()!,
  data: Object.fromEntries(Object.entries(j.fields ?? {}).map(([k, v]) => [k, fromFs(v)])), updateTime: j.updateTime,
});
const auth = async (env: Env, d: Deps): Promise<Record<string, string>> => ({ authorization: `Bearer ${await accessToken(env, d)}`, 'content-type': 'application/json' });

export async function fsGet(env: Env, d: Deps, path: string): Promise<FsDoc | null> {
  const r = await d.fetch(`${fsRoot(env)}/${path}`, { headers: await auth(env, d) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore get ${r.status}`);
  return toDoc((await r.json()) as never);
}

export interface FsWrite {
  path: string;
  fields?: Record<string, unknown>;
  mask?: string[];
  delete?: boolean;
  precondition?: { exists: boolean } | { updateTime: string };
  /** Fields Google's servers stamp with the commit time (REQUEST_TIME), so the value cannot come from any client or from this Worker's clock. */
  serverTime?: string[];
}
export class FsConflict extends Error {}
export async function fsCommit(env: Env, d: Deps, writes: FsWrite[]): Promise<void> {
  const r = await d.fetch(`${fsRoot(env)}:commit`, {
    method: 'POST', headers: await auth(env, d),
    body: JSON.stringify({
      writes: writes.map((w) => w.delete
        ? { delete: fsName(env, w.path), ...(w.precondition ? { currentDocument: w.precondition } : {}) }
        : {
          update: { name: fsName(env, w.path), fields: Object.fromEntries(Object.entries(w.fields ?? {}).map(([k, v]) => [k, toFs(v)])) },
          ...(w.mask ? { updateMask: { fieldPaths: w.mask } } : {}),
          ...(w.serverTime?.length ? { updateTransforms: w.serverTime.map((f) => ({ fieldPath: f, setToServerValue: 'REQUEST_TIME' })) } : {}),
          ...(w.precondition ? { currentDocument: w.precondition } : {}),
        }),
    }),
  });
  if (r.status === 409 || r.status === 412 || r.status === 404 && writes.some((w) => w.precondition)) throw new FsConflict(`firestore commit ${r.status}`);
  if (!r.ok) throw new Error(`firestore commit ${r.status}`);
}

export interface FsFilter { field: string; op: 'EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL'; value: unknown }
export interface FsQuery { parent?: string; collection: string; where?: FsFilter[]; orderBy?: { field: string; desc?: boolean }[]; limit?: number; startAfterId?: string }

/** Query a collection under `parent` (a document path such as workspaces/abc, or empty for the root). */
export async function fsQuery(env: Env, d: Deps, q: FsQuery): Promise<FsDoc[]> {
  const filters = (q.where ?? []).map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: toFs(f.value) } }));
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: q.collection }],
    ...(filters.length ? { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } } } : {}),
    ...(q.orderBy?.length ? { orderBy: q.orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.desc ? 'DESCENDING' : 'ASCENDING' })) } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
    ...(q.startAfterId ? { startAt: { values: [{ referenceValue: fsName(env, `${q.parent ? q.parent + '/' : ''}${q.collection}/${q.startAfterId}`) }], before: false } } : {}),
  };
  const r = await d.fetch(`${fsRoot(env)}${q.parent ? `/${q.parent}` : ''}:runQuery`, { method: 'POST', headers: await auth(env, d), body: JSON.stringify({ structuredQuery }) });
  if (!r.ok) throw new Error(`firestore query ${r.status}`);
  return ((await r.json()) as { document?: { name: string; fields?: Record<string, unknown>; updateTime: string } }[]).filter((x) => x.document).map((x) => toDoc(x.document!));
}
