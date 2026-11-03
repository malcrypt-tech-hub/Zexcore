import { doc, getDoc, updateDoc, getDocs, query, where, orderBy, limit as qLimit, documentId, serverTimestamp, Timestamp, writeBatch, type QueryDocumentSnapshot } from 'firebase/firestore';
import { fb } from './firebase';
import { ApiError, audit, iso, limitError, loadCtx, monthPrefix, requireAdmin, toApiError, wsCol, wsDoc, type Ctx } from './core';
import { listServices, listStaff, type ServiceDto, type StaffDto } from './catalog';
import { CELL_MS, cellsFor, generateSlotStarts, localDateOf, localMidnightUtc, normalizePhone, weekdayOf, type SlotSettings } from './slots';
import { hasFeatureAccess, slotLimit } from './plan';
import { worker } from './worker';
import { emit } from './rules';

export interface BookingDto {
  id: string; ref: string; status: string; serviceId: string; serviceName: string; durationMin: number; staffId: string | null; staffName: string | null;
  customerName: string; customerPhone: string; customerEmail: string | null; startsAt: string; endsAt: string; currency: string; priceMinor: number;
  depositMinor: number; depositStatus: 'none' | 'unpaid' | 'paid' | 'refunded'; paymentReference: string | null; notes: string | null; source: string; createdAt: string | null;
  risk: { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] } | null;
}

export const refOf = (id: string): string => `ZX-${id.replace('_', '-')}`;

const depOf = (c: Ctx): Dep => ({ enabled: c.settings.depositEnabled, minor: c.settings.depositMinor });
interface Dep { enabled: boolean; minor: number }
/** A public booking made while deposits are on is "unpaid" until the Worker (or staff) records the payment. */
function deposit(x: Record<string, any>, price: number, dep: Dep): { depositMinor: number; depositStatus: 'none' | 'unpaid' | 'paid' | 'refunded'; paymentReference: string | null } {
  if (x.depositStatus === 'refunded') return { depositMinor: Number(x.depositMinor) || 0, depositStatus: 'refunded', paymentReference: x.paymentReference ?? null };
  if (x.depositStatus === 'paid') return { depositMinor: Number(x.depositMinor) || 0, depositStatus: 'paid', paymentReference: x.paymentReference ?? null };
  if (x.depositStatus === 'unpaid' && Number(x.depositMinor) > 0 && x.status !== 'cancelled') return { depositMinor: Number(x.depositMinor), depositStatus: 'unpaid', paymentReference: null };   // owed because of no-show risk
  const owed = x.source === 'public' && dep.enabled && dep.minor > 0 && x.status !== 'cancelled';
  return owed ? { depositMinor: price > 0 ? Math.min(dep.minor, price) : dep.minor, depositStatus: 'unpaid', paymentReference: null } : { depositMinor: 0, depositStatus: 'none', paymentReference: null };
}
function toDto(d: QueryDocumentSnapshot, svcs: Map<string, ServiceDto>, staff: Map<string, StaffDto>, dep: Dep): BookingDto {
  const x = d.data();
  const s = svcs.get(x.serviceId), p = staff.get(x.staffId);
  return {
    id: d.id, ref: refOf(d.id), status: x.status, serviceId: x.serviceId, serviceName: s?.name ?? 'Removed service', durationMin: s?.durationMin ?? Math.round((x.endsAt.toMillis() - x.startsAt.toMillis()) / 60000),
    staffId: x.staffId ?? null, staffName: p?.name ?? null, customerName: x.customerName, customerPhone: x.customerPhone, customerEmail: x.customerEmail ?? null,
    startsAt: iso(x.startsAt)!, endsAt: iso(x.endsAt)!, currency: 'USD', priceMinor: s?.priceMinor ?? 0, ...deposit(x, s?.priceMinor ?? 0, dep),
    notes: x.notes ?? null, source: x.source ?? 'staff', createdAt: iso(x.createdAt),
    risk: typeof x.riskScore === 'number' ? { score: x.riskScore, level: x.riskLevel, reasons: Array.isArray(x.riskReasons) ? x.riskReasons : [] } : null,
  };
}

async function maps(c: Ctx): Promise<{ svcs: Map<string, ServiceDto>; staff: Map<string, StaffDto> }> {
  const [s, t] = await Promise.all([listServices(c), listStaff(c)]);
  return { svcs: new Map(s.map((x) => [x.id, x])), staff: new Map(t.map((x) => [x.id, x])) };
}

