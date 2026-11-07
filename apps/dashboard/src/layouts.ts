import { html, mount, $, $$, type Raw } from './lib/html';
import { ic, type IconName } from './lib/icons';
import { current, logout } from './lib/session';
import { api } from './lib/api';
import { toast, openModal } from './lib/ui';
import { initials } from './lib/format';
import { navigate } from './router';
import { clearStore, loadSettings } from './lib/store';

import { hasFeatureAccess, type FeatureKey } from './lib/fb/plan';

const root = (): HTMLElement => document.getElementById('app')!;

const NAV: { label?: string; items: { href?: string; icon: IconName; text: string; key?: string; feature?: FeatureKey; comingSoon?: boolean }[] }[] = [
  { items: [
    { href: '/app', icon: 'house', text: 'Home' },
    { href: '/app/bookings', icon: 'calendar-check', text: 'Bookings', key: 'bk' },
    { href: '/app/calendar', icon: 'calendar-days', text: 'Calendar' },
    { href: '/app/messages', icon: 'message-square', text: 'Messages', key: 'msg' },
    { href: '/app/customers', icon: 'users', text: 'Customers' },
  ] },
  { label: 'Business', items: [
    { href: '/app/services', icon: 'list-checks', text: 'Services' },
    { href: '/app/shop', icon: 'shopping-bag', text: 'Shop', key: 'shop' },
    { href: '/app/enquiries', icon: 'mail', text: 'Service enquiries', key: 'enq' },
    { href: '/app/team', icon: 'id-card', text: 'Bookable staff' },
    { href: '/app/access', icon: 'users', text: 'Team access' },
    { href: '/app/booking-page', icon: 'link', text: 'Booking page' },
  ] },
  { label: 'Workspace tools', items: [
    { href: '/app/crm', icon: 'handshake', text: 'CRM' },
    { href: '/app/whatsapp', icon: 'message-circle', text: 'WhatsApp Business' },
    { href: '/app/insights', icon: 'activity', text: 'Business insights' },
    { href: '/app/waitlist', icon: 'clock', text: 'Revenue protection' },
    { href: '/app/devices', icon: 'cpu', text: 'Devices', feature: 'devices' },
    { href: '/app/automations', icon: 'workflow', text: 'Automations', feature: 'automations' },
    { href: '/app/content', icon: 'globe', text: 'Website pages' },
    { href: '/app/compliance', icon: 'scale', text: 'Data protection', feature: 'compliance' },
  ] },
  { label: 'Account', items: [
    { href: '/app/billing', icon: 'credit-card', text: 'Plan & billing' },
    { href: '/app/license', icon: 'server', text: 'Cluster & license' },
    { href: '/app/security', icon: 'shield-check', text: 'Security' },
    { href: '/app/backups', icon: 'database', text: 'Backups' },
    { href: '/app/api-keys', icon: 'key-round', text: 'API keys' },
    { href: '/app/audit', icon: 'history', text: 'Audit log' },
    { href: '/app/settings', icon: 'settings', text: 'Settings' },
  ] },
];

export function brand(size = '', logoUrl?: string | null): Raw {
  const h = size === 'lg' ? 44 : 32;
  if (logoUrl) {
    return html`<span class="brand ${size}"><img class="brand-lockup" src="${logoUrl}" alt="Logo" height="${h}" style="height:${h}px;max-width:140px;object-fit:contain;display:block"></span>`;
  }
  return html`<span class="brand ${size}"><img class="brand-lockup" src="/zexcore-logo-light.png" alt="ZexCore" height="${h}" style="height:${h}px;width:auto;display:block"></span>`;
}

let unread = 0;       // unread customer messages
let fresh = 0;        // new bookings since this person last opened Bookings
let freshOrders = 0;  // new shop orders since they last opened Shop
let freshEnq = 0;     // new enquiries since they last opened Service enquiries
let prevFresh = -1;
let pollInterval: ReturnType<typeof setInterval> | null = null;

const onBookings = (): boolean => location.pathname === '/app/bookings' || location.pathname.startsWith('/app/bookings/');
const baseTitle = (): string => document.title.replace(/^\(\d+\) /, '');

/** Re-applies the "(3)" in the tab title after a page sets its own title. */
export function syncTitle(): void { const t = unread + fresh + freshOrders + freshEnq; document.title = t > 0 ? `(${t}) ${baseTitle()}` : baseTitle(); }

