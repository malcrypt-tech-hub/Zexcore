import { html, mount, $, $$ } from '../lib/html';
import { ic, type IconName } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { current } from '../lib/session';
import { navigate } from '../router';
import { busy, toast } from '../lib/ui';
import { loadSettings, tenantSlug, SITE_URL } from '../lib/store';
import { minutesToTime, timeToMinutes } from '../lib/format';

type BizType = 'clinic' | 'real_estate' | 'salon' | 'delivery' | 'retail' | 'other';
const TYPES: { key: BizType; icon: IconName; title: string; text: string; popular?: boolean }[] = [
  { key: 'clinic', icon: 'stethoscope', title: 'Clinic or pharmacy', text: 'Patient consultations, test follow-ups and vaccinations.', popular: true },
  { key: 'real_estate', icon: 'building-2', title: 'Property & real estate', text: 'Property viewings, tenant inspections and short-let bookings.' },
  { key: 'salon', icon: 'scissors', title: 'Salon & spa', text: 'Hair, nails and spa sessions with upfront slot deposits.' },
  { key: 'delivery', icon: 'truck', title: 'Delivery & logistics', text: 'Pickup bookings and dispatch slots.' },
  { key: 'retail', icon: 'shopping-bag', title: 'Shop or retail store', text: 'Fittings, pickups and in-store appointments.' },
  { key: 'other', icon: 'sparkles', title: 'Something else', text: 'Consultants, event planners, creators and coaches.' },
];
// Starting points only. The owner edits or removes them before anything is saved.
const SUGGEST: Record<BizType, { name: string; min: number; ngn: number }[]> = {
  clinic: [{ name: 'General consultation', min: 30, ngn: 10 }, { name: 'Follow-up visit', min: 20, ngn: 5 }, { name: 'Lab test', min: 45, ngn: 7 }],
  real_estate: [{ name: 'Property viewing', min: 45, ngn: 0 }, { name: 'Tenant inspection', min: 60, ngn: 0 }],
  salon: [{ name: 'Haircut & styling', min: 60, ngn: 5 }, { name: 'Manicure', min: 45, ngn: 3 }],
  delivery: [{ name: 'Parcel pickup', min: 30, ngn: 0 }],
  retail: [{ name: 'Store appointment', min: 30, ngn: 0 }],
  other: [{ name: 'Consultation', min: 30, ngn: 0 }],
};

