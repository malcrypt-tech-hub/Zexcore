/** The owner's calendar appointments. Stored as workspaces/{wid}/appointments/<YYYYMMDD>_<0-14>: the id caps a day at 15. */
import { deleteDoc, doc, getDoc, getDocs, orderBy, query, runTransaction, serverTimestamp, updateDoc, where, limit as qLimit, type QueryDocumentSnapshot } from 'firebase/firestore';
import { fb } from './firebase';
import { ApiError, loadCtx, wsCol, wsDoc, type Ctx } from './core';
import { MAX_PER_DAY, clean, fullDays, landingDates, Invalid, type Appointment, type Draft } from '../appointments';

const toAppt = (d: QueryDocumentSnapshot): Appointment => {
  const x = d.data();
  return { id: d.id, title: x.title, date: x.date, startMin: x.startMin, durationMin: x.durationMin, notes: x.notes ?? null, priority: x.priority ?? 'normal', pinned: x.pinned === true,
    reminderMin: x.reminderMin ?? null, recur: x.recur ?? { freq: 'none', interval: 1, until: null }, done: x.done === true };
};
const guard = <T>(f: () => T): T => { try { return f(); } catch (e) { if (e instanceof Invalid) throw new ApiError(400, e.message); throw e; } };

/** Appointments dated in [from, to] plus every repeating one (their repeats may land in the range) and the pinned ones. */
export async function list(from: string, to: string): Promise<{ appointments: Appointment[] }> {
  const c = await loadCtx();
  const [inRange, recurring] = await Promise.all([
    getDocs(query(wsCol(c, 'appointments'), where('date', '>=', from), where('date', '<=', to), orderBy('date'), qLimit(1500))),
    getDocs(query(wsCol(c, 'appointments'), where('recurring', '==', true), qLimit(500))),
  ]);
  const byId = new Map<string, Appointment>();
  for (const d of [...inRange.docs, ...recurring.docs]) byId.set(d.id, toAppt(d));
  return { appointments: [...byId.values()] };
}
export async function pinned(): Promise<{ appointments: Appointment[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'appointments'), where('pinned', '==', true), qLimit(100)));
  return { appointments: s.docs.map(toAppt).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin) };
}

async function existingFor(c: Ctx, dates: string[]): Promise<Appointment[]> {
  const lo = dates[0]!, hi = dates[dates.length - 1]!;
  const [a, b] = await Promise.all([
    getDocs(query(wsCol(c, 'appointments'), where('date', '>=', lo), where('date', '<=', hi), qLimit(5000))),
    getDocs(query(wsCol(c, 'appointments'), where('recurring', '==', true), qLimit(500))),
  ]);
  const m = new Map<string, Appointment>(); [...a.docs, ...b.docs].forEach((d) => m.set(d.id, toAppt(d)));
  return [...m.values()];
}
const fullMessage = (day: string): ApiError => new ApiError(409, `${day} already has ${MAX_PER_DAY} appointments, which is the most one day can hold. Choose another day or remove one.`, 'day_full');

async function checkRoom(c: Ctx, a: Omit<Appointment, 'id'>, ignoreId?: string): Promise<void> {
  const dates = landingDates(a);
  const existing = (await existingFor(c, dates)).filter((x) => x.id !== ignoreId);
  const full = fullDays(existing, dates);
  if (full.length) throw fullMessage(full[0]!);
}

export async function create(d: Draft): Promise<{ id: string }> {
  const c = await loadCtx();
  const a = guard(() => clean(d));
  await checkRoom(c, a);
  const key = a.date.replace(/-/g, '');
  const { db } = fb();
  for (let n = 0; n < MAX_PER_DAY; n++) {
    const ref = doc(db, 'workspaces', c.wid, 'appointments', `${key}_${n}`);
    const ok = await runTransaction(db, async (t) => {
      if ((await t.get(ref)).exists()) return false;
      t.set(ref, { ...a, recurring: a.recur.freq !== 'none', createdAt: serverTimestamp(), createdBy: c.uid });
      return true;
    });
    if (ok) return { id: ref.id };
  }
  throw fullMessage(a.date);
}

export async function update(id: string, patch: Draft): Promise<{ id: string }> {
  const c = await loadCtx();
  const cur = await getDoc(wsDoc(c, 'appointments', id));
  if (!cur.exists()) throw new ApiError(404, 'That appointment no longer exists.');
  const a = guard(() => clean({ ...toAppt(cur as QueryDocumentSnapshot), ...patch }));
  if (a.date !== cur.data().date) {          // a new day means a new slot id: add it first, then remove the old one
    const made = await create(a);
    await deleteDoc(wsDoc(c, 'appointments', id));
    return made;
  }
  await checkRoom(c, a, id);
  await updateDoc(wsDoc(c, 'appointments', id), { ...a, recurring: a.recur.freq !== 'none' });
  return { id };
}
export async function remove(id: string): Promise<{ ok: true }> { const c = await loadCtx(); await deleteDoc(wsDoc(c, 'appointments', id)); return { ok: true }; }

/** Small switches that must not hit the room check (pin, done). */
export async function flag(id: string, f: { pinned?: boolean; done?: boolean }): Promise<{ ok: true }> {
  const c = await loadCtx();
  await updateDoc(wsDoc(c, 'appointments', id), f);
  return { ok: true };
}