// ───────────── availability (shared by the dashboard and the public page) ─────────────
export async function cellsFree(wid: string, staffId: string, cells: number[]): Promise<boolean> {
  const { db } = fb();
  const taken = await Promise.all(cells.map((n) => getDoc(doc(db, 'workspaces', wid, 'locks', `${staffId}_${n}`)).then((s) => s.exists())));
  return !taken.some(Boolean);
}

export async function availability(wid: string, s: SlotSettings, service: { durationMin: number }, staffIds: string[], date: string): Promise<{ startsAt: string; available: boolean }[]> {
  const starts = generateSlotStarts(date, service.durationMin, s);
  if (!starts.length || !staffIds.length) return [];
  const { db } = fb();
  const need = service.durationMin / 15;
  const first = starts[0]! / CELL_MS, last = starts[starts.length - 1]! / CELL_MS + need;
  const busy = new Map<string, Set<number>>();
  await Promise.all(staffIds.map(async (sid) => {
    const set = new Set<number>(); busy.set(sid, set);
    const todo: number[] = []; for (let n = first; n < last; n++) todo.push(n);
    for (let i = 0; i < todo.length; i += 60) {
      await Promise.all(todo.slice(i, i + 60).map(async (n) => { if ((await getDoc(doc(db, 'workspaces', wid, 'locks', `${sid}_${n}`))).exists()) set.add(n); }));
    }
  }));
  return starts.map((t) => {
    const cells = cellsFor(t, service.durationMin);
    return { startsAt: new Date(t).toISOString(), available: staffIds.some((sid) => !cells.some((n) => busy.get(sid)!.has(n))) };
  });
}

// ───────────── create ─────────────
interface NewBooking {
  wid: string; source: 'public' | 'staff'; service: { id: string; durationMin: number }; staffCandidates: string[];
  customerName: string; customerPhone: string; customerEmail: string | null; notes: string | null; startMs: number;
  nextN: () => Promise<number>; // staff: lowest free number; public: random below the page's cap hint
  maxTries: number; status: string;
}

export async function createBooking(n: NewBooking): Promise<{ id: string; staffId: string; startsAt: string }> {
  const { db } = fb();
  const phone = normalizePhone(n.customerPhone);
  if (!phone) throw new ApiError(400, 'Enter a valid phone number, for example 0803 123 4567.');
  const name = n.customerName.trim();
  if (name.length < 2 || name.length > 120) throw new ApiError(400, 'Please enter the customer\'s full name.');
  if (!Number.isFinite(n.startMs) || n.startMs % CELL_MS !== 0) throw new ApiError(400, 'That start time is not valid.');
  if (n.startMs <= Date.now()) throw new ApiError(409, 'That time has already passed. Please pick a later one.', 'conflict');
  const cells = cellsFor(n.startMs, n.service.durationMin);
  if (!n.staffCandidates.length) throw new ApiError(409, 'No one is available to take bookings yet.', 'conflict');

  let staffId = '';
  for (const sid of n.staffCandidates) if (await cellsFree(n.wid, sid, cells)) { staffId = sid; break; }
  if (!staffId) throw new ApiError(409, 'That time was just taken. Please pick another.', 'conflict');

  const ym = monthPrefix();
  for (let attempt = 0; attempt < n.maxTries; attempt++) {
    const id = `${ym}_${await n.nextN()}`;
    const b = writeBatch(db);
    b.set(doc(db, 'workspaces', n.wid, 'bookings', id), {
      serviceId: n.service.id, staffId, customerName: name, customerPhone: phone, customerEmail: n.customerEmail || null, notes: n.notes || null,
      startsAt: Timestamp.fromMillis(n.startMs), endsAt: Timestamp.fromMillis(n.startMs + n.service.durationMin * 60_000), cells, status: n.status, source: n.source, createdAt: serverTimestamp(),
    });
    for (const cell of cells) b.set(doc(db, 'workspaces', n.wid, 'locks', `${staffId}_${cell}`), { bookingId: id, createdAt: serverTimestamp() });
    try { await b.commit(); return { id, staffId, startsAt: new Date(n.startMs).toISOString() }; }
    catch (e) {
      if ((e as { code?: string }).code !== 'permission-denied') throw toApiError(e);
      // Denied: either the time was taken a moment ago, or the booking number was already used. Tell them apart.
      if (!(await cellsFree(n.wid, staffId, cells))) throw new ApiError(409, 'That time was just taken. Please pick another.', 'conflict');
    }
  }
  throw new ApiError(409, 'This business cannot take more bookings right now. Please try another day or contact them directly.', 'conflict');
}

