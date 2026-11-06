import { paymentsUrl } from './firebase';
import { doc, getDoc, getDocs, query, orderBy, collection, setDoc, serverTimestamp, type QueryDocumentSnapshot } from 'firebase/firestore';
import { fb } from './firebase';
import { ApiError, DEFAULT_SETTINGS, toApiError } from './core';
import { availability, createBooking, refOf } from './bookings';
import type { SlotSettings } from './slots';
import { getCachedNgnRate } from '../fx';
import { DEMO_SLUG, demoBook, demoProfile, demoSlots } from './demo';

interface PublicPage {
  wid: string; name: string; phone: string | null; address: string | null; openMinutes: number; closeMinutes: number; slotMinutes: number;
  daysOpen: number[]; leadMinutes: number; maxDaysAhead: number; bookingCap: number; bookingEnabled: boolean; depositEnabled: boolean; depositMinor: number; exchangeRate: number; rateAuto: boolean; riskDeposit: boolean; waitlist: boolean;
  currency?: string;
}
const cache = new Map<string, { at: number; page: PublicPage }>();

async function page(slug: string): Promise<PublicPage> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < 20_000) return hit.page;
  let snap;
  try { snap = await getDoc(doc(fb().db, 'slugs', slug)); } catch (e) { throw toApiError(e); }
  const d = snap.data();
  if (!snap.exists() || !d || d.bookingEnabled === false) throw new ApiError(404, 'Business not found', 'not_found');
  const closed: number[] = Array.isArray(d.closedWeekdays) ? d.closedWeekdays : [0];
  const p: PublicPage = {
    wid: d.wid, name: d.name, phone: d.phone ?? null, address: d.address ?? null,
    openMinutes: d.openMinutes ?? DEFAULT_SETTINGS.openMinutes, closeMinutes: d.closeMinutes ?? DEFAULT_SETTINGS.closeMinutes, slotMinutes: d.slotMinutes ?? 30,
    daysOpen: [0, 1, 2, 3, 4, 5, 6].filter((x) => !closed.includes(x)), leadMinutes: d.leadMinutes ?? 60, maxDaysAhead: Math.min(d.maxDaysAhead ?? 60, 120),
    bookingCap: Math.max(1, Math.min(Number(d.bookingCap) || 30, 999_999)), bookingEnabled: true,
    exchangeRate: Number(d.exchangeRate) > 0 ? Number(d.exchangeRate) : getCachedNgnRate(), rateAuto: !(Number(d.exchangeRate) > 0),
    riskDeposit: d.riskDeposit === true, waitlist: d.waitlist === true,
    depositEnabled: d.depositEnabled === true && Number(d.depositMinor) > 0, depositMinor: d.depositEnabled === true ? Math.max(0, Number(d.depositMinor) || 0) : 0,
    currency: (d.currency as string) || 'USD',
  };
  cache.set(slug, { at: Date.now(), page: p });
  return p;
}
export const slotSettings = (p: PublicPage): SlotSettings => ({ openMinutes: p.openMinutes, closeMinutes: p.closeMinutes, slotMinutes: p.slotMinutes, daysOpen: p.daysOpen, utcOffsetMinutes: 60, leadMinutes: p.leadMinutes, maxDaysAhead: p.maxDaysAhead });

async function catalog(wid: string) {
  const { db } = fb();
  const [s, t] = await Promise.all([
    getDocs(query(collection(db, 'workspaces', wid, 'services'), orderBy('seq'))),
    getDocs(query(collection(db, 'workspaces', wid, 'staff'), orderBy('seq'))),
  ]);
  return {
    services: s.docs.filter((d) => d.data().active !== false).map((d) => ({ id: d.id, name: d.data().name as string, description: (d.data().description ?? null) as string | null, durationMin: d.data().durationMin as number, priceMinor: (d.data().priceMinor ?? 0) as number, bookingMode: d.data().bookingMode === 'enquiry' ? 'enquiry' : 'appointment', intakeFields: Array.isArray(d.data().intakeFields) ? d.data().intakeFields : [], consultationEnabled: d.data().consultationEnabled === true })),
    products: (await getDocs(query(collection(db, 'workspaces', wid, 'products'), orderBy('seq'))).catch(() => ({ docs: [] as QueryDocumentSnapshot[] }))).docs.filter((d) => d.data().active !== false).map((d) => ({ id: d.id, name: d.data().name as string, description: (d.data().description ?? null) as string | null, priceMinor: Number(d.data().priceMinor) || 0, inStock: d.data().inStock !== false, imageUrl: (typeof d.data().imageUrl === 'string' && d.data().imageUrl.startsWith('https://res.cloudinary.com/') ? d.data().imageUrl : null) as string | null })),
    staff: t.docs.filter((d) => d.data().active !== false).map((d) => ({ id: d.id, name: d.data().name as string, title: (d.data().title ?? null) as string | null })),
  };
}

