import { addDoc, doc, getDoc, getDocs, limit as qLimit, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore';
import { fb } from './firebase';
import { ApiError, audit, iso, loadCtx, requireAdmin, requireFeature, wsCol, wsDoc, type Ctx } from './core';
import { normalizePhone } from './slots';

const BASIS = new Set(['consent', 'contract', 'legal_obligation', 'vital_interests', 'legitimate_interests']);
export const RETENTION_ENTITIES = ['messages', 'bookings'] as const;

// ───────────── subject lookup ─────────────
interface Subject { kind: 'phone' | 'email'; value: string }
function subjectOf(raw: unknown): Subject {
  const v = String(raw ?? '').trim();
  if (v.includes('@')) { if (!/^\S+@\S+\.\S+$/.test(v)) throw new ApiError(400, 'Enter a valid email address.'); return { kind: 'email', value: v.toLowerCase() }; }
  const p = normalizePhone(v);
  if (!p) throw new ApiError(400, 'Enter the person’s phone number (08012345678) or email address.');
  return { kind: 'phone', value: p };
}
const subjectKey = (s: Subject): string => s.value;

async function find(c: Ctx, col: string, field: string, value: string): Promise<QueryDocumentSnapshot[]> {
  return (await getDocs(query(wsCol(c, col), where(field, '==', value), qLimit(500)))).docs;
}

// ───────────── retention ─────────────
export async function listRetention(): Promise<unknown> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const s = await getDocs(wsCol(c, 'retention'));
  return { policies: s.docs.map((d) => ({ id: d.id, entity: d.id, retention_days: d.data().retentionDays, action: 'hard_delete', enabled: d.data().enabled !== false, last_run_at: iso(d.data().lastRunAt) })) };
}
export async function setRetention(b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const entity = String(b.entity ?? '');
  if (!(RETENTION_ENTITIES as readonly string[]).includes(entity)) throw new ApiError(400, 'Choose what to keep for a limited time.');
  const days = Number(b.retentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiError(400, 'Enter between 1 and 3650 days.');
  await setDoc(wsDoc(c, 'retention', entity), { retentionDays: days, enabled: b.enabled !== false, lastRunAt: null }, { merge: true });
  void audit(c, 'compliance.retention_set', 'retention', entity);
  return { ok: true };
}
async function deleteAll(docs: { ref: import('firebase/firestore').DocumentReference }[]): Promise<void> {
  const { db } = fb();
  for (let i = 0; i < docs.length; i += 400) { const b = writeBatch(db); docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
}
export async function runRetention(): Promise<{ summary: { entity: string; purged: number }[] }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const { db } = fb();
  const pol = await getDocs(wsCol(c, 'retention'));
  const summary: { entity: string; purged: number }[] = [];
  for (const p of pol.docs) {
    if (p.data().enabled === false) continue;
    const cutoff = Timestamp.fromMillis(Date.now() - Number(p.data().retentionDays) * 86_400_000);
    let purged = 0;
    if (p.id === 'messages') {
      const old = (await getDocs(query(wsCol(c, 'messages'), where('createdAt', '<', cutoff), qLimit(2000)))).docs;
      await deleteAll(old); purged = old.length;
    } else if (p.id === 'bookings') {
      const old = (await getDocs(query(wsCol(c, 'bookings'), where('startsAt', '<', cutoff), qLimit(1000)))).docs;
      const locks = old.flatMap((d) => (Array.isArray(d.data().cells) ? (d.data().cells as number[]) : []).map((n) => ({ ref: doc(db, 'workspaces', c.wid, 'locks', `${d.data().staffId}_${n}`) })));
      await deleteAll(locks); await deleteAll(old); purged = old.length;
    }
    await updateDoc(p.ref, { lastRunAt: serverTimestamp() });
    summary.push({ entity: p.id, purged });
  }
  void audit(c, 'compliance.retention_run', 'retention', summary.map((s) => `${s.entity}:${s.purged}`).join(','));
  return { summary };
}

// ───────────── erasure ─────────────
export async function listErasures(): Promise<unknown> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const s = await getDocs(query(wsCol(c, 'erasures'), orderBy('requestedAt', 'desc'), qLimit(100)));
  return { requests: s.docs.map((d) => ({ id: d.id, subject_id: d.data().subjectId, status: d.data().status, requested_at: iso(d.data().requestedAt) ?? new Date().toISOString(), completed_at: iso(d.data().completedAt) })) };
}
export async function createErasure(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const s = subjectOf(b.subjectId);
  const ref = await addDoc(wsCol(c, 'erasures'), { subjectId: subjectKey(s), kind: s.kind, reason: String(b.reason ?? '').slice(0, 255), status: 'pending', requestedAt: serverTimestamp(), requestedBy: c.uid, completedAt: null, summary: null });
  void audit(c, 'compliance.erasure_requested', 'erasure', ref.id);
  return { id: ref.id };
}
/** Removes or anonymises everything held about one phone number / email address in this workspace. */
export async function executeErasure(id: string): Promise<{ ok: true; summary: Record<string, number> }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const { db } = fb();
  const req = await getDoc(wsDoc(c, 'erasures', id));
  if (!req.exists()) throw new ApiError(404, 'That request no longer exists.');
  if (req.data().status === 'completed') throw new ApiError(409, 'This request has already been carried out.');
  const s = subjectOf(req.data().subjectId);
  const bookingField = s.kind === 'phone' ? 'customerPhone' : 'customerEmail';
  const bookings = await find(c, 'bookings', bookingField, s.value);
  const contacts = await find(c, 'contacts', s.kind === 'phone' ? 'phone' : 'email', s.value);
  const phone = s.kind === 'phone' ? s.value : bookings[0]?.data().customerPhone as string | undefined;
  const messages = phone ? await find(c, 'messages', 'phone', phone) : [];
  const consents = await find(c, 'consents', 'subjectId', s.value);

  // Bookings keep their time and money (the business may need them for its books) but lose every personal detail.
  for (let i = 0; i < bookings.length; i += 400) {
    const batch = writeBatch(db);
    bookings.slice(i, i + 400).forEach((d) => batch.update(d.ref, { customerName: 'Erased customer', customerPhone: '+000000000000', customerEmail: null, notes: null }));
    await batch.commit();
  }
  await deleteAll(contacts); await deleteAll(messages); await deleteAll(consents);
  if (phone) await deleteAll([{ ref: wsDoc(c, 'convState', phone) }]);

  const summary = { bookings: bookings.length, contacts: contacts.length, messages: messages.length, consents: consents.length };
  await updateDoc(req.ref, { status: 'completed', completedAt: serverTimestamp(), summary });
  void audit(c, 'compliance.erasure_done', 'erasure', id);
  return { ok: true, summary };
}

