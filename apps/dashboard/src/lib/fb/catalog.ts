import { deleteDoc, doc, getDoc, getDocs, updateDoc, query, orderBy, type QueryDocumentSnapshot } from 'firebase/firestore';
import { ApiError, DEFAULT_SETTINGS, audit, claimSlot, loadCtx, requireAdmin, requireEditor, wsCol, wsDoc, type Ctx, type WorkspaceSettings } from './core';
import { fb } from './firebase';
import { slotLimit } from './plan';

export interface ServiceDto { id: string; name: string; description: string | null; durationMin: number; priceMinor: number; active: boolean }
export interface StaffDto { id: string; name: string; title: string | null; active: boolean; auto?: boolean }

const svc = (d: QueryDocumentSnapshot): ServiceDto => ({ id: d.id, name: d.data().name, description: d.data().description ?? null, durationMin: d.data().durationMin, priceMinor: d.data().priceMinor ?? 0, active: d.data().active !== false });
const stf = (d: QueryDocumentSnapshot): StaffDto => ({ id: d.id, name: d.data().name, title: d.data().title ?? null, active: d.data().active !== false, auto: d.data().auto === true });
const bySeq = (name: string, c: Ctx) => query(wsCol(c, name), orderBy('seq'));

export async function listServices(c: Ctx): Promise<ServiceDto[]> { return (await getDocs(bySeq('services', c))).docs.map(svc); }
export async function listStaff(c: Ctx): Promise<StaffDto[]> { return (await getDocs(bySeq('staff', c))).docs.map(stf); }

function checkService(b: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name ?? '').trim();
    if (name.length < 1 || name.length > 120) throw new ApiError(400, 'Give the service a name (up to 120 characters).');
    out.name = name;
  }
  if (!partial || b.durationMin !== undefined) {
    const m = Number(b.durationMin);
    if (!Number.isInteger(m) || m < 15 || m > 120 || m % 15 !== 0) throw new ApiError(400, 'Service length must be 15, 30, 45 … up to 120 minutes (a multiple of 15).');
    out.durationMin = m;
  }
  if (!partial || b.priceMinor !== undefined) {
    const p = Number(b.priceMinor ?? 0);
    if (!Number.isInteger(p) || p < 0 || p > 100_000_000_00) throw new ApiError(400, 'Enter a valid price.');
    out.priceMinor = p;
  }
  if (b.description !== undefined) { const d = String(b.description ?? '').trim(); if (d.length > 500) throw new ApiError(400, 'Keep the description under 500 characters.'); out.description = d || null; }
  if (b.active !== undefined) out.active = Boolean(b.active);
  return out;
}

export async function createService(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireEditor(c);
  const data = checkService(b, false);
  const id = await claimSlot(c, 'services', 's', 'services', { description: null, active: true, ...data });
  void audit(c, 'service.create', 'service', id);
  return { id };
}
export async function patchService(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx(); requireEditor(c);
  await updateDoc(wsDoc(c, 'services', id), checkService(b, true));
  void audit(c, 'service.update', 'service', id);
  return { ok: true };
}

export async function deleteService(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c);
  const ref = wsDoc(c, 'services', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new ApiError(404, 'That service no longer exists.');
  await deleteDoc(ref);   // past bookings stay in the list and show as a removed service
  void audit(c, 'service.delete', 'service', id, String(snap.data().name ?? '').slice(0, 120));
  return { ok: true };
}

export async function createStaff(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx(); requireEditor(c);
  const name = String(b.name ?? '').trim();
  if (name.length < 1 || name.length > 120) throw new ApiError(400, 'Enter the person\'s name.');
  const title = String(b.title ?? '').trim().slice(0, 120) || null;
  const existing = await listStaff(c);
  const auto = existing.length === 1 && existing[0]!.auto === true;
  // The calendar created at sign-up is handed over to the first real team member when the plan has no room for another.
  if (auto && existing.length >= slotLimit(c.tier, 'staff')) {
    await updateDoc(wsDoc(c, 'staff', existing[0]!.id), { name, title, active: true, auto: false });
    void audit(c, 'staff.create', 'staff', existing[0]!.id);
    return { id: existing[0]!.id };
  }
  const id = await claimSlot(c, 'staff', 'p', 'staff', { name, title, active: true, auto: false });
  void audit(c, 'staff.create', 'staff', id);
  return { id };
}
export async function patchStaff(id: string, b: Record<string, unknown>): Promise<{ ok: true }> {
  const c = await loadCtx(); requireEditor(c);
  const out: Record<string, unknown> = { auto: false };
  if (b.name !== undefined) { const n = String(b.name).trim(); if (n.length < 1 || n.length > 120) throw new ApiError(400, 'Enter the person\'s name.'); out.name = n; }
  if (b.title !== undefined) out.title = String(b.title ?? '').trim().slice(0, 120) || null;
  if (b.active !== undefined) out.active = Boolean(b.active);
  await updateDoc(wsDoc(c, 'staff', id), out);
  void audit(c, 'staff.update', 'staff', id);
  return { ok: true };
}

// ───────────── settings ─────────────
const int = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ApiError(400, `${what} is out of range.`);
  return n;
};

export async function getSettings(): Promise<{ settings: WorkspaceSettings; tenant: { slug: string } }> {
  const c = await loadCtx(true);
  return { settings: c.settings, tenant: { slug: c.slug } };
}

