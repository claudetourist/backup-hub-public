/**
 * The index side of "Check old copies" (R1.4b). The ONLY writer of what a check finds, and it writes the index only:
 * - a copy that was read back and equals the phone's file: verified_how 'read_both', verified_at, expected_sha256 (and the checksum read);
 * - a copy that is different: verified_how 'differs' (the next backup copies the file again) and a row in file_problems;
 * - a copy whose drive file is not there any more: gone_at and gone_reason 'missing_on_drive' (the next backup copies the file again).
 * Nothing on the phone or on a drive is written, renamed or removed, and no index row is deleted. The list of files to check and the
 * report live in `meta`, never in `settings` (that table is read whole).
 */
import type { Db } from '../db';
import type { CheckOldReport } from '../../shared/phoneBackup';

const META_LIST = 'phoneBackup.checkOld.list.';
const META_REPORT = 'phoneBackup.checkOld.report.';

const metaGet = (db: Db, key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
const metaSet = (db: Db, key: string, value: string): void => void db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** What a check was asked to do: the copies to look at in a fixed order, and the words it needs for its report. */
export interface CheckOldInput {
  key: string;
  backupId: number;
  backupName: string;
  phoneName: string;
  serial: string;
  /** The drive the copies are on (destination 1). */
  destPlaceId: string;
  driveLabel: string;
  items: { copyId: number; phoneRowId: number; path: string; size: number; copyRel: string; group: string }[];
}

export const saveInput = (db: Db, input: CheckOldInput): void => metaSet(db, META_LIST + input.key, JSON.stringify(input));

export function loadInput(db: Db, key: string): CheckOldInput | null {
  const text = metaGet(db, META_LIST + key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as CheckOldInput;
  } catch {
    return null;
  }
}

export const dropInput = (db: Db, key: string): void => void db.prepare('DELETE FROM meta WHERE key = ?').run(META_LIST + key);

export const saveReport = (db: Db, jobId: number, report: CheckOldReport): void => metaSet(db, META_REPORT + jobId, JSON.stringify(report));

export function loadReport(db: Db, jobId: number): CheckOldReport | null {
  const text = metaGet(db, META_REPORT + jobId);
  if (text === null) return null;
  try {
    return JSON.parse(text) as CheckOldReport;
  } catch {
    return null;
  }
}

/** The state of copy rows now (the run skips what an earlier, cut-off run already settled). */
export function copyStates(db: Db, copyIds: readonly number[]): Map<number, { verifiedHow: string | null; goneAt: number | null; goneReason: string | null }> {
  const rows = db.prepare('SELECT id, verified_how, gone_at, gone_reason FROM files WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(copyIds)) as { id: number; verified_how: string | null; gone_at: number | null; gone_reason: string | null }[];
  return new Map(rows.map((r) => [r.id, { verifiedHow: r.verified_how, goneAt: r.gone_at, goneReason: r.gone_reason }]));
}

/** Is this copy still waiting to be checked (not checked, not marked different, not gone)? */
export const stillToCheck = (s: { verifiedHow: string | null; goneAt: number | null } | undefined): boolean => s !== undefined && s.goneAt === null && s.verifiedHow !== 'read_both' && s.verifiedHow !== 'differs';

/** The phone's file and the drive's file read equal: this copy is now a checked copy. */
export function markVerified(db: Db, copyId: number, sha256: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE files SET verified_how = 'read_both', verified_at = ?, expected_sha256 = ?, sha256 = ?, hashed_at = ?, hash_error = NULL
         WHERE id = ? AND origin_file_id IS NOT NULL AND gone_at IS NULL AND (verified_how IS NULL OR verified_how NOT IN ('read_both', 'differs'))`,
      )
      .run(now, sha256, sha256, now, copyId).changes > 0
  );
}

/** The drive's file is not the phone's file: it stops counting as a copy, and a problem is recorded. The drive's file is not touched. */
export function markDiffers(db: Db, copyId: number, now: number): boolean {
  return db
    .transaction((): boolean => {
      const changed = db.prepare("UPDATE files SET verified_how = 'differs', verified_at = ? WHERE id = ? AND origin_file_id IS NOT NULL AND gone_at IS NULL AND (verified_how IS NULL OR verified_how <> 'differs')").run(now, copyId).changes > 0;
      if (changed && !db.prepare("SELECT 1 FROM file_problems WHERE file_id = ? AND kind = 'copy_differs' AND state = 'open'").get(copyId)) {
        db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, 'copy_differs', ?, 'open')").run(copyId, now);
      }
      return changed;
    })
    .immediate();
}

/**
 * The person has seen a copy that is not the same as the phone's file and chose "Copy it again at the next backup" (what happens anyway:
 * the copy stays marked as not checked, so the next backup copies the phone's file again into a new folder). The problem is marked seen
 * ('acknowledged'); nothing else changes and no file is touched. `problemId` = this one problem; `backupId` = every open one of that backup.
 * Returns how many were marked.
 */
export function acknowledgeDiffers(db: Db, scope: { problemId: number } | { backupId: number }): number {
  if ('problemId' in scope) return db.prepare("UPDATE file_problems SET state = 'acknowledged' WHERE id = ? AND kind = 'copy_differs' AND state = 'open'").run(scope.problemId).changes;
  return db
    .prepare(
      `UPDATE file_problems SET state = 'acknowledged'
       WHERE kind = 'copy_differs' AND state = 'open'
         AND file_id IN (SELECT c.id FROM files c JOIN files p ON p.id = c.origin_file_id JOIN backup_profiles bp ON bp.source_place_id = p.place_id WHERE bp.id = ?)`,
    )
    .run(scope.backupId).changes;
}

/** The drive's file is not there: the row is marked gone (it is kept), so the next backup copies the phone's file again. */
export function markMissing(db: Db, copyId: number, now: number): boolean {
  return db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'missing_on_drive' WHERE id = ? AND origin_file_id IS NOT NULL AND gone_at IS NULL").run(now, copyId).changes > 0;
}
