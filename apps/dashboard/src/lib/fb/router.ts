import { worker } from './worker';
import { ApiError, toApiError, loadCtx } from './core';
import { fb } from './firebase';
import * as authApi from './auth';
import * as cat from './catalog';
import * as iot from './iot';
import * as rl from './rules';
import * as comp from './compliance';
import * as msg from './messages';
import * as bk from './bookings';
import * as pub from './public';
import * as crm from './crm';
import * as bill from './billing';
import * as appt from './appointments';
import * as payout from './payout';
import * as team from './team';
import * as keys from './apikeys';
import * as wl from './waitlist';
import * as shop from './shop';
import * as nt from './notify';
import * as ins from './insights';
import { getLiveNgnRate } from '../fx';

type Params = string[];
interface Req { method: string; params: Params; query: URLSearchParams; body: Record<string, any> }
type Handler = (r: Req) => Promise<unknown> | unknown;

const routes: { method: string; re: RegExp; run: Handler }[] = [];
const on = (method: string, path: string, run: Handler): void => {
  routes.push({ method, re: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), run });
};

// ── auth ──
on('POST', '/api/auth/register', async ({ body }) => { await authApi.register(body as never); return { token: 'firebase' }; });
on('POST', '/api/auth/login', async ({ body }) => { await authApi.login(body.email, body.password); return { token: 'firebase' }; });
on('POST', '/api/auth/logout', async () => { await authApi.logout(); return { ok: true }; });
on('GET', '/api/auth/me', async () => authApi.me());
on('POST', '/api/auth/password/forgot', async ({ body }) => { await authApi.forgot(body.email); return { ok: true }; });
on('POST', '/api/auth/password/reset', async ({ body }) => { await authApi.reset(body.token, body.password); return { ok: true }; });
on('POST', '/api/auth/password/change', async ({ body }) => { await authApi.changePassword(body.currentPassword, body.newPassword); return { token: 'firebase' }; });
on('POST', '/api/auth/email/verify', async ({ body }) => { await authApi.verifyEmail(body.token); return { ok: true }; });
on('GET', '/api/auth/email/status', () => authApi.emailStatus());
on('POST', '/api/auth/email/resend', async () => { await authApi.resendVerification(); return { ok: true }; });
// Security Watch: devices come from the Worker's record of sign-ins; Firebase cannot end one device's session on its own, so the only sign-out is "everywhere".
on('GET', '/api/security/devices', () => worker('/api/security/devices'));
on('POST', '/api/security/revoke-all', () => worker('/api/security/revoke-all', { method: 'POST', body: {} }));

on('GET', '/api/account/method', () => ({ method: authApi.signInMethod() }));
on('POST', '/api/account/delete', async ({ body }) => { await authApi.deleteAccount(body.password, String(body.confirm ?? '')); return { ok: true }; });

// ── workspace catalog ──
on('GET', '/api/bookings/settings', () => cat.getSettings());
on('PUT', '/api/bookings/settings', ({ body }) => cat.putSettings(body));
on('GET', '/api/bookings/services', async () => ({ services: await cat.listServices(await loadCtx()) }));
on('POST', '/api/bookings/services', ({ body }) => cat.createService(body));
on('PATCH', '/api/bookings/services/:id', ({ params, body }) => cat.patchService(params[0]!, body));
on('DELETE', '/api/bookings/services/:id', ({ params }) => cat.deleteService(params[0]!));
on('GET', '/api/bookings/staff', async () => ({ staff: await cat.listStaff(await loadCtx()) }));
on('POST', '/api/bookings/staff', ({ body }) => cat.createStaff(body));
on('PATCH', '/api/bookings/staff/:id', ({ params, body }) => cat.patchStaff(params[0]!, body));

// ── bookings ──
on('GET', '/api/bookings/summary', () => bk.summary());
on('GET', '/api/bookings/customers', ({ query }) => bk.customers(query));
on('GET', '/api/bookings', ({ query }) => bk.listBookings(query));
on('POST', '/api/bookings', ({ body }) => bk.staffCreate(body));
on('PATCH', '/api/bookings/:id', ({ params, body }) => bk.patchBooking(params[0]!, body));
on('POST', '/api/bookings/:id/payment-link', ({ params, body }) => bk.paymentLink(params[0]!, body));
on('POST', '/api/bookings/:id/refund', ({ params }) => bk.refundDeposit(params[0]!));
on('GET', '/api/payout', () => payout.getPayout());
on('GET', '/api/payout/banks', () => payout.listBanks());
on('POST', '/api/payout', ({ body }) => payout.savePayout(body));
on('GET', '/api/bookings/conversations', ({ query }) => msg.conversations(query));
on('GET', '/api/bookings/conversation', ({ query }) => msg.conversation(query));
on('POST', '/api/bookings/conversation/read', ({ body }) => msg.markRead(body));
on('POST', '/api/bookings/messages', ({ body }) => msg.send(body));

