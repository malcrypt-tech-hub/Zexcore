/** Shop: the goods a business sells online (with photos) and the order requests customers send. */
import { html, mount, $, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { money, ago } from '../lib/format';
import { emptyState, skeletonRows, confirmDialog } from '../lib/ui';
import { canEdit, canAdmin } from '../lib/session';
import { api, toast, badge, pageHead, formModal, inp, fail, errMsg } from './shared';
import { uploadPhoto, thumb, ORDER_STATUSES, type ProductDto, type OrderDto } from '../lib/fb/shop';

type Tab = 'products' | 'orders';
const STATUS_LABEL: Record<string, string> = { new: 'New', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
const KIND: Record<string, 'success' | 'warning' | 'primary' | 'info' | ''> = { new: 'warning', confirmed: 'primary', shipped: 'info', delivered: 'success', cancelled: '' };

export function renderShop(view: HTMLElement): void {
  let tab: Tab = location.hash === '#orders' ? 'orders' : 'products';
  mount(view, html`${pageHead('Shop', 'Goods you sell on your booking page, and the orders customers send.')}
    <div class="chips" role="tablist" id="st" style="margin-bottom:4px">${(['products', 'orders'] as Tab[]).map((t) => html`<button class="chip-btn" role="tab" data-tab="${t}">${t === 'products' ? 'Products' : 'Orders'}</button>`)}</div>
    <div id="sh" style="margin-top:16px"></div>`);
  const host = $('#sh', view)!;
  const draw = (): void => {
    view.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-selected', String(on)); });
    void (tab === 'products' ? products() : orders());
  };
  view.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab as Tab; history.replaceState(null, '', tab === 'orders' ? '#orders' : location.pathname); draw(); }));

  const productForm = (p?: ProductDto): void => {
    let image: string | null = p?.imageUrl ?? null;
    formModal({
      title: p ? 'Edit product' : 'Add a product', submitLabel: p ? 'Save' : 'Add product',
      body: html`<div class="field"><label for="pn">Name</label><input class="input" id="pn" maxlength="120" required value="${p?.name ?? ''}"></div>
        <div class="field"><label for="pd">Description <span class="faint">(optional)</span></label><textarea class="input" id="pd" rows="3" maxlength="500">${p?.description ?? ''}</textarea></div>
        <div class="field"><label for="pp">Price (US dollars)</label><input class="input" id="pp" type="number" min="0" step="0.01" required value="${p ? (p.priceMinor / 100).toFixed(2) : ''}"></div>
        <div class="field"><label>Photo <span class="faint">(JPG, PNG or WebP, up to 5 MB)</span></label>
          <div class="row" style="gap:12px;align-items:center"><img id="pv" alt="" style="width:64px;height:64px;border-radius:10px;object-fit:cover;background:var(--surface-2);${image ? '' : 'display:none'}" src="${thumb(image, 128) ?? ''}">
          <input id="pf" type="file" accept="image/jpeg,image/png,image/webp"><span id="pm" class="muted small" role="status"></span></div></div>
        <label class="check"><input type="checkbox" id="pa" ${p?.active === false ? '' : 'checked'}> Show on my booking page</label>
        <label class="check"><input type="checkbox" id="pi" ${p?.inStock === false ? '' : 'checked'}> In stock</label>`,
      submit: async (el) => {
        const file = ($('#pf', el) as HTMLInputElement).files?.[0];
        if (file) { $('#pm', el)!.textContent = 'Uploading…'; image = await uploadPhoto(file); }
        const body = { name: inp(el, '#pn'), description: inp(el, '#pd'), priceMinor: Math.round(Number(inp(el, '#pp')) * 100), imageUrl: image, active: ($('#pa', el) as HTMLInputElement).checked, inStock: ($('#pi', el) as HTMLInputElement).checked };
        if (!Number.isFinite(body.priceMinor)) throw new Error('Enter a valid price.');
        await api(p ? `/api/shop/products/${p.id}` : '/api/shop/products', { method: p ? 'PATCH' : 'POST', body });
        toast(p ? 'Product saved' : 'Product added', 'success'); void products();
      },
    });
  };

  const products = async (): Promise<void> => {
    mount(host, skeletonRows(3));
    try {
      const { products: rows } = await api<{ products: ProductDto[] }>('/api/shop/products');
      mount(host, html`${canEdit() ? html`<div class="row" style="justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary" data-add>${ic('plus', 'ico-sm')} Add a product</button></div>` : ''}
        <div class="card">${rows.length === 0 ? emptyState({ icon: 'shopping-bag', title: 'No products yet', text: 'Add what you sell. Customers see it on your booking page and can pay online or send you an order request. Online payment needs a payout account in Settings.' })
          : html`<div class="list">${rows.map((r) => html`<div class="list-item">
            ${thumb(r.imageUrl, 96) ? html`<img src="${thumb(r.imageUrl, 96)!}" alt="" width="48" height="48" style="border-radius:10px;object-fit:cover">` : html`<span class="icon-tile">${ic('shopping-bag')}</span>`}
            <div class="grow"><b>${r.name}</b><div class="muted small">${money(r.priceMinor)} · ${r.active ? (r.inStock ? 'On sale' : 'Out of stock') : 'Hidden'}</div></div>
            ${canEdit() ? html`<div class="row" style="gap:6px"><button class="btn btn-secondary btn-sm" data-edit="${r.id}">Edit</button><button class="btn btn-soft-danger btn-sm" data-del="${r.id}" data-name="${r.name}">Delete</button></div>` : ''}</div>`)}</div>`}</div>`);
      $('[data-add]', host)?.addEventListener('click', () => productForm());
      host.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) => b.addEventListener('click', () => productForm(rows.find((x) => x.id === b.dataset.edit))));
      host.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog({ title: `Delete ${b.dataset.name}?`, message: 'It disappears from your booking page. Past orders keep their own copy of the name and price.', confirmLabel: 'Delete', danger: true })) return;
        try { await api(`/api/shop/products/${b.dataset.del}`, { method: 'DELETE' }); toast('Product deleted', 'success'); void products(); } catch (e) { toast(errMsg(e, 'Could not delete'), 'error'); }
      }));
    } catch (e) { mount(host, fail(host, e, () => void products(), 'Could not load your products')); }
  };

  const orders = async (): Promise<void> => {
    mount(host, skeletonRows(3));
    try {
      const { orders: rows } = await api<{ orders: OrderDto[] }>('/api/shop/orders');
      const card = (o: OrderDto): Raw => html`<div class="card card-pad stack-sm" style="margin-bottom:12px">
        <div class="row between wrap" style="gap:8px"><div><b>${o.customerName}</b> <span class="muted small">${o.ref} · ${o.createdAt ? ago(o.createdAt) : ''}</span></div>${badge(STATUS_LABEL[o.status] ?? o.status, KIND[o.status] ?? '')}</div>
        <div class="small">${o.items.map((i) => html`<div>${i.qty} × ${i.name} <span class="muted">(${money(i.unitMinor)} each)</span></div>`)}</div>
        <div class="muted small">List total ${money(o.totalMinor)}${o.paymentStatus === 'paid' ? html` · <b style="color:var(--success)">Paid online</b>` : o.paymentStatus === 'refunded' ? ' · Refunded' : ''}</div>
        <div class="small"><span class="muted">Deliver to:</span> ${o.address}${o.notes ? html`<br><span class="muted">Notes:</span> ${o.notes}` : ''}</div>
        <div class="small"><a href="tel:${o.customerPhone}">${o.customerPhone}</a> · <a href="https://wa.me/${o.customerPhone.replace(/\D/g, '')}" target="_blank" rel="noopener">WhatsApp</a>${o.customerEmail ? html` · ${o.customerEmail}` : ' · no email given'}</div>
        <div class="row wrap" style="gap:6px">${canAdmin() ? html`<button class="btn btn-soft-danger btn-sm" data-delorder="${o.id}" data-paid="${o.paymentStatus === 'paid' ? '1' : ''}" data-ref="${o.ref}">Delete</button>` : ''}${o.paymentStatus === 'paid' ? html`<button class="btn btn-soft-danger btn-sm" data-refund="${o.id}">Refund and cancel</button>` : ''}${(o.paymentStatus === 'refunded' ? [] : ORDER_STATUSES).filter((s) => s !== o.status && !(o.paymentStatus === 'paid' && s === 'cancelled')).map((s) => html`<button class="btn btn-secondary btn-sm" data-st="${o.id}" data-to="${s}" data-mail="${o.customerEmail ? '1' : ''}">${s === 'cancelled' ? 'Cancel order' : `Mark ${STATUS_LABEL[s]!.toLowerCase()}`}</button>`)}</div></div>`;
      mount(host, rows.length ? html`<p class="muted small" style="margin-bottom:12px">Orders marked Paid online were paid by card through Paystack; the money goes to your payout account. Other orders are requests you settle with the customer. When you change the status the customer is emailed if they gave an address.</p>${rows.map(card)}`
        : html`<div class="card">${emptyState({ icon: 'shopping-bag', title: 'No orders yet', text: 'Order requests from your booking page appear here, and we email you when one arrives.' })}</div>`);
      host.querySelectorAll<HTMLButtonElement>('[data-delorder]').forEach((b) => b.addEventListener('click', async () => {
        const paid = b.dataset.paid === '1';
        if (!await confirmDialog({ title: `Delete order ${b.dataset.ref}?`, message: paid ? 'This order was paid online and has not been refunded. Deleting it does not refund the customer; the payment record stays with your payments. A line is kept in the audit log.' : 'It disappears from your orders. A line is kept in the audit log.', confirmLabel: 'Delete order', danger: true })) return;
        try { await api(`/api/shop/orders/${b.dataset.delorder}`, { method: 'DELETE' }); toast('Order deleted', 'success'); void orders(); } catch (e) { toast(errMsg(e, 'Could not delete the order'), 'error'); }
      }));
      host.querySelectorAll<HTMLButtonElement>('[data-refund]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Refund this order?', message: 'The customer is refunded in full through Paystack, the order is cancelled and they are emailed. This cannot be undone.', confirmLabel: 'Refund and cancel', danger: true })) return;
        try { await api(`/api/shop/orders/${b.dataset.refund}/refund`, { method: 'POST' }); toast('Refunded. The customer has been emailed.', 'success'); void orders(); } catch (e) { toast(errMsg(e, 'Could not refund the order'), 'error'); }
      }));
      host.querySelectorAll<HTMLButtonElement>('[data-st]').forEach((b) => b.addEventListener('click', async () => {
        const to = b.dataset.to!;
        if (to === 'cancelled' && !await confirmDialog({ title: 'Cancel this order?', message: 'The customer will be emailed that it was cancelled.', confirmLabel: 'Cancel order', danger: true })) return;
        try {
          const r = await api<{ customerEmailed: boolean | null }>(`/api/shop/orders/${b.dataset.st}/status`, { method: 'POST', body: { status: to, hasEmail: b.dataset.mail === '1' } });
          toast(r.customerEmailed === true ? 'Updated. The customer has been emailed.' : r.customerEmailed === null ? 'Updated. This customer gave no email, so tell them yourself.' : 'Updated, but the email to the customer could not be sent. Please tell them yourself.', r.customerEmailed === false ? 'error' : 'success');
          void orders();
        } catch (e) { toast(errMsg(e, 'Could not update the order'), 'error'); }
      }));
    } catch (e) { mount(host, fail(host, e, () => void orders(), 'Could not load your orders')); }
  };
  draw();
}
