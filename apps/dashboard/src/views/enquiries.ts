import { getDocs, limit, orderBy, query, updateDoc } from 'firebase/firestore';
import { audit, loadCtx, wsCol, wsDoc } from '../lib/fb/core';
import { html, mount } from '../lib/html';
import { $, busy, errorState, toast } from '../lib/ui';
import { ic } from '../lib/icons';
import { canEdit } from '../lib/session';

interface Enquiry {
  id: string; serviceName: string; customerName: string; customerPhone: string;
  customerEmail?: string | null; notes?: string | null; intakeAnswers?: Record<string, string>;
  consultationRequested?: boolean; status: string; createdAt?: { toDate?: () => Date } | null;
}

export async function renderEnquiries(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="page-head"><div><h1>Service enquiries</h1><p>Project requests and other enquiries that do not need an appointment slot.</p></div></div><div class="card" id="enquiry-list"><div class="skel" style="height:120px"></div></div>`);
  const host = $('#enquiry-list', view)!;
  const load = async () => {
    try {
      const c = await loadCtx();
      const snap = await getDocs(query(wsCol(c, 'enquiries'), orderBy('createdAt', 'desc'), limit(100)));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() } as Enquiry));
      if (!rows.length) {
        mount(host, html`<div class="empty"><span class="icon-tile">${ic('inbox')}</span><h3>No enquiries yet</h3><p>When someone submits a project or service enquiry, it will appear here.</p></div>`);
        return;
      }
      mount(host, html`<div class="list">${rows.map(e => html`<article class="list-item" style="align-items:flex-start"><span class="icon-tile">${ic('message-square-text')}</span><div class="grow" style="min-width:0"><div class="row between wrap"><b>${e.customerName}</b><span class="badge">${e.status}</span></div><div class="muted small">${e.serviceName} · ${e.createdAt?.toDate ? e.createdAt.toDate().toLocaleString() : 'Just received'}</div><div class="small" style="margin-top:6px"><a href="tel:${e.customerPhone}">${e.customerPhone}</a>${e.customerEmail ? html` · <a href="mailto:${e.customerEmail}">${e.customerEmail}</a>` : ''}</div>${e.consultationRequested ? html`<div class="small" style="margin-top:6px">Requested a consultation</div>` : ''}${e.notes ? html`<p class="small" style="margin-top:8px;white-space:pre-wrap">${e.notes}</p>` : ''}${Object.entries(e.intakeAnswers ?? {}).map(([k,v]) => html`<div class="small" style="margin-top:5px"><span class="muted">${k}:</span> ${v}</div>`)}${canEdit() ? html`<div class="row wrap" style="gap:6px;margin-top:10px"><button class="btn btn-secondary btn-sm" data-status="${e.id}" data-next="contacted" ${e.status === 'contacted' ? 'disabled' : ''}>Mark contacted</button><button class="btn btn-secondary btn-sm" data-status="${e.id}" data-next="closed" ${e.status === 'closed' ? 'disabled' : ''}>Close enquiry</button></div>` : ''}</div></article>`)}</div>`);
      host.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(btn => btn.addEventListener('click', () => {
        void busy(btn, async () => {
          try {
            const id = btn.dataset.status!, status = btn.dataset.next!;
            await updateDoc(wsDoc(c, 'enquiries', id), { status });
            void audit(c, 'enquiry.status', 'enquiry', id, status);
            toast('Enquiry updated', 'success');
            await load();
          } catch { toast('Could not update this enquiry', 'error'); }
        });
      }));
    } catch (e) {
      mount(host, errorState(e instanceof Error ? e.message : 'Could not load enquiries'));
    }
  };
  await load();
}
