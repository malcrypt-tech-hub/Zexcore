import { html, mount, $, $$, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, timeOf, DAY, MON, initials, ymd, whenLabel } from '../lib/format';
import { busy, toast } from '../lib/ui';
import { brand } from '../layouts';
import { formatInCurrency, fetchLiveRates, getCachedRates, type SupportedCurrency } from '../lib/fx';

interface Profile {
  business: { slug: string; name: string; type: string; phone: string | null; address: string | null };
  currency: string; exchangeRate?: number; deposit: { enabled: boolean; amountMinor: number }; waitlist?: boolean;
  hours: { openMinutes: number; closeMinutes: number; daysOpen: number[]; utcOffsetMinutes: number; maxDaysAhead: number };
  paystackPublicKey: string | null;
  services: { id: string; name: string; description: string | null; durationMin: number; priceMinor: number }[];
  staff: { id: string; name: string; title: string | null }[];
}
interface PayInfo { ref: string; status: string; depositStatus: string; amountMinor: number; currency: string; startsAt: string; serviceName: string }


function head(name: string, sub: string): Raw {
  return html`<header class="public-head"><div class="row between"><div class="row"><span class="avatar red" style="border-radius:12px">${initials(name)}</span><div><b style="font-size:1.0625rem">${name}</b><div class="muted small">${sub}</div></div></div><span class="badge" title="Powered by ZexCore">${brand()}</span></div></header>`;
}