// ───────────── consent ─────────────
const consentDto = (d: QueryDocumentSnapshot) => ({ id: d.id, subject_id: d.data().subjectId, purpose: d.data().purpose, legal_basis: d.data().legalBasis, granted_at: iso(d.data().grantedAt) ?? new Date().toISOString(), revoked_at: iso(d.data().revokedAt) });
export async function listConsent(subject: string): Promise<{ consents: unknown[] }> {
  const c = await loadCtx();
  const s = subjectOf(decodeURIComponent(subject));
  const rows = (await find(c, 'consents', 'subjectId', s.value)).sort((a, b) => String(iso(b.data().grantedAt)).localeCompare(String(iso(a.data().grantedAt))));
  return { consents: rows.map(consentDto) };
}
export async function recordConsent(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx();
  const s = subjectOf(b.subjectId);
  const purpose = String(b.purpose ?? '').trim();
  if (purpose.length < 2 || purpose.length > 128) throw new ApiError(400, 'Describe what the person agreed to.');
  const basis = String(b.legalBasis ?? 'consent');
  if (!BASIS.has(basis)) throw new ApiError(400, 'Choose a legal basis.');
  const ref = await addDoc(wsCol(c, 'consents'), { subjectId: s.value, purpose, legalBasis: basis, grantedAt: serverTimestamp(), revokedAt: null, by: c.uid });
  void audit(c, 'compliance.consent_recorded', 'consent', ref.id);
  return { id: ref.id };
}
export async function revokeConsent(b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx();
  const s = subjectOf(b.subjectId);
  const rows = (await find(c, 'consents', 'subjectId', s.value)).filter((d) => d.data().purpose === b.purpose && !d.data().revokedAt);
  if (!rows.length) throw new ApiError(404, 'No active consent for that purpose.');
  await Promise.all(rows.map((d) => updateDoc(d.ref, { revokedAt: serverTimestamp() })));
  void audit(c, 'compliance.consent_revoked', 'consent', s.value);
  return { ok: true };
}

// ───────────── activity log (data-protection actions from the tamper-evident trail) ─────────────
export async function accessLogs(params: URLSearchParams): Promise<{ accessLogs: unknown[] }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'compliance');
  const s = await getDocs(query(wsCol(c, 'auditChain'), orderBy('seq', 'desc'), qLimit(500)));
  const rows = s.docs.map((d) => d.data() as DocumentData).filter((x) => String(x.action).startsWith('compliance.'));
  return { accessLogs: rows.slice(0, Math.min(200, Number(params.get('limit')) || 100)).map((x) => ({ id: String(x.seq), subject_id: x.target ?? null, entity: String(x.action).replace('compliance.', '').replace(/_/g, ' '), accessed_at: iso(x.at) ?? new Date().toISOString(), actor_id: x.actor })) };
}
