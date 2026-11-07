/**
 * What is new since this person last looked, the way WhatsApp counts it.
 *  - Bookings: requests made since the last time THIS person opened Bookings. The moment is stored per person in the workspace
 *    (workspaces/{wid}/seen/{uid}), so it survives refreshes and carries across their devices; a teammate opening Bookings does not clear yours.
 *  - Messages: unread customer messages, from the per-conversation read marks the inbox already keeps; a conversation clears when it is opened.
 * The first time someone ever loads this we start counting from now, so a long-standing workspace is not greeted by a pile of old bookings.
 */
import { doc, getDoc, getDocs, limit as qLimit, orderBy, query, serverTimestamp, setDoc, where, Timestamp } from 'firebase/firestore';
import { fb } from './firebase';
import { loadCtx, wsCol } from './core';
import { conversations } from './messages';

export interface Notifications { bookings: number; messages: number; orders: number; enquiries: number }
export type SeenKind = 'bookings' | 'orders' | 'enquiries';
const KINDS: SeenKind[] = ['bookings', 'orders', 'enquiries'];
const seenRef = async () => { const c = await loadCtx(); const uid = fb().auth.currentUser?.uid; return { c, ref: uid ? doc(fb().db, 'workspaces', c.wid, 'seen', uid) : null }; };

/** "I have looked at these": remembered per person, so it survives a refresh and follows them across devices. */
export async function markSeen(kind: SeenKind): Promise<void> {
  const { ref } = await seenRef();
  if (ref) await setDoc(ref, { [`${kind}At`]: serverTimestamp() }, { merge: true }).catch(() => undefined);
}
export const markBookingsSeen = (): Promise<void> => markSeen('bookings');

/** New items of one kind since this person last looked. People without a marker yet start counting from now, not from the beginning. */
async function countNew(c: Awaited<ReturnType<typeof loadCtx>>, col: string, at: Timestamp, keep: (x: Record<string, unknown>) => boolean): Promise<number> {
  try {
    const s = await getDocs(query(wsCol(c, col), where('createdAt', '>', at), orderBy('createdAt'), qLimit(100)));
    return s.docs.filter((d) => keep(d.data())).length;
  } catch { return 0; }   // not allowed to read this (for example a viewer): nothing to show
}

export async function notifications(): Promise<Notifications> {
  const { c, ref } = await seenRef();
  let bookings = 0, orders = 0, enquiries = 0;
  if (ref) {
    const snap = await getDoc(ref).catch(() => null);
    const data = snap?.data() ?? {};
    const missing = KINDS.filter((k) => !(data[`${k}At`] instanceof Timestamp));
    if (snap && missing.length) {
      await setDoc(ref, Object.fromEntries(missing.map((k) => [`${k}At`, serverTimestamp()])), { merge: true }).catch(() => undefined);
    }
    const at = (k: SeenKind): Timestamp | null => (data[`${k}At`] instanceof Timestamp ? data[`${k}At`] : null);
    [bookings, orders, enquiries] = await Promise.all([
      at('bookings') ? countNew(c, 'bookings', at('bookings')!, (x) => x.source !== 'staff' && x.status !== 'cancelled') : 0,
      at('orders') ? countNew(c, 'orders', at('orders')!, (x) => x.status === 'new') : 0,
      at('enquiries') ? countNew(c, 'enquiries', at('enquiries')!, (x) => x.status === 'new') : 0,
    ]);
  }
  const r = (await conversations(new URLSearchParams())) as { conversations: { unread: number }[] };
  return { bookings, orders, enquiries, messages: r.conversations.reduce((n, x) => n + x.unread, 0) };
}