export async function profile(slug: string): Promise<unknown> {
  if (slug === DEMO_SLUG) return demoProfile();
  const p = await page(slug);
  let cat; try { cat = await catalog(p.wid); } catch (e) { throw toApiError(e); }
  return {
    business: { slug, name: p.name, type: 'business', phone: p.phone, address: p.address, currency: p.currency || 'USD' }, currency: p.currency || 'USD', rateAuto: p.rateAuto, exchangeRate: p.exchangeRate, deposit: { enabled: p.depositEnabled, amountMinor: p.depositMinor }, waitlist: p.waitlist,
    hours: { openMinutes: p.openMinutes, closeMinutes: p.closeMinutes, daysOpen: p.daysOpen, utcOffsetMinutes: 60, maxDaysAhead: p.maxDaysAhead },
    paystackPublicKey: null, services: cat.services, staff: cat.staff, products: cat.products,
  };
}

export async function slots(slug: string, params: URLSearchParams): Promise<{ slots: { startsAt: string; available: boolean }[] }> {
  if (slug === DEMO_SLUG) return demoSlots(params);
  const p = await page(slug);
  const date = params.get('date') ?? '', serviceId = params.get('serviceId') ?? '', staffId = params.get('staffId') ?? '';
  let cat; try { cat = await catalog(p.wid); } catch (e) { throw toApiError(e); }
  const service = cat.services.find((s) => s.id === serviceId);
  if (!service) throw new ApiError(400, 'Choose a service.');
  const ids = staffId ? cat.staff.filter((s) => s.id === staffId).map((s) => s.id) : cat.staff.map((s) => s.id);
  try { return { slots: await availability(p.wid, slotSettings(p), service, ids, date) }; } catch (e) { throw toApiError(e); }
}

