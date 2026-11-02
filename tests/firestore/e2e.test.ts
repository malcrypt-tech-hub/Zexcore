// End-to-end: the real dashboard data layer (apps/dashboard/src/lib/fb) against the real security rules, in the emulators.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { emulatorBase, installWorker, WORKER_URL } from './worker-harness';

vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-zexcore');
vi.stubEnv('VITE_FIREBASE_API_KEY', 'demo-key');
vi.stubEnv('VITE_FIREBASE_APP_ID', '1:1:web:demo');
installWorker();

type Mod<T> = T extends Promise<infer U> ? U : never;
let auth: Mod<ReturnType<typeof loadAuth>>, cat: Mod<ReturnType<typeof loadCat>>, bk: Mod<ReturnType<typeof loadBk>>;
let pub: Mod<ReturnType<typeof loadPub>>, crm: Mod<ReturnType<typeof loadCrm>>, core: Mod<ReturnType<typeof loadCore>>, bill: Mod<ReturnType<typeof loadBill>>;
const loadAuth = () => import('../../apps/dashboard/src/lib/fb/auth');
const loadCat = () => import('../../apps/dashboard/src/lib/fb/catalog');
const loadBk = () => import('../../apps/dashboard/src/lib/fb/bookings');
const loadPub = () => import('../../apps/dashboard/src/lib/fb/public');
const loadCrm = () => import('../../apps/dashboard/src/lib/fb/crm');
const loadCore = () => import('../../apps/dashboard/src/lib/fb/core');
const loadBill = () => import('../../apps/dashboard/src/lib/fb/billing');