function paint(): void {
  const total = unread + fresh + freshOrders + freshEnq;
  $$('[data-unread]').forEach((el) => { el.textContent = unread > 99 ? '99+' : String(unread); el.classList.toggle('hidden', unread === 0); });
  $$('[data-booking-badge]').forEach((el) => { el.textContent = fresh > 99 ? '99+' : String(fresh); el.classList.toggle('hidden', fresh === 0); });
  $$('[data-shop-badge]').forEach((el) => { el.textContent = freshOrders > 99 ? '99+' : String(freshOrders); el.classList.toggle('hidden', freshOrders === 0); });
  $$('[data-enq-badge]').forEach((el) => { el.textContent = freshEnq > 99 ? '99+' : String(freshEnq); el.classList.toggle('hidden', freshEnq === 0); });
  $$('[data-unread-pip]').forEach((el) => { el.textContent = total > 99 ? '99+' : String(total); el.classList.toggle('hidden', total === 0); });
  syncTitle();
}

/** Opening Bookings is "looking": clear the count here and on the server so it stays cleared after a refresh. */
export async function bookingsViewed(): Promise<void> {
  fresh = 0; prevFresh = 0; paint();
  await api('/api/notifications/seen', { method: 'POST' }).catch(() => undefined);
}

/** Opening Shop or Service enquiries is "looking" too. */
export async function sectionViewed(kind: 'orders' | 'enquiries'): Promise<void> {
  if (kind === 'orders') freshOrders = 0; else freshEnq = 0;
  paint();
  await api('/api/notifications/seen', { method: 'POST', body: { kind } }).catch(() => undefined);
}
const onPath = (p: string): boolean => location.pathname === p || location.pathname.startsWith(`${p}/`);

export async function refreshUnread(): Promise<void> {
  let prevOrders = freshOrders, prevEnq = freshEnq;
  try {
    const n = await api<{ bookings: number; messages: number; orders?: number; enquiries?: number }>('/api/notifications');
    unread = n.messages; fresh = n.bookings; freshOrders = n.orders ?? 0; freshEnq = n.enquiries ?? 0;
  } catch { return; }   // a failed check must not make the counts vanish or flicker
  if (onPath('/app/shop') && freshOrders > 0) await sectionViewed('orders');
  if (onPath('/app/enquiries') && freshEnq > 0) await sectionViewed('enquiries');
  if (prevFresh >= 0 && freshOrders > prevOrders) { const d = freshOrders - prevOrders; toast(`${d} new order${d > 1 ? 's' : ''}`, 'info'); }
  if (prevFresh >= 0 && freshEnq > prevEnq) { const d = freshEnq - prevEnq; toast(`${d} new enquir${d > 1 ? 'ies' : 'y'}`, 'info'); }
  prevOrders = freshOrders; prevEnq = freshEnq;
  if (onBookings() && fresh > 0) { await bookingsViewed(); return; }   // already looking at them: like an open WhatsApp chat
  if (prevFresh >= 0 && fresh > prevFresh) { const d = fresh - prevFresh; toast(`${d} new booking${d > 1 ? 's' : ''}`, 'info'); }
  prevFresh = fresh;
  paint();
}

export function startPolling(): void {
  if (pollInterval) return;
  pollInterval = setInterval(() => { if (!document.hidden) void refreshUnread(); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshUnread(); });
}

