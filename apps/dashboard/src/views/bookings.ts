import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, whenLabel, timeOf, initials, ymd } from '../lib/format';
import { toast, openModal, confirmDialog, emptyState, errorState, skeletonRows, busy, copyText } from '../lib/ui';
import { type Booking, type Service, type Staff, offset, loadSettings, tenantSlug, bookingUrl } from '../lib/store';
import { canManage } from '../lib/session';

export const statusBadge = (s: Booking['status']): Raw => ({
  pending: html`<span class="badge badge-warning"><span class="dot dot-warning"></span>Pending</span>`,
  confirmed: html`<span class="badge badge-info"><span class="dot" style="background:var(--info)"></span>Confirmed</span>`,
  completed: html`<span class="badge badge-success">${ic('check', 'ico-sm')}Completed</span>`,
  cancelled: html`<span class="badge">Cancelled</span>`,
  no_show: html`<span class="badge badge-primary">No-show</span>`,
}[s]);

export const depositBadge = (b: Booking): Raw => {
  if (b.depositStatus === 'paid' && b.status === 'cancelled') return html`<span class="badge badge-warning">${ic('triangle-alert', 'ico-sm')}Cancelled — ${money(b.depositMinor, b.currency)} deposit to refund</span>`;
  if (b.depositStatus === 'paid') return html`<span class="badge badge-success">${ic('circle-check', 'ico-sm')}Deposit ${money(b.depositMinor, b.currency)} paid</span>`;
  if (b.depositStatus === 'unpaid') return html`<span class="badge badge-primary">${ic('triangle-alert', 'ico-sm')}Deposit ${money(b.depositMinor, b.currency)} unpaid</span>`;
  if (b.depositStatus === 'mismatch') return html`<span class="badge badge-warning">Payment amount mismatch</span>`;
  return '' as unknown as Raw;
};

export function bookingCard(b: Booking): Raw {
  const needs = b.depositStatus === 'unpaid' && (b.status === 'pending' || b.status === 'confirmed');
  return html`<article class="card booking-card ${needs ? 'needs' : ''}" data-id="${b.id}">
    <div class="row">
      <span class="avatar ${needs ? 'red' : ''}">${initials(b.customerName)}</span>
      <div class="grow"><div style="font-weight:650">${b.customerName}</div><div class="muted small">${b.customerPhone}</div></div>
      ${canManage() ? html`<button class="btn btn-ghost btn-sm btn-icon" data-act="menu" aria-label="Actions for ${b.customerName}">${ic('ellipsis-vertical')}</button>` : ''}
    </div>
    <div class="booking-meta">
      <div class="l"><b>${b.serviceName ?? 'Service'}</b><span class="ref">${b.ref}</span></div>
      <div class="l muted"><span>${b.staffName ? ic('user', 'ico-sm') : ''} ${b.staffName ?? 'Unassigned'}</span><span class="row" style="gap:4px">${ic('clock', 'ico-sm')} ${whenLabel(b.startsAt, offset())}</span></div>
    </div>
    <div class="row wrap" style="gap:8px">${statusBadge(b.status)} ${depositBadge(b)}</div>
    ${needs && canManage() ? html`<button class="btn btn-primary btn-block" data-act="link">${ic('send', 'ico-sm')} Send payment link</button>` : ''}
    <div class="row" style="gap:8px">
      <a class="btn btn-secondary btn-sm grow" href="https://wa.me/${b.customerPhone.replace('+', '')}" target="_blank" rel="noopener noreferrer">${ic('message-circle', 'ico-sm')} WhatsApp</a>
      <a class="btn btn-secondary btn-sm grow" href="tel:${b.customerPhone}">${ic('phone', 'ico-sm')} Call</a>
    </div>
  </article>`;
}

/** Wires the actions on booking cards inside `host`. `reload` refreshes the surrounding view. */
export function wireBookingCards(host: HTMLElement, list: Booking[], reload: () => void): void {
  host.querySelectorAll<HTMLElement>('.booking-card').forEach((card) => {
    const b = list.find((x) => x.id === card.dataset.id);
    if (!b) return;
    card.querySelector('[data-act="menu"]')?.addEventListener('click', () => openActions(b, reload));
    card.querySelector('[data-act="link"]')?.addEventListener('click', (e) => void sendPaymentLink(b, e.currentTarget as HTMLButtonElement, reload));
  });
}

