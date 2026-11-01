/**
 * ZexCore Enterprise Navigation Bar Component
 * Red & White Design System | Structured Categories & Standout CTAs
 */

export function renderNavbar(activePage: string): string {
  return `
    <header class="site-header">
      <div class="header-inner">
        <a href="/" data-link class="brand-link" id="nav-brand-logo" aria-label="ZexCore Home">
          <img src="/zexcore-logo-light.png" alt="ZexCore" class="site-logo" />
        </a>

        <nav class="desktop-nav" aria-label="Main Navigation">
          <a href="/" data-link class="nav-link ${activePage === 'home' ? 'active' : ''}">Home</a>

          <!-- Product & Features Dropdown -->
          <div class="nav-dropdown-item">
            <button class="nav-dropdown-btn ${(activePage === 'modules' || activePage === 'platform' || activePage === 'console') ? 'active' : ''}">
              <span>Product</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown-menu">
              <a href="#/console/crm" class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">WhatsApp &amp; CRM Inbox</div>
                  <div class="nav-dropdown-desc">Customer chat, deal pipelines &amp; Paystack payment links</div>
                </div>
              </a>
              <a href="#/console/iot" class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Live Sensor &amp; Fleet Hub</div>
                  <div class="nav-dropdown-desc">Real-time hardware tracking, GPS &amp; temperature alerts</div>
                </div>
              </a>
              <a href="#/console/rules" class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Automated Business Rules</div>
                  <div class="nav-dropdown-desc">Instant trigger actions and alerts without writing code</div>
                </div>
              </a>
              <a href="#/console/compliance" class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Data Privacy &amp; GDPR Vault</div>
                  <div class="nav-dropdown-desc">Bank-grade encryption &amp; customer record protection</div>
                </div>
              </a>
              <a href="#/console/audit" class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Audit Ledger &amp; Finance</div>
                  <div class="nav-dropdown-desc">Tamper-proof financial logs &amp; compliance evidence</div>
                </div>
              </a>
              <div style="border-top: 1px solid var(--border-default); margin: 6px 0; padding-top: 6px;">
                <a href="/platform" data-link class="nav-dropdown-link" style="padding: 6px 12px;">
                  <span style="font-size: 0.78rem; font-weight: 700; color: #0F172A;">Overview of All Platform Capabilities &rarr;</span>
                </a>
              </div>
            </div>
          </div>

          <!-- Solutions Dropdown -->
          <div class="nav-dropdown-item">
            <button class="nav-dropdown-btn ${activePage === 'solutions' ? 'active' : ''}">
              <span>Solutions</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown-menu">
              <a href="/solutions#solutions-agency" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.26L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Web &amp; Software Agencies</div>
                  <div class="nav-dropdown-desc">A private workspace for every client</div>
                </div>
              </a>
              <a href="/solutions#solutions-regulated" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Clinics &amp; Wellness</div>
                  <div class="nav-dropdown-desc">Appointments, reminders &amp; visit records</div>
                </div>
              </a>
              <a href="/solutions" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Workshops &amp; Equipment</div>
                  <div class="nav-dropdown-desc">Equipment readings, alerts &amp; job bookings</div>
                </div>
              </a>
              <div style="border-top: 1px solid var(--border-default); margin: 6px 0; padding-top: 6px;">
                <a href="/solutions" data-link class="nav-dropdown-link" style="padding: 6px 12px;">
                  <span style="font-size: 0.78rem; font-weight: 700; color: #0F172A;">Explore All Industry Blueprints &rarr;</span>
                </a>
              </div>
            </div>
          </div>

          <a href="/pricing" data-link class="nav-link ${activePage === 'pricing' ? 'active' : ''}">Pricing</a>
          <a href="/docs" data-link class="nav-link ${activePage === 'docs' ? 'active' : ''}">Docs</a>

          <!-- Developers Dropdown -->
          <div class="nav-dropdown-item">
            <button class="nav-dropdown-btn ${(activePage === 'architecture' || activePage === 'tenancy' || activePage === 'automation' || activePage === 'security' || activePage === 'docs') ? 'active' : ''}">
              <span>Developers</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="nav-dropdown-menu">
              <a href="/multi-tenancy" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E50920" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg></div>
                <div>
                  <div class="nav-dropdown-title">Multi-tenancy</div>
                  <div class="nav-dropdown-desc">Private workspace for every business</div>
                </div>
              </a>
              <a href="/automation" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E50920" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg></div>
                <div>
                  <div class="nav-dropdown-title">Automation</div>
                  <div class="nav-dropdown-desc">Triggers, conditions and actions</div>
                </div>
              </a>
              <a href="/architecture" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">System Architecture</div>
                  <div class="nav-dropdown-desc">How the Firebase backend fits together</div>
                </div>
              </a>
              <a href="/security" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">Security model</div>
                  <div class="nav-dropdown-desc">Rules, roles and payments</div>
                </div>
              </a>
              <a href="/docs" data-link class="nav-dropdown-link">
                <div class="nav-dropdown-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </div>
                <div>
                  <div class="nav-dropdown-title">API &amp; Developer Docs</div>
                  <div class="nav-dropdown-desc">Fastify micro-kernel endpoints &amp; webhooks</div>
                </div>
              </a>
            </div>
          </div>

          <a href="/about" data-link class="nav-link ${activePage === 'about' ? 'active' : ''}">About</a>
          <a href="/contact" data-link class="nav-link ${activePage === 'contact' ? 'active' : ''}">Contact</a>
        </nav>

        <div class="header-actions">
          <a href="/signin" data-link class="btn btn-secondary btn-sm" id="btn-header-signin">Sign In</a>
          <a href="/signup" data-link class="btn btn-primary" id="btn-header-launch">
            Start free &rarr;
          </a>
          <button class="mobile-toggle" id="btn-mobile-menu" aria-label="Toggle navigation menu">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Mobile Navigation Drawer -->
      <div class="mobile-drawer" id="mobile-drawer">
        <div class="mobile-drawer-inner">
          <div class="mobile-drawer-links">
            <a href="/" data-link class="mobile-nav-link ${activePage === 'home' ? 'active' : ''}">Home</a>
            <a href="/about" data-link class="mobile-nav-link ${activePage === 'about' ? 'active' : ''}">About ZexCore</a>
            
            <div style="padding: 10px 16px 4px; font-size: 0.72rem; font-weight: 800; color: #0F172A; text-transform: uppercase; letter-spacing: 0.05em;">
              Product Capabilities
            </div>
            <a href="#/console/crm" class="mobile-nav-link" style="padding-left: 28px;">WhatsApp &amp; CRM Inbox</a>
            <a href="#/console/iot" class="mobile-nav-link" style="padding-left: 28px;">Sensor &amp; Fleet Tracking</a>
            <a href="#/console/rules" class="mobile-nav-link" style="padding-left: 28px;">Automated Business Rules</a>
            <a href="#/console/compliance" class="mobile-nav-link" style="padding-left: 28px;">Privacy &amp; GDPR Vault</a>
            <a href="#/console/audit" class="mobile-nav-link" style="padding-left: 28px;">Audit &amp; Financial Ledger</a>
            <a href="/platform" data-link class="mobile-nav-link" style="padding-left: 28px;">Platform Overview</a>
            
            <div style="padding: 10px 16px 4px; font-size: 0.72rem; font-weight: 800; color: #0F172A; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid var(--border-default); margin-top: 8px;">
              Industry Solutions
            </div>
            <a href="/solutions" data-link class="mobile-nav-link ${activePage === 'solutions' ? 'active' : ''}">All Industry Blueprints</a>
            <a href="/pricing" data-link class="mobile-nav-link ${activePage === 'pricing' ? 'active' : ''}">Pricing Plans</a>

            <div style="padding: 10px 16px 4px; font-size: 0.72rem; font-weight: 800; color: #0F172A; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid var(--border-default); margin-top: 8px;">
              Developers &amp; Engineering
            </div>
            <a href="/architecture" data-link class="mobile-nav-link ${activePage === 'architecture' ? 'active' : ''}" style="padding-left: 28px;">Architecture</a>
            <a href="/multi-tenancy" data-link class="mobile-nav-link" style="padding-left: 28px;">Multi-tenancy</a>
            <a href="/automation" data-link class="mobile-nav-link" style="padding-left: 28px;">Automation</a>
            <a href="/security" data-link class="mobile-nav-link ${activePage === 'security' ? 'active' : ''}" style="padding-left: 28px;">Security</a>
            <a href="/docs" data-link class="mobile-nav-link ${activePage === 'docs' ? 'active' : ''}" style="padding-left: 28px;">Developer Documentation</a>

            <div style="border-top: 1px solid var(--border-default); margin: 8px 0;"></div>
            <a href="/contact" data-link class="mobile-nav-link ${activePage === 'contact' ? 'active' : ''}">Contact Support</a>
          </div>
          <div class="mobile-drawer-actions">
            <a href="/signin" data-link class="btn btn-secondary" style="width: 100%; justify-content: center; font-weight: 600;">Sign In</a>
            <a href="/console" data-link class="btn btn-primary" style="width: 100%; justify-content: center; font-weight: 750;">Launch Live Console &rarr;</a>
          </div>
        </div>
      </div>
    </header>
  `;
}

export function setupNavbarEvents(): void {
  const toggleBtn = document.getElementById('btn-mobile-menu');
  const drawer = document.getElementById('mobile-drawer');
  if (!toggleBtn || !drawer) return;

  const setOpen = (open: boolean): void => {
    drawer.classList.toggle('open', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : ''; // the page behind the menu must not scroll
  };
  toggleBtn.setAttribute('aria-controls', 'mobile-drawer');
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));

  // Close the drawer on any link, on Escape, and when the screen grows past the phone layout
  drawer.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) setOpen(false); });
  window.matchMedia('(min-width: 901px)').addEventListener('change', (m) => { if (m.matches) setOpen(false); });
}
