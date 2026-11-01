import { addDoc, getDocs, getDoc, updateDoc, query, orderBy, limit as qLimit, serverTimestamp, type QueryDocumentSnapshot } from 'firebase/firestore';
import { ApiError, audit, claimSlot, iso, loadCtx, requireAdmin, requireEditor, wsCol, wsDoc } from './core';
import { emit } from './rules';

const str = (v: unknown, max: number): string | null => { const s = String(v ?? '').trim().slice(0, max); return s || null; };

// ───────────── pipeline stages ─────────────
export async function listStages(): Promise<{ stages: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'stages'), orderBy('position')));
  return { stages: s.docs.map((d) => ({ id: d.id, name: d.data().name, position: d.data().position })) };
}
export async function createStage(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireAdmin(c);
  const name = str(b.name, 80);
  if (!name) throw new ApiError(400, 'Give the stage a name.');
  const position = Number.isInteger(Number(b.position)) ? Number(b.position) : 99;
  const ref = await addDoc(wsCol(c, 'stages'), { name, position, isDefault: b.isDefault === true, createdAt: serverTimestamp() });
  return { id: ref.id };
}

// ───────────── contacts ─────────────
const contact = (d: QueryDocumentSnapshot) => ({
  id: d.id, type: d.data().type ?? 'person', first_name: d.data().firstName ?? null, last_name: d.data().lastName ?? null, company: d.data().company ?? null,
  email: d.data().email ?? null, phone: d.data().phone ?? null, created_at: iso(d.data().createdAt) ?? new Date().toISOString(),
});

export async function listContacts(params: URLSearchParams): Promise<{ contacts: unknown[] }> {
  const c = await loadCtx();
  const snap = await getDocs(query(wsCol(c, 'contacts'), orderBy('seq', 'desc'), qLimit(Math.min(500, Number(params.get('limit')) || 200))));
  let rows = snap.docs.map(contact);
  const term = (params.get('search') ?? '').trim().toLowerCase();
  if (term) rows = rows.filter((r) => [r.first_name, r.last_name, r.company, r.email, r.phone].some((v) => String(v ?? '').toLowerCase().includes(term)));
  return { contacts: rows };
}
export async function createContact(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx();
  const firstName = str(b.firstName, 128), lastName = str(b.lastName, 128), company = str(b.company, 255);
  if (!firstName && !lastName && !company) throw new ApiError(400, 'Enter a name or a company.');
  const email = str(b.email, 200);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
  const id = await claimSlot(c, 'contacts', 'c', 'crmContacts', { type: b.type === 'company' ? 'company' : 'person', firstName, lastName, company, email, phone: str(b.phone, 32) });
  void audit(c, 'contact.create', 'contact', id);
  return { id };
}

// ───────────── leads ─────────────
export async function listLeads(params: URLSearchParams): Promise<{ leads: unknown[] }> {
  const c = await loadCtx();
  const [leads, contacts] = await Promise.all([
    getDocs(query(wsCol(c, 'leads'), orderBy('createdAt', 'desc'), qLimit(Math.min(500, Number(params.get('limit')) || 200)))),
    getDocs(wsCol(c, 'contacts')),
  ]);
  const cm = new Map(contacts.docs.map((d) => [d.id, d.data()]));
  const onlyOpen = params.get('closed') === 'false';
  return {
    leads: leads.docs.filter((d) => !onlyOpen || !d.data().closedAt).map((d) => {
      const x = d.data(), k = cm.get(x.contactId);
      return { id: d.id, title: x.title, value: x.value ?? null, currency: x.currency ?? 'USD', stage_id: x.stageId, first_name: k?.firstName ?? null, last_name: k?.lastName ?? null, company: k?.company ?? null, closed_at: iso(x.closedAt), close_reason: x.closeReason ?? null };
    }),
  };
}
export async function createLead(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx();
  const title = str(b.title, 255);
  if (!title) throw new ApiError(400, 'Give the lead a title.');
  const value = b.value === undefined || b.value === null ? null : Number(b.value);
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new ApiError(400, 'Enter a valid value.');
  const id = await claimSlot(c, 'leads', 'l', 'crmContacts', { title, contactId: String(b.contactId ?? ''), stageId: String(b.stageId ?? ''), value, currency: 'USD', closedAt: null, closeReason: null });
  void audit(c, 'lead.create', 'lead', id);
  emit('crm.lead.created', c.wid, id);
  return { id };
}
export async function moveLead(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx();
  await updateDoc(wsDoc(c, 'leads', id), { stageId: String(b.stageId ?? '') });
  return { ok: true };
}
export async function closeLead(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx();
  await updateDoc(wsDoc(c, 'leads', id), { closedAt: serverTimestamp(), closeReason: b.reason === 'won' ? 'won' : 'lost' });
  void audit(c, `lead.${b.reason === 'won' ? 'won' : 'lost'}`, 'lead', id);
  return { ok: true };
}

// ───────────── website pages ─────────────
const page = (d: QueryDocumentSnapshot) => ({
  id: d.id, slug: d.data().slug, title: d.data().title, description: d.data().description ?? null, status: d.data().published ? 'published' : 'draft',
  publishedAt: iso(d.data().publishedAt), createdAt: iso(d.data().createdAt) ?? new Date().toISOString(),
});
export async function listPages(): Promise<{ pages: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'pages'), orderBy('seq', 'desc')));
  return { pages: s.docs.map(page) };
}
export async function createPage(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireEditor(c);
  const title = str(b.title, 200), slug = str(b.slug, 120);
  if (!title || !slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, 'Give the page a title and an address (lowercase letters, numbers and dashes).');
  const existing = await getDocs(wsCol(c, 'pages'));
  if (existing.docs.some((d) => d.data().slug === slug)) throw new ApiError(409, 'You already have a page at that address.', 'conflict');
  const body = String((b.content as { body?: unknown } | undefined)?.body ?? '').slice(0, 50_000);
  const id = await claimSlot(c, 'pages', 'g', 'cmsPages', { title, slug, description: str(b.description, 300), content: { body }, published: false, publishedAt: null });
  void audit(c, 'page.create', 'page', id);
  return { id };
}
export async function publishPage(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireEditor(c);
  if (!(await getDoc(wsDoc(c, 'pages', id))).exists()) throw new ApiError(404, 'That page no longer exists.');
  await updateDoc(wsDoc(c, 'pages', id), { published: true, publishedAt: serverTimestamp() });
  void audit(c, 'page.publish', 'page', id);
  return { ok: true };
}
