import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { login, register } from '../lib/session';
import { ApiError, api } from '../lib/api';
import { authLayout } from '../layouts';
import { navigate } from '../router';
import { busy } from '../lib/ui';
import { mountGoogleButton, googleExchange, type GoogleOutcome } from '../lib/google';


function pwField(id: string, label: string, autocomplete: string): Raw {
  const isNew = autocomplete === 'new-password';
  return html`<div class="field">
    <label for="${id}">${label}</label>
    <div class="input-icon">${ic('lock')}<input class="input" id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required minlength="${isNew ? 10 : 1}" placeholder="${isNew ? 'At least 10 characters' : 'Enter your password'}">
      <button type="button" class="btn btn-ghost btn-sm btn-icon trail" data-toggle-pw aria-label="Show password">${ic('eye')}</button></div>
  </div>`;
}

function wirePwToggle(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>('[data-toggle-pw]').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement!.querySelector('input')!;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));
}

function workspacePicker(workspaces: { slug: string; name: string }[], onPick: (slug: string) => void): void {
  const host = $('#auth-body')!;
  mount(host, html`
    <h2 style="font-size:1.375rem">Choose a workspace</h2>
    <p class="muted" style="margin:6px 0 16px">Your account belongs to more than one business.</p>
    <div class="stack-sm">${workspaces.map((w) => html`<button class="option-card" data-ws="${w.slug}"><span class="icon-tile">${ic('store')}</span><span class="grow"><b>${w.name}</b><br><span class="muted small mono">${w.slug}</span></span>${ic('chevron-right')}</button>`)}</div>`);
  host.querySelectorAll<HTMLElement>('[data-ws]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.ws!)));
}

const googleBlock = (): Raw => html`<div class="divider" style="margin:18px 0">OR</div><div id="g-btn" style="display:flex;justify-content:center;min-height:44px"></div>`;

function wireGoogle(onOutcome: (o: GoogleOutcome) => void, showErr: (m: string) => void): void {
  const host = $('#g-btn');
  if (host) void mountGoogleButton(host, onOutcome, showErr);
}

export function renderSignIn(): void {
  authLayout(html`
    <div id="auth-body">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="font-size:1.55rem;font-weight:700;letter-spacing:-0.025em;color:var(--ink);margin-bottom:6px">Sign in to ZexCore</h1>
        <p class="muted" style="font-size:0.875rem;line-height:1.5">Enter your email and password to access your workspace</p>
      </div>
      <form id="f" class="form-grid" novalidate>
        <div id="err" class="alert alert-error hidden" role="alert"></div>
        <div class="field"><label for="email">Email address</label>
          <div class="input-icon">${ic('mail')}<input class="input" id="email" name="email" type="email" autocomplete="username" required placeholder="you@company.com"></div></div>
        ${pwField('password', 'Password', 'current-password')}
        <div style="text-align:right;margin-top:-6px"><a href="/forgot-password" data-link class="small" style="color:var(--primary);font-weight:600">Forgot password?</a></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit" style="margin-top:6px">Sign in ${ic('arrow-right', 'ico-sm')}</button>
      </form>
      ${googleBlock()}
      <p style="text-align:center;margin-top:22px;font-size:.9rem;color:var(--slate)">New to ZexCore? <a href="/signup" data-link style="color:var(--primary);font-weight:600">Create your workspace</a></p>
    </div>`);
  const form = $('#f') as HTMLFormElement;
  const err = $('#err')!;
  wirePwToggle(form);
  const showErr = (m: string) => { err.textContent = m; err.classList.remove('hidden'); };
  const done = () => navigate('/app', true);

  const submit = async (slug?: string) => {
    err.classList.add('hidden');
    const fd = new FormData(form);
    try {
      const r = await login(String(fd.get('email')).trim(), String(fd.get('password')), slug);
      if (r.ok) return done();
      workspacePicker(r.workspaces, (s) => void submit(s));
    } catch (e) { showErr(e instanceof ApiError ? e.message : 'Sign in failed'); }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    void busy(form.querySelector('button[type=submit]'), () => submit());
  });
  wireGoogle(async (o) => {
    if (o.kind === 'signed-in') return done();
    if (o.kind === 'choose') return workspacePicker(o.workspaces, async (s) => { await googleExchange(o.credential, { workspace: s }); done(); });
    googleSignupStep(o);
  }, showErr);
}

