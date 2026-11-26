/**
 * The rows of `backup_rules` and `backup_checklist`, and nothing else writes them (PLAN.md section 3b). A choice only changes what the next
 * preview offers: nothing here touches a file, a drive or a phone, and nothing here removes a file or authorises a removal.
 * `backup_exclusions` is the old list: the migration copied it in, and `BackupProfileStore.addExclusion` still keeps a copy here, so one
 * place (this one) decides what is left out.
 */
import type { Db } from '../db';
import { draftProblem, FOLDER_ROOT_FOLDER, NOT_COVERED_ITEMS, ruleWords, storedPattern, type BackupRule, type RuleChoice, type RuleDraft, type RuleScope, type RuleView } from '../../shared/rules';
import { isLegacyWindowsPath, translateLegacyRules } from './legacyPaths';
import { compileRules, type CompiledRules } from './ruleMatcher';

interface RuleRow {
  id: number;
  backup_id: number | null;
  scope: RuleScope;
  pattern: string;
  choice: RuleChoice;
  destination: string | null;
  note: string | null;
  created_at: number;
}

const toRule = (r: RuleRow): BackupRule => ({ id: r.id, backupId: r.backup_id, scope: r.scope, pattern: r.pattern, choice: r.choice, destination: r.destination, note: r.note, createdAt: r.created_at });

export const toView = (rule: BackupRule): RuleView => ({ id: rule.id, scope: rule.scope, choice: rule.choice, pattern: rule.pattern, words: ruleWords(rule), createdAt: rule.createdAt, everyBackup: rule.backupId === null });

export type AddOutcome = { ok: true; rule: BackupRule; added: boolean } | { ok: false; message: string };