export async function book(slug: string, b: Record<string, unknown>): Promise<unknown> {
  if (slug === DEMO_SLUG) return demoBook(b);
  const p = await page(slug);
  const cat = await catalog(p.wid).catch((e) => { throw toApiError(e); });
  const service = cat.services.find((s) => s.id === b.serviceId);
  if (!service) throw new ApiError(400, 'Choose a service.');
  const candidates = b.staffId ? cat.staff.filter((s) => s.id === b.staffId).map((s) => s.id) : cat.staff.map((s) => s.id);
  const cleanAnswers = (() => {
    const raw = b.intakeAnswers && typeof b.intakeAnswers === 'object' ? b.intakeAnswers as Record<string, unknown> : {};
    const fields = Array.isArray(service.intakeFields) ? service.intakeFields : [];
    const clean: Record<string,string> = {};
    for (const f of fields) {
      const value = String(raw[f.key] ?? '').trim().slice(0, 2000);
      if (f.required && !value) throw new ApiError(400, `Please complete: ${f.label}`);
      if (value && f.type === 'select' && !f.options?.includes(value)) throw new ApiError(400, `Choose a valid option for ${f.label}.`);
      if (value && f.type === 'url' && !/^https?:\/\//i.test(value)) throw new ApiError(400, `Enter a valid URL for ${f.label}.`);
      if (value && f.type === 'number' && !Number.isFinite(Number(value))) throw new ApiError(400, `Enter a number for ${f.label}.`);
      if (value) clean[f.key] = value;
    }
    return clean;
  })();
  if (service.bookingMode === 'enquiry') {
    const name = String(b.customerName ?? '').trim();
    const phone = String(b.customerPhone ?? '').trim();
    if (name.length < 2 || name.length > 120) throw new ApiError(400, 'Please enter your full name.');
    if (!/^\+?[0-9 ()-]{8,20}$/.test(phone)) throw new ApiError(400, 'Enter a valid phone number.');
    const ref = doc(collection(fb().db, 'workspaces', p.wid, 'enquiries'));
    await setDoc(ref, {
      serviceId: service.id, serviceName: service.name, customerName: name, customerPhone: phone,
      customerEmail: b.customerEmail ? String(b.customerEmail).trim().slice(0, 160) : null,
      notes: b.notes ? String(b.notes).trim().slice(0, 1000) : null, intakeAnswers: cleanAnswers,
      consultationRequested: service.consultationEnabled === true && b.consultationRequested === true,
      status: 'new', source: 'public', createdAt: serverTimestamp(),
    }).catch((e) => { throw toApiError(e); });
    return { enquiry: { ref: ref.id, serviceName: service.name, status: 'new' }, payment: null };
  }
  const made = await createBooking({
    wid: p.wid, source: 'public', service, staffCandidates: candidates, customerName: String(b.customerName ?? ''), customerPhone: String(b.customerPhone ?? ''),
    customerEmail: b.customerEmail ? String(b.customerEmail).slice(0, 160) : null,
    notes: b.notes ? String(b.notes).slice(0, 500) : null,
    intakeAnswers: cleanAnswers,
    consultationRequested: service.consultationEnabled === true && b.consultationRequested === true,
    startMs: new Date(String(b.startsAt)).getTime(),
    status: 'pending', maxTries: 24,
    // The public page cannot read bookings, so it picks a random free-looking number below the plan's monthly cap.
    nextN: () => Promise.resolve(Math.floor(Math.random() * p.bookingCap)),
  });
  // Tell the Worker so the owner is notified and approved automations run. Best effort: the booking already exists.
  if (paymentsUrl()) void fetch(`${paymentsUrl()}/api/public/booked`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, bookingId: made.id }) }).catch(() => undefined);
  const booking = { ref: refOf(made.id), status: 'pending', startsAt: made.startsAt, serviceName: service.name };
  // With risk protection on, the Worker decides after scoring this booking whether a deposit is due; it answers 409 when not.
  if (!(p.depositEnabled || p.riskDeposit) || !paymentsUrl()) return { booking, payment: null };
  // The Worker creates the Paystack checkout (amount is decided server-side from the business's own settings).
  try {
    const r = await fetch(`${paymentsUrl()}/api/public/deposit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, bookingId: made.id, email: b.customerEmail ?? '' }) });
    const j = (await r.json().catch(() => ({}))) as { authorizationUrl?: string; reference?: string; amountMinor?: number };
    if (r.ok && j.authorizationUrl) return { booking, payment: { reference: j.reference, amountMinor: j.amountMinor, authorizationUrl: j.authorizationUrl } };
  } catch { /* the booking still stands; the business can send a payment link */ }
  return { booking, payment: null };
}

export async function joinWaitlist(slug: string, b: Record<string, unknown>): Promise<unknown> {
  const p = await page(slug);
  if (!p.waitlist) throw new ApiError(409, 'This business does not have a waitlist.', 'waitlist_off');
  const base = paymentsUrl();
  if (!base) throw new ApiError(503, 'The waitlist is not available right now.', 'unavailable');
  let r: Response;
  try { r = await fetch(`${base}/api/public/waitlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...b, slug }) }); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your connection.', 'network'); }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'Could not join the waitlist.');
  return j;
}

export async function placeOrder(slug: string, b: Record<string, unknown>): Promise<unknown> {
  await page(slug);
  const base = paymentsUrl();
  if (!base) throw new ApiError(503, 'Ordering is not available right now.', 'unavailable');
  let r: Response;
  try { r = await fetch(`${base}/api/public/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...b, slug }) }); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your connection.', 'network'); }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'Could not send your order.');
  return j;
}

export async function payment(slug: string, ref: string): Promise<unknown> {
  const base = paymentsUrl();
  if (!base) throw new ApiError(503, 'Payments are not switched on yet.', 'unavailable');
  let r: Response;
  try { r = await fetch(`${base}/api/public/deposit-status?${new URLSearchParams({ slug, reference: ref })}`); }
  catch { throw new ApiError(0, 'Cannot reach the payment service.', 'network'); }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'Payment not found', r.status === 404 ? 'not_found' : undefined);
  return j;
}