// ── public booking page ──
on('GET', '/api/public/:slug', ({ params }) => pub.profile(params[0]!));
on('GET', '/api/public/:slug/availability', ({ params, query }) => pub.slots(params[0]!, query));
on('POST', '/api/public/:slug/bookings', ({ params, body }) => pub.book(params[0]!, body));
on('POST', '/api/public/:slug/waitlist', ({ params, body }) => pub.joinWaitlist(params[0]!, body));
on('GET', '/api/public/:slug/payments/:ref', ({ params }) => pub.payment(params[0]!, params[1]!));

// ── CRM + website pages ──
on('GET', '/api/crm/stages', () => crm.listStages());
on('POST', '/api/crm/stages', ({ body }) => crm.createStage(body));
on('GET', '/api/crm/contacts', ({ query }) => crm.listContacts(query));
on('POST', '/api/crm/contacts', ({ body }) => crm.createContact(body));
on('GET', '/api/crm/leads', ({ query }) => crm.listLeads(query));
on('POST', '/api/crm/leads', ({ body }) => crm.createLead(body));
on('PATCH', '/api/crm/leads/:id/move', ({ params, body }) => crm.moveLead(params[0]!, body));
on('PATCH', '/api/crm/leads/:id/close', ({ params, body }) => crm.closeLead(params[0]!, body));
on('GET', '/api/cms/pages', () => crm.listPages());
on('POST', '/api/cms/pages', ({ body }) => crm.createPage(body));
on('POST', '/api/cms/pages/:id/publish', ({ params }) => crm.publishPage(params[0]!));

// ── team access ──
on('GET', '/api/team', () => team.listTeam());
on('POST', '/api/team/invite', ({ body }) => team.invite(body));
on('POST', '/api/team/revoke', ({ body }) => team.revokeInvite(String(body.id)));
on('POST', '/api/team/role', ({ body }) => team.setRole(String(body.uid), String(body.role)));
on('GET', '/api/insights', ({ query }) => ins.get(Number(query.get('days'))));
on('GET', '/api/notifications', () => nt.notifications());
on('POST', '/api/notifications/seen', async ({ body }) => { const k = body?.kind; await nt.markSeen(k === 'orders' || k === 'enquiries' ? k : 'bookings'); return { ok: true }; });
on('GET', '/api/shop/products', () => shop.listProducts());
on('POST', '/api/shop/products', ({ body }) => shop.createProduct(body));
on('PATCH', '/api/shop/products/:id', ({ params, body }) => shop.patchProduct(params[0]!, body));
on('DELETE', '/api/shop/products/:id', ({ params }) => shop.removeProduct(params[0]!));
on('GET', '/api/shop/orders', () => shop.listOrders());
on('POST', '/api/shop/orders/:id/status', ({ params, body }) => shop.setOrderStatus(params[0]!, String(body.status ?? ''), body.hasEmail === true));
on('POST', '/api/public/:slug/orders', ({ params, body }) => pub.placeOrder(params[0]!, body));
on('GET', '/api/waitlist', () => wl.overview());
on('DELETE', '/api/waitlist/:id', async ({ params }) => { await wl.removeEntry(params[0]!); return { ok: true }; });
on('GET', '/api/keys', async () => ({ keys: await keys.listKeys() }));
on('POST', '/api/keys', ({ body }) => keys.createKey(String(body.name ?? '')));
on('POST', '/api/keys/revoke', async ({ body }) => { await keys.revokeKey(String(body.id)); return { ok: true }; });
on('POST', '/api/team/remove', ({ body }) => team.removeMember(String(body.uid)));