async function nextMonthlyN(c: Ctx): Promise<number> {
  const ym = monthPrefix();
  const snap = await getDocs(query(wsCol(c, 'bookings'), where(documentId(), '>=', `${ym}_`), where(documentId(), '<', `${ym}\``)));
  const used = new Set(snap.docs.map((d) => Number(d.id.split('_')[1])));
  const max = slotLimit(c.tier, 'bookingsPerMonth');
  for (let i = 0; i < max; i++) if (!used.has(i)) return i;
  throw limitError(c, 'bookingsPerMonth');
}

export async function staffCreate(b: Record<string, unknown>): Promise<{ booking: BookingDto }> {
  const c = await loadCtx();
  const services = await listServices(c);
  const service = services.find((s) => s.id === b.serviceId && s.active);
  if (!service) throw new ApiError(400, 'Choose a service.');
  const staff = (await listStaff(c)).filter((s) => s.active);
  const candidates = b.staffId ? staff.filter((s) => s.id === b.staffId).map((s) => s.id) : staff.map((s) => s.id);
  const made = await createBooking({
    wid: c.wid, source: 'staff', service, staffCandidates: candidates, customerName: String(b.customerName ?? ''), customerPhone: String(b.customerPhone ?? ''),
    customerEmail: null, notes: b.notes ? String(b.notes).slice(0, 500) : null, startMs: new Date(String(b.startsAt)).getTime(), status: 'confirmed',
    nextN: () => nextMonthlyN(c), maxTries: 3,
  });
  void audit(c, 'booking.create', 'booking', made.id);
  emit('bookings.booking.created', c.wid, made.id);
  // Enterprise: score the booking now so the owner sees the risk straight away. Best effort; the booking already exists.
  if (hasFeatureAccess(c.tier, 'risk')) await worker('/api/risk/assess', { body: { workspaceId: c.wid, bookingId: made.id } }).catch(() => undefined);
  const snap = await getDoc(wsDoc(c, 'bookings', made.id));
  const m = await maps(c);
  return { booking: toDto(snap as QueryDocumentSnapshot, m.svcs, m.staff, depOf(c)) };
}

// ───────────── read ─────────────
const LIVE = ['pending', 'confirmed', 'completed', 'no_show'];

export async function listBookings(params: URLSearchParams): Promise<{ bookings: BookingDto[]; counts: Record<string, number> }> {
  const c = await loadCtx();
  const m = await maps(c);
  const from = params.get('from'), to = params.get('to');
  let q;
  if (from || to) {
    const parts = [];
    if (from) parts.push(where('startsAt', '>=', Timestamp.fromDate(new Date(from))));
    if (to) parts.push(where('startsAt', '<=', Timestamp.fromDate(new Date(to))));
    q = query(wsCol(c, 'bookings'), ...parts, orderBy('startsAt'), qLimit(500));
  } else q = query(wsCol(c, 'bookings'), orderBy('startsAt', 'desc'), qLimit(500));
  let rows = (await getDocs(q)).docs.map((d) => toDto(d, m.svcs, m.staff, depOf(c)));

  const now = Date.now();
  const upcoming = (b: BookingDto) => new Date(b.startsAt).getTime() >= now && (b.status === 'pending' || b.status === 'confirmed');
  const counts = { all: rows.length, upcoming: rows.filter(upcoming).length, pending: rows.filter((b) => b.status === 'pending').length, completed: rows.filter((b) => b.status === 'completed').length };

  const status = params.get('status');
  if (status) { const set = new Set(status.split(',')); rows = rows.filter((b) => set.has(b.status)); }
  if (params.get('upcoming') === 'true') rows = rows.filter(upcoming).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const term = (params.get('q') ?? '').trim().toLowerCase();
  if (term) rows = rows.filter((b) => [b.customerName, b.customerPhone, b.ref, b.id].some((v) => v.toLowerCase().includes(term)));
  return { bookings: rows.slice(0, Math.min(500, Number(params.get('limit')) || 100)), counts };
}

