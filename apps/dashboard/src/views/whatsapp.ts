import { html, mount, $, $$ } from '../lib/html';
import { busy, toast, confirmDialog } from '../lib/ui';
import { worker } from '../lib/fb/worker';
import { ApiError } from '../lib/api';
import { current, canAdmin, canManage } from '../lib/session';

interface Connection { connected: boolean; phoneNumberId: string | null; displayPhoneNumber: string | null; verifiedName: string | null; connectedAt: string | null }
interface Step { delayMinutes: number; templateName: string; language: string; bodyParameters: string[] }
interface Sequence { id: string; name: string; enabled: boolean; trigger: string; steps: Step[] }

/** Workspace-scoped Meta WhatsApp connection, consent records and follow-up sequence management. */
export async function renderWhatsApp(view: HTMLElement): Promise<void> {
  const me = current()!;
  const wid = me.tenant.id;
  const admin = canAdmin();
  const manage = canManage();
  let connection: Connection = { connected: false, phoneNumberId: null, displayPhoneNumber: null, verifiedName: null, connectedAt: null };
  let sequences: Sequence[] = [];
  mount(view, html`<div class="page-head"><div><h1>WhatsApp Business</h1><p>Connect your business number, manage customer consent and automate follow-ups.</p></div></div>
    <div class="stack-lg">
      <section class="card card-pad stack">
        <div class="row between wrap"><div><b>Connection status</b><p class="muted small">Each workspace connects its own WhatsApp Business phone number.</p></div><span class="badge" id="wa-status">Checking…</span></div>
        <div id="wa-current" class="muted small">Loading connection details…</div><div id="wa-error" class="alert alert-error hidden" role="alert"></div>
        <div><h3>Connect with Meta</h3><p class="muted small">Use a WhatsApp Business Platform phone number ID and a Meta access token with WhatsApp permissions.</p></div>
        <div class="alert alert-info small">The access token is sent over HTTPS, encrypted before storage, and never shown again. Only owners and admins can manage the connection.</div>
        <div class="field"><label for="wa-phone-id">Phone number ID</label><input class="input" id="wa-phone-id" inputmode="numeric" autocomplete="off" placeholder="e.g. 123456789012345"></div>
        <div class="field"><label for="wa-token">Meta access token</label><input class="input" id="wa-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste your Meta access token"></div>
        <div class="row wrap"><button class="btn btn-primary" id="wa-connect" type="button" ${admin ? '' : 'disabled'}>Verify and connect</button><button class="btn btn-soft-danger hidden" id="wa-disconnect" type="button" ${admin ? '' : 'disabled'}>Disconnect number</button></div>
        <p class="muted small">ZexCore verifies the credentials against Meta before saving them.</p>
      </section>
      <section class="card card-pad stack">
        <div><h3>Follow-up sequences</h3><p class="muted small">Send approved WhatsApp templates after customer events. Only customers with recorded opt-in are eligible.</p></div>
        <div id="wa-sequences" class="stack-sm"><p class="muted small">Loading sequences…</p></div>
        <div class="divider"></div>
        <h4 id="wa-seq-heading">Create a sequence</h4>
        <div class="field"><label for="wa-seq-name">Sequence name</label><input class="input" id="wa-seq-name" maxlength="80" placeholder="e.g. Booking confirmation"></div>
        <div class="field"><label for="wa-seq-trigger">Trigger event</label><select class="input" id="wa-seq-trigger"><option value="bookings.booking.created">New booking created</option></select><small class="muted">New booking is currently the supported trigger.</small></div>
        <div class="field"><label for="wa-seq-template">Approved Meta template name</label><input class="input" id="wa-seq-template" maxlength="128" placeholder="e.g. booking_followup"></div>
        <div class="form-grid two">
          <div class="field"><label for="wa-seq-delay">Delay (minutes)</label><input class="input" id="wa-seq-delay" type="number" min="0" max="525600" value="0"></div>
          <div class="field"><label for="wa-seq-language">Template language</label><input class="input" id="wa-seq-language" value="en" placeholder="en or en_US"></div>
        </div>
        <div class="field"><label for="wa-seq-params">Body parameters (one per line)</label><textarea class="input" id="wa-seq-params" rows="3" placeholder="Customer name\nBusiness name"></textarea><small class="muted">Values are sent in order to the approved template's body placeholders.</small></div>
        <label class="check"><input type="checkbox" id="wa-seq-enabled" checked> Enable this sequence</label>
        <div class="row wrap"><button class="btn btn-primary" id="wa-seq-save" type="button" ${admin ? '' : 'disabled'}>Save sequence</button><button class="btn btn-secondary hidden" id="wa-seq-cancel" type="button">Cancel edit</button></div>
        <p id="wa-seq-error" class="alert alert-error hidden" role="alert"></p>
      </section>
      <section class="card card-pad stack">
        <h3>Customer messaging consent</h3>
        <p class="muted small">Record a customer's explicit permission before adding them to automated WhatsApp follow-ups. Keep the source of consent for your records.</p>
        <div class="form-grid two">
          <div class="field"><label for="wa-consent-phone">Customer phone (international format)</label><input class="input" id="wa-consent-phone" type="tel" placeholder="+2348012345678"></div>
          <div class="field"><label for="wa-consent-source">Consent source</label><select class="input" id="wa-consent-source"><option value="dashboard">In person / phone</option><option value="website">Website form</option><option value="paper">Written form</option><option value="other">Other recorded source</option></select></div>
        </div>
        <div class="row wrap"><button class="btn btn-primary" id="wa-opt-in" type="button" ${manage ? '' : 'disabled'}>Record opt-in</button><button class="btn btn-soft-danger" id="wa-opt-out" type="button" ${manage ? '' : 'disabled'}>Record opt-out</button></div>
        <p id="wa-consent-result" class="muted small" aria-live="polite"></p>
      </section>
      <p class="muted small">Messages use Meta-approved templates. Connecting a number does not itself grant customer consent. Delivery receipts and inbound STOP/opt-out keyword handling are not yet available; staff should record opt-outs here immediately.</p>
    </div>`);
  const status = $('#wa-status', view)!;
  const currentBox = $('#wa-current', view)!;
  const error = $('#wa-error', view)!;
  const connect = $('#wa-connect', view) as HTMLButtonElement;
  const disconnect = $('#wa-disconnect', view)!;
  const token = $('#wa-token', view) as HTMLInputElement;
  const phoneId = $('#wa-phone-id', view) as HTMLInputElement;
  const seqHost = $('#wa-sequences', view)!;
  const seqError = $('#wa-seq-error', view)!;
  const seqSave = $('#wa-seq-save', view) as HTMLButtonElement;
  const seqCancel = $('#wa-seq-cancel', view)!;
  let editingId: string | null = null;
  const showError = (e: unknown, target = error) => { target.textContent = e instanceof ApiError ? e.message : 'Could not complete the WhatsApp request. Try again.'; target.classList.remove('hidden'); };
  const paintConnection = () => {
    status.textContent = connection.connected ? 'Connected' : 'Not connected';
    status.className = connection.connected ? 'badge badge-success' : 'badge';
    currentBox.textContent = connection.connected ? [connection.verifiedName, connection.displayPhoneNumber, `Phone number ID: ${connection.phoneNumberId}`].filter(Boolean).join(' · ') : 'No WhatsApp Business number is connected to this workspace.';
    disconnect.classList.toggle('hidden', !connection.connected);
  };
  const loadConnection = async () => {
    try { connection = await worker<Connection>('/api/whatsapp/status', { method: 'POST', body: { workspaceId: wid } }); paintConnection(); }
    catch (e) { showError(e); status.textContent = 'Unavailable'; currentBox.textContent = 'Connection status could not be loaded.'; }
  };
  connect.addEventListener('click', ev => void busy(ev.currentTarget as HTMLButtonElement, async () => {
    error.classList.add('hidden');
    const id = phoneId.value.trim(), accessToken = token.value.trim();
    if (!/^\\d{5,30}$/.test(id) || accessToken.length < 30) { error.textContent = 'Enter a valid phone number ID and Meta access token.'; error.classList.remove('hidden'); return; }
    try {
      const result = await worker<{ connected: boolean; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }>('/api/whatsapp/connect', { method: 'POST', body: { workspaceId: wid, phoneNumberId: id, accessToken } });
      token.value = ''; connection = { ...result, connectedAt: new Date().toISOString() }; paintConnection(); toast('WhatsApp Business number verified and connected.', 'success');
    } catch (e) { token.value = ''; showError(e); }
  }));
  disconnect.addEventListener('click', () => void confirmDialog({ title: 'Disconnect WhatsApp Business?', message: 'This clears the encrypted access token. Existing customer conversations are not deleted.', confirmLabel: 'Disconnect', danger: true }).then(async ok => {
    if (!ok) return;
    try { await worker('/api/whatsapp/disconnect', { method: 'POST', body: { workspaceId: wid } }); connection = { connected: false, phoneNumberId: null, displayPhoneNumber: null, verifiedName: null, connectedAt: null }; paintConnection(); toast('WhatsApp Business disconnected.', 'success'); }
    catch (e) { showError(e); }
  }));
  const resetSequenceForm = () => {
    editingId = null;
    ($('#wa-seq-name', view) as HTMLInputElement).value = '';
    ($('#wa-seq-trigger', view) as HTMLSelectElement).value = 'bookings.booking.created';
    ($('#wa-seq-template', view) as HTMLInputElement).value = '';
    ($('#wa-seq-delay', view) as HTMLInputElement).value = '0';
    ($('#wa-seq-language', view) as HTMLInputElement).value = 'en';
    ($('#wa-seq-params', view) as HTMLTextAreaElement).value = '';
    ($('#wa-seq-enabled', view) as HTMLInputElement).checked = true;
    $('#wa-seq-heading', view)!.textContent = 'Create a sequence';
    seqSave.textContent = 'Save sequence'; seqCancel.classList.add('hidden'); seqError.classList.add('hidden');
  };
  const paintSequences = () => {
    if (!sequences.length) { mount(seqHost, html`<div class="empty-state"><p class="muted small">No follow-up sequences yet. Create one below to start.</p></div>`); return; }
    mount(seqHost, html`<div class="list">${sequences.map(s => html`<div class="list-item"><span class="icon-tile">↗</span><div class="grow"><b>${s.name}</b><div class="muted small">${s.trigger} · ${s.steps.length} step(s) · ${s.steps[0]?.templateName ?? 'No template'}</div></div><span class="badge">${s.enabled ? 'Enabled' : 'Paused'}</span><button class="btn btn-secondary btn-sm" data-wa-edit="${s.id}">Edit</button><button class="btn btn-soft-danger btn-sm" data-wa-delete="${s.id}">Delete</button></div>` )}</div>`);
    $$('[data-wa-edit]', seqHost).forEach(b => b.addEventListener('click', () => {
      const s = sequences.find(x => x.id === b.dataset.waEdit); if (!s) return;
      editingId = s.id;
      ($('#wa-seq-name', view) as HTMLInputElement).value = s.name;
      ($('#wa-seq-trigger', view) as HTMLSelectElement).value = s.trigger;
      ($('#wa-seq-template', view) as HTMLInputElement).value = s.steps[0]?.templateName ?? '';
      ($('#wa-seq-delay', view) as HTMLInputElement).value = String(s.steps[0]?.delayMinutes ?? 0);
      ($('#wa-seq-language', view) as HTMLInputElement).value = s.steps[0]?.language ?? 'en';
      ($('#wa-seq-params', view) as HTMLTextAreaElement).value = (s.steps[0]?.bodyParameters ?? []).join('\n');
      ($('#wa-seq-enabled', view) as HTMLInputElement).checked = s.enabled;
      $('#wa-seq-heading', view)!.textContent = 'Edit sequence'; seqSave.textContent = 'Update sequence'; seqCancel.classList.remove('hidden');
    }));
    $$('[data-wa-delete]', seqHost).forEach(b => b.addEventListener('click', () => void confirmDialog({ title: 'Delete this sequence?', message: 'Future events will no longer queue messages from this sequence.', confirmLabel: 'Delete sequence', danger: true }).then(async ok => {
      if (!ok) return;
      try { await worker('/api/whatsapp/sequences', { method: 'POST', body: { workspaceId: wid, action: 'delete', id: b.dataset.waDelete } }); sequences = sequences.filter(s => s.id !== b.dataset.waDelete); paintSequences(); toast('Sequence deleted.', 'success'); }
      catch (e) { showError(e, seqError); }
    })));
  };
  const loadSequences = async () => {
    try { const r = await worker<{ sequences: Sequence[] }>('/api/whatsapp/sequences', { method: 'POST', body: { workspaceId: wid, action: 'list' } }); sequences = r.sequences ?? []; paintSequences(); }
    catch (e) { showError(e, seqError); seqHost.textContent = 'Could not load sequences.'; }
  };
  seqSave.addEventListener('click', ev => void busy(ev.currentTarget as HTMLButtonElement, async () => {
    seqError.classList.add('hidden');
    const name = ($('#wa-seq-name', view) as HTMLInputElement).value.trim();
    const templateName = ($('#wa-seq-template', view) as HTMLInputElement).value.trim();
    const delayMinutes = Number(($('#wa-seq-delay', view) as HTMLInputElement).value);
    const language = ($('#wa-seq-language', view) as HTMLInputElement).value.trim() || 'en';
    const bodyParameters = ($('#wa-seq-params', view) as HTMLTextAreaElement).value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!name || !/^[a-z0-9_]{2,128}$/.test(templateName) || !Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 525600 || bodyParameters.length > 10 || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
      seqError.textContent = 'Check the sequence name, template name, delay, language and up to 10 body parameters.'; seqError.classList.remove('hidden'); return;
    }
    const sequence = { name, trigger: ($('#wa-seq-trigger', view) as HTMLSelectElement).value, enabled: ($('#wa-seq-enabled', view) as HTMLInputElement).checked, steps: [{ delayMinutes, templateName, language, bodyParameters }] };
    try {
      const r = await worker<{ id: string }>('/api/whatsapp/sequences', { method: 'POST', body: { workspaceId: wid, action: 'save', ...(editingId ? { id: editingId } : {}), sequence } });
      if (editingId) sequences = sequences.map(s => s.id === editingId ? { id: editingId!, ...sequence } : s); else sequences.push({ id: r.id, ...sequence }); 
      paintSequences(); resetSequenceForm(); toast('Sequence saved.', 'success');
    } catch (e) { showError(e, seqError); }
  }));
  seqCancel.addEventListener('click', resetSequenceForm);
  const setConsent = async (optedIn: boolean) => {
    const phone = ($('#wa-consent-phone', view) as HTMLInputElement).value.trim();
    const source = ($('#wa-consent-source', view) as HTMLSelectElement).value;
    const result = $('#wa-consent-result', view)!;
    if (!/^\\+?[1-9]\\d{7,14}$/.test(phone.replace(/[\\s().-]/g, ''))) { result.textContent = 'Enter a valid phone number in international format, including country code.'; return; }
    try {
      const r = await worker<{ ok: boolean; optedIn: boolean }>('/api/whatsapp/consent', { method: 'POST', body: { workspaceId: wid, phone, source, optedIn } });
      result.textContent = r.optedIn ? 'Opt-in recorded. This customer is eligible for configured follow-ups.' : 'Opt-out recorded. Queued follow-ups will be cancelled before sending.';
      toast(r.optedIn ? 'Customer opt-in recorded.' : 'Customer opt-out recorded.', 'success');
    } catch (e) { result.textContent = e instanceof ApiError ? e.message : 'Could not save consent.'; }
  };
  $('#wa-opt-in', view)!.addEventListener('click', () => void setConsent(true));
  $('#wa-opt-out', view)!.addEventListener('click', () => void setConsent(false));
  if (!admin) { connect.disabled = true; disconnect.setAttribute('disabled', 'true'); }
  await Promise.all([loadConnection(), loadSequences()]);
}
