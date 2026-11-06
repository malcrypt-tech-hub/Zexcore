/**
 * The industries offered in setup. Picking one configures a starting point: suggested services, the wording used across
 * the dashboard, and the shortcuts on Home. It never limits what the workspace can do; every tool stays available.
 */
import type { IconName } from './icons';

/** A question the booking page asks for one service, set up for this kind of business. The owner can change every one. */
export interface IntakeField { key: string; label: string; type: 'text' | 'textarea' | 'select' | 'number' | 'url'; required?: boolean; options?: string[]; placeholder?: string }
const q = (key: string, label: string, type: IntakeField['type'] = 'text', required = false, extra: Partial<IntakeField> = {}): IntakeField => ({ key, label, type, required, ...extra });
const ABOUT = q('about', 'What do you need?', 'textarea', true, { placeholder: 'Describe it in a few sentences' });

export interface Action { t: string; icon: IconName; href?: string; newBooking?: boolean }
export interface Terms { one: string; many: string; customers: string; today: string; emptyTitle: string; emptyText: string; newLabel: string; actions: Action[] }
export interface Industry {
  key: string; icon: IconName; title: string; text: string; popular?: boolean;
  subtypes: string[];
  services: { name: string; min: number; usd: number; mode?: 'appointment' | 'enquiry'; fields?: IntakeField[] }[];   // starting points only; the owner edits or removes them
  terms: Terms;
}

const A = {
  msg: (t = 'Messages'): Action => ({ t, icon: 'message-square', href: '/app/messages' }),
  cust: (t = 'Customers'): Action => ({ t, icon: 'users', href: '/app/customers' }),
  svc: (t = 'Services'): Action => ({ t, icon: 'list-checks', href: '/app/services' }),
  staff: (t = 'Bookable staff'): Action => ({ t, icon: 'id-card', href: '/app/team' }),
  crm: (t = 'Leads'): Action => ({ t, icon: 'handshake', href: '/app/crm' }),
  pages: (t = 'Website pages'): Action => ({ t, icon: 'globe', href: '/app/content' }),
  cal: (t = 'Calendar'): Action => ({ t, icon: 'calendar-days', href: '/app/calendar' }),
  dev: (t = 'Devices'): Action => ({ t, icon: 'cpu', href: '/app/devices' }),
};
const terms = (one: string, many: string, customers: string, actions: Action[], today = `Today's ${many}`): Terms => ({
  one, many, customers, today, emptyTitle: `No ${many} today`, emptyText: `Share your booking link so ${customers} can book, or add one by hand.`,
  newLabel: `New ${one}`, actions: [{ t: `New ${one}`, icon: 'plus', newBooking: true }, ...actions],
});