export async function patchBooking(id: string, b: Record<string, unknown>): Promise<{ ok: true; id: string }> {
  const c = await loadCtx();
  const { db } = fb();
  const ref = wsDoc(c, 'bookings', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new ApiError(404, 'That booking no longer exists.');
  const cur = snap.data();

  if (b.markDepositPaid) {
    const row = toDto(snap as QueryDocumentSnapshot, new Map(), new Map(), depOf(c));
    const minor = Math.round(Number(b.depositMinor ?? row.depositMinor));
    if (!(minor > 0)) throw new ApiError(400, 'There is no deposit to record on this booking.');
    await updateDoc(ref, { depositStatus: 'paid', depositMinor: minor, paymentReference: 'recorded-by-staff', ...(cur.status === 'pending' ? { status: 'confirmed' } : {}) }).catch((e) => { throw toApiError(e); });
    void audit(c, 'booking.deposit.recorded', 'booking', id);
    return { ok: true, id };
  }

  if (b.startsAt !== undefined) {
    // Moving a booking creates a fresh booking at the new time and removes the old one in one atomic step: the
    // double-booking rules only allow a time cell to be claimed together with the booking that owns it.
    const svc = (await listServices(c)).find((s) => s.id === cur.serviceId);
    const duration = svc?.durationMin ?? Math.round((cur.endsAt.toMillis() - cur.startsAt.toMillis()) / 60000);
    const startMs = new Date(String(b.startsAt)).getTime();
    if (!Number.isFinite(startMs) || startMs % CELL_MS !== 0 || startMs <= Date.now()) throw new ApiError(400, 'Pick a time in the future.');
    const cells = cellsFor(startMs, duration);
    const oldCells: number[] = cur.cells ?? [];
    const free = (await Promise.all(cells.map((n) => (oldCells.includes(n) ? true : getDoc(doc(db, 'workspaces', c.wid, 'locks', `${cur.staffId}_${n}`)).then((s) => !s.exists()))))).every(Boolean);
    if (!free) throw new ApiError(409, 'That time is already taken. Pick another.', 'conflict');
    const newId = `${monthPrefix()}_${await nextMonthlyN(c)}`;
    const batch = writeBatch(db);
    // Cells shared by the old and new time stay as they are (a lock can only be created, never changed).
    for (const n of oldCells.filter((x) => !cells.includes(x))) batch.delete(doc(db, 'workspaces', c.wid, 'locks', `${cur.staffId}_${n}`));
    batch.delete(ref);
    batch.set(wsDoc(c, 'bookings', newId), {
      serviceId: cur.serviceId, staffId: cur.staffId, customerName: cur.customerName, customerPhone: cur.customerPhone, customerEmail: cur.customerEmail ?? null, notes: cur.notes ?? null,
      startsAt: Timestamp.fromMillis(startMs), endsAt: Timestamp.fromMillis(startMs + duration * 60_000), cells, status: cur.status, source: cur.source ?? 'staff', createdAt: serverTimestamp(),
    });
    for (const n of cells.filter((x) => !oldCells.includes(x))) batch.set(doc(db, 'workspaces', c.wid, 'locks', `${cur.staffId}_${n}`), { bookingId: newId, createdAt: serverTimestamp() });
    try { await batch.commit(); } catch (e) { throw (e as { code?: string }).code === 'permission-denied' ? new ApiError(409, 'That time was just taken. Pick another.', 'conflict') : toApiError(e); }
    void audit(c, 'booking.move', 'booking', newId);
    return { ok: true, id: newId };
  }

  if (b.status !== undefined) {
    const status = String(b.status);
    if (![...LIVE, 'cancelled'].includes(status)) throw new ApiError(400, 'Unknown booking status.');
    const batch = writeBatch(db);
    batch.update(ref, status === 'cancelled' && cur.depositStatus === 'paid' ? { status, refundDue: true } : { status });
    if (status === 'cancelled') for (const n of (cur.cells ?? []) as number[]) batch.delete(doc(db, 'workspaces', c.wid, 'locks', `${cur.staffId}_${n}`)); // frees the time
    await batch.commit().catch((e) => { throw toApiError(e); });
    void audit(c, `booking.${status}`, 'booking', id);
  }
  return { ok: true, id };
}

export async function customers(params: URLSearchParams): Promise<{ customers: unknown[] }> {
  const { bookings } = await listBookings(new URLSearchParams({ limit: '500' }));
  const by = new Map<string, { phone: string; name: string; email: string | null; bookings: number; completed: number; noShows: number; depositsMinor: number; lastVisit: string }>();
  for (const b of bookings) {
    if (b.status === 'cancelled') continue;
    const x = by.get(b.customerPhone) ?? { phone: b.customerPhone, name: b.customerName, email: b.customerEmail, bookings: 0, completed: 0, noShows: 0, depositsMinor: 0, lastVisit: b.startsAt };
    x.bookings += 1; if (b.status === 'completed') x.completed += 1; if (b.status === 'no_show') x.noShows += 1;
    if (b.startsAt > x.lastVisit) { x.lastVisit = b.startsAt; x.name = b.customerName; }
    x.email ??= b.customerEmail;
    by.set(b.customerPhone, x);
  }
  const term = (params.get('q') ?? '').trim().toLowerCase();
  let rows = [...by.values()];
  if (term) rows = rows.filter((r) => r.name.toLowerCase().includes(term) || r.phone.includes(term));
  return { customers: rows.sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)) };
}