function googleSignupStep(o: Extract<GoogleOutcome, { kind: 'needs-signup' }>): void {
  mount($('#auth-body')!, html`
    <h2 style="font-size:1.375rem">One last step, ${o.name.split(' ')[0]}</h2>
    <p class="muted" style="margin:6px 0 16px">We'll create a workspace for <b>${o.email}</b>.</p>
    <form id="gf" class="form-grid">
      <div id="gerr" class="alert alert-error hidden" role="alert"></div>
      <div class="field"><label for="biz">Business name</label><input class="input" id="biz" required minlength="2" maxlength="120" placeholder="e.g. Metro Medical Clinic"></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Create workspace ${ic('arrow-right', 'ico-sm')}</button>
    </form>`);
  const f = $('#gf') as HTMLFormElement;
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(f.querySelector('button'), async () => {
      try {
        await googleExchange(o.credential, { tenantName: ($('#biz') as HTMLInputElement).value.trim() });
        navigate('/app/onboarding', true);
      } catch (x) { const g = $('#gerr')!; g.textContent = x instanceof ApiError ? x.message : `Could not create the workspace${(x as { code?: string })?.code ? ` (${(x as { code?: string }).code})` : ''}. Please try again.`; g.classList.remove('hidden'); }
    });
  });
}

export function renderSignUp(): void {
  authLayout(html`
    <div id="auth-body">
      <h1 style="font-size:1.75rem;letter-spacing:-0.02em">Create your workspace</h1>
      <p class="muted" style="margin:6px 0 18px">Free to start. Takes about two minutes.</p>
      <form id="f" class="form-grid" novalidate>
        <div id="err" class="alert alert-error hidden" role="alert"></div>
        <div class="field"><label for="biz">Business name</label><input class="input" id="biz" name="biz" required minlength="2" maxlength="120" autocomplete="organization" placeholder="e.g. Metro Medical Clinic"></div>
        <div class="field"><label for="name">Your name</label><input class="input" id="name" name="name" required minlength="2" maxlength="120" autocomplete="name" placeholder="Full name"></div>
        <div class="field"><label for="email">Email address</label>
          <div class="input-icon">${ic('mail')}<input class="input" id="email" name="email" type="email" autocomplete="email" required placeholder="you@company.com"></div></div>
        ${pwField('password', 'Password', 'new-password')}
        <button class="btn btn-primary btn-lg btn-block" type="submit">Create workspace ${ic('arrow-right', 'ico-sm')}</button>
      </form>
      ${googleBlock()}
      <p class="muted small" style="text-align:center;margin-top:18px">By continuing you agree to our <a href="/terms" data-link style="text-decoration:underline;display:inline;min-height:0;padding:0">Terms</a> and <a href="/privacy" data-link style="text-decoration:underline;display:inline;min-height:0;padding:0">Privacy Policy</a>.</p>
      <p style="text-align:center;margin-top:8px;font-size:.9rem">Already have an account? <a href="/signin" data-link style="color:var(--primary);font-weight:600">Sign in</a></p>
    </div>`);
  const form = $('#f') as HTMLFormElement;
  const err = $('#err')!;
  wirePwToggle(form);
  const showErr = (m: string) => { err.textContent = m; err.classList.remove('hidden'); };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    err.classList.add('hidden');
    const fd = new FormData(form);
    void busy(form.querySelector('button[type=submit]'), async () => {
      try {
        await register({ tenantName: String(fd.get('biz')).trim(), name: String(fd.get('name')).trim(), email: String(fd.get('email')).trim(), password: String(fd.get('password')) });
        navigate('/app/onboarding', true);
      } catch (x) { showErr(x instanceof ApiError ? x.message : 'Could not create your workspace'); }
    });
  });
  wireGoogle(async (o) => {
    if (o.kind === 'signed-in') return navigate('/app', true);
    if (o.kind === 'choose') return workspacePicker(o.workspaces, async (s) => { await googleExchange(o.credential, { workspace: s }); navigate('/app', true); });
    googleSignupStep(o);
  }, showErr);
}

// ── Password reset & email confirmation ──────────────────────────────────────