const email = `sade${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery';
const BIZ = `Sade Salon e2e ${Date.now().toString(36)}`;
let slug = '';

/** Next open weekday (not Sunday) at least two days out, as YYYY-MM-DD in Lagos time. */
function openDate(plusDays = 2): string {
  for (let i = plusDays; i < plusDays + 8; i++) {
    const d = new Date(Date.now() + i * 86_400_000 + 3_600_000);
    if (d.getUTCDay() !== 0) return d.toISOString().slice(0, 10);
  }
  throw new Error('no open day');
}
const code = async (p: Promise<unknown>): Promise<string | number | undefined> => { try { await p; return undefined; } catch (e: any) { return e.code ?? e.status; } };

beforeAll(async () => {
  const fbm = await import('../../apps/dashboard/src/lib/fb/firebase');
  fbm.useEmulators();
  [auth, cat, bk, pub, crm, core, bill] = await Promise.all([loadAuth(), loadCat(), loadBk(), loadPub(), loadCrm(), loadCore(), loadBill()]);
});

describe('dashboard on Firebase, end to end', () => {
  it('signs a business up and creates its workspace, owner row, slug and first calendar', async () => {
    await auth.register({ tenantName: BIZ, name: 'Sade Ade', email, password: PASSWORD });
    const me: any = await auth.me();
    slug = me.tenant.slug;
    expect(slug).toMatch(/^sade-salon-e2e-[a-z0-9]+$/);
    expect(me.role).toBe('owner');
    expect(me.tenant.tier).toBe('free');
    const staff = await cat.listStaff(await core.loadCtx());
    expect(staff).toHaveLength(1);
    expect(staff[0]!.auto).toBe(true);
  });

  it('refuses a second business with a taken slug name by picking a different address', async () => {
    const before = slug;
    await auth.logout();
    await auth.register({ tenantName: BIZ, name: 'Other Owner', email: `other${Date.now()}@example.com`, password: PASSWORD });
    const me: any = await auth.me();
    expect(me.tenant.slug).not.toBe(before);
    await auth.logout();
    await auth.login(email, PASSWORD);
  });

  it('rejects a wrong password with a plain message', async () => {
    await auth.logout();
    await expect(auth.login(email, 'wrong-password-123')).rejects.toMatchObject({ message: 'Incorrect email or password.' });
    await auth.login(email, PASSWORD);
  });

  it('saves settings and enforces the free plan limit of 3 services', async () => {
    await cat.putSettings({ onboarded: true, publicName: BIZ, phone: '08031234567', daysOpen: [1, 2, 3, 4, 5, 6] });
    for (const n of ['Braids', 'Wash', 'Trim']) await cat.createService({ name: n, durationMin: 60, priceMinor: 1_500_000 });
    await expect(cat.createService({ name: 'Fourth', durationMin: 30, priceMinor: 0 })).rejects.toMatchObject({ status: 402, code: 'plan_limit' });
    await expect(cat.createService({ name: 'Bad length', durationMin: 25, priceMinor: 0 })).rejects.toMatchObject({ status: 400 });
    // Deposits need an amount and a verified payout account first.
    await expect(cat.putSettings({ depositEnabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(cat.putSettings({ depositEnabled: true, depositMinor: 500 })).rejects.toMatchObject({ code: 'payout_missing' });
    await expect(cat.putSettings({ depositMinor: 50 })).rejects.toMatchObject({ status: 400 });
    expect((await cat.putSettings({ depositMinor: 500, exchangeRate: 1650 })).settings).toMatchObject({ depositEnabled: false, depositMinor: 500, exchangeRate: 1650, currency: 'USD' });
    await expect(cat.putSettings({ exchangeRate: 5 })).rejects.toMatchObject({ status: 400 });
  });

  it('hands the starter calendar to the first real team member on the free plan', async () => {
    await cat.createStaff({ name: 'Ngozi', title: 'Stylist' });
    const staff = await cat.listStaff(await core.loadCtx());
    expect(staff.map((s) => s.name)).toEqual(['Ngozi']);
    await expect(cat.createStaff({ name: 'Second person' })).rejects.toMatchObject({ code: 'plan_limit' });
  });

  it('shows the public booking page to a signed-out visitor', async () => {
    await auth.logout();
    const p: any = await pub.profile(slug);
    expect(p.business.name).toBe(BIZ);
    expect(p.services).toHaveLength(3);
    expect(p.staff).toHaveLength(1);
  });

  let slot = '';
  let serviceId = '';
  it('lists open times, books one as a signed-out visitor, and then shows it as taken', async () => {
    const p: any = await pub.profile(slug);
    serviceId = p.services[0].id;
    const date = openDate();
    const before = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
    expect(before.slots.length).toBeGreaterThan(4);
    expect(before.slots.every((s) => s.available)).toBe(true);
    slot = before.slots[2]!.startsAt;
    const r: any = await pub.book(slug, { serviceId, staffId: null, customerName: 'Chidi Okeke', customerPhone: '0803 123 4567', customerEmail: null, startsAt: slot });
    expect(r.booking.ref).toMatch(/^ZX-\d{6}-\d+$/);
    expect(r.booking.status).toBe('pending');
    const after = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
    expect(after.slots.find((s) => s.startsAt === slot)!.available).toBe(false);
    expect(after.slots.filter((s) => !s.available).length).toBe(3); // a 60-minute service blocks the start before it, its own start, and the one after
  });

  it('refuses to double-book the same time', async () => {
    await expect(pub.book(slug, { serviceId, staffId: null, customerName: 'Another Person', customerPhone: '08039999999', startsAt: slot })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a booking that overlaps one cell', async () => {
    const overlapping = new Date(new Date(slot).getTime() + 30 * 60_000).toISOString();
    await expect(pub.book(slug, { serviceId, staffId: null, customerName: 'Another Person', customerPhone: '08039999999', startsAt: overlapping })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a booking with a bad phone number or in the past', async () => {
    const free = new Date(new Date(slot).getTime() + 4 * 3_600_000).toISOString();
    await expect(pub.book(slug, { serviceId, customerName: 'Chidi Okeke', customerPhone: '123', startsAt: free })).rejects.toMatchObject({ status: 400 });
    await expect(pub.book(slug, { serviceId, customerName: 'Chidi Okeke', customerPhone: '08031234567', startsAt: new Date(Math.floor((Date.now() - 3_600_000) / 900_000) * 900_000).toISOString() })).rejects.toMatchObject({ status: 409 });
  });

  it('lets the owner see, confirm, move and cancel bookings', async () => {
    await auth.login(email, PASSWORD);
    const list = await bk.listBookings(new URLSearchParams());
    expect(list.bookings).toHaveLength(1);
    const b = list.bookings[0]!;
    expect(b.customerName).toBe('Chidi Okeke');
    expect(b.customerPhone).toBe('+2348031234567');
    expect(b.staffName).toBe('Ngozi');
    expect(list.counts.pending).toBe(1);

    await bk.patchBooking(b.id, { status: 'confirmed' });
    expect((await bk.listBookings(new URLSearchParams())).bookings[0]!.status).toBe('confirmed');

    // move it two hours later, which keeps no cell in common with the old time
    const later = new Date(new Date(b.startsAt).getTime() + 2 * 3_600_000).toISOString();
    const moved = await bk.patchBooking(b.id, { startsAt: later });
    const afterMove = (await bk.listBookings(new URLSearchParams())).bookings;
    expect(afterMove).toHaveLength(1);
    expect(afterMove[0]!.id).toBe(moved.id);
    expect(afterMove[0]!.startsAt).toBe(later);

    // the old time is free again; the new one is taken
    await auth.logout();
    const date = openDate();
    const s = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
    expect(s.slots.find((x) => x.startsAt === slot)!.available).toBe(true);
    expect(s.slots.find((x) => x.startsAt === later)!.available).toBe(false);

    await auth.login(email, PASSWORD);
    await bk.patchBooking(moved.id, { status: 'cancelled' });
    await auth.logout();
    const s2 = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
    expect(s2.slots.every((x) => x.available)).toBe(true);
    await auth.login(email, PASSWORD);
  });

  it('creates a booking from the dashboard and lists customers and the home summary', async () => {
    const date = openDate(3);
    const { slots } = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
    const r = await bk.staffCreate({ serviceId, staffId: null, customerName: 'Ada Eze', customerPhone: '08051112222', startsAt: slots[1]!.startsAt, notes: 'First visit' });
    expect(r.booking.status).toBe('confirmed');
    expect(r.booking.notes).toBe('First visit');
    const c = await bk.customers(new URLSearchParams());
    expect(c.customers.map((x: any) => x.name)).toContain('Ada Eze');
    const s: any = await bk.summary();
    expect(s.setup).toMatchObject({ onboarded: true, services: 3, staff: 1 });
    expect(s.week.perDay).toHaveLength(7);
  });

  it('stops the 31st booking of the month on the free plan', async () => {
    // 1 already exists this month; fill the rest of the allowance, then expect the limit message
    const ctx = await core.loadCtx();
    let made = 0;
    for (let d = 4; d < 40 && made < 40; d++) {
      const date = openDate(d);
      const { slots } = await pub.slots(slug, new URLSearchParams({ date, serviceId }));
      for (const sl of slots.filter((x) => x.available).filter((_, i) => i % 2 === 0)) {
        const err = await code(bk.staffCreate({ serviceId, customerName: `Client ${made}`, customerPhone: `0805000${String(made).padStart(4, '0')}`, startsAt: sl.startsAt }));
        if (err) { expect(err).toBe('plan_limit'); expect(ctx.tier).toBe('free'); return; }
        made++;
      }
    }
    throw new Error('the monthly limit never applied');
  }, 120_000);

  it('manages CRM contacts, stages, leads and website pages', async () => {
    await crm.createStage({ name: 'New', position: 1, isDefault: true });
    await crm.createStage({ name: 'Proposal', position: 2 });
    const stages: any = await crm.listStages();
    expect(stages.stages.map((s: any) => s.name)).toEqual(['New', 'Proposal']);
    const { id: contactId } = await crm.createContact({ type: 'person', firstName: 'Tunde', lastName: 'Bello', email: 'tunde@example.com' });
    await expect(crm.createContact({ type: 'person' })).rejects.toMatchObject({ status: 400 });
    const { id: leadId } = await crm.createLead({ title: 'Wedding party', contactId, stageId: stages.stages[0].id, value: 5_000_000 });
    await crm.moveLead(leadId, { stageId: stages.stages[1].id });
    let leads: any = await crm.listLeads(new URLSearchParams('closed=false'));
    expect(leads.leads[0]).toMatchObject({ title: 'Wedding party', stage_id: stages.stages[1].id, first_name: 'Tunde' });
    await crm.closeLead(leadId, { reason: 'won' });
    leads = await crm.listLeads(new URLSearchParams('closed=false'));
    expect(leads.leads).toHaveLength(0);

    const { id: pageId } = await crm.createPage({ title: 'About us', slug: 'about-us', content: { body: 'Hello' } });
    await expect(crm.createPage({ title: 'Dup', slug: 'about-us' })).rejects.toMatchObject({ status: 409 });
    await crm.publishPage(pageId);
    const pages: any = await crm.listPages();
    expect(pages.pages[0]).toMatchObject({ slug: 'about-us', status: 'published' });
  });

  it('reports plan usage, plans and the audit trail; payments are read-only', async () => {
    const u: any = await bill.usage();
    expect(u.effectiveTier).toBe('free');
    expect(u.usage.services).toEqual({ used: 3, limit: 3 });
    expect(((await bill.plans()) as any).plans.map((p: any) => p.tier)).toContain('growth');
    await core.flushAudit();
    const a = await bill.auditLog();
    expect(a.entries.length).toBeGreaterThan(5);
    expect((a.entries[0] as any).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await bill.verifyAuditLog()).toMatchObject({ valid: true });
    expect((await bill.payments()).payments).toEqual([]);
  });

  it('runs the inbox: logs replies, groups by phone, tracks read state', async () => {
    const msg = await import('../../apps/dashboard/src/lib/fb/messages');
    const sent: any = await msg.send({ phone: '08011112222', name: 'Ada', body: 'See you at 10' });
    expect(sent.whatsappUrl).toBe('https://wa.me/2348011112222?text=See%20you%20at%2010');
    expect(await code(msg.send({ phone: '123', body: 'x' }))).toBe(400);
    const list: any = await msg.conversations(new URLSearchParams());
    const conv = list.conversations.find((x: any) => x.phone === '+2348011112222');
    expect(conv).toMatchObject({ name: 'Ada', lastBody: 'See you at 10', lastDirection: 'out', unread: 0 });
    const thread: any = await msg.conversation(new URLSearchParams({ phone: '+2348011112222' }));
    expect(thread.messages).toHaveLength(1);
    // the public booking made earlier is an inbound request waiting for a reply
    expect(list.counts.waiting).toBeGreaterThan(0);
    const waiting: any = await msg.conversations(new URLSearchParams({ filter: 'waiting' }));
    const w = waiting.conversations[0];
    expect(w.unread).toBeGreaterThan(0);
    await msg.markRead({ phone: w.phone });
    const after: any = await msg.conversations(new URLSearchParams());
    expect(after.conversations.find((x: any) => x.phone === w.phone).unread).toBe(0);
  });

  it('detects a tampered audit entry', async () => {
    const ctx = await core.loadCtx();
    const r = await fetch(`${emulatorBase}/workspaces/${ctx.wid}/auditChain/0000000002?updateMask.fieldPaths=action`, {
      method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { action: { stringValue: 'booking.cancelled' } } }),
    });
    expect(r.ok).toBe(true);
    expect(await bill.verifyAuditLog()).toMatchObject({ valid: false, brokenSeq: 2 });
  });

  it('cannot change its own plan from the browser', async () => {
    const { updateDoc } = await import('firebase/firestore');
    const ctx = await core.loadCtx();
    expect(await code(updateDoc(core.wsDoc(ctx), { plan: 'enterprise' }))).toBe('permission-denied');
  });
});

describe('data protection, end to end', () => {
  it('records and revokes consent, sets retention, and erases a customer', async () => {
    const comp = await import('../../apps/dashboard/src/lib/fb/compliance');
    // Data protection is Starter-and-above.
    await setPlan('starter');
    await comp.recordConsent({ subjectId: '0803 123 4567', purpose: 'Appointment reminders', legalBasis: 'consent' });
    expect(await code(comp.recordConsent({ subjectId: 'nonsense', purpose: 'x1' }))).toBe(400);
    let c: any = await comp.listConsent('08031234567');
    expect(c.consents).toHaveLength(1);
    expect(c.consents[0]).toMatchObject({ purpose: 'Appointment reminders', legal_basis: 'consent', revoked_at: null });
    await comp.revokeConsent({ subjectId: '08031234567', purpose: 'Appointment reminders' });
    c = await comp.listConsent('08031234567');
    expect(c.consents[0].revoked_at).not.toBeNull();

    await comp.setRetention({ entity: 'messages', retentionDays: 365, enabled: true });
    expect(await code(comp.setRetention({ entity: 'passwords', retentionDays: 1 }))).toBe(400);
    expect((await comp.listRetention() as any).policies[0]).toMatchObject({ entity: 'messages', retention_days: 365, enabled: true });
    expect(await comp.runRetention()).toEqual({ summary: [{ entity: 'messages', purged: 0 }] });

    const req = await comp.createErasure({ subjectId: '08031234567', reason: 'Customer asked' });
    const done: any = await comp.executeErasure(req.id);
    expect(done.summary.bookings).toBeGreaterThan(0);
    expect(done.summary.consents).toBe(1);
    const list: any = await bk.listBookings(new URLSearchParams({ limit: '500' }));
    expect(list.bookings.some((b: any) => b.customerPhone === '+2348031234567')).toBe(false);
    expect(list.bookings.some((b: any) => b.customerName === 'Erased customer')).toBe(true);
    expect(await code(comp.executeErasure(req.id))).toBe(409);
    expect((await comp.listErasures() as any).requests[0].status).toBe('completed');
    await core.flushAudit();
    expect(((await comp.accessLogs(new URLSearchParams())) as any).accessLogs.length).toBeGreaterThan(0);
  });
});

/** Changes the plan the way only the Worker can: through the emulator's admin access. */
async function setPlan(plan: string): Promise<void> {
  const ctx = await core.loadCtx();
  const r = await fetch(`${emulatorBase}/workspaces/${ctx.wid}?updateMask.fieldPaths=plan`, { method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { plan: { stringValue: plan } } }) });
  expect(r.ok).toBe(true);
  await core.loadCtx(true);
}

describe('devices and automations, end to end', () => {
  it('registers a device, ingests readings through the Worker, raises an alert and runs an approved rule', async () => {
    const iot = await import('../../apps/dashboard/src/lib/fb/iot');
    const rl = await import('../../apps/dashboard/src/lib/fb/rules');
    // Devices and automations are Growth-and-above: refused on the free plan, up front by requireFeature.
    expect(await code(iot.createDevice({ name: 'Blocked', deviceKey: 'blocked-1', kind: 'x' }))).toBe('plan_feature');
    expect(await code(rl.createRule({ name: 'Blocked', trigger: { source: 'event:iot.reading' }, actions: [{ type: 'notify', message: 'x' }] }))).toBe('plan_limit');
    await setPlan('growth');
    const ctx = await core.loadCtx(true);
    const made: any = await iot.createDevice({ name: 'Cold room', deviceKey: 'cold-room-1', kind: 'temperature_sensor' });
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await code(iot.createDevice({ name: 'Dup', deviceKey: 'cold-room-1', kind: 'x' }))).toBe('conflict');
    const devId = made.device.id;
    await iot.createAlertRule({ deviceId: devId, metric: 'temperature', op: 'gt', threshold: 8, severity: 'high', message: 'Cold room too warm' });

    // automations: a draft does nothing until an admin approves it
    expect(await code(rl.createRule({ name: 'x', trigger: { source: 'event:nonsense' }, actions: [] }))).toBe(400);
    expect(await code(rl.createRule({ name: 'Bad hook', trigger: { source: 'event:iot.reading' }, actions: [{ type: 'webhook', url: 'http://127.0.0.1/x' }] }))).toBe(400);
    const rule: any = await rl.createRule({ name: 'Hot reading', trigger: { source: 'event:iot.reading' }, conditions: { field: 'metrics.temperature', op: 'gt', value: 8 }, actions: [{ type: 'notify', message: '{{device.name}} is at {{metrics.temperature}}' }] });
    expect((await rl.testRun(rule.id, { payload: { metrics: { temperature: 9 } } })) as any).toMatchObject({ wouldExecute: true });
    expect((await rl.testRun(rule.id, { payload: { metrics: { temperature: 5 } } })) as any).toMatchObject({ conditionsPassed: false, wouldExecute: false });

    const send = (token: string, metrics: object, tenant = ctx.wid) => fetch(`${WORKER_URL}/api/iot/ingest`, { method: 'POST', headers: { 'x-tenant-id': tenant, 'x-device-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ metrics }) });
    expect((await send('0'.repeat(64), { temperature: 4 })).status).toBe(401);
    expect((await send(made.token, { 'bad name': 1 })).status).toBe(400);
    const first = await send(made.token, { temperature: 9.5, door: 'closed' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ok: true, alertsFired: 1 });
    expect((await send(made.token, { temperature: 9.6 })).status).toBe(429);

    const alerts: any = await iot.recentAlerts();
    expect(alerts.alerts[0]).toMatchObject({ device_name: 'Cold room', severity: 'high', message: 'Cold room too warm' });
    expect(((await iot.latest()) as any).latest[0].metrics).toMatchObject({ temperature: 9.5 });
    expect(((await iot.listDevices()) as any).devices[0].status).toBe('online');

    // not approved yet: nothing ran. Approve, send again, and the run is recorded.
    expect(((await rl.runs()) as any).runs).toHaveLength(0);
    await rl.approveRule(rule.id);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await send(made.token, { temperature: 12 })).status).toBe(201);
    const runs: any = await rl.runs();
    expect(runs.runs[0]).toMatchObject({ rule: 'Hot reading', outcome: 'ok' });
    expect(runs.runs[0].detail).toContain('Cold room is at 12');

    // a rotated token replaces the old one
    const rotated = await iot.rotateToken(devId);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await send(made.token, { temperature: 4 })).status).toBe(401);
    expect((await send(rotated.token, { temperature: 4 })).status).toBe(201);
    // one workspace's device token never works against another
    expect((await send(rotated.token, { temperature: 4 }, 'AAAAAAAAAAAAAAAAAAAA')).status).toBe(401);

    // the booking page tells the Worker about a public booking exactly once
    const list: any = await bk.listBookings(new URLSearchParams({ limit: '5' }));
    const pubBooking = list.bookings.find((b: any) => b.source === 'public');
    if (pubBooking) {
      const body = JSON.stringify({ slug: ctx.slug, bookingId: pubBooking.id });
      const again = await fetch(`${WORKER_URL}/api/public/booked`, { method: 'POST', body });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ duplicate: true });
    }
    await iot.removeDevice(devId);
    expect(((await iot.listDevices()) as any).devices).toHaveLength(0);
  });
});
