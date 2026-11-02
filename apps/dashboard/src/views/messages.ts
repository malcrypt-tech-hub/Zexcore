import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { ago, initials, timeOf, whenLabel, money } from '../lib/format';
import { emptyState, errorState, skeletonRows, toast, openModal, busy, copyText, sendViaWhatsApp } from '../lib/ui';
import { loadSettings, offset } from '../lib/store';
import { refreshUnread } from '../layouts';
import { canManage, current } from '../lib/session';

interface Conv { phone: string; name: string; lastBody: string; lastKind: string; lastDirection: string; lastAt: string; unread: number; nextSlot: string | null; nextStatus: string | null; nextRef: string | null }
interface Msg { id: string; direction: 'in' | 'out'; kind: 'text' | 'system' | 'payment'; body: string; createdAt: string }

export async function renderMessages(view: HTMLElement, phoneParam?: string | null): Promise<void> {
  if (current()?.role === 'viewer') { mount(view, html`<div class="page-head"><div><h1>Messages</h1></div></div><div class="alert alert-info">Customer chats are private to the team. Your read-only login does not include them.</div>`); return; }
  await loadSettings();
  let filter: 'all' | 'waiting' | 'booked' = 'all';
  let active: string | null = phoneParam ?? null;

  mount(view, html`
    <div class="page-head"><div><h1>Messages</h1><p>Customer enquiries and automatic booking updates in one inbox.</p></div>${canManage() ? html`<button class="btn btn-primary" data-new-chat>${ic('plus', 'ico-sm')} New message</button>` : ''}</div>
    <div class="split"><div class="card conv-list" id="convs"></div><div class="card" id="thread" style="min-height:360px"></div></div>`);
  $('[data-new-chat]', view)?.addEventListener('click', openNewChat);

  async function loadConvs(): Promise<void> {
    const host = $('#convs', view)!;
    mount(host, skeletonRows(3));
    try {
      const r = await api<{ conversations: Conv[]; counts: { all: number; waiting: number; booked: number } }>(`/api/bookings/conversations?filter=${filter}`);
      const chips = html`<div class="chips" style="padding:12px 12px 0">${(['waiting', 'all', 'booked'] as const).map((f) => html`<button class="chip-btn" aria-pressed="${f === filter}" data-f="${f}">${f === 'waiting' ? 'Waiting for reply' : f === 'all' ? 'All' : 'Booked'} <span class="count">${r.counts[f]}</span></button>`)}</div>`;
      mount(host, html`${chips}${r.conversations.length === 0 ? emptyState({ icon: 'message-square', title: filter === 'waiting' ? 'No one is waiting' : 'No messages yet', text: filter === 'waiting' ? 'Every customer message has a reply.' : 'When customers message you or book, conversations appear here.' }) : html`<div class="list">${r.conversations.map((c) => html`
        <button class="list-item hover" style="width:100%;text-align:left;${c.phone === active ? 'background:var(--primary-tint)' : ''}" data-phone="${c.phone}">
          <span class="avatar ${c.unread ? 'red' : ''}">${initials(c.name)}</span>
          <span class="grow"><span class="row between"><b class="truncate">${c.name}</b><span class="faint small nowrap">${ago(c.lastAt)}</span></span>
            <span class="muted small truncate" style="display:block">${c.lastDirection === 'out' && c.lastKind === 'text' ? 'You: ' : ''}${c.lastBody}</span></span>
          ${c.unread ? html`<span class="badge badge-primary">${c.unread}</span>` : ''}</button>`)}</div>`}`);
      host.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f as typeof filter; void loadConvs(); }));
      host.querySelectorAll<HTMLElement>('[data-phone]').forEach((b) => b.addEventListener('click', () => { active = b.dataset.phone!; void loadThread(); void loadConvs(); }));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load messages')); $('[data-retry]', host)?.addEventListener('click', () => void loadConvs()); }
  }

  async function loadThread(): Promise<void> {
    const host = $('#thread', view)!;
    if (!active) { mount(host, emptyState({ icon: 'message-square', title: 'Select a conversation', text: 'Pick a customer on the left to read and reply.' })); return; }
    mount(host, skeletonRows(2));
    try {
      const r = await api<{ phone: string; messages: Msg[]; bookings: { ref: string; serviceName: string; startsAt: string; status: string; depositStatus: string; depositMinor: number; currency: string; customerName: string }[] }>(`/api/bookings/conversation?phone=${encodeURIComponent(active)}`);
      const b = r.bookings.find((x) => x.status === 'pending' || x.status === 'confirmed') ?? r.bookings[0];
      const name = b?.customerName ?? '';
      mount(host, html`
        <div class="card-head"><div class="row"><span class="avatar">${initials(name || r.phone)}</span><div><b>${name || r.phone}</b><div class="muted small mono">${r.phone}</div></div></div>
          ${matchMedia('(pointer: coarse)').matches ? html`<a class="btn btn-secondary btn-sm btn-icon" href="tel:${r.phone}" aria-label="Call ${r.phone}">${ic('phone', 'ico-sm')}</a>` : html`<button class="btn btn-secondary btn-sm btn-icon" data-copy-phone aria-label="Copy phone number" title="Copy phone number">${ic('copy', 'ico-sm')}</button>`}</div>
        ${b ? html`<div class="row between wrap" style="padding:12px 20px;background:var(--canvas);border-bottom:1px solid var(--border);gap:16px"><div><div class="faint small" style="text-transform:uppercase;letter-spacing:.06em">Next slot</div><b>${whenLabel(b.startsAt, offset())}</b></div><div><div class="faint small" style="text-transform:uppercase;letter-spacing:.06em">Deposit</div><b class="mono">${b.depositMinor ? `${money(b.depositMinor, b.currency)} ${b.depositStatus}` : 'None'}</b></div></div>` : ''}
        <div class="thread" id="msgs" style="max-height:52vh;overflow:auto">${r.messages.length === 0 ? html`<p class="muted small" style="text-align:center">No messages yet.</p>` : r.messages.map((m) => m.kind === 'system' ? html`<div class="msg-sys">${m.body}</div>` : m.kind === 'payment' ? html`<div class="msg-pay"><span class="icon-tile" style="background:var(--success);color:#fff;border-radius:50%">${ic('shield-check')}</span><div><b>Payment received</b><div class="muted small mono">${m.body}</div></div></div>` : html`<div class="msg ${m.direction}">${m.body}<span class="ts">${timeOf(m.createdAt, offset())}</span></div>`)}</div>
        ${canManage() ? html`<form class="compose" id="reply" autocomplete="off"><input class="input" id="rb" placeholder="Write a reply" maxlength="2000" aria-label="Reply"><button class="btn btn-primary btn-icon" type="submit" aria-label="Send">${ic('send', 'ico-sm')}</button></form><p class="hint" style="padding:0 14px 12px">Replies are saved here and opened in WhatsApp so you can send them to the customer.</p>` : ''}`);
      $('[data-copy-phone]', host)?.addEventListener('click', () => copyText(r.phone));
      const box = $('#msgs', host); if (box) box.scrollTop = box.scrollHeight;
      await api('/api/bookings/conversation/read', { method: 'POST', body: { phone: active } }).catch(() => {});
      void refreshUnread();
      $('#reply', host)?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#rb', host) as HTMLInputElement; const body = input.value.trim(); if (!body) return;
        void busy($('#reply button', host) as HTMLButtonElement, async () => {
          try {
            await sendViaWhatsApp(() => api<{ whatsappUrl: string }>('/api/bookings/messages', { method: 'POST', body: { phone: active, body } }));
            await loadThread(); await loadConvs();
          } catch (x) { toast(x instanceof ApiError ? x.message : 'Could not send', 'error'); }
        });
      });
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load conversation')); }
  }

  function openNewChat(): void {
    openModal({
      title: 'New message',
      body: html`<form id="nc" class="form-grid"><div id="nc-err" class="alert alert-error hidden"></div><div class="field"><label for="ncn">Customer name</label><input class="input" id="ncn" required maxlength="160"></div><div class="field"><label for="ncp">Phone / WhatsApp</label><input class="input" id="ncp" type="tel" required placeholder="0803 123 4567"></div><div class="field"><label for="ncb">Message</label><textarea class="textarea" id="ncb" required maxlength="2000"></textarea></div></form>`,
      footer: html`<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" data-send>Send on WhatsApp</button>`,
      onMount: (el, close) => $('[data-send]', el)!.addEventListener('click', () => void busy($('[data-send]', el) as HTMLButtonElement, async () => {
        const err = $('#nc-err', el)!; err.classList.add('hidden');
        try {
          await sendViaWhatsApp(() => api<{ whatsappUrl: string }>('/api/bookings/messages', { method: 'POST', body: { phone: ($('#ncp', el) as HTMLInputElement).value, name: ($('#ncn', el) as HTMLInputElement).value, body: ($('#ncb', el) as HTMLTextAreaElement).value } }));
          close(); await loadConvs();
        } catch (x) { err.textContent = x instanceof ApiError ? x.message : 'Could not send'; err.classList.remove('hidden'); }
      })),
    });
  }

  await loadConvs(); await loadThread();
}
