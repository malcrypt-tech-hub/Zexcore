import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { isSignedIn } from '../lib/session';
import { brand } from '../layouts';

const EMAIL = 'hello@zexcore.com.ng';
const root = (): HTMLElement => document.getElementById('app')!;

function setMeta(title: string, desc: string): void {
  document.title = title;
  document.querySelector('meta[name=description]')?.setAttribute('content', desc);
}

function shell(path: string, body: Raw): void {
  const link = (href: string, t: string) => html`<a href="${href}" data-link ${path === href ? 'aria-current="page"' : ''}>${t}</a>`;
  const signed = isSignedIn();
  mount(root(), html`<div class="site">
    <header class="site-nav"><div class="container">
      <a href="/" data-link aria-label="ZexCore home">${brand()}</a>
      <nav class="site-links" aria-label="Main">${link('/product', 'Product')}${link('/pricing', 'Pricing')}${link('/security', 'Security')}${link('/contact', 'Contact')}</nav>
      <div class="site-cta">
        ${signed ? html`<a class="btn btn-primary btn-sm" href="/app" data-link>Open dashboard</a>` : html`<a class="btn btn-ghost btn-sm hide-sm" href="/signin" data-link>Sign in</a><a class="btn btn-primary btn-sm" href="/signup" data-link>Get started</a>`}
        <button class="btn btn-ghost btn-sm btn-icon burger" data-burger aria-label="Menu" aria-expanded="false">${ic('menu')}</button>
      </div></div>
      <div class="mobile-menu hidden" data-mm><a href="/product" data-link>Product</a><a href="/pricing" data-link>Pricing</a><a href="/security" data-link>Security</a><a href="/contact" data-link>Contact</a>${signed ? '' : html`<a href="/signin" data-link>Sign in</a>`}</div>
    </header>
    <main id="main">${body}</main>
    <footer class="site-footer"><div class="container">
      <div class="foot-grid"><div>${brand()}<p style="margin-top:12px;max-width:300px;font-size:.9rem">Bookings, deposits and customer conversations for businesses in Nigeria and beyond. A product of Zexlabs.</p></div>
        <div><h4>Product</h4><ul><li><a href="/product" data-link>Features</a></li><li><a href="/pricing" data-link>Pricing</a></li><li><a href="/security" data-link>Security</a></li></ul></div>
        <div><h4>Company</h4><ul><li><a href="/contact" data-link>Contact</a></li><li><a href="mailto:${EMAIL}">${EMAIL}</a></li></ul></div>
        <div><h4>Legal</h4><ul><li><a href="/privacy" data-link>Privacy</a></li><li><a href="/terms" data-link>Terms</a></li></ul></div></div>
      <div class="foot-bottom"><span>© ${new Date().getFullYear()} Zexlabs. All rights reserved.</span><span>ZexCore, a product of Zexlabs</span></div></div></footer></div>`);
  $('[data-burger]')?.addEventListener('click', (e) => { const mm = $('[data-mm]')!; const open = mm.classList.toggle('hidden') === false; (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open)); });
  window.scrollTo(0, 0);
}


function legal(path: string, title: string, body: Raw): void {
  setMeta(`${title} — ZexCore`, `${title} for ZexCore.`);
  shell(path, html`<section class="page-hero"><div class="container"><h1>${title}</h1></div></section><section class="section"><div class="container prose">${body}</div></section>`);
}

export function renderPrivacy(): void {
  legal('/privacy', 'Privacy Policy', html`
    <p class="muted">Draft for review. Last updated 25 October 2026.</p>
    <h2>What we collect</h2><p>Account details (name, email), business details you enter, and, on behalf of the businesses that use ZexCore, their customers' booking details such as name, phone number, email and appointment times.</p>
    <h2>How we use it</h2><p>To provide the service: showing bookings, taking deposits, and keeping a record of changes. We do not sell personal data.</p>
    <h2>Payments</h2><p>Card payments are processed by Paystack. We do not store card numbers.</p>
    <h2>Your rights</h2><p>You can ask us to access, correct or delete your data. Email ${EMAIL}.</p>
    <h2>Contact</h2><p>${EMAIL}</p>`);
}
export function renderTerms(): void {
  legal('/terms', 'Terms of Service', html`
    <p class="muted">Draft for review. Last updated 25 October 2026.</p>
    <h2>The service</h2><p>ZexCore provides booking, deposit collection and customer messaging tools to businesses.</p>
    <h2>Your account</h2><p>Keep your password safe. You are responsible for activity under your workspace and for the accuracy of the services and prices you publish.</p>
    <h2>Payments</h2><p>Deposits are collected by Paystack and settle to your Paystack account. Paystack's terms apply to those payments.</p>
    <h2>Acceptable use</h2><p>Do not use ZexCore for unlawful activity or to send unsolicited messages.</p>
    <h2>Contact</h2><p>${EMAIL}</p>`);
}

export function renderNotFound(): void {
  setMeta('Page not found — ZexCore', 'That page does not exist.');
  shell('', html`<section class="section"><div class="container" style="text-align:center;max-width:520px"><span class="icon-tile" style="margin:0 auto 16px;background:var(--primary-tint);color:var(--primary)">${ic('search')}</span><h1 style="font-size:2rem">We can't find that page</h1><p class="muted" style="margin:10px 0 24px">The link may be wrong or the page may have moved.</p><a class="btn btn-primary" href="/" data-link>Back to home</a></div></section>`);
}