export async function renderPublicBooking(slug: string, payRef: string | null): Promise<void> {
  const root = document.getElementById('app')!;
  mount(root, html`<div class="public-wrap"><div class="skel" style="height:64px;margin:12px 0"></div><div class="skel" style="height:300px"></div></div>`);
  let p: Profile;
  try { p = await api<Profile>(`/api/public/${encodeURIComponent(slug)}`, { auth: false }); }
  catch (e) {
    mount(root, html`<div class="auth-wrap"><div class="auth-card" style="text-align:center"><div class="auth-logo">${brand('lg')}</div><h2>${e instanceof ApiError && e.status === 404 ? 'We couldn\'t find that business' : 'Something went wrong'}</h2><p class="muted" style="margin:8px 0 20px">${e instanceof ApiError && e.status === 404 ? 'Check the link you were given, or ask the business to resend it.' : 'Please try again in a moment.'}</p><a class="btn btn-primary" href="/" data-link>Go to ZexCore</a></div></div>`);
    return;
  }
  document.title = `Book with ${p.business.name}`;
  const off = p.hours.utcOffsetMinutes;
  const sub = [p.business.address, p.business.phone].filter(Boolean).join(' · ') || 'Online booking';

  const showReceipt = (ref: string, serviceName: string, startsAt: string, status: string, paid: boolean): void => {
    mount(root, html`<div class="public-wrap">${head(p.business.name, sub)}
      <div class="receipt"><span class="icon-tile" style="margin:0 auto 12px;background:${paid || status === 'confirmed' ? 'var(--success)' : 'var(--warning)'};color:#fff;border-radius:50%">${ic(paid || status === 'confirmed' ? 'check' : 'clock')}</span>
        <h2>${paid || status === 'confirmed' ? 'You\'re booked' : 'Request received'}</h2>
        <p class="muted" style="margin:6px 0 18px">${paid || status === 'confirmed' ? 'Your appointment is confirmed.' : 'The business will confirm your appointment shortly.'}</p>
        <div class="booking-meta" style="text-align:left"><div class="l"><span class="muted">Service</span><b>${serviceName}</b></div><div class="l"><span class="muted">When</span><b>${whenLabel(startsAt, off)}</b></div><div class="l"><span class="muted">Reference</span><span class="ref">${ref}</span></div>${p.business.address ? html`<div class="l"><span class="muted">Where</span><b>${p.business.address}</b></div>` : ''}</div>
        <p class="muted small" style="margin-top:16px">Save your reference. ${p.business.phone ? html`Questions? Call <a href="tel:${p.business.phone}" style="text-decoration:underline">${p.business.phone}</a>.` : ''}</p></div></div>`);
  };

  const status = (ref: string): Promise<PayInfo> => api<PayInfo>(`/api/public/${slug}/payments/${encodeURIComponent(ref)}`, { auth: false });
  const waiting = (): void => mount(root, html`<div class="auth-wrap"><div class="auth-card" style="text-align:center"><div class="spinner" style="margin:0 auto 14px"></div><h3>Confirming your payment…</h3><p class="muted small" style="margin-top:6px">This usually takes a few seconds.</p></div></div>`);

  // ── Returning from Paystack: confirm the deposit with the server (it verifies with Paystack itself) ──
  if (payRef) {
    waiting();
    for (let i = 0; i < 10; i++) {
      try {
        const s = await status(payRef);
        if (s.depositStatus === 'paid') { showReceipt(s.ref, s.serviceName, s.startsAt, s.status, true); return; }
        if (s.depositStatus === 'mismatch') break;
      } catch (e) { if (e instanceof ApiError && e.status === 404) break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    mount(root, html`<div class="public-wrap">${head(p.business.name, sub)}<div class="card"><div class="empty"><h3>We have not received your payment yet</h3><p>If you were charged, your booking will be confirmed automatically within a few minutes. Otherwise ${p.business.phone ? html`call ${p.business.phone}` : 'contact the business'} to complete it.</p></div></div></div>`);
    return;
  }

  // ── Booking flow ──
  let rates = getCachedRates();
  void fetchLiveRates().then((r) => { rates = r; draw(); }).catch(() => undefined);
  let displayCurrency: SupportedCurrency = (['USD', 'NGN', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'].includes(p.currency) ? (p.currency as SupportedCurrency) : 'USD');
  try {
    const saved = localStorage.getItem('zx.display_currency') as SupportedCurrency;
    if (saved && ['USD', 'NGN', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'].includes(saved)) {
      displayCurrency = saved;
    }
  } catch { /* ignore */ }

  const st = { serviceId: p.services[0]?.id ?? '', staffId: '', date: '', slot: '' };
  const today = ymd(new Date().toISOString(), off);
  const days: string[] = [];
  for (let i = 0; i < Math.min(p.hours.maxDaysAhead, 21); i++) days.push(ymd(new Date(Date.now() + i * 86_400_000).toISOString(), off));
  const open = (d: string) => p.hours.daysOpen.includes(new Date(d + 'T00:00:00Z').getUTCDay());
  st.date = days.find(open) ?? today;
  { // a waitlist offer links here with ?service=&date= so the freed day is already selected
    const q = new URLSearchParams(location.search); const sv = q.get('service'), dt = q.get('date');
    if (sv && p.services.some((s) => s.id === sv)) st.serviceId = sv;
    if (dt && days.includes(dt)) st.date = dt;
  }
  const svc = () => p.services.find((s) => s.id === st.serviceId);
  const needDeposit = p.deposit.enabled;
  const dep = () => { const s = svc(); const price = s?.priceMinor ?? 0; return needDeposit ? (price > 0 ? Math.min(p.deposit.amountMinor, price) : p.deposit.amountMinor) : 0; };

  const priceText = (usdMinor: number): string => {
    if (!usdMinor) return 'Free';
    if (displayCurrency === 'USD') return money(usdMinor, 'USD');
    const converted = formatInCurrency(usdMinor, displayCurrency, rates, p.exchangeRate);
    return `${converted} (${money(usdMinor, 'USD')})`;
  };

  const depositNgn = (): number => {
    const rate = p.exchangeRate && p.exchangeRate > 100 ? p.exchangeRate : (rates.NGN || 1350);
    return Math.round(dep() * rate);
  };

  if (!p.services.length) { mount(root, html`<div class="public-wrap">${head(p.business.name, sub)}<div class="card"><div class="empty"><h3>Bookings aren't open yet</h3><p>${p.business.name} hasn't added any services. Please check back soon.</p></div></div></div>`); return; }

  const draw = () => {
    mount(root, html`<div class="public-wrap">${head(p.business.name, sub)}
      <div class="row between wrap" style="align-items:center;margin:-10px 0 16px;gap:8px">
        <span class="muted small">Display prices in:</span>
        <div class="row" style="gap:4px">
          ${(['USD', 'NGN', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'] as SupportedCurrency[]).map((cur) => html`<button type="button" class="btn btn-sm ${cur === displayCurrency ? 'btn-primary' : 'btn-secondary'}" data-cur="${cur}" style="padding:0 8px;font-size:0.75rem;min-height:28px;height:28px">${cur}</button>`)}
        </div>
      </div>
      <form id="bf" novalidate>
      <section class="pub-section"><h2 style="margin-top:8px">1. Choose a service <small></small></h2>
        <div class="stack-sm" role="radiogroup" aria-label="Service">${p.services.map((s) => html`<button type="button" class="option-card" role="radio" aria-checked="${s.id === st.serviceId}" data-svc="${s.id}"><span class="radio-dot">${ic('check')}</span><span class="grow"><b>${s.name}</b><br><span class="muted small">${s.durationMin} min${s.description ? ` · ${s.description}` : ''}</span></span><b class="num" style="color:var(--primary)">${priceText(s.priceMinor)}</b></button>`)}</div></section>
      ${p.staff.length ? html`<section class="pub-section"><h2>2. Choose who <small>Any available is fastest</small></h2>
        <div class="stack" style="grid-template-columns:1fr 1fr;gap:10px"><button type="button" class="option-card" role="radio" aria-checked="${st.staffId === ''}" data-staff="" style="background:${st.staffId === '' ? 'var(--primary-tint)' : '#fff'}"><span class="grow"><b>Any available</b><br><span class="muted small">Auto-assigned</span></span></button>
        ${p.staff.map((s) => html`<button type="button" class="option-card" role="radio" aria-checked="${s.id === st.staffId}" data-staff="${s.id}"><span class="avatar grey">${initials(s.name)}</span><span class="grow"><b>${s.name}</b><br><span class="muted small">${s.title ?? ''}</span></span></button>`)}</div></section>` : ''}
      <section class="pub-section"><h2>${p.staff.length ? 3 : 2}. Pick a date & time <small>${off === 60 ? 'WAT (GMT+1)' : ''}</small></h2>
        <div class="date-strip">${days.map((d) => { const dt = new Date(d + 'T00:00:00Z'); return html`<button type="button" class="date-chip" aria-pressed="${d === st.date}" data-date="${d}" ${open(d) ? '' : 'disabled'}><span>${DAY[dt.getUTCDay()]}</span><b>${dt.getUTCDate()}</b><span>${MON[dt.getUTCMonth()]}</span></button>`; })}</div>
        <div id="slots" class="slot-grid" style="margin-top:12px" aria-live="polite"></div></section>
      <section class="pub-section"><h2>${p.staff.length ? 4 : 3}. Your details</h2>
        <div class="card card-pad form-grid">
          <div class="field"><label for="cn">Full name</label><input class="input" id="cn" autocomplete="name" required maxlength="160"></div>
          <div class="field"><label for="cp">WhatsApp / mobile number</label><input class="input" id="cp" type="tel" autocomplete="tel" required placeholder="0803 123 4567"></div>
          <div class="field"><label for="ce">Email ${needDeposit ? '(for your receipt)' : html`<span class="faint">(optional)</span>`}</label><input class="input" id="ce" type="email" autocomplete="email" ${needDeposit ? 'required' : ''}></div>
        </div></section>
      ${needDeposit ? html`<section class="pub-section"><h2>${p.staff.length ? 5 : 4}. Secure your slot</h2><div class="notice">${ic('info')}<div><b>${priceText(dep())} refundable deposit</b> is required to hold your appointment. You will pay securely by card.${svc() && svc()!.priceMinor > dep() ? html` The balance of <b>${priceText(svc()!.priceMinor - dep())}</b> is paid when you arrive.` : ''}<div class="muted small" style="margin-top:6px;font-size:0.75rem">Charged as ${money(depositNgn(), 'NGN')} via Paystack at checkout.</div></div></div></section>` : ''}
      <div id="berr" class="alert alert-error hidden" style="margin-top:16px" role="alert"></div>
      </form>
      <div class="pay-bar"><div><button class="btn btn-primary btn-lg btn-block" id="go">${needDeposit ? html`${ic('lock', 'ico-sm')} Pay ${money(depositNgn(), 'NGN')} deposit` : 'Request booking'}</button>
        ${needDeposit ? html`<p class="muted small" style="text-align:center;margin-top:6px">Secured by Paystack (${priceText(dep())})</p>` : ''}</div></div></div>`);

    $$('[data-cur]').forEach((b) => b.addEventListener('click', () => {
      displayCurrency = b.dataset.cur as SupportedCurrency;
      try { localStorage.setItem('zx.display_currency', displayCurrency); } catch { /* ignore */ }
      keep();
    }));
    $$('[data-svc]').forEach((b) => b.addEventListener('click', () => { st.serviceId = b.dataset.svc!; st.slot = ''; keep(); }));
    $$('[data-staff]').forEach((b) => b.addEventListener('click', () => { st.staffId = b.dataset.staff!; st.slot = ''; keep(); }));
    $$('[data-date]').forEach((b) => b.addEventListener('click', () => { st.date = b.dataset.date!; st.slot = ''; keep(); }));
    void loadSlots();
    $('#go')!.addEventListener('click', (e) => void submit(e.currentTarget as HTMLButtonElement));
  };
  const keep = () => { const v = { n: ($('#cn') as HTMLInputElement)?.value, p: ($('#cp') as HTMLInputElement)?.value, e: ($('#ce') as HTMLInputElement)?.value }; const y = window.scrollY; draw(); ($('#cn') as HTMLInputElement).value = v.n ?? ''; ($('#cp') as HTMLInputElement).value = v.p ?? ''; ($('#ce') as HTMLInputElement).value = v.e ?? ''; window.scrollTo(0, y); };

  async function loadSlots(): Promise<void> {
    const host = $('#slots')!;
    mount(host, html`<div class="skel" style="height:56px;grid-column:1/-1"></div>`);
    try {
      const q = new URLSearchParams({ date: st.date, serviceId: st.serviceId }); if (st.staffId) q.set('staffId', st.staffId);
      const r = await api<{ slots: { startsAt: string; available: boolean }[] }>(`/api/public/${slug}/availability?${q}`, { auth: false });
      const full = !r.slots.some((s) => s.available);
      if (full && p.waitlist) {
        mount(host, html`${r.slots.length ? '' : html`<p class="muted" style="grid-column:1/-1">No times available on this day.</p>`}<div class="notice" style="grid-column:1/-1">${ic('info')}<div><b>Fully booked?</b> Join the waitlist and we will email you if a time opens up on this day. It is first come, first served.<div style="margin-top:10px"><button type="button" class="btn btn-secondary" id="wl">Join the waitlist</button></div><div id="wlmsg" class="small" style="margin-top:8px" role="status"></div></div></div>`);
        $('#wl')!.addEventListener('click', (e) => void joinWaitlist(e.currentTarget as HTMLButtonElement));
        if (!r.slots.length) return;
      } else if (!r.slots.length) { mount(host, html`<p class="muted" style="grid-column:1/-1">No times available on this day. Try another date.</p>`); return; }
      mount(host, html`${full && p.waitlist ? html`<div class="notice" style="grid-column:1/-1">${ic('info')}<div><b>Fully booked?</b> Join the waitlist and we will email you if a time opens up on this day. It is first come, first served.<div style="margin-top:10px"><button type="button" class="btn btn-secondary" id="wl">Join the waitlist</button></div><div id="wlmsg" class="small" style="margin-top:8px" role="status"></div></div></div>` : ''}${r.slots.map((s) => html`<button type="button" class="slot" data-t="${s.startsAt}" aria-pressed="${s.startsAt === st.slot}" ${s.available ? '' : 'disabled'}>${timeOf(s.startsAt, off)}<small>${s.available ? 'Available' : 'Booked'}</small></button>`)}`);
      if (full && p.waitlist) $('#wl')!.addEventListener('click', (e) => void joinWaitlist(e.currentTarget as HTMLButtonElement));
      $$('.slot:not(:disabled)', host).forEach((b) => b.addEventListener('click', () => { st.slot = b.dataset.t!; $$('.slot', host).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
    } catch { mount(host, html`<p class="err" style="grid-column:1/-1">Could not load times. Please refresh.</p>`); }
  }

  async function joinWaitlist(btn: HTMLButtonElement): Promise<void> {
    const msg = $('#wlmsg')!; const say = (m: string, ok = false) => { msg.textContent = m; msg.style.color = ok ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)'; };
    const name = ($('#cn') as HTMLInputElement).value.trim(), phone = ($('#cp') as HTMLInputElement).value.trim(), email = ($('#ce') as HTMLInputElement).value.trim();
    if (name.length < 2) return say('Enter your full name above first.');
    if (!phone) return say('Enter your phone number above first.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return say('Enter your email above so we can tell you when a time opens.');
    await busy(btn, async () => {
      try { await api(`/api/public/${slug}/waitlist`, { method: 'POST', auth: false, body: { serviceId: st.serviceId, date: st.date, name, phone, email } }); say('You are on the waitlist. We will email you if a time opens up on this day.', true); btn.disabled = true; }
      catch (e) { say(e instanceof ApiError ? e.message : 'Could not join the waitlist. Please try again.'); }
    });
  }

  async function submit(btn: HTMLButtonElement): Promise<void> {
    const err = $('#berr')!; err.classList.add('hidden');
    const fail = (m: string) => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    const name = ($('#cn') as HTMLInputElement).value.trim(), phone = ($('#cp') as HTMLInputElement).value.trim(), email = ($('#ce') as HTMLInputElement).value.trim();
    if (!st.slot) return fail('Please pick a time slot.');
    if (name.length < 2) return fail('Please enter your full name.');
    if (!phone) return fail('Please enter your phone number.');
    if (needDeposit && !/^\S+@\S+\.\S+$/.test(email)) return fail('Please enter a valid email for your receipt.');
    await busy(btn, async () => {
      try {
        const r = await api<{ booking: { ref: string; status: string; startsAt: string; serviceName: string }; payment: { reference: string; amountMinor: number; authorizationUrl: string } | null }>(`/api/public/${slug}/bookings`, { method: 'POST', auth: false, body: { serviceId: st.serviceId, staffId: st.staffId || null, customerName: name, customerPhone: phone, customerEmail: email || null, startsAt: st.slot } });
        if (!r.payment) { showReceipt(r.booking.ref, r.booking.serviceName, r.booking.startsAt, r.booking.status, false); if (needDeposit) toast('Your request is in. The business will arrange your deposit with you.', 'info'); return; }
        location.assign(r.payment.authorizationUrl);
      } catch (e) { fail(e instanceof ApiError ? e.message : 'Could not complete your booking'); if (e instanceof ApiError && e.status === 409) void loadSlots(); }
    });
  }
  draw();
}
