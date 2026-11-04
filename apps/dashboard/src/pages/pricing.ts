/** Pricing: generated from the same constants the database rules and payments Worker use, so the page cannot drift from reality. */
import { LIMITS, PRICES, hasFeatureAccess, type Tier } from '../lib/fb/plan';
import { block, cta, intro, shell, table } from './ref';

const usd = (amount: number): string => '$' + amount.toLocaleString('en-US');
const lim = (n: number | null, t?: Tier): string => (n === null ? (t === 'dedicated' ? 'Custom' : 'Unlimited (fair use)') : t === 'dedicated' ? 'Custom' : n.toLocaleString('en-US'));
const NAMES: Record<Tier, string> = { free: 'Free', starter: 'Starter', growth: 'Growth', agency: 'Agency', enterprise: 'Enterprise', dedicated: 'Dedicated' };
const BLURB: Record<Tier, string> = {
  free: 'Take your first bookings.', starter: 'A single location getting started.', growth: 'A busy calendar and a small team.',
  agency: 'Several locations or many staff.', enterprise: 'Large organisations with no limits.', dedicated: 'A dedicated setup, built with our team.',
};

export function renderPricingPage(): string {
  const tiers = Object.keys(LIMITS) as Tier[];
  const plan = (t: Tier): string => {
    const contact = t === 'enterprise' || t === 'dedicated';
    const pr = t === 'free' || contact ? null : PRICES[t as keyof typeof PRICES];
    const price = contact ? 'Contact us' : pr ? usd(pr.monthlyUsd) : '$0';
    const annual = pr ? `<div class="rp-note" style="margin:10px 0 0;padding:8px 12px">${usd(pr.annualUsd)} a year, two months free</div>` : '';
    const featured = t === 'growth';
    return `<div class="rp-card" style="${featured ? 'border-color:#E50920;box-shadow:0 8px 30px rgba(229,9,32,.12)' : ''}">
      ${featured ? '<span class="rp-tag">MOST POPULAR</span>' : ''}<h3>${NAMES[t]}</h3>
      <div style="font-size:1.9rem;font-weight:800;color:#0f172a;margin:6px 0">${price}${contact ? '' : '<span style="font-size:.9rem;font-weight:500;color:#64748b"> / month</span>'}</div>
      <p>${BLURB[t]}</p>${annual}
      <ul style="padding:0;margin:14px 0;color:#475569;line-height:1.9;font-size:.93rem;list-style:none">
        <li style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${lim(LIMITS[t].bookingsPerMonth, t)} bookings a month</li>
        <li style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${lim(LIMITS[t].staff, t)} bookable ${LIMITS[t].staff === 1 ? 'staff member' : 'staff'}</li>
        <li style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${lim(LIMITS[t].services, t)} services</li>
        <li style="display:flex;align-items:center;gap:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${lim(LIMITS[t].crmContacts, t)} contacts</li>
      </ul>
      <a href="${t === 'enterprise' || t === 'dedicated' ? '/contact' : '/signup'}" data-link class="btn ${featured ? 'btn-primary' : 'btn-secondary'}" style="width:100%;justify-content:center">${t === 'enterprise' || t === 'dedicated' ? 'Talk to us' : t === 'free' ? 'Start free' : 'Choose ' + NAMES[t]}</a></div>`;
  };
  return shell('pricing',
    intro('PRICING', 'Simple Plans. No Surprises.', 'Start free. Upgrade when you outgrow it. Prices are in USD; card payments are charged in naira at the day\'s rate through Paystack. Enterprise and Dedicated are set up with our team.'),
    block('Choose a plan', 'Every plan includes online booking, customers and your public booking page.', `<div class="rp-grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))">${tiers.map(plan).join('')}</div>`, true),
    block('Compare Plans', 'Every limit is enforced by the platform — not just the interface.', table(
      ['', ...tiers.map((t) => NAMES[t])],
      [
        ['Bookings / month', ...tiers.map((t) => lim(LIMITS[t].bookingsPerMonth, t))],
        ['Bookable staff', ...tiers.map((t) => lim(LIMITS[t].staff, t))],
        ['Team logins (owner, admins, editors)', ...tiers.map((t) => lim(LIMITS[t].staff, t))],
        ['Services', ...tiers.map((t) => lim(LIMITS[t].services, t))],
        ['Booking pages', ...tiers.map((t) => lim(LIMITS[t].cmsPages, t))],
        ['Contacts', ...tiers.map((t) => lim(LIMITS[t].crmContacts, t))],
        ['Your own logo', ...tiers.map((t) => (hasFeatureAccess(t, 'branding') ? 'Included' : '—'))],
        ['Data protection tools', ...tiers.map((t) => (hasFeatureAccess(t, 'compliance') ? 'Included' : '—'))],
        ['Devices', ...tiers.map((t) => (hasFeatureAccess(t, 'devices') ? lim(LIMITS[t].devices, t) : '—'))],
        ['Automation rules', ...tiers.map((t) => (hasFeatureAccess(t, 'automations') ? lim(LIMITS[t].rules, t) : '—'))],
      ])),
    block('Questions', '', `<div class="rp-grid">
      <div class="rp-card"><h3>Do I need a card to start?</h3><p>No. Creating a workspace is free.</p></div>
      <div class="rp-card"><h3>What happens if my plan expires?</h3><p>You get a 3-day grace period, then the workspace returns to Free. Nothing is deleted; the Free limits apply to new records.</p></div>
      <div class="rp-card"><h3>How do I pay?</h3><p>Through Paystack or card checkout with debit/credit card, bank transfer or USSD.</p></div>
      <div class="rp-card"><h3>Can I change plans?</h3><p>Yes. Upgrade from the Billing page whenever you like, or email us and we will help you switch.</p></div></div>`, true),
    cta('Start Free Today', 'No card needed. Upgrade only when your calendar fills up.', [{ text: 'Create Your Workspace', href: '/signup', primary: true }, { text: 'Contact Us', href: '/contact' }]),
  );
}
