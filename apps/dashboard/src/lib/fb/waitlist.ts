/** Revenue protection (Enterprise and Dedicated): who is waiting, which freed times were offered, and what was won back. */
import { deleteDoc, getDocs, limit as qLimit, orderBy, query, where } from 'firebase/firestore';
import { iso, loadCtx, requireFeature, wsCol, wsDoc } from './core';
import { listServices } from './catalog';

export interface WaitRow { id: string; name: string; phone: string; email: string; serviceName: string; date: string; status: 'waiting' | 'offered'; createdAt: string | null; offeredAt: string | null }
export interface Recovered { id: string; customerName: string; serviceName: string; startsAt: string; priceMinor: number }
export interface WaitlistView { enabled: boolean; waiting: WaitRow[]; recovered: Recovered[]; recoveredMinor: number }

export async function overview(): Promise<WaitlistView> {
  const c = await loadCtx(); requireFeature(c, 'waitlist');
  const [w, r, svcs] = await Promise.all([
    getDocs(query(wsCol(c, 'waitlist'), where('status', 'in', ['waiting', 'offered']), qLimit(300))),
    getDocs(query(wsCol(c, 'bookings'), where('recoveredFromWaitlist', '==', true), orderBy('startsAt', 'desc'), qLimit(100))),
    listServices(c),
  ]);
  const by = new Map(svcs.map((s) => [s.id, s]));
  const waiting = w.docs.map((d) => { const x = d.data(); return { id: d.id, name: String(x.name ?? ''), phone: String(x.phone ?? ''), email: String(x.email ?? ''), serviceName: String(x.serviceName ?? by.get(x.serviceId)?.name ?? 'Service'), date: String(x.date ?? ''), status: x.status === 'offered' ? 'offered' : 'waiting', createdAt: iso(x.createdAt), offeredAt: iso(x.offeredAt) } as WaitRow; })
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const recovered = r.docs.map((d) => { const x = d.data(); const s = by.get(x.serviceId); return { id: d.id, customerName: String(x.customerName ?? ''), serviceName: s?.name ?? 'Removed service', startsAt: iso(x.startsAt)!, priceMinor: s?.priceMinor ?? 0 }; });
  return { enabled: c.settings.waitlistEnabled === true, waiting, recovered, recoveredMinor: recovered.reduce((n, x) => n + x.priceMinor, 0) };
}
export async function removeEntry(id: string): Promise<void> {
  const c = await loadCtx();
  await deleteDoc(wsDoc(c, 'waitlist', id));
}
