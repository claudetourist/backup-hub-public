/**
 * The index side of a folder backup run, beyond what the phone backup's run store already writes (backup_runs, the copy rows, the confirmed list in
 * `meta`): the report kept with the job, and two small writes that only ever fill an empty column of an existing row.
 */
import type { Db } from '../db';
import type { FolderBackupReport } from '../../shared/folderBackup';

const META_REPORT = 'folderBackup.report.';

export const saveFolderReport = (db: Db, jobId: number, report: FolderBackupReport): void =>
  void db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_REPORT + jobId, JSON.stringify(report));

export function loadFolderReport(db: Db, jobId: number): FolderBackupReport | null {
  const text = db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(META_REPORT + jobId) as string | undefined;
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as FolderBackupReport;
  } catch {
    return null;
  }
}

/** A copy in the backup that points at no file yet now points at this one (its size, date, path and checksum are never touched). */
export function linkOriginOnly(db: Db, copyRowId: number, sourceRowId: number): boolean {
  return db.prepare('UPDATE files SET origin_file_id = ? WHERE id = ? AND origin_file_id IS NULL').run(sourceRowId, copyRowId).changes > 0;
}

/** The folder's own row learns the checksum that was just read, only while the row still describes the file that was read. */
export function learnSourceSha(db: Db, rowId: number, size: number, sha256: string, now: number): void {
  db.prepare('UPDATE files SET sha256 = ?, hashed_at = ? WHERE id = ? AND size = ?').run(sha256, now, rowId, size);
}
