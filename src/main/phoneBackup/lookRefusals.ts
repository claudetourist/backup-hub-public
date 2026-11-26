/**
 * The latest look at the phone that was refused (R1.0a lookGuard: the list did not come back complete, came back empty, showed a mass
 * change, or had two names that clash), kept per backup so "Needs your decision" can show it after a restart. Before this the refusal lived
 * only in the look job's answer in memory and as the failed job's text. The look job (phoneBackupService.ts) is the only writer: it stores
 * the refusal when a look is refused, and takes it away when a later look makes a plan. Stored in `meta` (never in `settings`: that table
 * is read whole). Nothing here touches the phone, a drive or a file.
 */
import type { Db } from '../db';
import type { DecisionKind } from '../look/lookGuard';

const KEY = 'phoneBackup.refusal.';

export const LOOK_REFUSAL_KINDS: readonly DecisionKind[] = ['look_incomplete', 'look_empty', 'look_mass_change', 'look_name_clash'];

export interface LookRefusal {
  backupId: number;
  /** The look job that was refused. */
  jobId: number;
  kind: DecisionKind;
  /** The guard allows "accept" (only an empty list or a mass change; a half list can only be tried again). */
  canAccept: boolean;
  /** The guard's plain words: what was seen, and that nothing was changed. */
  message: string;
  at: number;
}

export function saveRefusal(db: Db, refusal: LookRefusal): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY + refusal.backupId, JSON.stringify(refusal));
}

export function clearRefusal(db: Db, backupId: number): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(KEY + backupId);
}

function parse(text: string): LookRefusal | null {
  try {
    const v = JSON.parse(text) as Partial<LookRefusal> | null;
    if (v === null || typeof v !== 'object') return null;
    if (typeof v.backupId !== 'number' || typeof v.jobId !== 'number' || typeof v.message !== 'string' || typeof v.at !== 'number' || typeof v.canAccept !== 'boolean') return null;
    if (!LOOK_REFUSAL_KINDS.includes(v.kind as DecisionKind)) return null;
    return v as LookRefusal;
  } catch {
    return null;
  }
}

/** Every stored refusal, newest first. */
export function loadRefusals(db: Db): LookRefusal[] {
  const rows = db.prepare('SELECT value FROM meta WHERE substr(key, 1, ?) = ?').all(KEY.length, KEY) as { value: string }[];
  return rows.map((r) => parse(r.value)).filter((r): r is LookRefusal => r !== null).toSorted((a, b) => b.at - a.at);
}

export function loadRefusal(db: Db, backupId: number): LookRefusal | null {
  const text = db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(KEY + backupId) as string | undefined;
  return text === undefined ? null : parse(text);
}
