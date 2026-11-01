import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/site.css';
import './styles/modules.css';
import './styles/mobile-app.css';

import { route, setNotFound, setGuard, setAfter, startRouter, navigate } from './router';
import { setUnauthorizedHandler } from './lib/api';
import { loadMe, isSignedIn, current } from './lib/session';
import { appLayout, leaveApp } from './layouts';
import { html, mount } from './lib/html';
import { errorState } from './lib/ui';

const clearLegacySiteStyles = () => {
  document.getElementById('legacy-site-style')?.remove();
};

setUnauthorizedHandler(() => navigate('/signin', true));

const TITLES: Record<string, string> = {
  '/app': 'Home', '/app/bookings': 'Bookings', '/app/calendar': 'Calendar', '/app/messages': 'Messages', '/app/more': 'More',
  '/app/customers': 'Customers', '/app/services': 'Services', '/app/team': 'Team', '/app/booking-page': 'Booking page',
  '/app/billing': 'Plan & billing', '/app/audit': 'Audit log', '/app/settings': 'Settings', '/app/security': 'Security',
  '/app/crm': 'CRM', '/app/devices': 'Devices', '/app/automations': 'Automations', '/app/content': 'Website pages', '/app/compliance': 'Data protection',
  '/docs': 'Documentation', '/documentation': 'Documentation',
  '/pricing': 'Pricing', '/product': 'Product', '/platform': 'Product', '/solutions': 'Solutions', '/modules': 'Modules', '/security': 'Security',
  '/contact': 'Contact', '/about': 'About', '/architecture': 'Architecture', '/multi-tenancy': 'Multi-tenancy', '/automation': 'Automation',
  '/privacy': 'Privacy', '/terms': 'Terms', '/signin': 'Sign in', '/signup': 'Create your workspace', '/forgot-password': 'Reset your password',
};

setGuard(async (ctx) => {
  const inApp = ctx.path === '/app' || ctx.path.startsWith('/app/');
  if (inApp) {
    if (!isSignedIn()) return '/signin';
    try { if (!(await loadMe())) return '/signin'; }
    catch { mount(document.getElementById('app')!, html`<div class="auth-wrap"><div class="auth-card">${errorState('We could not reach ZexCore. Check your connection and try again.')}</div></div>`); document.querySelector('[data-retry]')?.addEventListener('click', () => location.reload()); return ctx.path; }
  }
  if ((ctx.path === '/signin' || ctx.path === '/signup') && isSignedIn()) {
    // Only bother with the async Firebase call when we already have a local session token
    const me = await loadMe().catch(() => null);
    if (me) return '/app';
  }
});
const SITE = 'https://zexcore.com.ng';
const SITE_PAGES = new Set(['/', '/product', '/pricing', '/solutions', '/modules', '/about', '/architecture', '/multi-tenancy', '/automation', '/security', '/contact', '/privacy', '/terms', '/docs', '/documentation']);
function setMeta(path: string): void {
  const head = document.head;
  let canon = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  let robots = head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (SITE_PAGES.has(path)) {
    robots?.remove();
    if (!canon) { canon = document.createElement('link'); canon.rel = 'canonical'; head.appendChild(canon); }
    canon.href = SITE + (path === '/' ? '/' : path);
  } else {
    canon?.remove();
    if (['/signin', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(path) || path.startsWith('/app')) {
      if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; head.appendChild(robots); }
      robots.content = 'noindex, nofollow';
    } else robots?.remove();
  }
}
setAfter((ctx) => { if (TITLES[ctx.path]) document.title = `${TITLES[ctx.path]} — ZexCore`; setMeta(ctx.path); });

const loadLegacy = () => import('./legacySite').then((m) => m.renderLegacySite);
const legacyRoute = (path: string, page: string) =>
  route(path, async () => {
    if (path === '/home') history.replaceState(null, '', '/');
    const render = await loadLegacy();
    render(page as any);
  });

legacyRoute('/', 'home');
legacyRoute('/home', 'home');
legacyRoute('/product', 'platform');
legacyRoute('/platform', 'platform');
legacyRoute('/architecture', 'architecture');
legacyRoute('/multi-tenancy', 'tenancy');
legacyRoute('/automation', 'automation');
legacyRoute('/modules', 'modules');
legacyRoute('/solutions', 'solutions');
legacyRoute('/security', 'security');
legacyRoute('/docs', 'docs');
legacyRoute('/documentation', 'docs');
legacyRoute('/resources', 'resources');
legacyRoute('/pricing', 'pricing');
legacyRoute('/about', 'about');
legacyRoute('/contact', 'contact');

route('/console', () => navigate('/app', true));
route('/dashboard', () => navigate('/app', true));
route('/console/:tab', (ctx) => {
  const aliases: Record<string, string> = { overview: '/app', iot: '/app/devices', crm: '/app/crm', rules: '/app/automations', compliance: '/app/compliance', audit: '/app/audit', whitelabel: '/app/settings', license: '/app/billing', billing: '/app/billing' };
  navigate(aliases[ctx.params.tab] || '/app', true);
});

