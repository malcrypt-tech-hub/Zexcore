import { limitLines, LIMIT_ORDER, type Limits, type Labels, type LimitKey } from '../lib/limits';
import { html, mount, $, $$ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, ago } from '../lib/format';
import { toast, emptyState, errorState, skeletonRows, busy } from '../lib/ui';
import { current, loadMe, canAdmin } from '../lib/session';
import { LIMITS, hasFeatureAccess, type Tier } from '../lib/fb/plan';

interface PlanList { currencyRates: { NGN_PER_USD: number }; paystackPublicKey: string | null; plans: { tier: string; monthlyUsd: number | null; annualUsd: number | null; limits: Limits | null }[]; freeLimits: Limits; limitLabels: Labels }
interface Usage { tier: string; effectiveTier: string; usage: Record<LimitKey, { used: number; limit: number | null }>; labels: Labels }
interface Payment { reference: string; tier: string; cycle: string; currency: string; amount_minor: string | number; paid_minor: string | number | null; status: string; gateway: string | null; created_at: string; paid_at: string | null }
/** Mirrors the Worker's default MAX_CHECKOUT_NGN: bigger single card charges are arranged with our team. */
const CHECKOUT_CEILING_NGN = 1_000_000;
const BLURB: Record<string, string> = { starter: 'For a single location getting started.', growth: 'For growing businesses with a busy calendar.', agency: 'For operators running several locations.', enterprise: 'For large organisations with advanced needs.', dedicated: 'A dedicated setup, built with our team.' };

/** What each plan adds, with quantities, generated from the same constants the database rules and Worker enforce. */
const cap = (t: Tier, k: 'devices' | 'rules'): string => (LIMITS[t][k] === null ? 'unlimited' : `up to ${LIMITS[t][k]!.toLocaleString('en-NG')}`);
function extrasFor(t: string): string[] {
  const tier = t as Tier;
  const out: string[] = [];
  if (hasFeatureAccess(tier, 'shopPay')) out.push('Customers pay online for shop orders');
  if (hasFeatureAccess(tier, 'branding')) out.push('Your own logo');
  if (hasFeatureAccess(tier, 'compliance')) out.push('Data protection tools');
  if (hasFeatureAccess(tier, 'automations')) out.push(`Automations (${cap(tier, 'rules')})`);
  if (hasFeatureAccess(tier, 'devices')) out.push(`Device monitoring (${cap(tier, 'devices')} devices)`);
  if (hasFeatureAccess(tier, 'backups')) out.push('Daily encrypted backups and data export');
  if (hasFeatureAccess(tier, 'api')) out.push('API keys');
  if (hasFeatureAccess(tier, 'insights')) out.push('Business insights, waitlist and no-show protection');
  if (tier === 'enterprise' || tier === 'dedicated') out.push('Signed licence file and dedicated cluster requests');
  if (tier === 'dedicated') out.push('A dedicated cluster built with our team');
  return out;
}

