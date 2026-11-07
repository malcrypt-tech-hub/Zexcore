import { paymentsUrl } from '../lib/fb/firebase';
import { html, mount, $, $$, type Raw } from '../lib/html';
import { ic, type IconName } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, initials, minutesToTime, timeToMinutes } from '../lib/format';
import { toast, openModal, emptyState, errorState, skeletonRows, busy, copyText, confirmDialog } from '../lib/ui';
import { loadSettings, bookingUrl, clearStore, type Service, type Staff } from '../lib/store';
import { canAdmin, canEdit, current, loadMe, logout } from '../lib/session';
import { navigate } from '../router';
import { hasFeatureAccess } from '../lib/fb/plan';
import { fetchLiveRates, formatInCurrency, ratesMeta, type SupportedCurrency } from '../lib/fx';

const ro = (edit = false): Raw => (edit ? canEdit() : canAdmin()) ? html`` : html`<div class="alert alert-info" style="margin-bottom:16px">${ic('info', 'ico-sm')} ${edit ? 'Only owners, admins and editors can change this.' : 'Only owners and admins can change these settings.'}</div>`;

export function renderMore(view: HTMLElement): void {
  const items: { href?: string; icon: IconName; t: string; s: string; comingSoon?: boolean }[] = [
    { href: '/app/customers', icon: 'users', t: 'Customers', s: 'Everyone who has booked' },
    { href: '/app/enquiries', icon: 'mail', t: 'Service enquiries', s: 'Project requests and non-appointment enquiries' },
    { href: '/app/whatsapp', icon: 'message-circle', t: 'WhatsApp Business', s: 'Connect your business number for messaging' },
    { href: '/app/services', icon: 'list-checks', t: 'Services', s: 'What you offer, how long, how much' },
    { href: '/app/team', icon: 'id-card', t: 'Bookable staff', s: 'Doctors, stylists and other calendars' },
    { href: '/app/access', icon: 'users', t: 'Team access', s: 'Invite admins and editors to sign in' },
    { href: '/app/booking-page', icon: 'link', t: 'Booking page', s: 'Your public link to share' },
    { href: '/app/crm', icon: 'handshake', t: 'CRM', s: 'Leads, pipeline and contacts' },
    { href: '/app/devices', icon: 'cpu', t: 'Devices', s: 'Sensors, readings and alerts' },
    { href: '/app/automations', icon: 'workflow', t: 'Automations', s: 'Rules that react to events' },
    { href: '/app/content', icon: 'globe', t: 'Website pages', s: 'Draft and publish page content' },
    { href: '/app/compliance', icon: 'scale', t: 'Data protection', s: 'Consent, erasure and retention' },
    { href: '/app/billing', icon: 'credit-card', t: 'Plan & billing', s: 'Your subscription and payments' },
    { href: '/app/license', icon: 'server', t: 'Cluster & license', s: 'Signed licence file and dedicated setup' },
    { href: '/app/security', icon: 'shield-check', t: 'Security', s: 'Password and signed-in devices' },
    { href: '/app/backups', icon: 'database', t: 'Backups', s: 'Encrypted daily copies and certificates' },
    { href: '/app/insights', icon: 'activity', t: 'Business insights', s: 'Bookings, revenue and busy times' },
    { href: '/app/shop', icon: 'shopping-bag', t: 'Shop', s: 'Products you sell and customer orders' },
    { href: '/app/waitlist', icon: 'clock', t: 'Revenue protection', s: 'Waitlist and cancelled times won back' },
    { href: '/app/api-keys', icon: 'key-round', t: 'API keys', s: 'Read-only access for other systems' },
    { href: '/app/export', icon: 'download', t: 'Export data', s: 'CSV and JSON downloads of your records' },
    { href: '/app/audit', icon: 'history', t: 'Audit log', s: 'Tamper-evident record of changes' },
    { href: '/app/settings', icon: 'settings', t: 'Settings', s: 'Hours, deposits and business details' },
  ];
  const me = current()!;
  mount(view, html`<div class="page-head"><div><h1>More</h1><p>${me.tenant.name}</p></div></div>
    <div class="card list">${items.filter((i) => !(me.role === 'viewer' && i.href === '/app/access')).map((i) => {
      if (i.comingSoon) {
        return html`<div class="list-item" style="cursor:default;opacity:0.75" aria-disabled="true" title="Coming soon">
          <span class="icon-tile">${ic(i.icon)}</span>
          <span class="grow"><b>${i.t}</b><br><span class="muted small">${i.s}</span></span>
          <span class="badge" style="font-size:0.6875rem;padding:3px 8px;font-weight:600">Coming soon</span>
        </div>`;
      }
      return html`<a class="list-item hover" href="${i.href!}" data-link><span class="icon-tile">${ic(i.icon)}</span><span class="grow"><b>${i.t}</b><br><span class="muted small">${i.s}</span></span>${ic('chevron-right')}</a>`;
    })}</div>
    <button class="btn btn-secondary btn-block" style="margin-top:16px" data-out>${ic('log-out', 'ico-sm')} Sign out</button>`);
  $('[data-out]', view)!.addEventListener('click', () => { logout(); navigate('/signin'); });
  void import('../lib/fb/team').then(async ({ myWorkspaces, switchWorkspace }) => {
    const all = await myWorkspaces();
    if (all.length < 2) return;
    const box = document.createElement('div');
    mount(box, html`<div class="card card-pad" style="margin-top:16px"><h3 style="margin-bottom:8px">Switch workspace</h3><div class="stack-sm">${all.map((w) => html`<button class="btn ${w.id === me.tenant.id ? 'btn-primary' : 'btn-secondary'} btn-block" data-ws="${w.id}" ${w.id === me.tenant.id ? 'disabled' : ''}>${w.name} <span class="small" style="opacity:.8">(${w.role})</span></button>`)}</div></div>`);
    view.appendChild(box);
    box.querySelectorAll<HTMLElement>('[data-ws]').forEach((b) => b.addEventListener('click', async () => { switchWorkspace(b.dataset.ws!); clearStore(); await loadMe(true); navigate('/app', true); }));
  }).catch(() => undefined);
}

