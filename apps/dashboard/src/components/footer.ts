/**
 * ZexCore Enterprise Footer Component
 * Clean Red & White Information Architecture | Comprehensive Sitemap
 */

export function renderFooter(): string {
  return `
    <footer class="site-footer">
      <div class="footer-top">
        <div class="footer-brand-col">
          <a href="/" data-link class="footer-logo-link">
            <img src="/zexcore-logo-dark.png" alt="ZexCore" class="footer-logo" />
          </a>
          <p class="footer-tagline">ZexCore by Zexlabs</p>
          <p class="footer-desc">
            Booking, customers, payments and automation for appointment-based businesses, built on Firebase.
          </p>
          <p style="margin-top: 12px; font-size: 0.85rem; color: rgba(255,255,255,0.88);">
            Contact: <a href="mailto:hello@zexcore.com.ng" style="color: #ffffff; text-decoration: underline; font-weight: 600;">hello@zexcore.com.ng</a>
          </p>
        </div>

        <div class="footer-links-grid">
          <div class="footer-col">
            <h4 class="footer-col-title">Platform</h4>
            <ul class="footer-list">
              <li><a href="/product" data-link>Product overview</a></li>
              <li><a href="/about" data-link>About</a></li>
              <li><a href="/contact" data-link>Contact</a></li>
            </ul>
          </div>

          <div class="footer-col">
            <h4 class="footer-col-title">Architecture</h4>
            <ul class="footer-list">
              <li><a href="/architecture" data-link>Architecture</a></li>
              <li><a href="/multi-tenancy" data-link>Multi-tenancy</a></li>
              <li><a href="/automation" data-link>Automation</a></li>
            </ul>
          </div>

          <div class="footer-col">
            <h4 class="footer-col-title">Product</h4>
            <ul class="footer-list">
              <li><a href="/modules" data-link>All modules</a></li>
              <li><a href="/product" data-link>Product</a></li>
              <li><a href="/solutions" data-link>Solutions</a></li>
            </ul>
          </div>

          <div class="footer-col">
            <h4 class="footer-col-title">Security &amp; Trust</h4>
            <ul class="footer-list">
              <li><a href="/security" data-link>Security Model</a></li>
              <li><a href="/privacy" data-link>Privacy</a></li>
              <li><a href="/terms" data-link>Terms</a></li>
            </ul>
          </div>

          <div class="footer-col">
            <h4 class="footer-col-title">Developers</h4>
            <ul class="footer-list">
              <li><a href="/docs" data-link>Documentation</a></li>
              <li><a href="/docs#start" data-link>Quickstart</a></li>
              <li><a href="/docs#worker" data-link>Payments Worker API</a></li>
              <li><a href="/resources" data-link>Resources</a></li>
              <li><a href="/pricing" data-link>Pricing</a></li>
              <li><a href="/signin" data-link>Workspace Sign In</a></li>
            </ul>
          </div>
        </div>
      </div>

      <div class="footer-bottom">
        <div class="footer-bottom-inner">
          <p class="footer-copyright">
            &copy; 2026 ZexCore by Zexlabs. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  `;
}
