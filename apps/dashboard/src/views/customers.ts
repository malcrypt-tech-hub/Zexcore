import { html, mount, $ } from '../lib/html';
import { ic } from '../lib/icons';
import { api, ApiError } from '../lib/api';
import { money, initials, ago } from '../lib/format';
import { emptyState, errorState, skeletonRows } from '../lib/ui';
import { navigate } from '../router';

interface Cust { phone: string; name: string; email: string | null; bookings: number; enquiries: number; orders: number; completed: number; noShows: number; depositsMinor: number; lastVisit: string }

export async function renderCustomers(view: HTMLElement): Promise<void> {
  mount(view, html`<div class="page-head"><div><h1>Customers</h1><p>Everyone who has booked, sent an enquiry or ordered, built automatically.</p></div></div>
    <div class="input-icon" style="margin-bottom:12px">${ic('search')}<input class="input" id="cq" type="search" placeholder="Search by name or phone" aria-label="Search customers"></div>
    <div class="card" id="cl"></div>`);
  const host = $('#cl', view)!;
  const load = async (q = '') => {
    mount(host, skeletonRows(4));
    try {
      const r = await api<{ customers: Cust[] }>(`/api/bookings/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      if (!r.customers.length) { mount(host, emptyState({ icon: 'users', title: q ? 'No matches' : 'No customers yet', text: q ? 'Try another name or number.' : 'Customers are added automatically when they book, send an enquiry or order.' })); return; }
      mount(host, html`<div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Bookings</th><th>Enquiries</th><th>Orders</th><th>No-shows</th><th>Deposits paid</th><th>Last activity</th><th></th></tr></thead><tbody>
        ${r.customers.map((c) => html`<tr><td><div class="row"><span class="avatar">${initials(c.name)}</span><div><b>${c.name}</b><div class="muted small mono">${c.phone}</div></div></div></td><td class="num">${c.bookings}</td><td class="num">${c.enquiries}</td><td class="num">${c.orders}</td><td class="num">${c.noShows}</td><td class="num">${money(c.depositsMinor)}</td><td class="muted">${ago(c.lastVisit)}</td><td class="t-right"><button class="btn btn-secondary btn-sm" data-msg="${c.phone}">${ic('message-square', 'ico-sm')} Message</button></td></tr>`)}</tbody></table></div>`);
      host.querySelectorAll<HTMLElement>('[data-msg]').forEach((b) => b.addEventListener('click', () => navigate(`/app/messages?phone=${encodeURIComponent(b.dataset.msg!)}`)));
    } catch (e) { mount(host, errorState(e instanceof ApiError ? e.message : 'Could not load customers')); $('[data-retry]', host)?.addEventListener('click', () => void load(q)); }
  };
  let t: number | undefined;
  $('#cq', view)!.addEventListener('input', (e) => { clearTimeout(t); t = window.setTimeout(() => void load((e.target as HTMLInputElement).value.trim()), 300); });
  await load();
}
