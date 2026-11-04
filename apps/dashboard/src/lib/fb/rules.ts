import { deleteDoc, getDocs, limit as qLimit, orderBy, query, updateDoc } from 'firebase/firestore';
import { cleanRule, evaluate, sourceOf, type RuleDef } from '../../../../../shared/rules-engine';
import { ApiError, audit, claimSlot, iso, loadCtx, requireAdmin, requireFeature, wsCol, wsDoc } from './core';
import { worker } from './worker';

const dto = (id: string, x: Record<string, any>) => ({
  id, name: x.name, description: x.description ?? null, enabled: x.enabled === true, approved: x.approved === true,
  trigger: x.trigger, conditions: x.conditions ?? null, actions: x.actions ?? [],
});

export async function listRules(): Promise<{ rules: unknown[] }> {
  const c = await loadCtx();
  const s = await getDocs(query(wsCol(c, 'rules'), orderBy('seq'), qLimit(200)));
  return { rules: s.docs.map((d) => dto(d.id, d.data())) };
}

export async function createRule(b: Record<string, unknown>): Promise<{ id: string }> {
  const c = await loadCtx();
  const r = cleanRule(b);
  if (!r.ok) throw new ApiError(400, r.error);
  const description = String(b.description ?? '').trim().slice(0, 255);
  const id = await claimSlot(c, 'rules', 'r', 'rules', { ...r.rule, description, enabled: false, approved: false, createdBy: c.uid });
  void audit(c, 'rule.create', 'rule', id);
  return { id };
}

export async function approveRule(id: string): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'automations');
  await updateDoc(wsDoc(c, 'rules', id), { approved: true, enabled: true, approvedBy: c.uid });
  void audit(c, 'rule.approve', 'rule', id);
  return { ok: true };
}
export async function setEnabled(id: string, enabled: boolean): Promise<{ ok: true }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'automations');
  await updateDoc(wsDoc(c, 'rules', id), { enabled });
  void audit(c, enabled ? 'rule.enable' : 'rule.disable', 'rule', id);
  return { ok: true };
}
export async function removeRule(id: string): Promise<{ ok: true }> {
  const c = await loadCtx();
  await deleteDoc(wsDoc(c, 'rules', id));
  void audit(c, 'rule.delete', 'rule', id);
  return { ok: true };
}

/** Dry run with the same engine the Worker uses. Nothing is executed. */
export async function testRun(id: string, b: Record<string, unknown>): Promise<unknown> {
  const c = await loadCtx();
  const s = (await getDocs(wsCol(c, 'rules'))).docs.find((d) => d.id === id);
  if (!s) throw new ApiError(404, 'That rule no longer exists.');
  const def: RuleDef = { trigger: s.data().trigger, conditions: s.data().conditions ?? null, actions: s.data().actions ?? [] };
  return evaluate(def, sourceOf(def.trigger), b.payload ?? {});
}

export async function runs(): Promise<{ runs: unknown[] }> {
  const c = await loadCtx(); requireAdmin(c); requireFeature(c, 'automations');
  const s = await getDocs(query(wsCol(c, 'automationRuns'), orderBy('at', 'desc'), qLimit(30)));
  return { runs: s.docs.map((d) => ({ id: d.id, rule: d.data().ruleName, event: d.data().event, outcome: d.data().outcome, detail: d.data().detail, at: iso(d.data().at) })) };
}

/** Tells the Worker something happened so approved rules can react. Never blocks or fails the action itself. */
export function emit(event: 'bookings.booking.created' | 'bookings.booking.cancelled' | 'crm.lead.created', wid: string, id: string): void {
  void worker('/api/events', { body: { workspaceId: wid, event, id } }).catch(() => undefined);
}