export function renderForgot(): void {
  authLayout(html`
    <div id="auth-body">
      <h1 style="font-size:1.5rem;letter-spacing:-0.02em">Reset your password</h1>
      <p class="muted" style="margin:6px 0 18px">Enter your email and we will send you a link to choose a new password.</p>
      <form id="f" class="form-grid" novalidate>
        <div id="err" class="alert alert-error hidden" role="alert"></div>
        <div class="field"><label for="email">Email address</label>
          <div class="input-icon">${ic('mail')}<input class="input" id="email" name="email" type="email" autocomplete="username" required placeholder="you@company.com"></div></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">Send reset link</button>
      </form>
      <p style="text-align:center;margin-top:18px;font-size:.9rem"><a href="/signin" data-link style="color:var(--primary);font-weight:600">Back to sign in</a></p>
    </div>`);
  const form = $('#f') as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    void busy(form.querySelector('button[type=submit]'), async () => {
      const err = $('#err')!;
      try {
        const email = String(new FormData(form).get('email')).trim();
        await api('/api/auth/password/forgot', { method: 'POST', body: { email }, auth: false });
        mount($('#auth-body')!, html`
          <div style="text-align:center"><span class="icon-tile" style="margin:0 auto 14px;background:var(--primary-tint);color:var(--primary)">${ic('mail')}</span>
          <h1 style="font-size:1.5rem">Check your inbox</h1>
          <p class="muted" style="margin:8px 0 18px">If <b>${email}</b> has a ZexCore account, a reset link is on its way. It works once and expires in an hour.</p>
          <a class="btn btn-secondary btn-block" href="/signin" data-link>Back to sign in</a></div>`);
      } catch (x) { err.textContent = x instanceof ApiError ? x.message : 'Something went wrong. Please try again.'; err.classList.remove('hidden'); }
    });
  });
}

let cachedResetToken = '';
/** Reads and caches the one-time token (Firebase oobCode or query token) */
function takeToken(): string {
  const p = new URLSearchParams(location.search);
  const t = p.get('oobCode') ?? p.get('token') ?? p.get('code') ?? '';
  if (t) {
    cachedResetToken = t;
    history.replaceState(null, '', location.pathname);
  }
  return cachedResetToken || t;
}

export function renderReset(): void {
  const token = takeToken();
  if (!token) {
    authLayout(html`<div id="auth-body"><h1 style="font-size:1.5rem">This link is incomplete</h1><p class="muted" style="margin:8px 0 18px">Open the link from your email again, or request a new one.</p><a class="btn btn-primary btn-block" href="/forgot-password" data-link>Request a new link</a></div>`);
    return;
  }
  authLayout(html`
    <div id="auth-body">
      <h1 style="font-size:1.5rem;letter-spacing:-0.02em">Choose a new password</h1>
      <p class="muted" style="margin:6px 0 18px">Use at least 10 characters. You will be signed out of every device.</p>
      <form id="f" class="form-grid" novalidate>
        <div id="err" class="alert alert-error hidden" role="alert"></div>
        ${pwField('password', 'New password', 'new-password')}
        <button class="btn btn-primary btn-lg btn-block" type="submit">Save password</button>
      </form>
    </div>`);
  const form = $('#f') as HTMLFormElement;
  wirePwToggle(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    void busy(form.querySelector('button[type=submit]'), async () => {
      const err = $('#err')!;
      err.classList.add('hidden');
      try {
        await api('/api/auth/password/reset', { method: 'POST', body: { token, password: String(new FormData(form).get('password')) }, auth: false });
        cachedResetToken = '';
        mount($('#auth-body')!, html`
          <div style="text-align:center"><span class="icon-tile" style="margin:0 auto 14px;background:var(--success-tint);color:var(--success)">${ic('circle-check')}</span>
          <h1 style="font-size:1.5rem">Password updated</h1>
          <p class="muted" style="margin:8px 0 18px">You can now sign in with your new password.</p>
          <a class="btn btn-primary btn-block" href="/signin" data-link>Sign in</a></div>`);
      } catch (x) {
        err.innerHTML = '';
        err.textContent = x instanceof ApiError ? x.message : 'Could not update your password. Please try again.';
        err.classList.remove('hidden');
      }
    });
  });
}

export async function renderVerify(): Promise<void> {
  const token = takeToken();
  authLayout(html`<div id="auth-body" style="text-align:center"><div class="spinner" style="margin:0 auto 14px"></div><p class="muted">Confirming your email…</p></div>`);
  const body = $('#auth-body')!;
  const done = (ok: boolean, msg: string) => mount(body, html`
    <span class="icon-tile" style="margin:0 auto 14px;background:${ok ? 'var(--success-tint)' : 'var(--primary-tint)'};color:${ok ? 'var(--success)' : 'var(--primary)'}">${ic(ok ? 'circle-check' : 'circle-alert')}</span>
    <h1 style="font-size:1.5rem">${ok ? 'Email confirmed' : 'Link not valid'}</h1>
    <p class="muted" style="margin:8px 0 18px">${msg}</p>
    <a class="btn btn-primary btn-block" href="/app" data-link>${ok ? 'Continue to ZexCore' : 'Go to ZexCore'}</a>`);
  if (!token) return done(false, 'Open the link from your email again. You can request a new one from inside the app.');
  try {
    await api('/api/auth/email/verify', { method: 'POST', body: { token }, auth: false });
    done(true, 'Thanks. Your account is now confirmed.');
  } catch (x) { done(false, x instanceof ApiError ? x.message : 'We could not confirm your email. Please try again.'); }
}
