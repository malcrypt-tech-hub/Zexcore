/** Wording and shortcuts that match the kind of business picked in setup, so the dashboard reads like their business and not a generic one. */
import type { IconName } from './icons';

export interface Action { t: string; icon: IconName; href?: string; newBooking?: boolean }
export interface Terms {
  one: string;            // "appointment"
  many: string;           // "appointments"
  customers: string;      // "patients"
  today: string;          // "Today's appointments"
  emptyTitle: string;
  emptyText: string;
  newLabel: string;       // "New appointment"
  actions: Action[];
}

const BASE: Terms = {
  one: 'booking', many: 'bookings', customers: 'customers', today: "Today's schedule", emptyTitle: 'Nothing booked today',
  emptyText: 'Share your booking link or add a booking by hand.', newLabel: 'New booking',
  actions: [{ t: 'New booking', icon: 'plus', newBooking: true }, { t: 'Messages', icon: 'message-square', href: '/app/messages' }, { t: 'Customers', icon: 'users', href: '/app/customers' }, { t: 'Services', icon: 'list-checks', href: '/app/services' }],
};

const T: Record<string, Partial<Terms>> = {
  clinic: {
    one: 'appointment', many: 'appointments', customers: 'patients', today: "Today's appointments", emptyTitle: 'No appointments today',
    emptyText: 'Share your booking link so patients can book, or add an appointment by hand.', newLabel: 'New appointment',
    actions: [{ t: 'New appointment', icon: 'plus', newBooking: true }, { t: 'Patient messages', icon: 'message-square', href: '/app/messages' }, { t: 'Patients', icon: 'users', href: '/app/customers' }, { t: 'Bookable staff', icon: 'id-card', href: '/app/team' }],
  },
  real_estate: {
    one: 'viewing', many: 'viewings', customers: 'clients', today: "Today's viewings", emptyTitle: 'No viewings today',
    emptyText: 'Share your booking link so prospects can book a viewing, or add one by hand.', newLabel: 'New viewing',
    actions: [{ t: 'New viewing', icon: 'plus', newBooking: true }, { t: 'Leads', icon: 'handshake', href: '/app/crm' }, { t: 'Enquiries', icon: 'message-square', href: '/app/messages' }, { t: 'Listings page', icon: 'globe', href: '/app/content' }],
  },
  salon: {
    one: 'appointment', many: 'appointments', customers: 'clients', today: "Today's appointments", emptyTitle: 'No appointments today',
    emptyText: 'Share your booking link so clients can reserve a slot, or add one by hand.', newLabel: 'New appointment',
    actions: [{ t: 'New appointment', icon: 'plus', newBooking: true }, { t: 'Stylists & staff', icon: 'id-card', href: '/app/team' }, { t: 'Services & prices', icon: 'list-checks', href: '/app/services' }, { t: 'Clients', icon: 'users', href: '/app/customers' }],
  },
  delivery: {
    one: 'pickup', many: 'pickups', customers: 'customers', today: "Today's pickups", emptyTitle: 'No pickups today',
    emptyText: 'Share your booking link so customers can book a pickup slot, or add one by hand.', newLabel: 'New pickup',
    actions: [{ t: 'New pickup', icon: 'plus', newBooking: true }, { t: 'Messages', icon: 'message-square', href: '/app/messages' }, { t: 'Devices', icon: 'cpu', href: '/app/devices' }, { t: 'Calendar', icon: 'calendar-days', href: '/app/calendar' }],
  },
  retail: {
    one: 'visit', many: 'visits', customers: 'customers', today: "Today's visits", emptyTitle: 'No visits booked today',
    emptyText: 'Share your booking link for fittings and pickups, or add a visit by hand.', newLabel: 'New visit',
    actions: [{ t: 'New visit', icon: 'plus', newBooking: true }, { t: 'Messages', icon: 'message-square', href: '/app/messages' }, { t: 'Customers', icon: 'users', href: '/app/customers' }, { t: 'Website pages', icon: 'globe', href: '/app/content' }],
  },
};

export const termsFor = (businessType: string | undefined): Terms => ({ ...BASE, ...(T[businessType ?? ''] ?? {}) });
