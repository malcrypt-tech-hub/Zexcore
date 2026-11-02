import { html, esc, mount, type Raw, $ } from './html';
import { ic, type IconName } from './icons';

let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

export interface ModalHandle { el: HTMLElement; close: () => void }

export function openModal(opts: { title: string; subtitle?: string; body: Raw; footer?: Raw; onMount?: (el: HTMLElement, close: () => void) => void }): ModalHandle {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const prevFocus = document.activeElement as HTMLElement | null;
  mount(overlay, html`
    <div class="modal" role="dialog" aria-modal="true" aria-label="${opts.title}">
      <div class="modal-head">
        <div><h3>${opts.title}</h3>${opts.subtitle ? html`<p class="muted small" style="margin-top:2px">${opts.subtitle}</p>` : ''}</div>
        <button class="btn btn-ghost btn-sm btn-icon" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <div class="modal-body">${opts.body}</div>
      ${opts.footer ? html`<div class="modal-foot">${opts.footer}</div>` : ''}
    </div>`);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.overlay')) document.body.style.overflow = '';
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const first = overlay.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])');
  first?.focus();
  opts.onMount?.(overlay, close);
  return { el: overlay, close };
}

export function confirmDialog(opts: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: opts.title,
      body: html`<p class="muted">${opts.message}</p>`,
      footer: html`<button class="btn btn-secondary" data-no>Cancel</button><button class="btn ${opts.danger ? 'btn-soft-danger' : 'btn-primary'}" data-yes>${opts.confirmLabel}</button>`,
      onMount: (el, close) => {
        $('[data-yes]', el)!.addEventListener('click', () => { done = true; close(); resolve(true); });
        $('[data-no]', el)!.addEventListener('click', () => { close(); });
      },
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el) && !done) { obs.disconnect(); resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

export function emptyState(opts: { icon: IconName; title: string; text: string; action?: Raw }): Raw {
  return html`<div class="empty"><div class="badge-ico">${ic(opts.icon, 'ico-lg')}</div><h3>${opts.title}</h3><p>${opts.text}</p>${opts.action ?? ''}</div>`;
}

export function errorState(message: string, retry = true): Raw {
  return html`<div class="empty"><div class="badge-ico">${ic('triangle-alert', 'ico-lg')}</div><h3>Something went wrong</h3><p>${message}</p>${retry ? html`<button class="btn btn-secondary btn-sm" data-retry>Try again</button>` : ''}</div>`;
}

export const skeletonRows = (n = 3): Raw => html`<div class="stack" style="padding:20px">${Array.from({ length: n }, () => html`<div class="skel" style="height:56px"></div>`)}</div>`;

/** Disable a button and show a spinner while an async action runs. */
export async function busy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner on-primary" aria-hidden="true"></span>`; }
  try { return await fn(); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label ?? ''; } }
}

export function copyText(text: string): void {
  const done = () => toast('Copied to clipboard', 'success');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy', 'error'));
  else { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch { toast('Could not copy', 'error'); } t.remove(); }
}
export { esc };

/**
 * Runs `job` (which saves a message and returns the WhatsApp link) and opens WhatsApp for the person to press send.
 * The window is opened synchronously on the click, before any waiting, because browsers block pop-ups opened afterwards.
 * If it still cannot open, the link stays on screen as a button.
 */
export async function sendViaWhatsApp(job: () => Promise<{ whatsappUrl: string }>): Promise<boolean> {
  const win = window.open('about:blank', '_blank');
  try {
    const { whatsappUrl } = await job();
    if (win && !win.closed) { win.opener = null; win.location.href = whatsappUrl; return true; }
    toast('Saved. Tap Open WhatsApp to send it.', 'info');
    openModal({ title: 'Message saved', body: html`<p class="muted">Your browser blocked the WhatsApp window. Open it here to send the message.</p>`, footer: html`<a class="btn btn-primary" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" data-close>Open WhatsApp</a>` });
    return true;
  } catch (e) { win?.close(); throw e; }
}
