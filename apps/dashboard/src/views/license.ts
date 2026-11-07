/** Cluster & license: a signed licence file for Enterprise and Dedicated workspaces, and a request for a dedicated cluster. */
import { html, mount, $ } from '../lib/html';
import { emptyState, skeletonRows, busy } from '../lib/ui';
import { current, canAdmin } from '../lib/session';
import { longDate } from '../lib/format';
import { api, toast, pageHead, formModal, inp, errMsg } from './shared';
import type { LicenseDto, ClusterRequestDto } from '../lib/fb/license';

const SIZE: Record<string, string> = { small: 'Small: one location or team', medium: 'Medium: several locations', large: 'Large: a whole organisation', unsure: 'Not sure yet' };
const STATUS: Record<string, string> = { new: 'Received. We will email you.', contacted: 'Our team has been in touch.', closed: 'Closed' };

export function renderLicense(view: HTMLElement): void {
  const me = current()!;
  const licensed = me.tenant.tier === 'enterprise' || me.tenant.tier === 'dedicated';
  mount(view, html`${pageHead('Cluster & license', 'Your signed licence file, and a dedicated setup built with our team.')}
    <section class="card card-pad stack" id="lic" style="margin-bottom:16px"><h3>Licence file</h3><div id="licb">${skeletonRows(2)}</div></section>
    <section class="card card-pad stack" id="clu"><h3>Dedicated cluster</h3><div id="club">${skeletonRows(2)}</div></section>`);

  // ── Licence ──
  const licb = $('#licb', view)!;
  if (!licensed) {
    mount(licb, html`<p class="muted">Licence files come with the <b>Enterprise</b> and <b>Dedicated</b> plans. You are on <b style="text-transform:capitalize">${me.tenant.tier}</b>.</p><div><a class="btn btn-primary" href="/app/billing" data-link>See plans</a></div>`);
  } else if (!canAdmin()) {
    mount(licb, html`<p class="muted">Only a workspace owner or admin can download the licence.</p>`);
  } else {
    mount(licb, html`<p class="muted small">A licence states which plan this workspace holds and until when. It is signed with our private key, so anyone can check it is genuine with our public key, offline, and nobody can alter it. It does not change what your plan allows: limits are enforced by the platform itself.</p>
      <div class="row wrap" style="gap:8px"><button class="btn btn-primary" id="getlic">Generate licence file</button></div><div id="licout"></div>`);
    $('#getlic', view)!.addEventListener('click', (e) => void busy(e.currentTarget as HTMLButtonElement, async () => {
      try {
        const r = await api<LicenseDto>('/api/license', { method: 'POST', body: {} });
        const file = new Blob([r.license + '\n'], { type: 'text/plain' });
        const url = URL.createObjectURL(file);
        mount($('#licout', view)!, html`<div class="stack-sm" style="margin-top:12px">
          <div class="booking-meta"><div class="l"><span class="muted">Licence</span><span class="ref">${r.payload.id}</span></div>
            <div class="l"><span class="muted">Plan</span><span style="text-transform:capitalize">${r.payload.plan}</span></div>
            <div class="l"><span class="muted">Valid until</span><span>${longDate(r.payload.expiresAt.slice(0, 10))} (plus ${r.payload.graceDays} days of grace)</span></div></div>
          <div class="row wrap" style="gap:8px"><a class="btn btn-secondary" download="zexcore-licence-${r.payload.id}.zxl" href="${url}">Download file</a><button class="btn btn-secondary" id="cplic">Copy licence text</button></div>
          <p class="muted small">Public key (Ed25519), for verifying: <span class="ref" style="word-break:break-all">${r.publicKey}</span></p></div>`);
        $('#cplic', view)!.addEventListener('click', () => void navigator.clipboard.writeText(r.license).then(() => toast('Licence copied', 'success'), () => toast('Could not copy. Use Download instead.', 'error')));
      } catch (x) { toast(errMsg(x, 'Could not create the licence'), 'error'); }
    }));
  }

  // ── Cluster ──
  const club = $('#club', view)!;
  const draw = (r: ClusterRequestDto | null): void => {
    if (r && r.status !== 'closed') {
      mount(club, html`<p><b>Your request is in.</b> ${STATUS[r.status] ?? r.status}</p>
        <div class="booking-meta"><div class="l"><span class="muted">Size</span><span>${SIZE[r.size] ?? r.size}</span></div>${r.region ? html`<div class="l"><span class="muted">Region</span><span>${r.region}</span></div>` : ''}
          <div class="l"><span class="muted">What you need</span><span>${r.needs}</span></div>${r.createdAt ? html`<div class="l"><span class="muted">Sent</span><span>${longDate(r.createdAt.slice(0, 10))}</span></div>` : ''}</div>`);
      return;
    }
    mount(club, html`<p class="muted small">A dedicated cluster is your own isolated setup, with its own capacity and limits agreed with us. We build it together with you, so this form sends your request to our team. Nothing is created or charged automatically, and we reply by email.</p>
      ${me.role === 'owner' ? html`<div><button class="btn btn-primary" id="askclu">Request a dedicated cluster</button></div>` : html`<p class="muted small">Only the workspace owner can send this request.</p>`}`);
    $('#askclu', view)?.addEventListener('click', () => formModal({
      title: 'Request a dedicated cluster', subtitle: 'We will reply by email.', submitLabel: 'Send request',
      body: html`<div class="field"><label for="cs">Size</label><select class="input" id="cs">${Object.entries(SIZE).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
        <div class="field"><label for="cn">What do you need?</label><textarea class="input" id="cn" rows="4" maxlength="1500" placeholder="For example: how many locations and people, any data location or compliance needs."></textarea></div>
        <div class="field"><label for="cr">Preferred region <span class="faint">(optional)</span></label><input class="input" id="cr" maxlength="80"></div>
        <div class="field"><label for="cp">Phone <span class="faint">(optional)</span></label><input class="input" id="cp" type="tel" maxlength="30"></div>`,
      submit: async (el) => {
        const r2 = await api<{ ok: true }>('/api/cluster/request', { method: 'POST', body: { size: inp(el, '#cs'), needs: inp(el, '#cn'), region: inp(el, '#cr'), phone: inp(el, '#cp') } });
        void r2; toast('Request sent. We will email you.', 'success'); void load();
      },
    }));
  };
  const load = async (): Promise<void> => {
    if (!canAdmin()) { mount(club, emptyState({ icon: 'server', title: 'Owners and admins only', text: 'Ask your workspace owner about a dedicated cluster.' })); return; }
    try { draw((await api<{ request: ClusterRequestDto | null }>(`/api/cluster/request`)).request); } catch (x) { mount(club, html`<p class="muted">${errMsg(x, 'Could not load your request')}</p>`); }
  };
  void load();
}