export class RulesStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The choices of one backup and the ones for every backup, oldest first (a choice that names one destination, such as "leave out of Google", is not one of these). */
  list(backupId: number): BackupRule[] {
    return (this.db.prepare('SELECT id, backup_id, scope, pattern, choice, destination, note, created_at FROM backup_rules WHERE (backup_id = ? OR backup_id IS NULL) AND destination IS NULL ORDER BY id').all(backupId) as RuleRow[]).map(toRule);
  }

  get(id: number): BackupRule | null {
    const row = this.db.prepare('SELECT id, backup_id, scope, pattern, choice, destination, note, created_at FROM backup_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return row ? toRule(row) : null;
  }

  count(backupId: number): number {
    return this.db.prepare('SELECT count(*) FROM backup_rules WHERE (backup_id = ? OR backup_id IS NULL) AND destination IS NULL').pluck().get(backupId) as number;
  }

  /** How many things a backup never backs up (its own "leave out" choices and the ones for every backup): the number on "Exclusions (N)". */
  countLeftOut(backupId: number): number {
    return this.db.prepare("SELECT count(*) FROM backup_rules WHERE (backup_id = ? OR backup_id IS NULL) AND choice = 'leave_out' AND destination IS NULL").pluck().get(backupId) as number;
  }

  /**
   * The choices as they are matched and shown. For a folder backup a choice carried over from the old tool as a full Windows path is translated to
   * "/source/<path below the folder>" (legacy paths outside the folder are dropped for matching, kept for showing); the stored rows stay as they are.
   */
  listFor(backupId: number, purpose: 'match' | 'show'): BackupRule[] {
    const rules = this.list(backupId);
    if (!rules.some((r) => r.scope !== 'pattern' && isLegacyWindowsPath(r.pattern))) return rules;
    const profile = this.db.prepare('SELECT source_kind, source_root FROM backup_profiles WHERE id = ?').get(backupId) as { source_kind: string; source_root: string } | undefined;
    return profile?.source_kind === 'folder' ? translateLegacyRules(rules, profile.source_root, purpose === 'show') : rules;
  }

  /** The choices of one backup, compiled for matching (one per plan). */
  compiled(backupId: number): CompiledRules {
    return compileRules(this.listFor(backupId, 'match'));
  }

  /**
   * What saving a draft would do: refused (plain reason), already there (the same choice twice changes nothing), or new. The opposite
   * choice for the very same thing is refused (the person removes the first one), so a "never back up" can never be silently overridden
   * by an older "always include".
   */
  examine(backupId: number, draft: RuleDraft): { ok: false; message: string } | { ok: true; existing: BackupRule | null } {
    const kind = this.db.prepare('SELECT source_kind FROM backup_profiles WHERE id = ?').pluck().get(backupId) as string | undefined;
    const problem = draftProblem(draft, kind === 'folder' ? FOLDER_ROOT_FOLDER : undefined);
    if (problem !== null) return { ok: false, message: problem };
    const same = this.db.prepare('SELECT id, backup_id, scope, pattern, choice, destination, note, created_at FROM backup_rules WHERE backup_id = ? AND scope = ? AND pattern = ? AND destination IS NULL').all(backupId, draft.scope, storedPattern(draft)) as RuleRow[];
    const twin = same.find((r) => r.choice === draft.choice);
    if (twin) return { ok: true, existing: toRule(twin) };
    const opposite = same[0];
    if (opposite) return { ok: false, message: `You already chose this the other way (${ruleWords(toRule(opposite))}). Remove that choice first.` };
    return { ok: true, existing: null };
  }

  /** Saves one choice for one backup (see `examine`); the same choice twice changes nothing (`added: false`). */
  add(backupId: number, draft: RuleDraft, note: string | null = null): AddOutcome {
    const seen = this.examine(backupId, draft);
    if (!seen.ok) return seen;
    if (seen.existing) return { ok: true, rule: seen.existing, added: false };
    const id = Number(this.db.prepare('INSERT INTO backup_rules (backup_id, scope, pattern, choice, destination, note, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(backupId, draft.scope, storedPattern(draft), draft.choice, note, this.now()).lastInsertRowid);
    return { ok: true, rule: this.get(id)!, added: true };
  }

  /** Takes one choice away. Nothing else changes. */
  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM backup_rules WHERE id = ?').run(id).changes === 1;
  }

  /** Every choice and tick of a backup that is deleted for good (the backup never ran). */
  removeAllFor(backupId: number): void {
    this.db.prepare('DELETE FROM backup_rules WHERE backup_id = ?').run(backupId);
    this.db.prepare('DELETE FROM backup_checklist WHERE backup_id = ?').run(backupId);
  }

  /** The old "never back up this file" list: keeps a leave_out choice for the file in step with `backup_exclusions`. */
  addLegacyFile(backupId: number, path: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO backup_rules (backup_id, scope, pattern, choice, destination, note, created_at) VALUES (?, 'file', ?, 'leave_out', NULL, 'Carried over from the old never-back-up list', ?)").run(backupId, path, at);
  }

  removeLegacyFile(backupId: number, path: string): void {
    this.db.prepare("DELETE FROM backup_rules WHERE backup_id = ? AND scope = 'file' AND pattern = ? AND choice = 'leave_out' AND destination IS NULL").run(backupId, path);
  }

  // ---- things no backup can copy (the tick-offs) ------------------------------------------------------------------------------------

  /** Item id -> when it was ticked, for the items that are ticked now. */
  ticks(backupId: number): Map<string, number> {
    const rows = this.db.prepare('SELECT item, ticked_at FROM backup_checklist WHERE backup_id = ? AND ticked_at IS NOT NULL').all(backupId) as { item: string; ticked_at: number }[];
    return new Map(rows.map((r) => [r.item, r.ticked_at]));
  }

  /** Ticks or unticks one known item. Returns false for an item that is not on the list. */
  setTick(backupId: number, item: string, ticked: boolean): boolean {
    if (!NOT_COVERED_ITEMS.some((i) => i.id === item)) return false;
    this.db.prepare('INSERT INTO backup_checklist (backup_id, item, ticked_at) VALUES (?, ?, ?) ON CONFLICT(backup_id, item) DO UPDATE SET ticked_at = excluded.ticked_at').run(backupId, item, ticked ? this.now() : null);
    return true;
  }
}