export function stopPolling(): void {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function isActive(href: string, path: string): boolean {
  return href === '/app' ? path === '/app' : path === href || path.startsWith(href + '/');
}

/** Renders the signed-in chrome once and returns the element views render into. */
export async function appLayout(path: string, onNew: () => void): Promise<HTMLElement> {
  let view = $('#view');
  const me = current()!;
  if (!view || !$('.app')) {
    // Render the shell immediately with the tenant name from cached session data —
    // no Firestore round-trip before first paint. Settings are patched in the background.
    const bizName = me.tenant.name;
    const isDismissed = Boolean(sessionStorage.getItem('zx.verify_dismissed'));
    mount(root(), html`
      <div class="app">
        <aside class="sidebar" aria-label="Main">
          <a href="/app" data-link>${brand()}</a>
          ${NAV.map((g) => html`
            ${g.label ? html`<div class="nav-label">${g.label}</div>` : ''}
            ${g.items.filter((i) => !(me.role === 'viewer' && i.href === '/app/access')).map((i) => {
              if (i.comingSoon) {
                return html`<div class="nav-link nav-link-disabled" style="cursor:default;opacity:0.75" aria-disabled="true" title="Coming soon">
                  ${ic(i.icon)}
                  <span>${i.text}</span>
                  <span class="badge" style="margin-left:auto;font-size:0.6875rem;padding:2px 7px;font-weight:600;letter-spacing:0;background:var(--canvas,#f1f5f9);color:var(--muted,#64748b);border-color:var(--border,#cbd5e1)">Coming soon</span>
                </div>`;
              }
              const locked = i.feature && !hasFeatureAccess(me.tenant.tier, i.feature);
              return html`<a class="nav-link" href="${i.href!}" data-link data-nav="${i.href!}">
                ${ic(i.icon)}
                <span>${i.text}</span>
                ${locked ? html`<span class="nav-lock" title="Plan upgrade required" style="margin-left:auto;opacity:0.6;display:inline-flex">${ic('lock', 'ico-xs')}</span>` : ''}
                ${i.key === 'msg' ? html`<span class="badge-n hidden" data-unread>0</span>` : ''}
                ${i.key === 'bk' ? html`<span class="badge-n hidden" data-booking-badge>0</span>` : ''}
                ${i.key === 'shop' ? html`<span class="badge-n hidden" data-shop-badge>0</span>` : ''}
                ${i.key === 'enq' ? html`<span class="badge-n hidden" data-enq-badge>0</span>` : ''}
              </a>`;
            })}`)}
        </aside>
        <div class="content-col">
          <header class="topbar">
            <a href="/app" data-link class="brand-link">${brand()}</a>
            <span class="biz-chip"><span class="dot dot-success pulse"></span><span class="t">${bizName}</span></span>
            <span class="spacer"></span>
            <a href="/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm topbar-back-site" title="Back to website (opens in new page)">
              ${ic('globe', 'ico-sm')}<span>Back to website</span>
            </a>
            <button class="btn btn-primary btn-sm" data-new>${ic('plus', 'ico-sm')} New</button>
            <button class="icon-circle" data-bell aria-label="Notifications" aria-haspopup="dialog">${ic('bell')}<span class="pip hidden" data-unread-pip></span></button>
            <div class="menu-wrap">
              <button class="avatar-btn" data-menu aria-haspopup="true" aria-label="Account menu">${initials(me.user.name || me.tenant.name)}</button>
              <div class="menu hidden" data-menu-panel role="menu">
                <div class="who"><div style="font-weight:650">${me.user.name || 'Account'}</div><div class="muted small truncate">${me.user.email ?? ''}</div><div class="small faint" style="margin-top:2px">${me.tenant.name} · ${me.role ?? ''}</div></div>
                <a href="/app/settings" data-link role="menuitem">${ic('settings', 'ico-sm')} Settings</a>
                <a href="/app/billing" data-link role="menuitem">${ic('credit-card', 'ico-sm')} Plan & billing</a>
                <a href="/" target="_blank" rel="noopener" role="menuitem">${ic('globe', 'ico-sm')} Back to website</a>
                <button data-logout role="menuitem">${ic('log-out', 'ico-sm')} Sign out</button>
              </div>
            </div>
          </header>
          ${me.role === 'viewer' ? html`<div class="verify-banner" role="status">${ic('eye')}<span class="grow"><b>Read-only access.</b> You can look at records and payments but not change anything.</span></div>` : ''}
          ${me.user.emailVerified === false && !isDismissed ? html`<div class="verify-banner" data-verify-banner role="status">
            ${ic('mail')}
            <span class="grow" data-verify-text><b>Confirm your email.</b> We sent a link to ${me.user.email ?? 'your address'}. You need it to upgrade your plan.</span>
            <button class="btn btn-secondary btn-sm" data-resend>Resend</button>
            <button type="button" class="btn btn-ghost btn-sm" data-dismiss-verify aria-label="Dismiss this message">Cancel</button>
          </div>` : ''}
          <main class="main" id="view" tabindex="-1"></main>
        </div>
        <nav class="bottom-nav" aria-label="Primary">
          <a href="/app" data-link data-nav="/app">${ic('house')}Home</a>
          <a href="/app/bookings" data-link data-nav="/app/bookings">${ic('calendar-check')}Bookings<span class="badge-n hidden" data-booking-badge>0</span></a>
          <a href="/app/calendar" data-link data-nav="/app/calendar">${ic('calendar-days')}Calendar</a>
          <a href="/app/messages" data-link data-nav="/app/messages">${ic('message-square')}Messages<span class="badge-n hidden" data-unread>0</span></a>
          <a href="/app/more" data-link data-nav="/app/more">${ic('ellipsis')}More</a>
        </nav>
      </div>`);
    view = $('#view')!;
    $('[data-new]')!.addEventListener('click', onNew);
    $('[data-resend]')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
      try {
        await api('/api/auth/email/resend', { method: 'POST' });
        // Say it once, then get out of the way.
        const t = $('[data-verify-text]'); if (t) t.innerHTML = '<b>Link sent.</b> Check your inbox and spam folder.';
        b.remove();
        setTimeout(() => { try { sessionStorage.setItem('zx.verify_dismissed', '1'); } catch { /* ignore */ } $('[data-verify-banner]')?.remove(); }, 6000);
      }
      catch (x) { b.disabled = false; toast(x instanceof Error ? x.message : 'Could not send the email', 'error'); }
    });
    $('[data-dismiss-verify]')?.addEventListener('click', () => {
      try { sessionStorage.setItem('zx.verify_dismissed', '1'); } catch { /* ignore */ }
      $('[data-verify-banner]')?.remove();
    });
    // The link opens in another tab; when the person comes back, re-check and drop the banner once confirmed.
    if (document.querySelector('[data-verify-banner]')) {
      const recheck = async (): Promise<void> => {
        try {
          const r = await api<{ verified: boolean }>('/api/auth/email/status');
          if (r.verified) { document.querySelector('[data-verify-banner]')?.remove(); toast('Email confirmed. Thank you.', 'success'); window.removeEventListener('focus', recheck); }
        } catch { /* ignore */ }
      };
      window.addEventListener('focus', recheck);
    }
    const menu = $('[data-menu]')!, panel = $('[data-menu-panel]')!;
    menu.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); });
    document.addEventListener('click', () => panel.classList.add('hidden'));
    $('[data-logout]')!.addEventListener('click', () => { logout(); clearStore(); navigate('/signin'); });
    $('[data-bell]')!.addEventListener('click', () => openNotifications());
    void refreshUnread();
    startPolling();
    void import('./lib/reminders').then((m) => m.startReminders());
    // Patch logo and business name from settings without blocking first paint.
    void loadSettings().then((s) => {
      const name = s.publicName || me.tenant.name;
      $$('.biz-chip .t').forEach((el) => { el.textContent = name; });
      if (s.logoUrl) {
        $$('.brand-lockup').forEach((el) => { if (el instanceof HTMLImageElement) el.src = s.logoUrl!; });
      }
    }).catch(() => undefined);
  }
  $$('[data-nav]').forEach((a) => { isActive(a.dataset.nav!, path) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  const moreActive = !['/app', '/app/bookings', '/app/calendar', '/app/messages'].some((h) => isActive(h, path));
  $('.bottom-nav [data-nav="/app/more"]')?.[moreActive ? 'setAttribute' : 'removeAttribute']('aria-current', 'page');
  if (isActive('/app/bookings', path)) void bookingsViewed();
  if (isActive('/app/shop', path)) void sectionViewed('orders');
  if (isActive('/app/enquiries', path)) void sectionViewed('enquiries');   // Messages clear per conversation, as in WhatsApp
  return view;
}

export function leaveApp(): void {
  stopPolling();
  prevFresh = -1; unread = 0; fresh = 0; freshOrders = 0; freshEnq = 0;
  if ($('.app')) mount(root(), '');
}

export function authLayout(inner: Raw, showBack = true): void {
  mount(root(), html`<div class="auth-wrap">
    ${showBack ? html`<a class="auth-back-link" href="/" data-link aria-label="Back to website">${ic('arrow-left', 'ico-sm')} Back to website</a>` : ''}
    <a class="auth-logo" href="/" data-link aria-label="ZexCore home">
      <img src="/zexcore-logo-light.png" alt="ZexCore" width="168" height="44" style="height:44px;width:auto;display:block;margin:0 auto">
    </a>
    <main class="auth-card">${inner}</main>
    <footer class="auth-footer">
      ${ic('shield-check', 'ico-sm')}
      <span>Protected workspace access. Your business data stays isolated.</span>
    </footer>
  </div>`);
}

/** The bell: what is new, with a way straight to it. Looking at the new bookings counts as seeing them. */
function openNotifications(): void {
  const row = (href: string, icon: IconName, n: number, one: string, many: string): Raw => html`<a class="list-item" href="${href}" data-link data-close>${ic(icon)}<span class="grow"><b>${n}</b> ${n === 1 ? one : many}</span>${ic('chevron-right', 'ico-sm')}</a>`;
  openModal({
    title: 'Notifications',
    body: fresh + unread + freshOrders + freshEnq === 0 ? html`<p class="muted" style="padding:8px 0">You are all caught up.</p>`
      : html`<div class="list">${fresh ? row('/app/bookings', 'calendar-check', fresh, 'new booking request', 'new booking requests') : ''}${freshOrders ? row('/app/shop#orders', 'shopping-bag', freshOrders, 'new shop order', 'new shop orders') : ''}${freshEnq ? row('/app/enquiries', 'mail', freshEnq, 'new service enquiry', 'new service enquiries') : ''}${unread ? row('/app/messages', 'message-square', unread, 'unread customer message', 'unread customer messages') : ''}</div>`,
    footer: html`<button class="btn btn-secondary" data-close>Close</button>`,
    onMount: (el, close) => el.querySelectorAll('a[data-link]').forEach((a) => a.addEventListener('click', () => close())),
  });
  if (fresh) void bookingsViewed();
  if (freshOrders) void sectionViewed('orders');
  if (freshEnq) void sectionViewed('enquiries');
}
