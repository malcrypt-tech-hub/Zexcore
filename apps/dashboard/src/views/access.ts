/** Team access (who can sign in, and as what) and the page an invited person lands on. */
import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { toast, openModal, errorState, skeletonRows, busy, copyText } from '../lib/ui';
import { current, loadMe, logout } from '../lib/session';
import { clearStore } from '../lib/store';
import { authLayout } from '../layouts';
import { navigate } from '../router';
import { hasFeatureAccess } from '../lib/fb/plan';
import { acceptInvite, inviteInfo, type TeamInvite, type TeamMember } from '../lib/fb/team';

const ROLE_TEXT: Record<string, string> = {
  owner: 'Owner. Full control, including plan and payouts.',
  admin: 'Admin. Runs the workspace: settings, team, automations. Cannot change the owner.',
  editor: 'Editor. Handles bookings, customers, messages, services, staff calendars and website pages. No settings, billing or team changes.',
  viewer: 'Viewer. Read-only: sees bookings, customers, payments and the audit log, but cannot change anything or read customer chats. For accountants and investors (Enterprise and Dedicated).',
  staff: 'Staff',
};
const roleLabel = (r: string): string => ({ owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' } as Record<string, string>)[r] ?? 'Staff';

export async function renderAccess(view: HTMLElement): Promise<void> {
  const me = current()!;
  const isOwner = me.role === 'owner', isAdmin = isOwner || me.role === 'admin';
  const viewerOk = hasFeatureAccess(me.tenant.tier, 'export');   // Enterprise and Dedicated
  mount(view, html`<div class="page-head"><div><h1>Team access</h1><p>People who can sign in to ${me.tenant.name}. Staff that customers book with are managed under Bookable staff.</p></div>${isAdmin ? html`<button class="btn btn-primary" data-invite>${ic('plus', 'ico-sm')} Invite</button>` : ''}</div>
    <div class="card" id="l"></div>
    <div class="card card-pad" style="margin-top:16px"><h3 style="margin-bottom:8px">What each role can do</h3>
      <div class="stack-sm">${(['owner', 'admin', 'editor', 'viewer'] as const).map((r) => html`<div class="small"><b>${roleLabel(r)}.</b> ${ROLE_TEXT[r]!.replace(/^[A-Za-z]+\. /, '')}</div>`)}</div></div>`);
  const host = $('#l', view)!;
  let data: { members: TeamMember[]; invites: TeamInvite[]; seats: number } | null = null;

  const load = async () => {
    mount(host, skeletonRows(3));
    try {
      data = await api('/api/team');
      const d = data!;
      const used = d.members.length + d.invites.length;
      mount(host, html`<div class="list">
        ${d.members.map((m) => html`<div class="list-item"><span class="avatar green">${(m.name ?? m.email ?? '?').slice(0, 1).toUpperCase()}</span>
          <div class="grow"><b>${m.name ?? m.email ?? 'Member'}</b> ${m.you ? html`<span class="badge">You</span>` : ''}<div class="muted small">${m.email ?? ''}</div></div>
          <span class="badge">${roleLabel(m.role)}</span>
          ${m.role !== 'owner' && (isOwner || (isAdmin && (m.role === 'editor' || m.role === 'viewer'))) && !m.you ? html`<button class="btn btn-ghost btn-sm" data-manage="${m.uid}">Manage</button>` : ''}
          ${m.you && m.role !== 'owner' ? html`<button class="btn btn-ghost btn-sm" data-leave>Leave</button>` : ''}</div>`)}
        ${d.invites.map((i) => html`<div class="list-item"><span class="avatar grey">${ic('mail', 'ico-sm')}</span>
          <div class="grow"><b>${i.email}</b> <span class="badge">Invited as ${roleLabel(i.role)}</span><div class="muted small">Waiting to accept${i.expiresAt ? ` until ${new Date(i.expiresAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}` : ''}</div></div>
          <button class="btn btn-ghost btn-sm" data-revoke="${i.id}">Cancel</button></div>`)}
        </div>
        <p class="muted small" style="padding:12px 16px">${used} of ${d.seats >= 1000 ? 'unlimited' : d.seats} team logins used on your plan.${d.seats <= 1 && isAdmin ? html` <a href="/app/billing" data-link>Upgrade to add people.</a>` : ''}</p>`);
      host.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) => b.addEventListener('click', () => void busy(b as HTMLButtonElement, async () => {
        try { await api('/api/team/revoke', { method: 'POST', body: { id: b.dataset.revoke } }); toast('Invitation cancelled', 'success'); void load(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not cancel', 'error'); }
      })));
      host.querySelectorAll<HTMLElement>('[data-manage]').forEach((b) => b.addEventListener('click', () => manage(d.members.find((m) => m.uid === b.dataset.manage)!)));
      $('[data-leave]', host)?.addEventListener('click', () => leave());
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load your team')); $('[data-retry]', host)?.addEventListener('click', () => void load()); }
  };

  function manage(m: TeamMember): void {
    openModal({
      title: m.email ?? 'Team member', subtitle: `Currently ${roleLabel(m.role).toLowerCase()}`,
      body: html`<div id="me" class="alert alert-error hidden"></div>
        ${isOwner ? html`<div class="field"><label for="mr">Role</label><select class="input" id="mr"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>${viewerOk || m.role === 'viewer' ? html`<option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer (read-only)</option>` : ''}</select></div>` : ''}
        <p class="muted small" style="margin-top:10px">Removing someone signs them out of this workspace. Their past bookings and notes stay.</p>`,
      footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-danger" data-rm>Remove</button>${isOwner ? html`<button class="btn btn-primary" data-save>Save role</button>` : ''}`,
      onMount: (el, close) => {
        const fail = (e: unknown) => { const x = $('#me', el)!; x.textContent = e instanceof ApiError ? e.message : 'Could not save'; x.classList.remove('hidden'); };
        $('[data-save]', el)?.addEventListener('click', () => void busy($('[data-save]', el) as HTMLButtonElement, async () => {
          try { await api('/api/team/role', { method: 'POST', body: { uid: m.uid, role: ($('#mr', el) as HTMLSelectElement).value } }); toast('Role updated', 'success'); close(); void load(); } catch (e) { fail(e); }
        }));
        $('[data-rm]', el)!.addEventListener('click', () => void busy($('[data-rm]', el) as HTMLButtonElement, async () => {
          try { await api('/api/team/remove', { method: 'POST', body: { uid: m.uid } }); toast('Removed', 'success'); close(); void load(); } catch (e) { fail(e); }
        }));
      },
    });
  }

  async function leave(): Promise<void> {
    if (!window.confirm('Leave this workspace? You will lose access until someone invites you again.')) return;
    try { await api('/api/team/remove', { method: 'POST', body: { uid: me.user.id } }); clearStore(); toast('You left the workspace', 'success'); logout(); navigate('/signin'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not leave', 'error'); }
  }

  function inviteModal(): void {
    openModal({
      title: 'Invite someone', subtitle: 'They get an email with a link that works for 7 days.',
      body: html`<div id="ie" class="alert alert-error hidden"></div>
        <div class="field"><label for="im">Email</label><input class="input" id="im" type="email" maxlength="254" autocomplete="off" placeholder="name@example.com"></div>
        <div class="field"><label for="ir">Role</label><select class="input" id="ir"><option value="editor">Editor</option>${isOwner ? html`<option value="admin">Admin</option>` : ''}${viewerOk ? html`<option value="viewer">Viewer (read-only)</option>` : ''}</select></div>
        <p class="muted small" id="ih">${ROLE_TEXT.editor}</p><div id="il"></div>`,
      footer: html`<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" data-send>Send invitation</button>`,
      onMount: (el) => {
        const sel = $('#ir', el) as HTMLSelectElement;
        sel.addEventListener('change', () => { $('#ih', el)!.textContent = ROLE_TEXT[sel.value] ?? ''; });
        $('[data-send]', el)!.addEventListener('click', () => void busy($('[data-send]', el) as HTMLButtonElement, async () => {
          const err = $('#ie', el)!; err.classList.add('hidden');
          try {
            const r = await api<{ link: string; emailed: boolean }>('/api/team/invite', { method: 'POST', body: { email: ($('#im', el) as HTMLInputElement).value.trim(), role: sel.value } });
            mount($('#il', el)!, html`<div class="alert alert-info" style="margin-top:12px">${r.emailed ? 'Invitation emailed.' : 'We could not send the email from here, so share this link with them yourself.'}
              <div class="row" style="gap:8px;margin-top:8px"><input class="input" readonly value="${r.link}" style="flex:1"><button class="btn btn-secondary btn-sm" data-copy>Copy link</button></div></div>`);
            $('[data-copy]', el)!.addEventListener('click', () => copyText(r.link));
            void load();
          } catch (e) { err.textContent = e instanceof ApiError ? e.message : 'Could not send the invitation'; err.classList.remove('hidden'); }
        }));
      },
    });
  }
  $('[data-invite]', view)?.addEventListener('click', inviteModal);
  await load();
}

// ── Accepting an invitation ──────────────────────────────────────────────────
const PENDING = 'zx.invite';
export const pendingInvite = (): { w: string; t: string } | null => { try { const v = JSON.parse(localStorage.getItem(PENDING) ?? 'null'); return v && typeof v.w === 'string' && typeof v.t === 'string' ? v : null; } catch { return null; } };
const setPending = (v: { w: string; t: string } | null): void => { try { if (v) localStorage.setItem(PENDING, JSON.stringify(v)); else localStorage.removeItem(PENDING); } catch { /* ignore */ } };

export async function renderAcceptInvite(query: URLSearchParams): Promise<void> {
  const link = { w: query.get('w') ?? '', t: query.get('t') ?? '' };
  const stored = pendingInvite();
  const inv = link.w && link.t ? link : stored;
  const card = (body: Raw): void => authLayout(html`<div id="auth-body">${body}</div>`);
  if (!inv) { card(html`<h1 style="font-size:1.4rem">No invitation here</h1><p class="muted" style="margin:8px 0 16px">Open the link from your invitation email.</p><a class="btn btn-primary" href="/signin" data-link>Sign in</a>`); return; }
  card(html`<p class="muted">Checking your invitation…</p>`);
  let info: { workspace: string; role: string; email: string };
  try { info = await inviteInfo(inv.w, inv.t); }
  catch (e) {
    const gone = e instanceof ApiError && (e.status === 400 || e.status === 410);
    if (gone) setPending(null);
    card(html`<h1 style="font-size:1.4rem">${gone ? 'This invitation is no longer valid' : 'Could not check your invitation'}</h1><p class="muted" style="margin:8px 0 16px">${e instanceof ApiError ? e.message : 'Please try again.'}${gone ? ' Ask the workspace owner to send a new one.' : ''}</p>${gone ? html`<a class="btn btn-primary" href="/signin" data-link>Go to sign in</a>` : html`<button class="btn btn-primary" data-retry>Try again</button>`}`);
    $('[data-retry]')?.addEventListener('click', () => void renderAcceptInvite(query));
    return;
  }
  setPending(inv);
  const who = html`<b>${info.workspace}</b> as ${info.role === 'admin' ? 'an admin' : info.role === 'viewer' ? 'a read-only viewer' : 'an editor'}`;
  const me = await loadMe().catch(() => null);
  if (!me) {
    card(html`<h1 style="font-size:1.4rem">You're invited</h1>
      <p class="muted" style="margin:8px 0 16px">You've been invited to join ${who}. Sign in or create an account with <b>${info.email}</b> to accept.</p>
      <a class="btn btn-primary btn-block" href="/signin" data-link>Sign in</a><a class="btn btn-secondary btn-block" style="margin-top:8px" href="/signup" data-link>Create an account</a>`);
    return;
  }
  if ((me.user.email ?? '').toLowerCase() !== info.email.toLowerCase()) {
    card(html`<h1 style="font-size:1.4rem">Wrong account</h1><p class="muted" style="margin:8px 0 16px">This invitation was sent to <b>${info.email}</b>, but you are signed in as ${me.user.email}.</p><button class="btn btn-primary btn-block" data-out>Sign out and switch</button><button class="btn btn-ghost btn-block" style="margin-top:8px" data-later>Not now</button>`);
    $('[data-later]')!.addEventListener('click', () => { setPending(null); navigate('/app', true); });
    $('[data-out]')!.addEventListener('click', () => { logout(); navigate(`/accept-invite?w=${encodeURIComponent(inv.w)}&t=${encodeURIComponent(inv.t)}`, true); });
    return;
  }
  card(html`<h1 style="font-size:1.4rem">Join ${info.workspace}</h1><p class="muted" style="margin:8px 0 16px">You'll join ${who}.</p><div id="ae" class="alert alert-error hidden"></div><button class="btn btn-primary btn-lg btn-block" data-go>Accept invitation</button><button class="btn btn-ghost btn-block" style="margin-top:8px" data-later>Not now</button>`);
  $('[data-later]')!.addEventListener('click', () => { setPending(null); navigate('/app', true); });
  $('[data-go]')!.addEventListener('click', () => void busy($('[data-go]') as HTMLButtonElement, async () => {
    try {
      await acceptInvite(inv.w, inv.t);
      setPending(null); clearStore(); await loadMe(true);
      toast(`You joined ${info.workspace}`, 'success'); navigate('/app', true);
    } catch (e) { const x = $('#ae')!; x.textContent = e instanceof ApiError ? e.message : 'Could not accept the invitation'; x.classList.remove('hidden'); }
  }));
}