export async function renderBilling(view: HTMLElement): Promise<void> {
  const me = current()!;
  let cycle: 'monthly' | 'annual' = 'monthly';
  mount(view, html`<div class="page-head"><div><h1>Plan & billing</h1><p>Current plan: <b style="text-transform:capitalize">${me.tenant.tier}</b>${me.tenant.plan_expires_at ? ` · renews ${new Date(me.tenant.plan_expires_at).toISOString().slice(0, 10)}` : ''}</p></div>
    <div class="chips"><button class="chip-btn" data-c="monthly" aria-pressed="true">Monthly</button><button class="chip-btn" data-c="annual" aria-pressed="false">Annual · 2 months free</button></div></div>
    <div id="usage"></div>
    <div id="plans" class="stack" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr))"></div>
    <p class="muted small" style="margin-top:12px">Every plan includes online booking, booking deposits, reminder and thank-you emails, and Security Watch. Prices are in US dollars; card payments are charged in naira at the day's rate. Payments are processed securely via Paystack. Enterprise and Dedicated are set up with our team: press Contact us and we will arrange it with you.</p>
    <h3 style="margin:28px 0 12px">Payment history</h3><div class="card" id="pay"></div>
    <div id="padmin"></div>`);
  let plans: PlanList;
  try { plans = await api<PlanList>('/api/billing/plans', { auth: false }); }
  catch (e) { mount($('#plans', view)!, errorState(e instanceof ApiError ? e.message : 'Could not load plans')); return; }

  const draw = () => {
    $$('[data-c]', view).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === cycle)));
    mount($('#plans', view)!, html`${plans.plans.map((p) => {
      const usd = cycle === 'annual' ? p.annualUsd : p.monthlyUsd;
      const contact = p.tier === 'enterprise' || p.tier === 'dedicated';
      const tooBig = usd !== null && usd * plans.currencyRates.NGN_PER_USD > CHECKOUT_CEILING_NGN;   // Worker enforces the real limit
      const cur = me.tenant.tier === p.tier;
      const extras = extrasFor(p.tier);
      return html`<section class="card card-pad stack-sm" style="${cur ? 'border:2px solid var(--primary);padding:19px' : ''}">
        <div class="row between"><h3 style="text-transform:capitalize">${p.tier}</h3>${cur ? html`<span class="badge badge-primary">Current</span>` : ''}</div>
        <div>${contact || usd === null ? html`<span style="font-size:1.5rem;font-weight:700;letter-spacing:-.02em">Contact us</span>` : html`<span style="font-size:1.75rem;font-weight:700;letter-spacing:-.02em" class="num">${money(usd * 100, 'USD')}</span><span class="muted small"> / ${cycle === 'annual' ? 'year' : 'month'}</span>${cycle === 'annual' ? html`<div class="muted small">2 months free</div>` : ''}`}</div>
        <p class="muted small">${BLURB[p.tier]}</p>
        <ul class="plan-list">
          ${limitLines(p.limits, plans.limitLabels, p.tier).map((l) => html`<li>${ic('check', 'ico-sm')} ${l}</li>`)}
          ${extras.map((ex) => html`<li>${ic('check', 'ico-sm')} <b>${ex}</b></li>`)}
        </ul>
        ${canAdmin() ? (p.tier === 'enterprise' || p.tier === 'dedicated'
          ? (cur ? html`<button class="btn btn-secondary btn-block" disabled>Your plan</button>` : html`<a class="btn btn-primary btn-block" href="mailto:hello@zexcore.com.ng?subject=${encodeURIComponent(`${p.tier[0]!.toUpperCase()}${p.tier.slice(1)} plan for ${me.tenant.name}`)}">Contact us</a>`)
          : tooBig ? html`<a class="btn btn-primary btn-block" href="mailto:hello@zexcore.com.ng?subject=${encodeURIComponent(`${p.tier[0]!.toUpperCase()}${p.tier.slice(1)} annual plan for ${me.tenant.name}`)}">Contact us to pay yearly</a>`
          : html`<button class="btn ${cur ? 'btn-secondary' : 'btn-primary'} btn-block" data-buy="${p.tier}" ${cur ? 'disabled' : ''}>${cur ? 'Your plan' : 'Choose plan'}</button>`) : ''}</section>`;
    })}`);
    $$('[data-buy]', view).forEach((b) => b.addEventListener('click', () => void checkout(b.dataset.buy!, b as HTMLButtonElement)));
  };
  $$('[data-c]', view).forEach((b) => b.addEventListener('click', () => { cycle = b.dataset.c as typeof cycle; draw(); }));

  // Platform admins (an allow-list kept on the server) can give a workspace a plan without payment.
  void import('../lib/fb/admin').then(async (a) => {
    if (!(await a.adminMe()).admin) return;
    mount($('#padmin', view)!, html`<h3 style="margin:28px 0 12px">Platform admin</h3><section class="card card-pad form-grid">
      <p class="muted small">Give a workspace a plan without payment. It is recorded in that workspace's audit log. This does not give you access to its data.</p>
      <div class="field"><label for="pw">Workspace ID</label><input class="input" id="pw" value="${me.tenant.id}"></div>
      <div class="field"><label for="pp2">Plan</label><select class="input" id="pp2">${['starter', 'growth', 'agency', 'enterprise', 'dedicated'].map((t) => html`<option value="${t}" ${t === 'dedicated' ? 'selected' : ''}>${t[0]!.toUpperCase() + t.slice(1)}</option>`)}</select></div>
      <div class="field"><label for="pd2">Days <span class="faint">(empty for no expiry)</span></label><input class="input" id="pd2" type="number" min="1" max="3650" step="1"></div>
      <div><button class="btn btn-primary" id="pg">Grant plan</button></div></section>`);
    $('#pg', view)!.addEventListener('click', (e) => void busy(e.currentTarget as HTMLButtonElement, async () => {
      const days = ($('#pd2', view) as HTMLInputElement).value.trim();
      try {
        const r = await a.grantPlan({ workspaceId: ($('#pw', view) as HTMLInputElement).value.trim(), plan: ($('#pp2', view) as HTMLSelectElement).value, days: days === '' ? null : Number(days) });
        toast(`Plan set to ${r.plan}${r.expiresAt ? '' : ' with no expiry'}`, 'success');
        await loadMe(true); void renderBilling(view);
      } catch (x) { toast(x instanceof ApiError ? x.message : 'Could not set the plan', 'error'); }
    }));
  });

  // What the workspace has used so far against what its plan includes.
  void api<Usage>('/api/billing/usage').then((u) => {
    const rows = LIMIT_ORDER.map((k) => ({ k, ...u.usage[k], label: u.labels[k] }));
    mount($('#usage', view)!, html`<section class="card card-pad stack" style="margin-bottom:20px"><div class="row between"><b>Usage on your ${u.effectiveTier} plan</b>${u.effectiveTier !== u.tier ? html`<span class="badge badge-warning">Plan expired</span>` : ''}</div>
      ${u.effectiveTier !== u.tier ? html`<div class="alert alert-warn">${ic('triangle-alert', 'ico-sm')} Your ${u.tier} plan has lapsed, so free limits apply until you renew.</div>` : ''}
      <div class="usage-grid">${rows.map((r) => {
        const pct = r.limit === null ? 0 : Math.min(100, Math.round((r.used / Math.max(1, r.limit)) * 100));
        return html`<div><div class="row between small"><span>${r.label.many[0]!.toUpperCase() + r.label.many.slice(1)}</span><b class="num">${r.used.toLocaleString('en-NG')}${r.limit === null ? '' : ` / ${r.limit.toLocaleString('en-NG')}`}</b></div>
          <div class="bar" style="margin-top:6px"><i style="width:${r.limit === null ? 4 : Math.max(pct, r.used ? 3 : 0)}%;${pct >= 100 ? 'background:var(--danger,#b80016)' : pct >= 80 ? 'background:var(--warning)' : ''}"></i></div>
          ${pct >= 100 ? html`<div class="small" style="color:var(--primary);margin-top:4px">Limit reached</div>` : ''}</div>`;
      })}</div></section>`);
  }).catch(() => undefined);

  async function checkout(tier: string, btn: HTMLButtonElement): Promise<void> {
    if (!plans.paystackPublicKey) { toast('Online payments are not enabled on this server yet.', 'error'); return; }
    await busy(btn, async () => {
      try {
        const intent = await api<{ authorizationUrl: string }>('/api/billing/checkout', { method: 'POST', body: { tier, cycle, currency: 'NGN' } });
        if (!/^https:\/\/checkout\.paystack\.com\//.test(intent.authorizationUrl)) throw new ApiError(502, 'The payment service returned an unexpected address.');
        location.assign(intent.authorizationUrl); // Paystack's hosted checkout; it returns here with ?reference=
      } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not start checkout', 'error'); }
    });
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const me2 = await loadMe(true);
      if (me2 && me2.tenant.tier !== me.tenant.tier) { toast(`Plan updated to ${me2.tenant.tier}`, 'success'); void renderBilling(view); return; }
    }
    toast('Payment is still being confirmed. Refresh in a minute.', 'info');
  }
  draw();
  // Back from Paystack: the payments Worker upgrades the plan when Paystack confirms, so wait for it.
  if (new URLSearchParams(location.search).get('reference')) { toast('Payment received. Activating your plan…', 'success'); void settle(); }

  const ph = $('#pay', view)!;
  mount(ph, skeletonRows(2));
  try {
    const { payments } = await api<{ payments: Payment[] }>('/api/billing/payments');
    mount(ph, payments.length === 0 ? emptyState({ icon: 'receipt', title: 'No payments yet', text: 'Your receipts appear here after you choose a plan.' }) : html`<div class="table-wrap"><table class="table"><thead><tr><th>Reference</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${payments.map((p) => html`<tr><td class="mono">${p.reference.slice(0, 22)}…</td><td style="text-transform:capitalize">${p.tier} · ${p.cycle}</td><td class="num">${money(Number(p.amount_minor), p.currency)}</td><td><span class="badge ${p.status === 'paid' ? 'badge-success' : p.status === 'mismatch' ? 'badge-warning' : ''}">${p.status}</span></td><td class="muted">${ago(p.created_at)}</td></tr>`)}</tbody></table></div>`);
  } catch (e) { mount(ph, errorState(e instanceof ApiError ? e.message : 'Could not load payments', false)); }
}