// ── Services ─────────────────────────────────────────────────────────────────
export async function renderServices(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="page-head"><div><h1>Services</h1><p>What customers can book.</p></div>${canEdit() ? html`<button class="btn btn-primary" data-add>${ic('plus', 'ico-sm')} Add service</button>` : ''}</div>${ro(true)}<div class="card" id="l"></div>`);
  const host = $('#l', view)!;
  const load = async () => {
    mount(host, skeletonRows(3));
    try {
      const { services } = await api<{ services: Service[] }>('/api/bookings/services');
      if (!services.length) { mount(host, emptyState({ icon: 'list-checks', title: 'No services yet', text: 'Add what you offer, for example “Consultation, 30 min, $10”.', action: canAdmin() ? html`<button class="btn btn-primary btn-sm" data-add2>${ic('plus', 'ico-sm')} Add service</button>` : undefined })); $('[data-add2]', host)?.addEventListener('click', () => edit()); return; }
      mount(host, html`<div class="list">${services.map((s) => html`<div class="list-item"><span class="icon-tile">${ic('list-checks')}</span><div class="grow"><b>${s.name}</b> ${s.active ? '' : html`<span class="badge">Hidden</span>`}<div class="muted small">${s.durationMin} min · ${money(s.priceMinor)}${s.description ? ` · ${s.description}` : ''}</div></div>${canAdmin() ? html`<button class="btn btn-secondary btn-sm" data-edit="${s.id}">Edit</button>` : ''}</div>`)}</div>`);
      host.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(services.find((s) => s.id === b.dataset.edit))));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load services')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  function edit(s?: Service): void {
    openModal({
      title: s ? 'Edit service' : 'Add service',
      body: html`<form class="form-grid"><div id="se" class="alert alert-error hidden"></div>
        <div class="field"><label for="sn">Name</label><input class="input" id="sn" required maxlength="120" value="${s?.name ?? ''}"></div>
        <div class="form-grid two"><div class="field"><label for="sd">Duration (minutes)</label><input class="input" id="sd" type="number" min="5" max="480" value="${s?.durationMin ?? 30}"></div>
        <div class="field"><label for="sp">Price ($)</label><input class="input" id="sp" type="number" min="0" value="${s ? s.priceMinor / 100 : 0}"></div></div>
        <div class="field"><label for="sx">Description <span class="faint">(optional)</span></label><input class="input" id="sx" maxlength="500" value="${s?.description ?? ''}"></div>
        <div class="form-grid two"><div class="field"><label for="sm">Booking type</label><select class="input" id="sm"><option value="appointment" ${s?.bookingMode !== 'enquiry' ? 'selected' : ''}>Appointment</option><option value="enquiry" ${s?.bookingMode === 'enquiry' ? 'selected' : ''}>Project / service enquiry</option></select></div><div class="field"><label for="sc">Consultation</label><label class="check"><input type="checkbox" id="sc" ${s?.consultationEnabled ? 'checked' : ''}> Offer optional consultation</label></div></div>
        <div class="field"><label for="sf">Custom intake questions (JSON)</label><textarea class="input" id="sf" rows="4" placeholder='[{"key":"project","label":"Describe your project","type":"textarea","required":true}]'>${JSON.stringify(s?.intakeFields ?? [], null, 2)}</textarea><small class="muted">Up to 12 questions. Types: text, textarea, number, url, select. Select fields need options.</small></div>
        ${s ? html`<label class="check"><input type="checkbox" id="sa" ${s.active ? 'checked' : ''}> Show on my booking page</label>` : ''}</form>`,
      footer: html`${s ? html`<button class="btn btn-soft-danger" data-del style="margin-right:auto">${ic('trash-2', 'ico-sm')} Delete</button>` : ''}<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>`,
      onMount: (el, close) => {
        $('[data-del]', el)?.addEventListener('click', async () => {
          if (!await confirmDialog({ title: `Delete “${s!.name}”?`, message: 'Customers will no longer be able to book it. Bookings already made stay in your list and show as a removed service. To keep it but stop new bookings, untick “Show on my booking page” instead. This is recorded in your audit log.', confirmLabel: 'Delete service', danger: true })) return;
          try { await api(`/api/bookings/services/${s!.id}`, { method: 'DELETE' }); toast('Service deleted', 'success'); close(); void load(); }
          catch (x) { const e = $('#se', el)!; e.textContent = x instanceof ApiError ? x.message : 'Could not delete'; e.classList.remove('hidden'); }
        });
        $('[data-save]', el)!.addEventListener('click', () => void busy($('[data-save]', el) as HTMLButtonElement, async () => {
        const body: Record<string, unknown> = { name: ($('#sn', el) as HTMLInputElement).value.trim(), durationMin: Number(($('#sd', el) as HTMLInputElement).value), priceMinor: Math.round(Number(($('#sp', el) as HTMLInputElement).value) * 100), description: ($('#sx', el) as HTMLInputElement).value.trim() };
        if (s) body.active = ($('#sa', el) as HTMLInputElement).checked;
        body.bookingMode = ($('#sm', el) as HTMLSelectElement).value; body.consultationEnabled = ($('#sc', el) as HTMLInputElement).checked;
        try { body.intakeFields = JSON.parse(($('#sf', el) as HTMLTextAreaElement).value || '[]'); } catch { const e = $('#se', el)!; e.textContent = 'Custom intake questions must be valid JSON.'; e.classList.remove('hidden'); return; }
        try { await api(s ? `/api/bookings/services/${s.id}` : '/api/bookings/services', { method: s ? 'PATCH' : 'POST', body }); toast('Saved', 'success'); close(); void load(); }
        catch (x) { const e = $('#se', el)!; e.textContent = x instanceof ApiError ? x.message : 'Could not save'; e.classList.remove('hidden'); }
      }));
      },
    });
  }
  $('[data-add]', view)?.addEventListener('click', () => edit());
  await load();
}

// ── Team ─────────────────────────────────────────────────────────────────────
export async function renderTeam(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="page-head"><div><h1>Bookable staff</h1><p>People customers can book with. Leave empty if you take bookings yourself.</p></div>${canEdit() ? html`<button class="btn btn-primary" data-add>${ic('plus', 'ico-sm')} Add person</button>` : ''}</div>${ro(true)}<div class="card" id="l"></div>`);
  const host = $('#l', view)!;
  const load = async () => {
    mount(host, skeletonRows(2));
    try {
      const { staff } = await api<{ staff: Staff[] }>('/api/bookings/staff');
      if (!staff.length) { mount(host, emptyState({ icon: 'id-card', title: 'No team members yet', text: 'Without staff, each time slot can be booked once. Add people to run parallel appointments.' })); return; }
      mount(host, html`<div class="list">${staff.map((s) => html`<div class="list-item"><span class="avatar ${s.active ? 'green' : 'grey'}">${initials(s.name)}</span><div class="grow"><b>${s.name}</b> ${s.active ? '' : html`<span class="badge">Inactive</span>`}<div class="muted small">${s.title ?? 'No title'}</div></div>${canAdmin() ? html`<button class="btn btn-secondary btn-sm" data-edit="${s.id}">Edit</button>` : ''}</div>`)}</div>`);
      host.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(staff.find((s) => s.id === b.dataset.edit))));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load team')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };
  function edit(s?: Staff): void {
    openModal({
      title: s ? 'Edit person' : 'Add person',
      body: html`<form class="form-grid"><div id="te" class="alert alert-error hidden"></div><div class="field"><label for="tn">Name</label><input class="input" id="tn" required maxlength="120" value="${s?.name ?? ''}"></div><div class="field"><label for="tt">Title <span class="faint">(optional)</span></label><input class="input" id="tt" maxlength="120" placeholder="e.g. General Medicine" value="${s?.title ?? ''}"></div>${s ? html`<label class="check"><input type="checkbox" id="ta" ${s.active ? 'checked' : ''}> Available for bookings</label>` : ''}</form>`,
      footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>`,
      onMount: (el, close) => $('[data-save]', el)!.addEventListener('click', () => void busy($('[data-save]', el) as HTMLButtonElement, async () => {
        const body: Record<string, unknown> = { name: ($('#tn', el) as HTMLInputElement).value.trim(), title: ($('#tt', el) as HTMLInputElement).value.trim() };
        if (s) body.active = ($('#ta', el) as HTMLInputElement).checked;
        try { await api(s ? `/api/bookings/staff/${s.id}` : '/api/bookings/staff', { method: s ? 'PATCH' : 'POST', body }); toast('Saved', 'success'); close(); void load(); }
        catch (x) { const e = $('#te', el)!; e.textContent = x instanceof ApiError ? x.message : 'Could not save'; e.classList.remove('hidden'); }
      })),
    });
  }
  $('[data-add]', view)?.addEventListener('click', () => edit());
  await load();
}

// ── Booking page ─────────────────────────────────────────────────────────────
export async function renderBookingPage(view: HTMLElement): Promise<void> {
  const s = await loadSettings();
  const url = bookingUrl();
  const msg = `Book an appointment with ${s.publicName ?? current()!.tenant.name}: ${url}`;
  mount(view, html`<div class="page-head"><div><h1>Booking page</h1><p>The page your customers use to pick a service, choose a time and pay a deposit.</p></div></div>
    <div class="card card-pad stack">
      <div class="field"><label>Your link</label><div class="copy-box"><code>${url}</code><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy</button></div></div>
      <div class="row wrap">
        <a class="btn btn-primary" href="${url}" target="_blank" rel="noopener noreferrer">${ic('external-link', 'ico-sm')} Open page</a>
        <a class="btn btn-secondary" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener noreferrer">${ic('message-circle', 'ico-sm')} Share on WhatsApp</a>
      </div>
      <div class="alert alert-info">${ic('info', 'ico-sm')}<span>Deposits are ${s.depositEnabled ? html`<b>on</b> (${money(s.depositMinor, 'USD')} per booking)` : html`<b>off</b>`}. Change this in <a href="/app/settings" data-link style="text-decoration:underline">Settings</a>.</span></div>
    </div>`);
  $('[data-copy]', view)!.addEventListener('click', () => copyText(url));
}

// ── Settings ─────────────────────────────────────────────────────────────────
export async function renderSettings(view: HTMLElement): Promise<void> {
  const s = await loadSettings(true);
  const me = current()!;
  const dis = canAdmin() ? '' : 'disabled';
  const canBrand = hasFeatureAccess(me.tenant.tier, 'branding');
  let currentLogo: string | null = s.logoUrl || null;

  mount(view, html`<div class="page-head"><div><h1>Settings</h1><p>Business details, branding, opening hours and deposit rules.</p></div></div>${ro()}
    <form id="st" class="stack-lg" novalidate>
      <div id="st-err" class="alert alert-error hidden" role="alert"></div>
      <section class="card card-pad form-grid"><h3>Business</h3>
        <div class="field"><label for="pn">Business name</label><input class="input" id="pn" maxlength="255" value="${s.publicName ?? me.tenant.name}" ${dis}></div>
        <div class="form-grid two"><div class="field"><label for="ph">Phone / WhatsApp</label><input class="input" id="ph" type="tel" value="${s.phone ?? ''}" ${dis}></div><div class="field"><label for="ad">Address</label><input class="input" id="ad" maxlength="500" value="${s.address ?? ''}" ${dis}></div></div></section>

      <section class="card card-pad form-grid">
        <div class="row between wrap">
          <div>
            <h3>Branding & Logo</h3>
            <p class="muted small">Display your custom logo on the dashboard and booking page.</p>
          </div>
          ${!canBrand ? html`<a href="/app/billing" data-link class="badge badge-warning" style="text-decoration:none">${ic('lock', 'ico-xs')} Upgrade to Starter</a>` : ''}
        </div>
        ${canBrand ? html`
          <div style="display:flex;align-items:center;gap:16px;margin-top:12px;flex-wrap:wrap">
            <div id="logo-preview-box" style="width:72px;height:72px;border-radius:10px;border:1px dashed var(--border,#ddd);background:var(--bg-subtle,#f9f9f9);display:flex;align-items:center;justify-content:center;overflow:hidden">
              ${currentLogo ? html`<img id="logo-img" src="${currentLogo}" alt="Logo" style="width:100%;height:100%;object-fit:contain;padding:4px" />` : html`<span id="logo-empty" class="muted small" style="font-size:11px;text-align:center">No logo</span>`}
            </div>
            <div class="stack-sm">
              <input type="file" id="logo-file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none" ${dis} />
              <div class="row" style="gap:8px">
                <button type="button" class="btn btn-secondary btn-sm" id="btn-pick-logo" ${dis}>${ic('upload', 'ico-sm')} Choose image</button>
                <button type="button" class="btn btn-ghost btn-sm ${currentLogo ? '' : 'hidden'}" id="btn-remove-logo" ${dis}>Remove</button>
              </div>
              <span class="hint">PNG, JPEG, WebP, or SVG. Automatically optimized.</span>
            </div>
          </div>
        ` : html`
          <div class="alert alert-info" style="margin-top:8px">
            <span>Custom branding is included with the <b>Starter</b> plan and higher. <a href="/app/billing" data-link style="text-decoration:underline">Upgrade your workspace</a> to upload your custom business logo.</span>
          </div>
        `}
      </section>

      <section class="card card-pad form-grid"><h3>Opening hours</h3>
        <div class="form-grid two"><div class="field"><label for="op">Opens</label><input class="input" id="op" type="time" value="${minutesToTime(s.openMinutes)}" ${dis}></div><div class="field"><label for="cl">Closes</label><input class="input" id="cl" type="time" value="${minutesToTime(s.closeMinutes)}" ${dis}></div></div>
        <div class="field"><label>Open days</label><div class="day-pills">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => html`<label><input type="checkbox" name="day" value="${i}" ${s.daysOpen.includes(i) ? 'checked' : ''} ${dis}><span>${d}</span></label>`)}</div></div>
        <div class="form-grid two"><div class="field"><label for="sl">Slot length (minutes)</label><select class="select" id="sl" ${dis}>${[15, 20, 30, 45, 60].map((n) => html`<option value="${n}" ${n === s.slotMinutes ? 'selected' : ''}>${n}</option>`)}</select></div>
        <div class="field"><label for="ld">Minimum notice (hours)</label><input class="input" id="ld" type="number" min="0" max="168" value="${s.leadMinutes / 60}" ${dis}></div></div></section>

      <section class="card card-pad form-grid"><h3>Emails to your customers</h3>
        <p class="muted small">These go only to customers who gave an email address when they booked.</p>
        <div class="row between"><div><b>Appointment reminder</b><div class="muted small">About a day before a confirmed appointment. Not sent for bookings made less than a day ahead.</div></div><label class="switch"><input type="checkbox" id="re" ${s.reminderEmails === true ? 'checked' : ''} ${dis}><span></span></label></div>
        <div class="row between"><div><b>Thank-you after a visit</b><div class="muted small">A day after you mark a booking completed, with a link to book again.</div></div><label class="switch"><input type="checkbox" id="fu" ${s.followUpEmails === true ? 'checked' : ''} ${dis}><span></span></label></div></section>

      <section class="card card-pad form-grid"><h3>Notifications</h3>
        <p class="muted small">Choose how you are told when a customer makes a booking request. Inside ZexCore, the bell and the Bookings and Messages tabs show a count of what is new until you open it.</p>
        <div class="row between"><div><b>Email alerts</b><div class="muted small">Get an email for every new booking request</div></div><label class="switch"><input type="checkbox" id="ne" ${s.notifyOwnerEmail !== false ? 'checked' : ''} ${dis}><span></span></label></div>
        <div class="row between"><div><b>WhatsApp alerts</b><div class="muted small">A WhatsApp message to you for every new booking request</div></div><label class="switch"><input type="checkbox" id="nw" ${s.notifyOwnerWhatsApp ? 'checked' : ''} ${dis}><span></span></label></div>
        <div class="field ${s.notifyOwnerWhatsApp ? '' : 'hidden'}" id="nwf"><label for="nwp">Your WhatsApp number</label><input class="input" id="nwp" type="tel" placeholder="e.g. 08012345678" value="${s.notifyWhatsAppPhone ?? ''}" ${dis}><span class="hint" id="nwh">Include your country code if it is not Nigeria, for example +44 7700 900123. Booking emails also carry a link to reply to the customer on WhatsApp.</span></div>
      </section>
      <section class="card card-pad form-grid" id="payout"><h3>Where deposits are paid</h3><p class="muted small">Loading…</p></section>
      <section class="card card-pad form-grid">
        <div class="row between">
          <div>
            <h3>Upfront deposit & currency</h3>
            <p class="muted small">Choose the currency your booking page shows first, and set slot deposits (in US dollars). Customer card payments settle directly to your bank account below.</p>
          </div>
          <label class="switch"><input type="checkbox" id="dep" ${s.depositEnabled ? 'checked' : ''} ${dis} aria-label="Require deposit"><span></span></label>
        </div>
        <div class="form-grid two">
          <div class="field">
            <label for="currency">Show prices to customers in</label>
            <select class="select" id="currency" ${dis}>
              <option value="USD" ${(s.currency || 'USD') === 'USD' ? 'selected' : ''}>USD ($) — US Dollar</option>
              <option value="NGN" ${s.currency === 'NGN' ? 'selected' : ''}>NGN (₦) — Nigerian Naira</option>
              <option value="GBP" ${s.currency === 'GBP' ? 'selected' : ''}>GBP (£) — British Pound</option>
              <option value="EUR" ${s.currency === 'EUR' ? 'selected' : ''}>EUR (€) — Euro</option>
              <option value="GHS" ${s.currency === 'GHS' ? 'selected' : ''}>GHS (GH₵) — Ghanaian Cedi</option>
              <option value="KES" ${s.currency === 'KES' ? 'selected' : ''}>KES (KSh) — Kenyan Shilling</option>
              <option value="ZAR" ${s.currency === 'ZAR' ? 'selected' : ''}>ZAR (R) — South African Rand</option>
            </select>
            <p class="muted small">You set prices and deposits in US dollars. This is the currency your booking page shows first; customers can switch to another on the page.</p>
          </div>
          <div class="field ${s.depositEnabled ? '' : 'hidden'}" id="depf">
            <label for="depn">Deposit per booking</label>
            <input class="input" id="depn" type="number" min="0" value="${s.depositMinor / 100}" ${dis}>
            <p class="muted small">Upfront amount required from customers to confirm their booking slot.</p>
          </div>
        </div>
        <div class="field">
          <div class="row between"><div><b>Use the live naira rate</b><div class="muted small">Recommended. Card payments are converted to naira at the market rate, updated hourly.</div></div><label class="switch"><input type="checkbox" id="fxauto" ${s.exchangeRateMode === 'auto' ? 'checked' : ''} ${dis} aria-label="Use the live naira rate"><span></span></label></div>
          <div class="${s.exchangeRateMode === 'auto' ? 'hidden' : ''}" id="fxm" style="margin-top:10px">
            <label for="fx">Your fixed rate (₦ per $1 USD)</label>
            <input class="input" id="fx" type="number" min="100" max="100000" step="0.01" value="${s.exchangeRate || ''}" ${dis}>
            <p class="muted small">A fixed rate does not move with the market. If the naira weakens you will be paid less than the dollar price is worth, so check it often or switch to the live rate.</p>
          </div>
          <p class="muted small" id="fxlive"></p>
        </div>
      </section>
      <section class="card card-pad form-grid" id="pricesCard"><div><h3>What you charge, in every currency</h3><p class="muted small">Your prices are in US dollars. This shows what customers see in each currency, so you never have to work it out.</p></div><div id="prices"><div class="skel" style="height:80px"></div></div></section>
      ${hasFeatureAccess(me.tenant.tier, 'insights') ? html`<section class="card card-pad form-grid"><div class="row between"><div><h3>Weekly summary email</h3><p class="muted small">Every Monday morning we email the owner last week's bookings, revenue at list price, no-show rate and busiest times. Switch it off here at any time.</p></div><label class="switch"><input type="checkbox" id="wd" ${s.weeklyDigest === false ? '' : 'checked'} ${dis} aria-label="Weekly summary email"><span></span></label></div></section>` : ''}
      ${hasFeatureAccess(me.tenant.tier, 'waitlist') ? html`<section class="card card-pad form-grid"><div class="row between"><div><h3>Revenue protection: waitlist</h3><p class="muted small">When a day is full, your booking page offers a waitlist. If a booking is cancelled, we email the people waiting for that service and day, and the first to book gets the time. See who is waiting under More, Revenue protection.</p></div><label class="switch"><input type="checkbox" id="wl" ${s.waitlistEnabled ? 'checked' : ''} ${dis} aria-label="Offer a waitlist"><span></span></label></div></section>` : ''}
      ${hasFeatureAccess(me.tenant.tier, 'risk') ? html`<section class="card card-pad form-grid"><div class="row between"><div><h3>No-show protection</h3><p class="muted small">Every booking gets a no-show risk score from that customer's history with you. When a booking scores as risky, the customer is asked for a deposit even if you do not ask everyone. Needs your payout account above.</p></div><label class="switch"><input type="checkbox" id="rd" ${s.riskDepositEnabled ? 'checked' : ''} ${dis} aria-label="Ask risky customers for a deposit"><span></span></label></div>
        <div class="form-grid two ${s.riskDepositEnabled ? '' : 'hidden'}" id="rdf"><div class="field"><label for="rl">Ask for a deposit when risk is</label><select class="select" id="rl" ${dis}><option value="high" ${s.riskDepositLevel !== 'medium' ? 'selected' : ''}>High (60 and above)</option><option value="medium" ${s.riskDepositLevel === 'medium' ? 'selected' : ''}>Medium or high (30 and above)</option></select></div>
        <div class="field"><label for="rdn">Deposit for risky bookings ($)</label><input class="input" id="rdn" type="number" min="1" max="5000" value="${(s.riskDepositMinor ?? 500) / 100}" ${dis}></div></div>
        <p class="muted small">Low 0 to 29, medium 30 to 59, high 60 and above. Points come from earlier no-shows, cancellations, unpaid deposits, first-time customers and how far ahead they booked, and good history lowers the score. The reasons are shown on each booking. If you already ask everyone for a deposit, that applies instead.</p></section>`
        : html`<section class="card card-pad"><div class="row between wrap"><div><h3>No-show protection</h3><p class="muted small">Score every booking for no-show risk and ask risky customers for a deposit automatically. Part of the Enterprise and Dedicated plans.</p></div><a class="btn btn-secondary btn-sm" href="/app/billing" data-link>${ic('lock', 'ico-sm')} See plans</a></div></section>`}
      ${canAdmin() ? html`<div><button class="btn btn-primary btn-lg" type="submit">Save changes</button></div>` : ''}
    </form>
    <section class="card card-pad stack-sm" style="margin-top:20px">
      <h3>Account</h3>
      <div class="muted small">Signed in as <b>${me.user.email}</b> · role <b>${me.role}</b></div>
      <div class="muted small">Workspace <span class="mono">${me.tenant.slug}</span> · plan <b style="text-transform:capitalize">${me.tenant.tier}</b></div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border,#e5e7eb)">
        <button type="button" class="btn btn-secondary" data-settings-logout style="color:var(--danger,#e50920);border-color:rgba(229,9,32,0.3)">
          ${ic('log-out', 'ico-sm')} Sign out of ZexCore
        </button>
      </div>
    </section>`);

  // Upfront deposit toggle visibility
  $('#dep', view)?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    $('#depf', view)?.classList.toggle('hidden', !on);
  });

  const fxAuto = (): boolean => ($('#fxauto', view) as HTMLInputElement | null)?.checked === true;
  const cur7: SupportedCurrency[] = ['USD', 'NGN', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'];
  const drawPrices = async (): Promise<void> => {
    const host = $('#prices', view); if (!host) return;
    try {
      const [{ services }, rates] = await Promise.all([api<{ services: Service[] }>('/api/bookings/services'), fetchLiveRates()]);
      const manual = fxAuto() ? null : Number(($('#fx', view) as HTMLInputElement | null)?.value) || null;
      const rows = services.filter((x) => (x as Service & { active?: boolean }).active !== false);
      const line = (usd: number) => cur7.filter((c) => c !== 'USD').map((c) => html`<div><span class="muted small">${c}</span><div class="num"><b>${usd ? formatInCurrency(usd, c, rates, c === 'NGN' ? manual ?? undefined : undefined) : 'Free'}</b></div></div>`);
      const block = (name: string, usd: number) => html`<div class="list-item" style="display:block"><div class="row between"><b>${name}</b><b class="num">${usd ? money(usd, 'USD') : 'Free'}</b></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:8px">${line(usd)}</div></div>`;
      const dep = s.depositEnabled ? [block('Deposit per booking', s.depositMinor)] : [];
      mount(host, html`${rows.length || dep.length ? html`<div class="list">${rows.map((x) => block(x.name, x.priceMinor))}${dep}</div>` : html`<p class="muted small">Add a service and its price will appear here in every currency.</p>`}
        <p class="muted small" style="margin-top:8px">${ratesMeta.live ? `Live market rates, fetched ${new Date(ratesMeta.updatedAt ?? Date.now()).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} and refreshed hourly.` : 'Live rates could not be reached just now, so these use the last known rates and may be out of date.'}${manual ? ` The naira column uses your fixed rate of ₦${manual.toLocaleString('en-NG')} per $1.` : ''} Customers pay by card in naira, so the other currencies are a guide for them.</p>`);
      const lv = $('#fxlive', view); if (lv) lv.textContent = `Today's market rate: ₦${Math.round(rates.NGN).toLocaleString('en-NG')} per $1${ratesMeta.live ? '' : ' (last known; live rate unavailable)'}.`;
    } catch { mount(host, html`<p class="muted small">Could not load your prices. Reload to try again.</p>`); }
  };
  void drawPrices();
  $('#fxauto', view)?.addEventListener('change', (e) => { $('#fxm', view)?.classList.toggle('hidden', (e.target as HTMLInputElement).checked); void drawPrices(); });
  $('#fx', view)?.addEventListener('input', () => void drawPrices());
  $('#rd', view)?.addEventListener('change', (e) => $('#rdf', view)?.classList.toggle('hidden', !(e.target as HTMLInputElement).checked));
  if ($('#nwh', view)) void fetch(`${paymentsUrl()}/api/health`).then((r) => r.json()).then((j: { whatsapp?: boolean }) => {
    if (j.whatsapp !== true && $('#nwh', view)) $('#nwh', view)!.textContent = 'WhatsApp delivery is not switched on for ZexCore yet, so for now you get the email only, with a link to reply to the customer on WhatsApp. This turns into a real WhatsApp message once it is.';
  }).catch(() => undefined);
  $('#nw', view)?.addEventListener('change', (e) => $('#nwf', view)?.classList.toggle('hidden', !(e.target as HTMLInputElement).checked));

  // Logo file picker & preview handling
  if (canBrand) {
    const logoFile = $('#logo-file', view) as HTMLInputElement | null;
    const btnPick = $('#btn-pick-logo', view);
    const btnRemove = $('#btn-remove-logo', view);
    const box = $('#logo-preview-box', view);

    const updatePreview = (): void => {
      if (!box) return;
      if (currentLogo) {
        box.innerHTML = `<img id="logo-img" src="${currentLogo}" alt="Logo" style="width:100%;height:100%;object-fit:contain;padding:4px" />`;
        btnRemove?.classList.remove('hidden');
      } else {
        box.innerHTML = `<span id="logo-empty" class="muted small" style="font-size:11px;text-align:center">No logo</span>`;
        btnRemove?.classList.add('hidden');
      }
    };

    btnPick?.addEventListener('click', () => logoFile?.click());
    btnRemove?.addEventListener('click', () => {
      currentLogo = null;
      if (logoFile) logoFile.value = '';
      updatePreview();
    });

    logoFile?.addEventListener('change', () => {
      const file = logoFile.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Logo image should be under 2MB', 'error'); return; }
      if (file.type === 'image/svg+xml' && file.size > 100 * 1024) { toast('SVG logos should be under 100KB. Use a PNG or a smaller SVG.', 'error'); return; }

      if (file.type === 'image/svg+xml') {
        const reader = new FileReader();
        reader.onload = () => { currentLogo = String(reader.result); updatePreview(); };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxDim = 256;
            let w = img.width, h = img.height;
            if (w > h) { if (w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; } }
            else { if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; } }
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, w, h);
            currentLogo = canvas.toDataURL('image/png');
            updatePreview();
          };
          img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Sign out button
  $('[data-settings-logout]', view)?.addEventListener('click', () => {
    logout();
    clearStore();
    navigate('/signin');
  });

  void paintPayout(view, s.depositEnabled);
  const form = $('#st', view) as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(form.querySelector('button[type=submit]'), async () => {
      const err = $('#st-err', view)!; err.classList.add('hidden');
      const days = $$('input[name=day]:checked', view).map((i) => Number((i as HTMLInputElement).value));
      const depChecked = ($('#dep') as HTMLInputElement).checked;
      const depMinor = depChecked ? Math.round(Number(($('#depn') as HTMLInputElement).value) * 100) : 0;
      try {
        await api('/api/bookings/settings', { method: 'PUT', body: {
          publicName: ($('#pn') as HTMLInputElement).value.trim(), phone: ($('#ph') as HTMLInputElement).value.trim(), address: ($('#ad') as HTMLInputElement).value.trim(),
          openMinutes: timeToMinutes(($('#op') as HTMLInputElement).value), closeMinutes: timeToMinutes(($('#cl') as HTMLInputElement).value), daysOpen: days,
          slotMinutes: Number(($('#sl') as HTMLSelectElement).value), leadMinutes: Math.round(Number(($('#ld') as HTMLInputElement).value) * 60),
          currency: ($('#currency', view) as HTMLSelectElement)?.value || s.currency || 'USD',
          exchangeRate: Number(($('#fx') as HTMLInputElement).value) || s.exchangeRate || 1350,
          exchangeRateMode: ($('#fxauto') as HTMLInputElement).checked ? 'auto' : 'manual',
          depositEnabled: depChecked,
          depositMinor: depMinor,
          ...($('#wd') ? { weeklyDigest: ($('#wd') as HTMLInputElement).checked } : {}),
          ...($('#wl') ? { waitlistEnabled: ($('#wl') as HTMLInputElement).checked } : {}),
          ...($('#rd') ? { riskDepositEnabled: ($('#rd') as HTMLInputElement).checked, riskDepositLevel: ($('#rl') as HTMLSelectElement).value, riskDepositMinor: Math.round(Number(($('#rdn') as HTMLInputElement).value) * 100) } : {}),
          logoUrl: currentLogo,
          reminderEmails: ($('#re') as HTMLInputElement | null)?.checked ?? false,
          followUpEmails: ($('#fu') as HTMLInputElement | null)?.checked ?? false,
          notifyOwnerEmail: ($('#ne') as HTMLInputElement | null)?.checked ?? true,
          notifyOwnerWhatsApp: ($('#nw') as HTMLInputElement | null)?.checked ?? false,
          notifyWhatsAppPhone: ($('#nwp') as HTMLInputElement | null)?.value.trim() || null,
        } });
        await loadSettings(true); toast('Settings saved', 'success');
      } catch (x) { err.textContent = x instanceof ApiError ? x.message : 'Could not save'; err.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
  });
}

interface PayoutInfo { setUp: boolean; bankName: string | null; accountName: string | null; last4: string | null }
async function paintPayout(view: HTMLElement, depositsOn: boolean): Promise<void> {
  const box = $('#payout', view); if (!box) return;
  let p: PayoutInfo;
  try { p = await api<PayoutInfo>('/api/payout'); } catch { box.innerHTML = ''; return; }
  const show = (editing: boolean): void => {
    if (p.setUp && !editing) {
      mount(box, html`<div class="row between wrap" style="gap:12px"><div><h3>Where deposits are paid</h3><p class="muted small">${p.accountName} · ${p.bankName ?? 'Bank'} · account ending ${p.last4}</p></div>${canAdmin() && current()?.role === 'owner' ? html`<button class="btn btn-secondary btn-sm" type="button" id="po-edit">Change account</button>` : ''}</div>`);
      $('#po-edit', box)?.addEventListener('click', () => show(true));
      return;
    }
    if (current()?.role !== 'owner') { mount(box, html`<h3>Where deposits are paid</h3><p class="muted small">${depositsOn ? 'Deposits are on.' : 'The workspace owner has not added a bank account yet.'} Only the owner can add or change it.</p>`); return; }
    mount(box, html`<h3>Where deposits are paid</h3><p class="muted small">Add the bank account that should receive deposits. We check the account name with your bank before saving.</p>
      <div id="po-err" class="alert alert-error hidden" role="alert"></div>
      <div class="form-grid two">
        <div class="field">
          <label for="po-bank-input">Bank <span class="muted small" style="font-weight:normal">(type to search or pick)</span></label>
          <div style="position:relative;display:flex;align-items:center">
            <input
              class="input"
              id="po-bank-input"
              list="po-banks-list"
              placeholder="Type to search (e.g. Access, GTB, Kuda, Zenith)…"
              autocomplete="off"
              style="color:#18191b !important;-webkit-text-fill-color:#18191b !important;background-color:#ffffff !important;caret-color:#e50920 !important;font-size:0.9375rem;padding-right:28px"
            >
            <span style="position:absolute;right:10px;pointer-events:none;color:#8e9bae;font-size:11px">▼</span>
          </div>
          <datalist id="po-banks-list"></datalist>
        </div>
        <div class="field">
          <label for="po-acct">Account number</label>
          <input
            class="input"
            id="po-acct"
            inputmode="numeric"
            maxlength="10"
            placeholder="10 digits"
            autocomplete="off"
            style="color:#18191b !important;-webkit-text-fill-color:#18191b !important;background-color:#ffffff !important;caret-color:#e50920 !important;font-size:0.9375rem"
          >
        </div>
      </div>
      <div class="row" style="gap:8px"><button class="btn btn-primary" type="button" id="po-save">Verify and save</button>${p.setUp ? html`<button class="btn btn-ghost" type="button" id="po-cancel">Cancel</button>` : ''}</div>`);
    const bankInput = $('#po-bank-input', box) as HTMLInputElement;
    const datalist = $('#po-banks-list', box) as HTMLDataListElement;
    let bankList: { name: string; code: string }[] = [];
    void api<{ banks: { name: string; code: string }[] }>('/api/payout/banks').then((r) => {
      bankList = r.banks;
      datalist.innerHTML = r.banks.map((b) => `<option value="${b.name.replace(/[<>&"]/g, '')}">${b.name.replace(/[<>&"]/g, '')}</option>`).join('');
    }).catch((e) => { const er = $('#po-err', box)!; er.textContent = e instanceof ApiError ? e.message : 'Could not load banks.'; er.classList.remove('hidden'); });
    $('#po-cancel', box)?.addEventListener('click', () => show(false));
    $('#po-save', box)?.addEventListener('click', (ev) => {
      void busy(ev.currentTarget as HTMLButtonElement, async () => {
        const er = $('#po-err', box)!; er.classList.add('hidden');
        const typed = bankInput.value.trim().toLowerCase();
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normTyped = norm(typed);

        const acronyms: Record<string, string[]> = {
          gtb: ['guaranty trust', 'gtbank', 'gt bank', 'guaranty'],
          gtbank: ['guaranty trust', 'gtbank', 'gt bank', 'guaranty'],
          fbn: ['first bank'],
          firstbank: ['first bank'],
          uba: ['united bank for africa'],
          ibtc: ['stanbic'],
          stanbic: ['stanbic ibtc'],
          kuda: ['kuda'],
          opay: ['opay', 'paycom'],
          palmpay: ['palmpay'],
        };
        const aliases = acronyms[normTyped] ?? [typed];

        const found = bankList.find((b) => {
          const bLower = b.name.toLowerCase();
          const bNorm = norm(b.name);
          if (bLower === typed || bNorm === normTyped) return true;
          return aliases.some((a) => bLower.includes(a.toLowerCase()) || bNorm.includes(norm(a)));
        }) ?? bankList.find((b) => b.name.toLowerCase().includes(typed));

        if (!found) {
          er.textContent = 'Please choose a valid bank from the suggestions.';
          er.classList.remove('hidden');
          return;
        }
        try {
          const r = await api<{ accountName: string; last4: string }>('/api/payout', { method: 'POST', body: { bankCode: found.code, bankName: found.name, accountNumber: ($('#po-acct', box) as HTMLInputElement).value.trim() } });
          p = { setUp: true, bankName: found.name, accountName: r.accountName, last4: r.last4 };
          toast(`Saved. Deposits will be paid to ${r.accountName}.`, 'success'); show(false);
        } catch (x) { er.textContent = x instanceof ApiError ? x.message : 'Could not save the account.'; er.classList.remove('hidden'); }
      });
    });
  };
  show(false);
}