export const INDUSTRIES: Industry[] = [
  { key: 'healthcare', icon: 'stethoscope', title: 'Healthcare', text: 'Clinics, pharmacies, wellness', popular: true, subtypes: ['Clinic', 'Pharmacy', 'Dental', 'Wellness centre', 'Laboratory'],
    services: [{ name: 'General consultation', min: 30, usd: 10, fields: [q('reason', 'Reason for your visit', 'textarea', true), q('visit', 'Is this your first visit?', 'select', true, { options: ['First visit', 'Returning patient'] })] },
      { name: 'Follow-up visit', min: 20, usd: 5, fields: [q('reason', 'What is the follow-up for?', 'textarea', true)] },
      { name: 'Lab test', min: 45, usd: 7, fields: [q('test', 'Which test were you asked to take?', 'text', true)] }],
    terms: terms('appointment', 'appointments', 'patients', [A.msg('Patient messages'), A.cust('Patients'), A.staff()]) },
  { key: 'technology', icon: 'cpu', title: 'Tech & software', text: 'Web, apps, IT support, agencies', popular: true, subtypes: ['Web development', 'Software house', 'IT support', 'Design & branding', 'Cybersecurity'],
    services: [{ name: 'Project enquiry', min: 30, usd: 0, mode: 'enquiry', fields: [ABOUT, q('type', 'Type of project', 'select', true, { options: ['Website', 'Mobile app', 'Web app', 'Design', 'Security review', 'Other'] }), q('budget', 'Budget range', 'text'), q('link', 'Link to a brief or reference', 'url')] },
      { name: 'Discovery call', min: 30, usd: 0, fields: [q('about', 'What would you like to talk about?', 'textarea', true)] }, { name: 'IT support request', min: 30, usd: 0, mode: 'enquiry', fields: [ABOUT, q('urgent', 'How urgent is it?', 'select', true, { options: ['Not urgent', 'This week', 'Today'] })] }],
    terms: terms('call', 'calls', 'clients', [A.crm('Leads & clients'), A.msg('Enquiries'), A.pages('Portfolio page')]) },
  { key: 'real_estate', icon: 'building-2', title: 'Property & real estate', text: 'Agents, rentals, inspections', subtypes: ['Agency', 'Short-let', 'Property manager', 'Developer'],
    services: [{ name: 'Property viewing', min: 45, usd: 0, fields: [q('property', 'Which property or listing?', 'text', true)] }, { name: 'Tenant inspection', min: 60, usd: 0, fields: [q('property', 'Which property?', 'text', true)] }],
    terms: terms('viewing', 'viewings', 'clients', [A.crm(), A.msg('Enquiries'), A.pages('Listings page')]) },
  { key: 'beauty', icon: 'scissors', title: 'Beauty & personal care', text: 'Salons, spas, barbers', subtypes: ['Hair salon', 'Barber', 'Spa', 'Nails', 'Makeup'],
    services: [{ name: 'Haircut & styling', min: 60, usd: 5, fields: [q('style', 'The style you want', 'text', false, { placeholder: 'Or paste a link to a photo' })] }, { name: 'Manicure', min: 45, usd: 3 }],
    terms: terms('appointment', 'appointments', 'clients', [A.staff('Stylists & staff'), A.svc('Services & prices'), A.cust('Clients')]) },
  { key: 'education', icon: 'clipboard-list', title: 'Education & training', text: 'Schools, tutors, academies', subtypes: ['School', 'Tutor', 'Academy', 'Training centre'],
    services: [{ name: 'Tutoring session', min: 60, usd: 5, fields: [q('subject', 'Subject and level', 'text', true), q('goal', 'What do you want to improve?', 'textarea')] }, { name: 'Admissions visit', min: 30, usd: 0, fields: [q('child', 'Name and class of the student', 'text', true)] }],
    terms: terms('session', 'sessions', 'students', [A.cust('Students'), A.msg('Parent & student messages'), A.staff('Teachers & tutors')]) },
  { key: 'hospitality', icon: 'map-pin', title: 'Hospitality & tourism', text: 'Hotels, travel, restaurants', subtypes: ['Hotel', 'Restaurant', 'Travel agency', 'Tour guide'],
    services: [{ name: 'Table reservation', min: 90, usd: 0, fields: [q('guests', 'Number of guests', 'number', true)] }, { name: 'Travel consultation', min: 30, usd: 0, fields: [q('trip', 'Where and when do you want to travel?', 'textarea', true)] }],
    terms: terms('reservation', 'reservations', 'guests', [A.cust('Guests'), A.msg('Guest messages'), A.pages('Menu & offers')]) },
  { key: 'retail', icon: 'shopping-bag', title: 'Retail & commerce', text: 'Shops, wholesalers, e-commerce', subtypes: ['Shop', 'Wholesaler', 'Online store', 'Boutique'],
    services: [{ name: 'Store appointment', min: 30, usd: 0, fields: [q('looking', 'What are you looking for?', 'text')] }, { name: 'Order pickup', min: 15, usd: 0, fields: [q('order', 'Your order number or name on the order', 'text', true)] }],
    terms: terms('visit', 'visits', 'customers', [A.msg(), A.cust(), A.pages()]) },
  { key: 'transport', icon: 'truck', title: 'Transport & logistics', text: 'Delivery, fleets, dispatch', subtypes: ['Delivery', 'Fleet', 'Courier', 'Haulage'],
    services: [{ name: 'Parcel pickup', min: 30, usd: 0, fields: [q('address', 'Pickup address', 'textarea', true), q('parcel', 'What are we collecting?', 'text', true)] }, { name: 'Delivery slot', min: 30, usd: 0, fields: [q('address', 'Delivery address', 'textarea', true)] }],
    terms: terms('pickup', 'pickups', 'customers', [A.msg(), A.dev(), A.cal()]) },
  { key: 'professional', icon: 'scale', title: 'Professional services', text: 'Legal, consulting, accounting', subtypes: ['Legal', 'Consulting', 'Accounting', 'Agency'],
    services: [{ name: 'Initial consultation', min: 30, usd: 0, fields: [q('matter', 'Briefly, what is this about?', 'textarea', true)] }, { name: 'Strategy session', min: 60, usd: 20, fields: [q('matter', 'What do you want to work on?', 'textarea', true)] }],
    terms: terms('consultation', 'consultations', 'clients', [A.crm('Leads & clients'), A.msg(), A.svc()]) },
  { key: 'automotive', icon: 'key-round', title: 'Automotive', text: 'Repairs, servicing, dealerships', subtypes: ['Workshop', 'Car wash', 'Dealership', 'Spare parts'],
    services: [{ name: 'Vehicle inspection', min: 45, usd: 5, fields: [q('car', 'Make, model and year', 'text', true), q('plate', 'Plate number', 'text')] }, { name: 'Service & repair', min: 120, usd: 0, fields: [q('car', 'Make, model and year', 'text', true), q('problem', 'What is wrong?', 'textarea', true)] }],
    terms: terms('job', 'jobs', 'customers', [A.cust(), A.msg(), A.cal()]) },
  { key: 'construction', icon: 'layers', title: 'Construction & engineering', text: 'Contractors, projects, maintenance', subtypes: ['Contractor', 'Engineering', 'Maintenance', 'Interior fit-out'],
    services: [{ name: 'Site visit', min: 60, usd: 0, fields: [q('site', 'Site address', 'textarea', true), q('work', 'What work is needed?', 'textarea', true)] }, { name: 'Quote consultation', min: 30, usd: 0, mode: 'enquiry', fields: [ABOUT, q('budget', 'Rough budget', 'text')] }],
    terms: terms('site visit', 'site visits', 'clients', [A.crm(), A.msg(), A.pages('Projects page')]) },
  { key: 'fitness', icon: 'activity', title: 'Fitness & wellness', text: 'Gyms, trainers, studios', subtypes: ['Gym', 'Personal trainer', 'Yoga studio', 'Sports club'],
    services: [{ name: 'Personal training', min: 60, usd: 8 }, { name: 'Trial session', min: 45, usd: 0 }],
    terms: terms('session', 'sessions', 'members', [A.cust('Members'), A.staff('Trainers'), A.svc('Classes & sessions')]) },
  { key: 'events', icon: 'calendar-days', title: 'Events & entertainment', text: 'Planners, venues, ticketing', subtypes: ['Planner', 'Venue', 'Photographer', 'DJ & entertainment'],
    services: [{ name: 'Planning consultation', min: 45, usd: 0, fields: [q('event', 'Type of event and date', 'text', true), q('guests', 'Expected guests', 'number')] }, { name: 'Venue tour', min: 30, usd: 0 }],
    terms: terms('booking', 'bookings', 'clients', [A.crm(), A.msg(), A.pages('Packages page')]) },
  { key: 'agriculture', icon: 'package', title: 'Agriculture', text: 'Farms, suppliers, distribution', subtypes: ['Farm', 'Supplier', 'Distributor', 'Agro-processing'],
    services: [{ name: 'Farm visit', min: 60, usd: 0 }, { name: 'Produce pickup', min: 30, usd: 0 }],
    terms: terms('pickup', 'pickups', 'buyers', [A.crm('Buyers & leads'), A.msg(), A.dev('Sensors')]) },
  { key: 'manufacturing', icon: 'cpu', title: 'Manufacturing', text: 'Production, inventory, suppliers', subtypes: ['Factory', 'Workshop', 'Supplier', 'Assembly'],
    services: [{ name: 'Factory tour', min: 60, usd: 0, fields: [q('group', 'Company and group size', 'text', true)] }, { name: 'Order consultation', min: 30, usd: 0, mode: 'enquiry', fields: [q('product', 'What do you want made or supplied?', 'textarea', true), q('qty', 'Quantity needed', 'text', true), q('deadline', 'When do you need it?', 'text')] }],
    terms: terms('appointment', 'appointments', 'customers', [A.crm('Customers & suppliers'), A.msg(), A.dev()]) },
  { key: 'other', icon: 'sparkles', title: 'Other', text: 'Any other type of business', subtypes: [],
    services: [{ name: 'Consultation', min: 30, usd: 0 }],
    terms: terms('booking', 'bookings', 'customers', [A.msg(), A.cust(), A.svc()], "Today's schedule") },
];

/** Workspaces made before the wider list used these three older keys. */
const LEGACY: Record<string, string> = { clinic: 'healthcare', salon: 'beauty', delivery: 'transport' };
export const industryOf = (key: string | undefined): Industry => {
  const k = LEGACY[key ?? ''] ?? key ?? 'other';
  return INDUSTRIES.find((i) => i.key === k) ?? INDUSTRIES[INDUSTRIES.length - 1]!;
};
export const termsFor = (key: string | undefined): Terms => industryOf(key).terms;