interface Entry { seq: number; action: string; entity: string; entity_id: string | null; actor: string; detail: string; created_at: string; google_time: boolean; hash: string }
const stamp = (iso: string): string => new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' });
export async function renderAudit(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="page-head"><div><h1>Audit log</h1><p>Every important change is recorded in a hash-chained log that cannot be edited.</p></div><button class="btn btn-secondary" data-verify>${ic('shield-check', 'ico-sm')} Verify integrity</button></div>
    <div id="vr" class="hidden" style="margin-bottom:16px"></div><div class="card" id="al"></div>
    <p class="muted small" style="margin-top:12px">Each entry's date and time is stamped by Google's servers at the moment it is saved, so it cannot be set or changed from anyone's device. Entries saved before 3 Nov 2026 carry the ZexCore server's clock instead.</p>`);
  const host = $('#al', view)!;
  mount(host, skeletonRows(4));
  try {
    const { entries } = await api<{ entries: Entry[] }>('/api/audit-log?limit=100');
    mount(host, entries.length === 0 ? emptyState({ icon: 'history', title: 'Nothing recorded yet', text: 'Actions like signups, settings changes and payments appear here.' }) : html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Action</th><th>Details</th><th>By</th><th>Date and time</th></tr></thead><tbody>${entries.map((e) => html`<tr><td class="mono muted">${e.seq}</td><td><b>${e.action}</b></td><td class="muted">${e.detail ? e.detail : html`${e.entity}${e.entity_id ? html` <span class="mono">${String(e.entity_id).slice(0, 12)}</span>` : ''}`}</td><td class="muted">${e.actor}</td><td class="muted" style="white-space:nowrap" title="${e.google_time ? 'Stamped by Google servers' : 'Stamped by the ZexCore server'}">${stamp(e.created_at)}</td></tr>`)}</tbody></table></div>`);
  } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load the audit log')); }
  $('[data-verify]', view)!.addEventListener('click', (ev) => void busy(ev.currentTarget as HTMLButtonElement, async () => {
    const box = $('#vr', view)!;
    try {
      const r = await api<{ valid: boolean; total: number; brokenSeq: number | null; reason: string | null; headHash: string | null }>('/api/audit-log/verify');
      box.className = r.valid ? 'alert alert-ok' : 'alert alert-error';
      mount(box, r.valid ? html`${ic('circle-check', 'ico-sm')}<span><b>Chain verified.</b> ${r.total} entries recomputed inside the database with no gaps or edits.${r.headHash ? html` Head <span class="mono">${r.headHash.slice(0, 16)}…</span>` : ''}</span>` : html`${ic('triangle-alert', 'ico-sm')}<span><b>Integrity problem at entry ${r.brokenSeq}.</b> ${r.reason}</span>`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Verification failed', 'error'); }
  }));
}
