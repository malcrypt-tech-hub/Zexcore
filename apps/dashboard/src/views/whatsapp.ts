import { html, mount, $ } from '../lib/html';
import { busy } from '../lib/ui';
import { ic } from '../lib/icons';
import { worker } from '../lib/fb/worker';
import { ApiError } from '../lib/api';
import { current, canAdmin } from '../lib/session';
import { toast, confirmDialog } from '../lib/ui';

interface Connection {
  connected: boolean;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  connectedAt: string | null;
}

/** Workspace-scoped Meta WhatsApp Cloud API connection. Credentials are sent directly to the Worker and never saved in the browser. */
export async function renderWhatsApp(view: HTMLElement): Promise<void> {
  const me = current()!;
  const wid = me.tenant.id;
  let connection: Connection = { connected: false, phoneNumberId: null, displayPhoneNumber: null, verifiedName: null, connectedAt: null };
  mount(view, html`<div class="page-head"><div><h1>WhatsApp Business</h1><p>Connect your business number to prepare customer messaging and follow-ups.</p></div></div>
    <div class="stack-lg">
      <section class="card card-pad stack">
        <div class="row between wrap"><div><b>Connection status</b><p class="muted small">Each workspace connects its own WhatsApp Business phone number.</p></div><span class="badge" id="wa-status">Checking…</span></div>
        <div id="wa-current" class="muted small">Loading connection details…</div>
        <div id="wa-error" class="alert alert-error hidden" role="alert"></div>
      </section>
      <section class="card card-pad stack">
        <div><h3>Connect with Meta</h3><p class="muted small">Create or select a WhatsApp Business Platform app in Meta for Developers. Copy its permanent or system-user access token and the phone number ID for the number you want ZexCore to use.</p></div>
        <div class="alert alert-info small">Your access token is sent over HTTPS to ZexCore's secured Worker, encrypted before storage, and never shown again. Only workspace owners and admins can manage this connection.</div>
        <div class="field"><label for="wa-phone-id">Phone number ID</label><input class="input" id="wa-phone-id" inputmode="numeric" autocomplete="off" placeholder="e.g. 123456789012345"></div>
        <div class="field"><label for="wa-token">Meta access token</label><input class="input" id="wa-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste your Meta access token"></div>
        <div class="row wrap"><button class="btn btn-primary" id="wa-connect" type="button" ${canAdmin() ? '' : 'disabled'}>Verify and connect</button><button class="btn btn-soft-danger hidden" id="wa-disconnect" type="button" ${canAdmin() ? '' : 'disabled'}>Disconnect number</button></div>
        <p class="muted small">You need a Meta access token with WhatsApp Business permissions and access to the selected phone number. ZexCore verifies the token against Meta before saving it.</p>
      </section>
      <section class="card card-pad stack">
        <h3>What this connection enables</h3>
        <p class="muted small">This is the secure connection step. Automated sequences, customer opt-in and opt-out controls, approved message templates, delivery updates and scheduled sending are separate features and are not enabled by connecting a number alone.</p>
      </section>
    </div>`);
  const status = $('#wa-status', view)!;
  const currentBox = $('#wa-current', view)!;
  const error = $('#wa-error', view)!;
  const connect = $('#wa-connect', view) as HTMLButtonElement;
  const disconnect = $('#wa-disconnect', view)!;
  const token = $('#wa-token', view) as HTMLInputElement;
  const phoneId = $('#wa-phone-id', view) as HTMLInputElement;
  const showError = (e: unknown) => {
    error.textContent = e instanceof ApiError ? e.message : 'Could not complete the WhatsApp request. Try again.';
    error.classList.remove('hidden');
  };
  const paint = () => {
    status.textContent = connection.connected ? 'Connected' : 'Not connected';
    status.className = connection.connected ? 'badge badge-success' : 'badge';
    currentBox.textContent = connection.connected
      ? [connection.verifiedName, connection.displayPhoneNumber, `Phone number ID: ${connection.phoneNumberId}`].filter(Boolean).join(' · ')
      : 'No WhatsApp Business number is connected to this workspace.';
    disconnect.classList.toggle('hidden', !connection.connected);
  };
  const load = async () => {
    try {
      connection = await worker<Connection>('/api/whatsapp/status', { method: 'POST', body: { workspaceId: wid } });
      paint();
    } catch (e) { showError(e); status.textContent = 'Unavailable'; currentBox.textContent = 'Connection status could not be loaded.'; }
  };
  connect.addEventListener('click', (ev) => {
    void busy(ev.currentTarget as HTMLButtonElement, async () => {
      error.classList.add('hidden');
      const id = phoneId.value.trim();
      const accessToken = token.value.trim();
      if (!/^\\d{5,30}$/.test(id) || accessToken.length < 30) {
        error.textContent = 'Enter a valid phone number ID and Meta access token.';
        error.classList.remove('hidden');
        return;
      }
      try {
        const result = await worker<{ connected: boolean; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }>('/api/whatsapp/connect', {
          method: 'POST', body: { workspaceId: wid, phoneNumberId: id, accessToken },
        });
        token.value = '';
        connection = { ...result, connectedAt: new Date().toISOString() };
        paint();
        toast('WhatsApp Business number verified and connected.', 'success');
      } catch (e) { token.value = ''; showError(e); }
    });
  });
  disconnect.addEventListener('click', () => {
    void confirmDialog({
      title: 'Disconnect WhatsApp Business?',
      message: 'ZexCore will disable this workspace connection and clear the encrypted access token. Existing customer conversations in WhatsApp are not deleted.',
      confirmLabel: 'Disconnect',
      danger: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
          await worker('/api/whatsapp/disconnect', { method: 'POST', body: { workspaceId: wid } });
          connection = { connected: false, phoneNumberId: null, displayPhoneNumber: null, verifiedName: null, connectedAt: null };
          paint();
          toast('WhatsApp Business disconnected.', 'success');
      } catch (e) { showError(e); }
    });
  });
  if (!canAdmin()) {
    connect.disabled = true;
    disconnect.setAttribute('disabled', 'true');
  }
  await load();
}
