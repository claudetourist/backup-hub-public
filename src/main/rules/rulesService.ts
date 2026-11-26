/**
 * What the window calls for "your choices" and for the list of things no backup can copy (PLAN.md section 3b, R1.2b part 1).
 * Every method is a direct answer to a click and checks its own arguments (ids, kinds, paths) before it touches anything: the window is
 * never trusted. A choice only changes what the NEXT preview offers; this service never touches a file, a drive or the phone, and it
 * never removes or authorises the removal of a file. The rows are written by `RulesStore` only.
 */
import type { Db } from '../db';
import { finishSliced } from '../sliceWork';
import {
  NOT_COVERED_ITEMS,
  storedPattern,
  type BackupRule,
  type NotCoveredLine,
  type NotCoveredResult,
  type NotCoveredTickRequest,
  type RuleAddRequest,
  type RuleAddResult,
  type RuleEffectRequest,
  type RuleEffectResult,
  type RuleRemoveRequest,
  type RuleRemoveResult,
  type RulesListResult,
} from '../../shared/rules';
import { effectSteps, type EffectFile } from './effect';
import { compileRules } from './ruleMatcher';
import { RulesStore, toView } from './rulesStore';

/** The plan main holds for a backup, as the files the effect is counted over (null: no plan is held). */
export interface EffectSource {
  effectFiles(backupId: number, planId?: string): { backupName: string; files: Iterable<EffectFile> } | null;
}

export interface RulesServiceDeps {
  db: Db;
  plans: EffectSource;
  now?: () => number;
  /** One turn of the event loop (tests pass a no-op). */
  pause?: () => Promise<void>;
  log?: { info(...args: unknown[]): void };
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export class RulesService {
  private readonly store: RulesStore;

  constructor(private readonly deps: RulesServiceDeps) {
    this.store = new RulesStore(deps.db, deps.now ?? Date.now);
  }

  /** The name of a phone or folder backup, or why it cannot be used. */
  private phoneBackupOf(backupId: unknown): { ok: true; id: number; name: string } | { ok: false; message: string } {
    if (!isId(backupId)) return { ok: false, message: 'That is not a valid request.' };
    const row = this.deps.db.prepare('SELECT id, name, source_kind FROM backup_profiles WHERE id = ?').get(backupId) as { id: number; name: string; source_kind: string } | undefined;
    if (!row) return { ok: false, message: 'That backup does not exist.' };
    if (row.source_kind !== 'phone' && row.source_kind !== 'folder') return { ok: false, message: `${row.name} is not a phone or folder backup.` };
    return { ok: true, id: row.id, name: row.name };
  }

  list(backupId: unknown): RulesListResult {
    const b = this.phoneBackupOf(backupId);
    if (!b.ok) return b;
    return { ok: true, backupId: b.id, backupName: b.name, rules: this.store.listFor(b.id, 'show').map(toView) };
  }

  /** How many choices a backup has (its own and the ones for every backup). */
  count(backupId: number): number {
    return this.store.count(backupId);
  }

  /** What saving a choice, or removing one, would do to the plan main holds for this backup. Reads only. */
  async effect(request: RuleEffectRequest): Promise<RuleEffectResult> {
    const b = this.phoneBackupOf(request?.backupId);
    if (!b.ok) return b;
    const rules = this.store.listFor(b.id, 'match');
    let after: BackupRule[];
    const change = request.change;
    if (change.kind === 'add') {
      const seen = this.store.examine(b.id, change.draft);
      if (!seen.ok) return seen;
      const draft = change.draft;
      after = seen.existing ? rules : [...rules, { id: Number.MAX_SAFE_INTEGER, backupId: b.id, scope: draft.scope, pattern: storedPattern(draft), choice: draft.choice, destination: null, note: null, createdAt: 0 }];
    } else {
      const rule = isId(change.ruleId) ? this.store.get(change.ruleId) : null;
      if (!rule || (rule.backupId !== null && rule.backupId !== b.id)) return { ok: false, message: 'That choice is not on the list any more.' };
      after = rules.filter((r) => r.id !== rule.id);
    }
    const source = this.deps.plans.effectFiles(b.id, request.planId);
    if (source === null) return { ok: true, backupName: b.name, hasPlan: false, leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 } };
    const result = await finishSliced(effectSteps(source.files, compileRules(rules), compileRules(after)), this.deps.pause);
    return { ok: true, backupName: b.name, hasPlan: true, ...result };
  }

  add(request: RuleAddRequest): RuleAddResult {
    const b = this.phoneBackupOf(request?.backupId);
    if (!b.ok) return b;
    const saved = this.store.add(b.id, { scope: request.scope, pattern: request.pattern, choice: request.choice });
    if (!saved.ok) return { ok: false, message: `${saved.message} Nothing was changed.` };
    if (saved.added) this.deps.log?.info(`rules: backup ${b.id} saved choice ${saved.rule.id} (${saved.rule.choice}, ${saved.rule.scope})`);
    const verb = saved.rule.choice === 'leave_out' ? 'leave this out' : 'include this';
    return { ok: true, message: saved.added ? `Saved. Every later backup of ${b.name} will ${verb}.` : 'You already had this choice. Nothing was changed.', rule: toView(saved.rule), count: this.store.count(b.id), added: saved.added };
  }

  /** Removing a choice changes only what the next backup offers; nothing is deleted anywhere. */
  remove(request: RuleRemoveRequest): RuleRemoveResult {
    const no = (message: string): RuleRemoveResult => ({ ok: false, message: `${message} Nothing was changed.` });
    if (request?.confirmed !== true) return no('Please confirm first.');
    const b = this.phoneBackupOf(request.backupId);
    if (!b.ok) return no(b.message);
    const rule = isId(request.ruleId) ? this.store.get(request.ruleId) : null;
    if (!rule || (rule.backupId !== null && rule.backupId !== b.id)) return no('That choice is not on the list any more.');
    this.store.remove(rule.id);
    this.deps.log?.info(`rules: backup ${b.id} removed choice ${rule.id}`);
    return { ok: true, message: 'Removed. Nothing was deleted.', count: this.store.count(b.id) };
  }

  // ---- things no backup can copy ----------------------------------------------------------------------------------------------------

  notCovered(backupId: unknown): NotCoveredResult {
    const b = this.phoneBackupOf(backupId);
    if (!b.ok) return b;
    const ticks = this.store.ticks(b.id);
    const items = NOT_COVERED_ITEMS.map((i): NotCoveredLine => ({ id: i.id, title: i.title, howTo: i.howTo, ticked: ticks.has(i.id), tickedAt: ticks.get(i.id) ?? null }));
    return { ok: true, backupId: b.id, backupName: b.name, items, done: items.filter((i) => i.ticked).length, total: items.length };
  }

  tick(request: NotCoveredTickRequest): NotCoveredResult {
    const b = this.phoneBackupOf(request?.backupId);
    if (!b.ok) return b;
    if (typeof request.ticked !== 'boolean' || !this.store.setTick(b.id, String(request.item), request.ticked)) return { ok: false, message: 'That is not on the list. Nothing was changed.' };
    return this.notCovered(b.id);
  }
}
