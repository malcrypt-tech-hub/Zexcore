import { html, mount, $, $$ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError, setToken } from '../lib/api';
import { ago } from '../lib/format';
import { toast, emptyState, errorState, skeletonRows, confirmDialog } from '../lib/ui';
import { current, resetSession } from '../lib/session';
import { clearStore } from '../lib/store';
import { navigate } from '../router';
import { formModal } from './shared';
import { inp } from './shared';

interface SessionRow { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; ip: string | null; current: boolean }

/** A short human label from a user-agent string. Good enough to recognise your own devices. */
function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export async function renderSecurity(view: HTMLElement): Promise<void> {
  const me = current()!;
  mount(view, html`<div class="page-head"><div><h1>Security</h1><p>Your sign-in, password and the devices signed in to your account.</p></div></div>
    <div class="stack-lg">
      <section class="card card-pad stack">
        <div class="row between"><div><b>Email</b><div class="muted small">${me.user.email ?? ''}</div></div>
          ${me.user.emailVerified === false ? html`<div class="row"><span class="badge badge-warning">Not confirmed</span><button class="btn btn-secondary btn-sm" data-resend>Resend link</button></div>` : html`<span class="badge badge-success">${ic('check', 'ico-sm')} Confirmed</span>`}</div>
        <div class="divider"></div>
        <div class="row between"><div><b>Password</b><div class="muted small">Changing it signs you out of your other devices.</div></div><button class="btn btn-secondary btn-sm" data-pw>${ic('key-round', 'ico-sm')} Change</button></div>
      </section>
      <section class="card card-pad stack" style="border-color:var(--danger,#c0392b)">
        <div class="row between"><div><b>Delete account</b><div class="muted small">Permanently deletes your sign-in${me.role === 'owner' ? ` and closes ${me.tenant.name}, erasing its bookings, customers, payments and messages` : ' and removes you from the workspaces you joined'}. The deletion is recorded in the audit log.</div></div><button class="btn btn-soft-danger btn-sm" data-del>${ic('trash-2', 'ico-sm')} Delete account</button></div>
      </section>
      <section class="card">
        <div class="card-head"><div><b>Devices signed in</b><div class="muted small">If you do not recognise one, sign it out and change your password.</div></div><button class="btn btn-soft-danger btn-sm hidden" data-others>Sign out others</button></div>
        <div id="ss">${skeletonRows(2)}</div>
      </section>
    </div>`);

  $('[data-resend]', view)?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
    try { await api('/api/auth/email/resend', { method: 'POST' }); b.textContent = 'Sent'; toast('Confirmation email sent', 'success'); }
    catch (x) { b.disabled = false; toast(x instanceof ApiError ? x.message : 'Could not send the email', 'error'); }
  });

  $('[data-pw]', view)!.addEventListener('click', () => formModal({
    title: 'Change password', subtitle: 'Use at least 10 characters. A passphrase works well.', submitLabel: 'Update password',
    body: html`<div class="field"><label for="pc">Current password</label><input class="input" id="pc" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pn">New password</label><input class="input" id="pn" type="password" autocomplete="new-password" minlength="10" required></div>`,
    submit: async (el) => {
      const currentPassword = inp(el, '#pc'), newPassword = inp(el, '#pn');
      if (!currentPassword || !newPassword) throw new ApiError(0, 'Fill in both fields');
      const r = await api<{ token: string }>('/api/auth/password/change', { method: 'POST', body: { currentPassword, newPassword } });
      setToken(r.token); // this device stays signed in; every other one is signed out
      toast('Password updated. Other devices were signed out.', 'success');
      void load();
    },
  }));

  $('[data-del]', view)!.addEventListener('click', async () => {
    const { method } = await api<{ method: 'password' | 'google' }>('/api/account/method');
    formModal({
      title: 'Delete your account?', subtitle: 'This cannot be undone.', submitLabel: 'Delete everything',
      body: html`<div class="alert alert-error">${ic('triangle-alert', 'ico-sm')}<span>Every workspace you own is closed and its data erased for good, and your team loses access. Workspaces you only joined just lose you. Download an export or backup first if you need your records.</span></div>
        <div class="field"><label for="dc">Type your email (${me.user.email ?? ''}) to confirm</label><input class="input" id="dc" autocomplete="off" required></div>
        ${method === 'password' ? html`<div class="field"><label for="dp">Password</label><input class="input" id="dp" type="password" autocomplete="current-password" required></div>` : html`<p class="muted small">You will be asked to confirm with Google.</p>`}`,
      submit: async (el) => {
        const confirm = inp(el, '#dc');
        if (!confirm) throw new ApiError(0, 'Type your email to confirm.');
        await api('/api/account/delete', { method: 'POST', body: { confirm, password: method === 'password' ? inp(el, '#dp') : undefined } });
        clearStore(); resetSession(); toast('Your account was deleted.', 'success'); navigate('/', true);
      },
    });
  });

  const host = $('#ss', view)!;
  async function load(): Promise<void> {
    try {
      const { sessions } = await api<{ sessions: SessionRow[] }>('/api/auth/sessions');
      $('[data-others]', view)!.classList.toggle('hidden', sessions.length < 2);
      if (!sessions.length) { mount(host, emptyState({ icon: 'shield-check', title: 'No other sessions', text: 'Only this device is signed in.' })); return; }
      mount(host, html`<div class="list">${sessions.map((s) => html`<div class="list-item"><span class="icon-tile">${ic('globe')}</span>
        <div class="grow"><b>${deviceName(s.userAgent)}</b> ${s.current ? html`<span class="badge badge-success">This device</span>` : ''}
          <div class="muted small">${s.ip ?? 'Unknown location'} · active ${ago(s.lastSeenAt)}</div></div>
        ${s.current ? '' : html`<button class="btn btn-ghost btn-sm" data-revoke="${s.id}">Sign out</button>`}</div>`)}</div>`);
      $$('[data-revoke]', host).forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/api/auth/sessions/${b.dataset.revoke}`, { method: 'DELETE' }); toast('Device signed out', 'success'); void load(); }
        catch (x) { toast(x instanceof ApiError ? x.message : 'Could not sign that device out', 'error'); }
      }));
    } catch (x) { mount(host, errorState(x instanceof ApiError ? x.message : 'Could not load your devices')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  }
  $('[data-others]', view)!.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Sign out other devices?', message: 'Everywhere except this device will need to sign in again.', confirmLabel: 'Sign out others', danger: true }))) return;
    try { const r = await api<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST' }); toast(`${r.revoked} device${r.revoked === 1 ? '' : 's'} signed out`, 'success'); void load(); }
    catch (x) { toast(x instanceof ApiError ? x.message : 'Could not sign out other devices', 'error'); }
  });
  await load();
}
