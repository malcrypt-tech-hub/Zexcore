/** The shop section of a booking page: pick goods and quantities, give a delivery address, send an order request. Nothing is charged. */
import { html, mount, $, $$, type Raw } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { busy, toast } from '../lib/ui';
import { thumb } from '../lib/fb/shop';

export interface ShopProduct { id: string; name: string; description: string | null; priceMinor: number; inStock: boolean; imageUrl: string | null }
export interface ShopCtx { slug: string; businessName: string; phone: string | null; products: ShopProduct[]; priceText: (usdMinor: number) => string; header: () => Raw; tabs: () => Raw; onTabs: () => void }

const MAX_QTY = 99;

export function createShop(root: HTMLElement, x: ShopCtx): () => void {
  const cart = new Map<string, number>();
  const f = { name: '', phone: '', email: '', address: '', notes: '' };
  const total = (): number => x.products.reduce((n, p) => n + p.priceMinor * (cart.get(p.id) ?? 0), 0);
  const count = (): number => [...cart.values()].reduce((a, b) => a + b, 0);

  const done = (ref: string): void => {
    mount(root, html`<div class="public-wrap">${x.header()}
      <div class="receipt"><span class="icon-tile" style="margin:0 auto 12px;background:var(--success);color:#fff;border-radius:50%">${ic('check')}</span>
        <h2>Order request sent</h2><p class="muted" style="margin:6px 0 18px">${x.businessName} will contact you to confirm your order, the final price and how to pay. Nothing has been charged.</p>
        <div class="booking-meta" style="text-align:left"><div class="l"><span class="muted">Reference</span><span class="ref">${ref}</span></div></div>
        <p class="muted small" style="margin-top:16px">Save your reference. ${x.phone ? html`Questions? Call <a href="tel:${x.phone}" style="text-decoration:underline">${x.phone}</a>.` : ''}</p></div></div>`);
  };

  const draw = (): void => {
    mount(root, html`<div class="public-wrap">${x.header()}${x.tabs()}
      <section class="pub-section"><h2 style="margin-top:8px">1. Choose what you want</h2>
        <div class="stack-sm">${x.products.map((p) => html`<div class="card card-pad row" style="gap:12px;align-items:center">
          ${thumb(p.imageUrl, 160) ? html`<img src="${thumb(p.imageUrl, 160)!}" alt="" width="64" height="64" loading="lazy" style="border-radius:10px;object-fit:cover;flex:none">` : ''}
          <div class="grow"><b>${p.name}</b>${p.description ? html`<div class="muted small">${p.description}</div>` : ''}<div>${x.priceText(p.priceMinor)}</div></div>
          ${p.inStock ? html`<div class="row" style="gap:6px;align-items:center"><button type="button" class="btn btn-secondary btn-sm" data-dec="${p.id}" aria-label="One less ${p.name}">−</button><b class="num" style="min-width:20px;text-align:center" aria-live="polite">${cart.get(p.id) ?? 0}</b><button type="button" class="btn btn-secondary btn-sm" data-inc="${p.id}" aria-label="One more ${p.name}">+</button></div>` : html`<span class="muted small">Out of stock</span>`}</div>`)}</div></section>
      <section class="pub-section"><h2>2. Your details</h2>
        <div id="oerr" class="alert alert-error hidden" role="alert"></div>
        <div class="form-grid two"><div class="field"><label for="on">Full name</label><input class="input" id="on" autocomplete="name" maxlength="120" value="${f.name}"></div>
          <div class="field"><label for="op">Phone / WhatsApp</label><input class="input" id="op" type="tel" autocomplete="tel" placeholder="0803 123 4567" value="${f.phone}"></div></div>
        <div class="field"><label for="oe">Email <span class="faint">(optional, for order updates)</span></label><input class="input" id="oe" type="email" autocomplete="email" maxlength="160" value="${f.email}"></div>
        <div class="field"><label for="oa">Delivery address</label><textarea class="input" id="oa" rows="3" maxlength="400" autocomplete="street-address">${f.address}</textarea></div>
        <div class="field"><label for="ox">Notes <span class="faint">(optional)</span></label><input class="input" id="ox" maxlength="500" value="${f.notes}"></div></section>
      <div class="card card-pad" style="position:sticky;bottom:8px"><div class="row between" style="align-items:center;gap:12px"><div><b>${count()} item${count() === 1 ? '' : 's'}</b><div class="muted small">${count() ? x.priceText(total()) : 'Nothing chosen yet'}</div></div>
        <button type="button" class="btn btn-primary btn-lg" id="osend" ${count() ? '' : 'disabled'}>Send order request</button></div>
        <p class="muted small" style="margin:8px 0 0">This sends a request. You are not charged online: the business confirms the order and agrees payment with you.</p></div></div>`);
    const keep = (): void => { f.name = ($('#on') as HTMLInputElement).value; f.phone = ($('#op') as HTMLInputElement).value; f.email = ($('#oe') as HTMLInputElement).value; f.address = ($('#oa') as HTMLTextAreaElement).value; f.notes = ($('#ox') as HTMLInputElement).value; };
    ['#on', '#op', '#oe', '#oa', '#ox'].forEach((s) => $(s)!.addEventListener('input', keep));
    const bump = (id: string, d: number): void => { keep(); const n = Math.max(0, Math.min(MAX_QTY, (cart.get(id) ?? 0) + d)); if (n) cart.set(id, n); else cart.delete(id); const y = window.scrollY; draw(); window.scrollTo(0, y); };
    $$('[data-inc]').forEach((b) => b.addEventListener('click', () => bump(b.dataset.inc!, 1)));
    $$('[data-dec]').forEach((b) => b.addEventListener('click', () => bump(b.dataset.dec!, -1)));
    x.onTabs();
    $('#osend')!.addEventListener('click', (e) => void busy(e.currentTarget as HTMLButtonElement, async () => {
      keep();
      const box = $('#oerr')!; box.classList.add('hidden');
      try {
        const r = await api<{ ref: string }>(`/api/public/${encodeURIComponent(x.slug)}/orders`, { method: 'POST', auth: false, body: { name: f.name, phone: f.phone, email: f.email, address: f.address, notes: f.notes, items: [...cart].map(([id, qty]) => ({ id, qty })) } });
        done(r.ref);
      } catch (err) {
        const m = err instanceof ApiError ? err.message : 'Could not send your order. Please try again.';
        box.textContent = m; box.classList.remove('hidden'); box.scrollIntoView({ block: 'center' }); toast(m, 'error');
      }
    }));
  };
  return draw;
}