// ── calendar appointments ──
on('GET', '/api/appointments', ({ query }) => appt.list(String(query.get('from')), String(query.get('to'))));
on('GET', '/api/appointments/pinned', () => appt.pinned());
on('POST', '/api/appointments', ({ body }) => appt.create(body));
on('PATCH', '/api/appointments/:id', ({ params, body }) => appt.update(params[0]!, body));
on('POST', '/api/appointments/:id/flag', ({ params, body }) => appt.flag(params[0]!, body));
on('DELETE', '/api/appointments/:id', ({ params }) => appt.remove(params[0]!));

// ── billing + audit ──
on('GET', '/api/rates', async () => ({ base: 'USD', target: 'NGN', rate: await getLiveNgnRate(), updatedAt: new Date().toISOString() }));
on('GET', '/api/billing/plans', () => bill.plans());
on('GET', '/api/billing/usage', () => bill.usage());
on('POST', '/api/billing/checkout', ({ body }) => bill.checkout(body));
on('GET', '/api/billing/payments', () => bill.payments());
on('GET', '/api/audit-log', () => bill.auditLog());
on('GET', '/api/audit-log/verify', () => bill.verifyAuditLog());

// ── data protection ──
on('GET', '/api/compliance/retention', () => comp.listRetention());
on('POST', '/api/compliance/retention', ({ body }) => comp.setRetention(body));
on('POST', '/api/compliance/retention/run', () => comp.runRetention());
on('GET', '/api/compliance/erasure', () => comp.listErasures());
on('POST', '/api/compliance/erasure', ({ body }) => comp.createErasure(body));
on('POST', '/api/compliance/erasure/:id/execute', ({ params }) => comp.executeErasure(params[0]!));
on('POST', '/api/compliance/access-request', ({ body }) => comp.accessRequest(body));
on('GET', '/api/compliance/breaches', () => comp.listBreaches());
on('POST', '/api/compliance/breaches', ({ body }) => comp.logBreach(body));
on('POST', '/api/compliance/breaches/:id', ({ params, body }) => comp.updateBreach(params[0]!, body));
on('POST', '/api/compliance/consent', ({ body }) => comp.recordConsent(body));
on('POST', '/api/compliance/consent/revoke', ({ body }) => comp.revokeConsent(body));
on('GET', '/api/compliance/consent/:subject', ({ params }) => comp.listConsent(params[0]!));
on('GET', '/api/compliance/access-logs', ({ query }) => comp.accessLogs(query));

// ── devices ──
on('GET', '/api/iot/devices', () => iot.listDevices());
on('POST', '/api/iot/devices', ({ body }) => iot.createDevice(body));
on('PATCH', '/api/iot/devices/:id', ({ params, body }) => iot.patchDevice(params[0]!, body));
on('POST', '/api/iot/devices/:id/rotate-token', ({ params }) => iot.rotateToken(params[0]!));
on('DELETE', '/api/iot/devices/:id', ({ params }) => iot.removeDevice(params[0]!));
on('GET', '/api/iot/telemetry/latest', () => iot.latest());
on('GET', '/api/iot/alerts', () => iot.listAlertRules());
on('POST', '/api/iot/alerts', ({ body }) => iot.createAlertRule(body));
on('DELETE', '/api/iot/alerts/:id', ({ params }) => iot.removeAlertRule(params[0]!));
on('GET', '/api/iot/alert-events', () => iot.recentAlerts());

// ── automations ──
on('GET', '/api/rules', () => rl.listRules());
on('POST', '/api/rules', ({ body }) => rl.createRule(body));
on('GET', '/api/rules/runs', () => rl.runs());
on('POST', '/api/rules/:id/approve', ({ params }) => rl.approveRule(params[0]!));
on('POST', '/api/rules/:id/disable', ({ params }) => rl.setEnabled(params[0]!, false));
on('POST', '/api/rules/:id/enable', ({ params }) => rl.setEnabled(params[0]!, true));
on('POST', '/api/rules/:id/test-run', ({ params, body }) => rl.testRun(params[0]!, body));
on('DELETE', '/api/rules/:id', ({ params }) => rl.removeRule(params[0]!));

export async function dispatch(path: string, method: string, body: unknown): Promise<unknown> {
  const url = new URL(path, 'https://zexcore.local');
  const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
  if (!route) throw new ApiError(404, 'Not found', 'not_found');
  const params = (route.re.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);
  try {
    fb(); // fails fast with a clear message when the Firebase settings are missing
    return await route.run({ method, params, query: url.searchParams, body: (body ?? {}) as Record<string, any> });
  } catch (e) { throw toApiError(e); }
}