export async function renderOnboarding(): Promise<void> {
  const root = document.getElementById('app')!;
  const me = current()!;
  const s = await loadSettings(true);
  let type: BizType = (s.businessType as BizType) in SUGGEST && s.businessType !== 'other' ? (s.businessType as BizType) : 'clinic';
  let rows = SUGGEST[type].map((x) => ({ ...x }));
  let team: string[] = [];
  let step = 1;

  const draw = () => {
    mount(root, html`<div class="auth-wrap" style="align-items:start"><div style="width:min(560px,100%)">
      <div class="row between" style="margin-bottom:12px"><a href="/app" data-link class="btn btn-ghost btn-sm">${ic('arrow-left', 'ico-sm')} Skip</a><span class="small muted">Step ${step} of 2</span></div>
      <div class="progress" style="margin-bottom:24px"><i style="width:${step * 50}%"></i></div>
      ${step === 1 ? html`
        <h1 style="font-size:1.75rem">What do you do?</h1>
        <p class="muted" style="margin:6px 0 18px">Pick your business type so we can suggest services and booking rules. You can change everything later.</p>
        <div class="stack-sm" role="radiogroup" aria-label="Business type">${TYPES.map((t) => html`<button class="option-card" role="radio" aria-checked="${t.key === type}" data-type="${t.key}"><span class="icon-tile">${ic(t.icon)}</span><span class="grow"><b>${t.title}</b>${t.popular ? html` <span class="badge badge-primary" style="margin-left:6px">Popular</span>` : ''}<br><span class="muted small">${t.text}</span></span><span class="radio-dot">${ic('check')}</span></button>`)}</div>
        <button class="btn btn-primary btn-lg btn-block" style="margin-top:20px" data-next>Continue ${ic('arrow-right', 'ico-sm')}</button>` : html`
        <h1 style="font-size:1.75rem">Set up your workspace</h1>
        <p class="muted" style="margin:6px 0 18px">This creates your public booking page.</p>
        <form id="ob" class="stack" novalidate>
          <div id="ob-err" class="alert alert-error hidden" role="alert"></div>
          <div class="card card-pad form-grid">
            <div class="field"><label for="pn">Business name</label><input class="input" id="pn" required maxlength="255" value="${s.publicName || me.tenant.name}"></div>
            <div class="field"><label>Your booking link</label><div class="copy-box"><code>${SITE_URL.replace(/^https?:\/\//, '')}/${tenantSlug()}</code></div><span class="hint">Customers use this address to book.</span></div>
            <div class="field"><label for="ph">Business phone / WhatsApp</label><input class="input" id="ph" type="tel" required placeholder="0803 123 4567" value="${s.phone ?? ''}"></div>
            <div class="form-grid two"><div class="field"><label for="op">Opens</label><input class="input" id="op" type="time" value="${minutesToTime(s.openMinutes)}"></div><div class="field"><label for="cl">Closes</label><input class="input" id="cl" type="time" value="${minutesToTime(s.closeMinutes)}"></div></div>
            <div class="field"><label>Open days</label><div class="day-pills">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => html`<label><input type="checkbox" name="day" value="${i}" ${s.daysOpen.includes(i) ? 'checked' : ''}><span>${d}</span></label>`)}</div></div>
          </div>
          <div class="card card-pad stack">
            <div class="row between"><div><h3>Services</h3><p class="muted small">Prices are in US dollars. Edit or remove the suggestions.</p></div><button type="button" class="btn btn-secondary btn-sm" data-add>${ic('plus', 'ico-sm')} Add</button></div>
            <div id="svc-rows" class="stack-sm">${rows.map((r, i) => html`<div class="form-grid" style="grid-template-columns:1fr 80px 110px 36px;gap:8px;align-items:center" data-row="${i}"><input class="input" aria-label="Service name" data-f="name" value="${r.name}" maxlength="120"><input class="input" aria-label="Minutes" data-f="min" type="number" min="5" max="480" value="${r.min}"><input class="input" aria-label="Price in US dollars" data-f="ngn" type="number" min="0" value="${r.ngn}"><button type="button" class="btn btn-ghost btn-sm btn-icon" data-rm="${i}" aria-label="Remove service">${ic('x', 'ico-sm')}</button></div>`)}</div>
            <p class="hint">Name · minutes · price ($)</p>
          </div>
          <div class="card card-pad stack">
            <div class="row between"><div class="row"><span class="icon-tile">${ic('banknote')}</span><div><h3>Require an upfront deposit</h3><p class="muted small">Reduces no-shows. Collected by Paystack before the slot is confirmed.</p></div></div><label class="switch"><input type="checkbox" id="dep" ${s.depositEnabled ? 'checked' : ''} aria-label="Require deposit"><span></span></label></div>
            <div class="field ${s.depositEnabled ? '' : 'hidden'}" id="dep-amt"><label for="depn">Deposit per booking ($)</label><input class="input" id="depn" type="number" min="0" value="${s.depositMinor ? s.depositMinor / 100 : 5}"></div>
          </div>
          <div class="card card-pad stack">
            <div><h3>Team <span class="faint" style="font-weight:500">(optional)</span></h3><p class="muted small">Add the people customers can book. You can skip this.</p></div>
            <div class="row"><input class="input" id="tm" placeholder="e.g. Dr. Bello" maxlength="120"><button type="button" class="btn btn-secondary" data-add-tm>Add</button></div>
            <div class="row wrap" style="gap:8px" id="tm-list">${team.map((n, i) => html`<span class="badge" style="height:30px">${n} <button type="button" data-rm-tm="${i}" aria-label="Remove ${n}">${ic('x', 'ico-sm')}</button></span>`)}</div>
          </div>
          <button class="btn btn-primary btn-lg btn-block" type="submit">Create workspace & go to dashboard ${ic('arrow-right', 'ico-sm')}</button>
        </form>`}
    </div></div>`);

    if (step === 1) {
      $$('[data-type]').forEach((b) => b.addEventListener('click', () => { type = b.dataset.type as BizType; rows = SUGGEST[type].map((x) => ({ ...x })); draw(); }));
      $('[data-next]')!.addEventListener('click', () => { step = 2; draw(); });
      return;
    }
    const sync = () => { rows = $$('[data-row]').map((r) => ({ name: ($('[data-f=name]', r) as HTMLInputElement).value, min: Number(($('[data-f=min]', r) as HTMLInputElement).value) || 30, ngn: Number(($('[data-f=ngn]', r) as HTMLInputElement).value) || 0 })); };
    $('[data-add]')!.addEventListener('click', () => { sync(); rows.push({ name: '', min: 30, ngn: 0 }); keepScrollDraw(); });
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { sync(); rows.splice(Number(b.dataset.rm), 1); keepScrollDraw(); }));
    $('#dep')!.addEventListener('change', (e) => $('#dep-amt')!.classList.toggle('hidden', !(e.target as HTMLInputElement).checked));
    const addTm = () => { const i = $('#tm') as HTMLInputElement; const v = i.value.trim(); if (v) { sync(); team.push(v); keepScrollDraw(); } };
    $('[data-add-tm]')!.addEventListener('click', addTm);
    $('#tm')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); addTm(); } });
    $$('[data-rm-tm]').forEach((b) => b.addEventListener('click', () => { sync(); team.splice(Number(b.dataset.rmTm), 1); keepScrollDraw(); }));

    const form = $('#ob') as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void busy(form.querySelector('button[type=submit]'), async () => {
        const err = $('#ob-err')!; err.classList.add('hidden');
        sync();
        const fail = (m: string) => { err.textContent = m; err.classList.remove('hidden'); };
        const open = timeToMinutes(($('#op') as HTMLInputElement).value), close = timeToMinutes(($('#cl') as HTMLInputElement).value);
        const nameOk = ($('#pn') as HTMLInputElement).value.trim().length > 1;
        const phoneOk = (($('#ph') as HTMLInputElement).value.match(/\d/g) ?? []).length >= 7;
        if (!nameOk) return fail('Enter your business name.');
        if (!phoneOk) return fail('Enter a phone or WhatsApp number so customers can reach you.');
        if (close <= open) return fail('Closing time must be after opening time.');
        const days = $$('input[name=day]:checked').map((i) => Number((i as HTMLInputElement).value));
        if (!days.length) return fail('Pick at least one open day.');
        const svcs = rows.filter((r) => r.name.trim());
        if (!svcs.length) return fail('Add at least one service.');
        const depOn = ($('#dep') as HTMLInputElement).checked;
        const depMinor = Math.round((Number(($('#depn') as HTMLInputElement).value) || 0) * 100);
        try {
          await api('/api/bookings/settings', { method: 'PUT', body: { businessType: type, publicName: ($('#pn') as HTMLInputElement).value.trim(), phone: ($('#ph') as HTMLInputElement).value.trim(), openMinutes: open, closeMinutes: close, daysOpen: days, depositEnabled: depOn && depMinor > 0, depositMinor: depOn ? depMinor : 0, onboarded: true } });
          const existing = await api<{ services: unknown[] }>('/api/bookings/services');
          if (!existing.services.length) for (const r of svcs) await api('/api/bookings/services', { method: 'POST', body: { name: r.name.trim(), durationMin: Math.min(480, Math.max(5, r.min)), priceMinor: Math.round(r.ngn * 100) } });
          for (const n of team) await api('/api/bookings/staff', { method: 'POST', body: { name: n } });
          await loadSettings(true);
          toast('Workspace ready. Your booking page is live.', 'success');
          navigate('/app', true);
        } catch (x) { fail(x instanceof ApiError ? x.message : 'Could not save your setup'); }
      });
    });
  };
  const keepScrollDraw = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };
  draw();
}
