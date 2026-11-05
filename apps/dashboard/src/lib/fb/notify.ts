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

export interface Notifications { bookings: number; messages: number }
const seenRef = async () => { const c = await loadCtx(); const uid = fb().auth.currentUser?.uid; return { c, ref: uid ? doc(fb().db, 'workspaces', c.wid, 'seen', uid) : null }; };

export async function markBookingsSeen(): Promise<void> {
  const { ref } = await seenRef();
  if (ref) await setDoc(ref, { bookingsAt: serverTimestamp() }).catch(() => undefined);
}

export async function notifications(): Promise<Notifications> {
  const { c, ref } = await seenRef();
  let bookings = 0;
  if (ref) {
    const snap = await getDoc(ref).catch(() => null);
    const at = snap?.data()?.bookingsAt;
    if (snap && !snap.exists()) await markBookingsSeen();
    else if (at instanceof Timestamp) {
      const s = await getDocs(query(wsCol(c, 'bookings'), where('createdAt', '>', at), orderBy('createdAt'), qLimit(100))).catch(() => null);
      bookings = s ? s.docs.filter((d) => d.data().source !== 'staff' && d.data().status !== 'cancelled').length : 0;
    }
  }
  const r = (await conversations(new URLSearchParams())) as { conversations: { unread: number }[] };
  return { bookings, messages: r.conversations.reduce((n, x) => n + x.unread, 0) };
}