export async function summary(): Promise<unknown> {
  const c = await loadCtx();
  const s = c.settings, off = s.utcOffsetMinutes;
  const [svcs, staff] = await Promise.all([listServices(c), listStaff(c)]);
  const today = localDateOf(Date.now(), off);
  const monday = new Date(`${today}T00:00:00Z`).getTime() - ((weekdayOf(today) + 6) % 7) * 86_400_000;
  const weekStart = monday - off * 60_000, weekEnd = weekStart + 7 * 86_400_000;
  const [wk, pend] = await Promise.all([
    getDocs(query(wsCol(c, 'bookings'), where('startsAt', '>=', Timestamp.fromMillis(weekStart)), where('startsAt', '<', Timestamp.fromMillis(weekEnd)), orderBy('startsAt'), qLimit(500))),
    getDocs(query(wsCol(c, 'bookings'), where('status', '==', 'pending'), qLimit(200))),
  ]);
  const sm = new Map(svcs.map((x) => [x.id, x])), tm = new Map(staff.map((x) => [x.id, x]));
  const rows = wk.docs.map((d) => toDto(d, sm, tm, depOf(c))).filter((b) => b.status !== 'cancelled');
  const unpaid = rows.filter((b) => b.depositStatus === 'unpaid' && b.status !== 'completed' && b.status !== 'no_show');
  const dayStart = localMidnightUtc(today, off)!;
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  const names = new Map<string, number>();
  for (const b of rows) {
    perDay[Math.min(6, Math.floor((new Date(b.startsAt).getTime() - weekStart) / 86_400_000))]! += 1;
    names.set(b.serviceName, (names.get(b.serviceName) ?? 0) + 1);
  }
  return {
    businessName: s.publicName ?? c.wsName, currency: 'USD', today, utcOffsetMinutes: off,
    setup: { onboarded: s.onboarded, services: svcs.length, staff: staff.length, depositEnabled: s.depositEnabled, hasPhone: !!(s.phone ?? '').trim(), hasName: !!(s.publicName ?? '').trim() },
    todayBookings: rows.filter((b) => { const t = new Date(b.startsAt).getTime(); return t >= dayStart && t < dayStart + 86_400_000; }),
    week: { total: rows.length, depositsMinor: rows.reduce((n, b) => n + (b.depositStatus === 'paid' ? b.depositMinor : 0), 0), noShows: rows.filter((b) => b.status === 'no_show').length, perDay },
    attention: { pending: pend.size, unpaidCount: unpaid.length, unpaidMinor: unpaid.reduce((n, b) => n + b.depositMinor, 0), waitingReplies: 0 },
    popularServices: [...names].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count, pct: rows.length ? Math.round((count / rows.length) * 100) : 0 })),
  };
}

/** Creates a Paystack checkout link for a booking's deposit, for the business to send to the customer. */
export async function paymentLink(id: string, b: Record<string, unknown>): Promise<{ url: string; message: string; phone: string; reference: string; amountMinor: number }> {
  const c = await loadCtx();
  const snap = await getDoc(wsDoc(c, 'bookings', id));
  if (!snap.exists()) throw new ApiError(404, 'That booking no longer exists.');
  const x = snap.data();
  const r = await worker<{ authorizationUrl: string; reference: string; amountMinor: number }>('/api/deposit/link', { method: 'POST', body: { workspaceId: c.wid, bookingId: id, email: b?.email ?? x.customerEmail ?? '' } });
  void audit(c, 'booking.deposit.link', 'booking', id);
  return { url: r.authorizationUrl, reference: r.reference, amountMinor: r.amountMinor, phone: String(x.customerPhone ?? ''),
    message: `Hello ${x.customerName}, here is the link to pay your deposit for booking ${refOf(id)}: ${r.authorizationUrl}` };
}

/** Refunds a deposit that was paid through Paystack. Owners and admins only; the Worker does the refund and records it. */
export async function refundDeposit(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c);
  await worker('/api/deposit/refund', { method: 'POST', body: { workspaceId: c.wid, bookingId: id } });
  void audit(c, 'booking.deposit.refunded', 'booking', id);
  return { ok: true };
}