route('/privacy', async () => { clearLegacySiteStyles(); const { renderPrivacy } = await import('./views/site'); renderPrivacy(); });
route('/terms', async () => { clearLegacySiteStyles(); const { renderTerms } = await import('./views/site'); renderTerms(); });
route('/signin', async () => { clearLegacySiteStyles(); leaveApp(); const { renderSignIn } = await import('./views/auth'); renderSignIn(); });
route('/signup', async () => { clearLegacySiteStyles(); leaveApp(); const { renderSignUp } = await import('./views/auth'); renderSignUp(); });
route('/forgot-password', async () => { clearLegacySiteStyles(); leaveApp(); const { renderForgot } = await import('./views/auth'); renderForgot(); });
route('/reset-password', async () => { clearLegacySiteStyles(); leaveApp(); const { renderReset } = await import('./views/auth'); renderReset(); });
route('/verify-email', async () => { clearLegacySiteStyles(); leaveApp(); const { renderVerify } = await import('./views/auth'); void renderVerify(); });

const handleAuthAction = (ctx: { query: URLSearchParams }) => {
  clearLegacySiteStyles();
  leaveApp();
  const mode = ctx.query.get('mode');
  const code = ctx.query.get('oobCode') || ctx.query.get('token') || ctx.query.get('code') || '';
  if (mode === 'resetPassword') {
    navigate(`/reset-password?oobCode=${encodeURIComponent(code)}`, true);
  } else if (mode === 'verifyEmail') {
    navigate(`/verify-email?oobCode=${encodeURIComponent(code)}`, true);
  } else {
    navigate('/signin', true);
  }
};
route('/auth/action', handleAuthAction);
route('/__/auth/action', handleAuthAction);

const appRoute = (path: string, loader: () => Promise<(view: HTMLElement, ctx: { query: URLSearchParams }) => Promise<void> | void>) =>
  route(path, async (ctx) => {
    clearLegacySiteStyles();
    const [view, render] = await Promise.all([
      appLayout(ctx.path, async () => {
        const { openNewBooking } = await import('./views/bookings');
        openNewBooking(() => navigate(location.pathname + location.search));
      }),
      loader(),
    ]);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    await render(view, ctx);
  });

route('/app/onboarding', async () => { const { renderOnboarding } = await import('./views/onboarding'); await renderOnboarding(); });
appRoute('/app', () => import('./views/home').then((m) => m.renderHome));
appRoute('/app/bookings', () => import('./views/bookings').then((m) => m.renderBookings));
appRoute('/app/calendar', () => import('./views/calendar').then((m) => m.renderCalendar));
appRoute('/app/messages', () => import('./views/messages').then((m) => (v, c) => m.renderMessages(v, c.query.get('phone'))));
appRoute('/app/more', () => import('./views/manage').then((m) => m.renderMore));
appRoute('/app/customers', () => import('./views/customers').then((m) => m.renderCustomers));
appRoute('/app/services', () => import('./views/manage').then((m) => m.renderServices));
appRoute('/app/team', () => import('./views/manage').then((m) => m.renderTeam));
appRoute('/app/booking-page', () => import('./views/manage').then((m) => m.renderBookingPage));
appRoute('/app/billing', () => import('./views/account').then((m) => m.renderBilling));
appRoute('/app/audit', () => import('./views/account').then((m) => m.renderAudit));
appRoute('/app/settings', () => import('./views/manage').then((m) => m.renderSettings));
appRoute('/app/security', () => import('./views/security').then((m) => m.renderSecurity));
appRoute('/app/crm', () => import('./views/crm').then((m) => m.renderCrm));
appRoute('/app/devices', () => import('./views/devices').then((m) => m.renderDevices));
appRoute('/app/automations', () => import('./views/automations').then((m) => m.renderAutomations));
appRoute('/app/content', () => import('./views/content').then((m) => m.renderContent));
appRoute('/app/compliance', () => import('./views/compliance').then((m) => m.renderCompliance));

setNotFound(async (ctx) => {
  clearLegacySiteStyles();
  const m = /^\/([a-z0-9][a-z0-9-]{1,62})$/.exec(ctx.path);
  if (m) {
    const { renderPublicBooking } = await import('./views/publicBooking');
    return renderPublicBooking(m[1]!, ctx.query.get('pay'));
  }
  const { renderNotFound } = await import('./views/site');
  renderNotFound();
});

void current;
startRouter();

// Pre-warm the most-visited view chunks during browser idle time.
// This means the first navigation to /app, /signin, etc. hits the module cache
// instead of triggering a network fetch + parse on demand.
const _prewarmChunks = () => {
  void import('./views/auth');
  void import('./views/home');
  void import('./views/bookings');
};
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(_prewarmChunks, { timeout: 2000 });
} else {
  setTimeout(_prewarmChunks, 300);
}