async function sendPaymentLink(b: Booking, btn: HTMLButtonElement | null, reload: () => void): Promise<void> {
  await busy(btn, async () => {
    try {
      const r = await api<{ url: string; message: string; phone: string }>(`/api/bookings/${b.id}/payment-link`, { method: 'POST' });
      const wa = `https://wa.me/${r.phone.replace('+', '')}?text=${encodeURIComponent(r.message)}`;
      openModal({
        title: 'Payment link ready', subtitle: `Deposit for ${b.customerName} (${b.ref})`,
        body: html`<div class="stack">
          <div class="copy-box"><code>${r.url}</code><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy</button></div>
          <p class="muted small">Send it by WhatsApp or SMS. The booking is confirmed automatically once the deposit is paid.</p></div>`,
        footer: html`<a class="btn btn-primary" href="${wa}" target="_blank" rel="noopener noreferrer">${ic('message-circle', 'ico-sm')} Send on WhatsApp</a>`,
        onMount: (el) => el.querySelector('[data-copy]')!.addEventListener('click', () => copyText(r.url)),
      });
      reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not create the link', 'error'); }
  });
}

async function patch(id: string, body: object, ok: string): Promise<boolean> {
  try { await api(`/api/bookings/${id}`, { method: 'PATCH', body }); toast(ok, 'success'); return true; }
  catch (e) { toast(e instanceof ApiError ? e.message : 'Update failed', 'error'); return false; }
}

function openActions(b: Booking, reload: () => void): void {
  const items: { key: string; label: string; icon: Parameters<typeof ic>[0]; show: boolean; danger?: boolean }[] = [
    { key: 'confirm', label: 'Confirm booking', icon: 'circle-check', show: b.status === 'pending' },
    { key: 'link', label: 'Send payment link', icon: 'send', show: b.depositStatus === 'unpaid' || (b.depositStatus === 'none' && b.status !== 'cancelled' && b.status !== 'completed') },
    { key: 'paid', label: 'Record deposit as received', icon: 'banknote', show: b.depositStatus === 'unpaid' || b.depositStatus === 'mismatch' },
    { key: 'resched', label: 'Reschedule', icon: 'calendar-days', show: b.status === 'pending' || b.status === 'confirmed' },
    { key: 'complete', label: 'Mark completed', icon: 'check-check', show: b.status === 'confirmed' || b.status === 'pending' },
    { key: 'noshow', label: 'Mark no-show', icon: 'x', show: b.status === 'confirmed' },
    { key: 'cancel', label: 'Cancel booking', icon: 'trash-2', show: b.status === 'pending' || b.status === 'confirmed', danger: true },
  ];
  openModal({
    title: b.customerName, subtitle: `${b.serviceName} · ${whenLabel(b.startsAt, offset())}`,
    body: html`<div class="stack-sm">${items.filter((i) => i.show).map((i) => html`<button class="option-card" data-k="${i.key}" style="${i.danger ? 'color:var(--primary)' : ''}"><span class="icon-tile">${ic(i.icon)}</span><span class="grow" style="font-weight:600">${i.label}</span></button>`)}</div>`,
    onMount: (el, close) => el.querySelectorAll<HTMLElement>('[data-k]').forEach((btn) => btn.addEventListener('click', async () => {
      const k = btn.dataset.k!;
      close();
      if (k === 'confirm' && await patch(b.id, { status: 'confirmed' }, 'Booking confirmed')) reload();
      if (k === 'complete' && await patch(b.id, { status: 'completed' }, 'Marked completed')) reload();
      if (k === 'noshow' && await patch(b.id, { status: 'no_show' }, 'Marked as no-show')) reload();
      if (k === 'paid' && await patch(b.id, { markDepositPaid: true }, 'Deposit recorded')) reload();
      if (k === 'link') await sendPaymentLink(b, null, reload);
      if (k === 'resched') openReschedule(b, reload);
      if (k === 'cancel' && await confirmDialog({ title: 'Cancel this booking?', message: b.depositStatus === 'paid' ? `${b.customerName}'s slot will be released. They paid a ${money(b.depositMinor, b.currency)} deposit online. It is NOT refunded automatically: refund it from your Paystack dashboard (Transactions) and let them know.` : `${b.customerName}'s slot will be released. This cannot be undone.`, confirmLabel: 'Cancel booking', danger: true }) && await patch(b.id, { status: 'cancelled' }, 'Booking cancelled')) reload();
    })),
  });
}

// ── Slot picker shared by new booking + reschedule ───────────────────────────
interface Slot { startsAt: string; available: boolean }
function slotPicker(host: HTMLElement, serviceId: () => string, staffId: () => string, onPick: (iso: string | null) => void, minDate = ymd(new Date().toISOString(), offset())): void {
  mount(host, html`<div class="stack-sm"><div class="field"><label for="sp-date">Date</label><input class="input" id="sp-date" type="date" min="${minDate}" value="${minDate}"></div><div id="sp-slots" class="slot-grid"></div></div>`);
  let picked: string | null = null;
  const grid = $('#sp-slots', host)!;
  const load = async () => {
    picked = null; onPick(null);
    const date = ($('#sp-date', host) as HTMLInputElement).value;
    if (!serviceId() || !date) { mount(grid, ''); return; }
    mount(grid, html`<div class="skel" style="height:56px;grid-column:1/-1"></div>`);
    try {
      const q = new URLSearchParams({ date, serviceId: serviceId() });
      if (staffId()) q.set('staffId', staffId());
      const r = await api<{ slots: Slot[] }>(`/api/public/${tenantSlug()}/availability?${q}`);
      if (!r.slots.length) { mount(grid, html`<p class="muted small" style="grid-column:1/-1">No slots on this day. Pick another date or check your opening hours in Settings.</p>`); return; }
      mount(grid, html`${r.slots.map((s) => html`<button type="button" class="slot" data-t="${s.startsAt}" ${s.available ? '' : 'disabled'} aria-pressed="false">${timeOf(s.startsAt, offset())}<small>${s.available ? 'Available' : 'Booked'}</small></button>`)}`);
      grid.querySelectorAll<HTMLButtonElement>('.slot:not(:disabled)').forEach((b) => b.addEventListener('click', () => {
        grid.querySelectorAll('.slot').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true'); picked = b.dataset.t!; onPick(picked);
      }));
    } catch (e) { mount(grid, html`<p class="err" style="grid-column:1/-1">${e instanceof ApiError ? e.message : 'Could not load slots'}</p>`); }
  };
  $('#sp-date', host)!.addEventListener('change', load);
  host.addEventListener('slots:reload', load);
  void load();
}

function openReschedule(b: Booking, reload: () => void): void {
  let pick: string | null = null;
  openModal({
    title: 'Reschedule', subtitle: `${b.customerName} · currently ${whenLabel(b.startsAt, offset())}`,
    body: html`<div id="rs"></div>`,
    footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-save disabled>Move booking</button>`,
    onMount: (el, close) => {
      const save = $('[data-save]', el) as HTMLButtonElement;
      slotPicker($('#rs', el)!, () => b.serviceId, () => b.staffId ?? '', (iso) => { pick = iso; save.disabled = !iso; });
      save.addEventListener('click', () => void busy(save, async () => { if (pick && await patch(b.id, { startsAt: pick }, 'Booking moved')) { close(); reload(); } }));
    },
  });
}

export async function openNewBooking(onDone: () => void): Promise<void> {
  let services: Service[] = [], staff: Staff[] = [];
  try {
    const [s, t] = await Promise.all([api<{ services: Service[] }>('/api/bookings/services'), api<{ staff: Staff[] }>('/api/bookings/staff')]);
    services = s.services.filter((x) => x.active); staff = t.staff.filter((x) => x.active);
  } catch { toast('Could not load services', 'error'); return; }
  if (!services.length) {
    openModal({ title: 'Add a service first', body: html`<p class="muted">Bookings need at least one service (for example “Consultation, 30 min”).</p>`, footer: html`<a class="btn btn-primary" href="/app/services" data-link data-close>Add a service</a>` });
    return;
  }
  let pick: string | null = null;
  openModal({
    title: 'New booking',
    body: html`<form id="nb" class="form-grid" novalidate>
      <div id="nb-err" class="alert alert-error hidden" role="alert"></div>
      <div class="field"><label for="nb-svc">Service</label><select class="select" id="nb-svc">${services.map((s) => html`<option value="${s.id}">${s.name} · ${s.durationMin} min · ${money(s.priceMinor)}</option>`)}</select></div>
      ${staff.length ? html`<div class="field"><label for="nb-staff">Staff</label><select class="select" id="nb-staff"><option value="">Any available</option>${staff.map((s) => html`<option value="${s.id}">${s.name}${s.title ? ` · ${s.title}` : ''}</option>`)}</select></div>` : ''}
      <div id="nb-slots"></div>
      <div class="form-grid two">
        <div class="field"><label for="nb-name">Customer name</label><input class="input" id="nb-name" required maxlength="160" autocomplete="off"></div>
        <div class="field"><label for="nb-phone">WhatsApp / phone</label><input class="input" id="nb-phone" required type="tel" placeholder="0803 123 4567" autocomplete="off"></div>
      </div>
      <div class="field"><label for="nb-notes">Notes <span class="faint">(optional)</span></label><input class="input" id="nb-notes" maxlength="1000"></div>
    </form>`,
    footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-save>Create booking</button>`,
    onMount: (el, close) => {
      const svc = $('#nb-svc', el) as HTMLSelectElement, stf = $('#nb-staff', el) as HTMLSelectElement | null;
      const host = $('#nb-slots', el)!;
      slotPicker(host, () => svc.value, () => stf?.value ?? '', (iso) => { pick = iso; });
      const reslot = () => host.dispatchEvent(new Event('slots:reload'));
      svc.addEventListener('change', reslot); stf?.addEventListener('change', reslot);
      const save = $('[data-save]', el) as HTMLButtonElement;
      const err = $('#nb-err', el)!;
      save.addEventListener('click', () => void busy(save, async () => {
        err.classList.add('hidden');
        const name = ($('#nb-name', el) as HTMLInputElement).value.trim(), phone = ($('#nb-phone', el) as HTMLInputElement).value.trim();
        if (!pick) { err.textContent = 'Pick a time slot.'; err.classList.remove('hidden'); return; }
        if (!name || !phone) { err.textContent = 'Customer name and phone are required.'; err.classList.remove('hidden'); return; }
        try {
          await api('/api/bookings', { method: 'POST', body: { serviceId: svc.value, staffId: stf?.value || null, customerName: name, customerPhone: phone, startsAt: pick, notes: ($('#nb-notes', el) as HTMLInputElement).value.trim() || null } });
          toast('Booking created', 'success'); close(); onDone();
        } catch (e) { err.textContent = e instanceof ApiError ? e.message : 'Could not create booking'; err.classList.remove('hidden'); }
      }));
    },
  });
}

// ── Bookings page ────────────────────────────────────────────────────────────
type Tab = 'all' | 'upcoming' | 'pending' | 'completed';
export async function renderBookings(view: HTMLElement): Promise<void> {
  await loadSettings();
  let tab: Tab = 'upcoming', q = '';
  mount(view, html`
    <div class="page-head"><div><h1>Bookings</h1><p>Everything your customers have booked, in one place.</p></div>
      ${canManage() ? html`<button class="btn btn-primary" data-new-booking>${ic('plus', 'ico-sm')} New booking</button>` : ''}</div>
    <div class="link-card" style="margin-bottom:16px">
      <div class="row between"><div class="row"><span class="icon-tile" style="background:var(--primary-tint);color:var(--primary)">${ic('share-2')}</span><div><b>Your public booking link</b><div class="muted small">Share it on WhatsApp, Instagram or your door.</div></div></div><span class="badge badge-success">Active</span></div>
      <div class="copy-box"><code>${bookingUrl()}</code><button class="btn btn-secondary btn-sm" data-copy>${ic('copy', 'ico-sm')} Copy link</button></div>
    </div>
    <div class="input-icon" style="margin-bottom:12px">${ic('search')}<input class="input" id="bq" type="search" placeholder="Search customer, phone or booking ID" aria-label="Search bookings"></div>
    <div class="chips" id="tabs" role="tablist"></div>
    <div id="list" class="stack" style="margin-top:8px"></div>`);
  $('[data-copy]', view)!.addEventListener('click', () => copyText(bookingUrl()));
  $('[data-new-booking]', view)?.addEventListener('click', () => void openNewBooking(load));
  const list = $('#list', view)!, tabs = $('#tabs', view)!;

  async function load(): Promise<void> {
    mount(list, skeletonRows(3));
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (tab === 'upcoming') params.set('upcoming', 'true');
      if (tab === 'pending') params.set('status', 'pending');
      if (tab === 'completed') params.set('status', 'completed');
      if (q) params.set('q', q);
      const r = await api<{ bookings: Booking[]; counts: Record<string, number> }>(`/api/bookings?${params}`);
      mount(tabs, html`${(['upcoming', 'all', 'pending', 'completed'] as Tab[]).map((t) => html`<button class="chip-btn" role="tab" aria-pressed="${t === tab}" data-tab="${t}">${t[0]!.toUpperCase() + t.slice(1)} <span class="count">${r.counts[t === 'all' ? 'all' : t] ?? 0}</span></button>`)}`);
      tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab as Tab; void load(); }));
      if (!r.bookings.length) {
        mount(list, html`<div class="card">${emptyState({ icon: 'calendar-days', title: q ? 'No matches' : 'No bookings yet', text: q ? 'Try a different name, phone number or booking ID.' : 'Share your booking link or add a booking yourself. New bookings show up here instantly.', action: canManage() && !q ? html`<button class="btn btn-primary btn-sm" data-empty-new>${ic('plus', 'ico-sm')} New booking</button>` : undefined })}</div>`);
        $('[data-empty-new]', list)?.addEventListener('click', () => void openNewBooking(load));
        return;
      }
      mount(list, html`<div class="stack" style="gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))">${r.bookings.map(bookingCard)}</div>`);
      wireBookingCards(list, r.bookings, () => void load());
    } catch (e) {
      mount(list, html`<div class="card">${errorState(e instanceof ApiError ? e.message : 'Could not load bookings')}</div>`);
      $('[data-retry]', list)?.addEventListener('click', () => void load());
    }
  }
  let t: number | undefined;
  $('#bq', view)!.addEventListener('input', (e) => { clearTimeout(t); t = window.setTimeout(() => { q = (e.target as HTMLInputElement).value.trim(); void load(); }, 300); });
  await load();

}
