/** Home: a plain promise, what you get, how to start, how your data is protected, who it is for, and answers to the questions owners ask first. */
import { LIMITS, PRICES } from '../lib/fb/plan';
import { block, cards, cta, shell, steps } from './ref';

const FREE_BOOKINGS = LIMITS.free.bookingsPerMonth;
const STARTER = PRICES.starter.monthlyUsd;

export function renderHomePage(): string {
  const hero = `<section class="rp-hero" id="home-flagship-hero"><div class="site-container"><div class="rp-hero-copy">
    <h1 class="rp-hero-title">Take bookings. Collect deposits.<br /><span class="rp-hero-red">Stop chasing customers.</span></h1>
    <p class="rp-hero-desc" style="font-weight:600">A booking page, customer records and a WhatsApp inbox in one place, for salons, clinics, studios and workshops. Customers can pay a deposit by card through Paystack, straight to your bank account.</p>
    <div class="rp-hero-actions">
      <a href="/signup" data-link class="btn btn-primary btn-lg" id="btn-hero-primary">Start free</a>
      <a href="/demo" data-link class="btn btn-secondary btn-lg" id="btn-hero-secondary">Try a demo booking page</a>
    </div>
    <div class="rp-hero-strip">
      <div class="rp-hero-strip-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Free to start, no card</div>
      <div class="rp-hero-strip-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>Pay in naira or by card</div>
      <div class="rp-hero-strip-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Your customers' data stays in your workspace</div>
    </div>
  </div></div></section>`;

  return shell('home',
    hero,
    block('Everything a booking business needs', 'One place instead of a notebook, a spreadsheet and three apps.', cards([
      { title: 'Online booking', text: 'A public page where customers choose a service and a time. The same time can never be booked twice.' },
      { title: 'Customers & leads', text: 'Every booking becomes a customer record with a history you can search.' },
      { title: 'Deposits', text: 'Ask for a deposit when someone books. They pay by card through Paystack and the money goes to your bank account.' },
      { title: 'Inbox', text: 'Reply to customers on WhatsApp with the booking details already filled in.' },
      { title: 'Device monitoring', text: 'Track equipment readings, such as a cold room, and get an email when something is off. Growth plan and above.' },
      { title: 'Automations', text: 'Turn repeat tasks into rules that email you or call your other tools. Growth plan and above.' },
    ], 300), true),

    block('Get started in three steps', 'From sign-up to your first booking in a few minutes.', steps([
      { title: 'Create your workspace', text: 'Sign up with your business name. Your public booking address is created for you.' },
      { title: 'Add services and hours', text: 'Say what you offer, how long it takes and when you work.' },
      { title: 'Share your link', text: 'Put it on WhatsApp, Instagram or your website. Bookings arrive in your dashboard.' },
    ])),

    block('Your data stays yours', 'Each business is kept apart from every other by the database itself, not only by the app.', `<p style="max-width:720px;color:#475569;line-height:1.7;margin:0 0 18px">Private pages need a sign-in, plan limits are checked by the database on every request, and important changes are written to a tamper-evident audit log. You can read exactly how it works.</p><p><a href="/security" data-link class="btn btn-secondary">Read the security model</a></p>`, true),

    block('Built for appointment-based businesses', 'Salons, clinics, studios and workshops.', cards([
      { title: 'Salons & beauty', text: 'Staff calendars, services with durations, and a booking page you can share on WhatsApp or Instagram.' },
      { title: 'Clinics & wellness', text: 'Appointments, a record of every visit and a WhatsApp inbox. Data protection tools come with Starter and above.' },
      { title: 'Workshops & field teams', text: 'Jobs, customers and equipment readings in one place.' },
    ], 300)),

    block('Questions owners ask first', '', cards([
      { title: 'How do deposits reach my bank?', text: 'You add your bank account once in Settings and ZexCore checks the account name with your bank. Each deposit is paid by card through Paystack and settled to that account on Paystack\'s normal schedule. ZexCore does not hold your customers\' money.' },
      { title: 'What does it cost?', text: `Free for up to ${FREE_BOOKINGS} bookings a month. Paid plans start at $${STARTER} a month and are charged in naira at the day\'s rate. Paystack\'s own card fee comes out of each deposit.` },
      { title: 'Do my customers need an account?', text: 'No. They pick a service and a time on your booking page and enter their name and phone number.' },
      { title: 'Can my team log in?', text: 'Yes. Invite people by email as admins or editors. Editors handle bookings, customers, messages, services and website pages; admins also manage settings and the team. The number of logins depends on your plan, and the Free plan is the owner only.' },
      { title: 'What if I stop paying?', text: 'You get a 3-day grace period, then the workspace returns to Free. Nothing is deleted; the Free limits apply to new records.' },
      { title: 'Is my customers\' data safe?', text: 'Each business\'s data is separated by the database\'s own rules, private pages need a sign-in, and changes are recorded in an audit log. The security page has the detail.' },
    ], 380), true),

    cta('Set up your booking page today', 'Create a free workspace, add your services and share your link. Upgrade only when your calendar fills up.', [{ text: 'Create your workspace', href: '/signup', primary: true }, { text: 'See pricing', href: '/pricing' }]),
  );
}

export function setupHomePageEvents(): void { /* the home page is static */ }