export async function putSettings(b: Record<string, unknown>): Promise<{ settings: WorkspaceSettings }> {
  const c = await loadCtx(true);
  if (c.role !== 'owner') throw new ApiError(403, 'Only the workspace owner can change these settings.', 'forbidden');
  const s: WorkspaceSettings = { ...DEFAULT_SETTINGS, ...c.settings };
  if (b.businessType !== undefined) s.businessType = String(b.businessType).slice(0, 40);
  if (b.businessSubtype !== undefined) s.businessSubtype = String(b.businessSubtype ?? '').slice(0, 40) || null;
  if (b.publicName !== undefined) { const n = String(b.publicName ?? '').trim(); if (n.length > 120) throw new ApiError(400, 'Business name is too long.'); s.publicName = n || null; }
  if (b.phone !== undefined) s.phone = String(b.phone ?? '').trim().slice(0, 32) || null;
  if (b.address !== undefined) s.address = String(b.address ?? '').trim().slice(0, 200) || null;
  if (b.openMinutes !== undefined) s.openMinutes = int(b.openMinutes, 0, 1439, 'Opening time');
  if (b.closeMinutes !== undefined) s.closeMinutes = int(b.closeMinutes, 1, 1440, 'Closing time');
  if (s.closeMinutes <= s.openMinutes) throw new ApiError(400, 'Closing time must be after opening time.');
  if (b.slotMinutes !== undefined) { s.slotMinutes = int(b.slotMinutes, 15, 120, 'Slot length'); if (s.slotMinutes % 15) throw new ApiError(400, 'Slot length must be a multiple of 15 minutes.'); }
  if (s.openMinutes % 15) throw new ApiError(400, 'Opening time must fall on a quarter hour.');
  if (b.daysOpen !== undefined) {
    const days = Array.isArray(b.daysOpen) ? [...new Set((b.daysOpen as unknown[]).map(Number))] : [];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ApiError(400, 'Pick the days you are open.');
    s.daysOpen = days.sort();
  }
  if (b.leadMinutes !== undefined) s.leadMinutes = int(b.leadMinutes, 0, 10080, 'Notice period');
  if (b.maxDaysAhead !== undefined) s.maxDaysAhead = int(b.maxDaysAhead, 1, 120, 'Booking horizon');
  if (b.depositMinor !== undefined) {
    const m = Math.round(Number(b.depositMinor));
    if (!Number.isFinite(m) || m < 0 || m > 5_000_00) throw new ApiError(400, 'Enter a deposit between $0 and $5,000.');
    if (m > 0 && m < 1_00) throw new ApiError(400, 'The smallest deposit is $1.');
    s.depositMinor = m;
  }
  if (b.depositEnabled !== undefined) s.depositEnabled = b.depositEnabled === true;
  if (s.depositEnabled && !(s.depositMinor > 0)) throw new ApiError(400, 'Set a deposit amount before turning deposits on.');
  if (s.depositEnabled && !c.settings.depositEnabled) {
    const p = await getDoc(doc(fb().db, 'workspaces', c.wid, 'payout', 'main'));
    if (!p.exists() || !p.data()?.subaccountCode) {
      if (b.onboarded) {
        // In onboarding, store the intended deposit amount but keep deposits off until a bank account is added
        s.depositEnabled = false;
      } else {
        throw new ApiError(400, 'Add the bank account where deposits should be paid before turning deposits on.', 'payout_missing');
      }
    }
  }
  if (b.exchangeRate !== undefined) {
    const r = Number(b.exchangeRate);
    if (!Number.isFinite(r) || r < 100 || r > 100_000) throw new ApiError(400, 'Enter the naira value of $1, between 100 and 100,000.');
    s.exchangeRate = Math.round(r * 100) / 100;
  }
  if (b.logoUrl !== undefined) s.logoUrl = b.logoUrl ? String(b.logoUrl) : null;
  if (b.onboarded !== undefined) s.onboarded = Boolean(b.onboarded);
  s.utcOffsetMinutes = 60; s.currency = 'USD';

  await updateDoc(wsDoc(c), { settings: s });
  await updateDoc(doc(fb().db, 'slugs', c.slug), {
    name: s.publicName || c.wsName, openMinutes: s.openMinutes, closeMinutes: s.closeMinutes, slotMinutes: s.slotMinutes,
    closedWeekdays: [0, 1, 2, 3, 4, 5, 6].filter((d) => !s.daysOpen.includes(d)), phone: s.phone, address: s.address,
    leadMinutes: s.leadMinutes, maxDaysAhead: s.maxDaysAhead, bookingCap: slotLimit(c.tier, 'bookingsPerMonth'),
    depositEnabled: s.depositEnabled, depositMinor: s.depositMinor, exchangeRate: s.exchangeRate, currency: 'USD',
  });
  void audit(c, 'settings.update', 'workspace', c.wid);
  await loadCtx(true);
  return { settings: s };
}

/** Keeps the public page's booking-id hint in step with the plan. Best effort; owner only. */
let capSynced = '';
export async function syncBookingCap(c: Ctx): Promise<void> {
  const cap = slotLimit(c.tier, 'bookingsPerMonth');
  if (c.role !== 'owner' || capSynced === `${c.wid}:${cap}`) return;
  try { await updateDoc(doc(fb().db, 'slugs', c.slug), { bookingCap: cap }); capSynced = `${c.wid}:${cap}`; } catch { /* retried next load */ }
}
