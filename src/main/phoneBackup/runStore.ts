/**
 * The index side of a phone backup run (R1.2a). The only writer of: backup_runs rows, the destination rows a copy makes, the link of a
 * confirmed existing copy to its phone row, and the confirmed list and report kept in `meta` (never in `settings`: that table is read whole).
 * Nothing here deletes a row. A destination row is written only after the safe copy finished.
 */
import type { Db } from '../db';
import { upsertFiles } from '../listing/fileStore';
import { prefixUpperBound } from '../listing/skipRules';
import { finishSync, sortSteps, STEP_ITEMS, type Steps } from '../sliceWork';
import type { PhoneBackupReport } from '../../shared/phoneBackup';
import { driveKey } from './pathMap';
import type { LooseRow } from './planModel';

const META_RUN = 'phoneBackup.run.';
const META_REPORT = 'phoneBackup.report.';

const metaGet = (db: Db, key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
const metaSet = (db: Db, key: string, value: string): void => void db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** What the person confirmed: exactly the files to copy, where each goes, the copies to link, the day folder and the backup's drive. */
export interface ConfirmedRun {
  planId: string;
  backupId: number;
  backupName: string;
  phoneName: string;
  serial: string;
  phonePlaceId: string;
  destPlaceId: string;
  destRoot: string;
  /** "Poco-F4-23Nov26": fixed when the plan was made, so a Continue after midnight still goes to the same folder. */
  sessionFolder: string;
  items: { path: string; size: number; mtimeSec: number; destRel: string; rowId: number | null; /** Folder backups: copies of the same path with the same size and a date off by whole hours; the run reads the file and decides by checksum. */ candidates?: { id: number; relPath: string; sha256: string | null }[] }[];
  relinks: { path: string; phoneRowId: number; copyRowId: number; sha256: string }[];
  leftOut: { files: number; bytes: number };
  notCovered: string[];
  /** The phone folders the look covered. */
  folders: string[];
  /** Doubtful looks the person already answered "accept" to when the plan was made (the run's own look honours them). */
  accept: string[];
  /** Folder backups (R2.1): there is no phone. `phoneName` is the folder in words, `serial` is empty, `phonePlaceId` the place of the folder's rows ('' for none). `path` of an item is "/source/<path below the folder>". */
  flat?: boolean;
  /** Folder backups: OneDrive files left out of the list because they are online only (counted in the report). */
  onlineOnly?: { files: number; bytes: number; examples: string[] };
}

/** Files (or copies to link) per stored piece: about 150 KB of text, a couple of milliseconds to write or read. */
const RUN_CHUNK = 1000;
const itemsKey = (jobKey: string, n: number): string => `${META_RUN}${jobKey}.i.${n}`;
const relinksKey = (jobKey: string, n: number): string => `${META_RUN}${jobKey}.r.${n}`;

type RunHeader = Omit<ConfirmedRun, 'items' | 'relinks'> & { itemChunks: number; relinkChunks: number };

/**
 * Stores what the person confirmed. A run of 60,000 files is about 9 MB of text: written as one value it blocked the main thread for 0.2 to
 * 0.5 s, so the lists are stored in pieces of `RUN_CHUNK` and the head (which tells how many pieces there are) is written LAST: a reader never
 * sees a head without its pieces. Slices (see sliceWork.ts); `saveConfirmed` runs them at once.
 */
export function* saveConfirmedSteps(db: Db, jobKey: string, run: ConfirmedRun): Steps<void> {
  const { items, relinks, ...rest } = run;
  const itemChunks = Math.ceil(items.length / RUN_CHUNK);
  const relinkChunks = Math.ceil(relinks.length / RUN_CHUNK);
  for (let n = 0; n < itemChunks; n += 1) {
    metaSet(db, itemsKey(jobKey, n), JSON.stringify(items.slice(n * RUN_CHUNK, (n + 1) * RUN_CHUNK)));
    yield;
  }
  for (let n = 0; n < relinkChunks; n += 1) {
    metaSet(db, relinksKey(jobKey, n), JSON.stringify(relinks.slice(n * RUN_CHUNK, (n + 1) * RUN_CHUNK)));
    yield;
  }
  const head: RunHeader = { ...rest, itemChunks, relinkChunks };
  metaSet(db, META_RUN + jobKey, JSON.stringify(head));
}

export const saveConfirmed = (db: Db, jobKey: string, run: ConfirmedRun): void => finishSync(saveConfirmedSteps(db, jobKey, run));

/** The confirmed run in slices: one piece at a time (a run stored whole by an older version is read as it was). Null when it is not there or a piece is missing. */
export function* loadConfirmedSteps(db: Db, jobKey: string): Steps<ConfirmedRun | null> {
  const text = metaGet(db, META_RUN + jobKey);
  if (text === null) return null;
  let head: (Partial<ConfirmedRun> & Partial<RunHeader>) | null;
  try {
    head = JSON.parse(text) as Partial<ConfirmedRun> & Partial<RunHeader>;
  } catch {
    return null;
  }
  if (head === null || typeof head !== 'object') return null;
  if (Array.isArray(head.items)) return head as ConfirmedRun;
  const { itemChunks, relinkChunks, ...rest } = head;
  if (typeof itemChunks !== 'number' || typeof relinkChunks !== 'number') return null;
  const items: ConfirmedRun['items'] = [];
  const relinks: ConfirmedRun['relinks'] = [];
  try {
    for (let n = 0; n < itemChunks; n += 1) {
      const piece = metaGet(db, itemsKey(jobKey, n));
      if (piece === null) return null;
      for (const i of JSON.parse(piece) as ConfirmedRun['items']) items.push(i);
      yield;
    }
    for (let n = 0; n < relinkChunks; n += 1) {
      const piece = metaGet(db, relinksKey(jobKey, n));
      if (piece === null) return null;
      for (const r of JSON.parse(piece) as ConfirmedRun['relinks']) relinks.push(r);
      yield;
    }
  } catch {
    return null;
  }
  return { ...(rest as Omit<ConfirmedRun, 'items' | 'relinks'>), items, relinks };
}

export const loadConfirmed = (db: Db, jobKey: string): ConfirmedRun | null => finishSync(loadConfirmedSteps(db, jobKey));

export const saveReport = (db: Db, jobId: number, report: PhoneBackupReport): void => metaSet(db, META_REPORT + jobId, JSON.stringify(report));

export function loadReport(db: Db, jobId: number): PhoneBackupReport | null {
  const text = metaGet(db, META_REPORT + jobId);
  if (text === null) return null;
  try {
    return JSON.parse(text) as PhoneBackupReport;
  } catch {
    return null;
  }
}

export const dropConfirmed = (db: Db, jobKey: string): void => {
  const pieces = `${META_RUN}${jobKey}.`;
  db.prepare('DELETE FROM meta WHERE key = ? OR substr(key, 1, ?) = ?').run(META_RUN + jobKey, pieces.length, pieces);
};

export function startRun(db: Db, backupId: number, destPlaceId: string, folder: string, now: number): number {
  return Number(db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, folder, started_at, state) VALUES (?, ?, ?, ?, 'running')").run(backupId, destPlaceId, folder, now).lastInsertRowid);
}

export function finishRun(db: Db, runId: number, state: 'done' | 'done_warnings' | 'failed', copied: number, bytes: number, failedJson: string, now: number): void {
  db.prepare('UPDATE backup_runs SET state = ?, ended_at = ?, files_copied = ?, bytes_copied = ?, failed_json = ? WHERE id = ?').run(state, now, copied, bytes, failedJson, runId);
}

/** Rows at the drive under one folder (not gone): path key -> the phone row they came from. For names already taken. */
export function takenUnder(db: Db, placeId: string, folderRel: string): Map<string, number | null> {
  const prefix = folderRel.replace(/\/+$/, '') + '/';
  const rows = db.prepare('SELECT rel_path, origin_file_id FROM files WHERE place_id = ? AND rel_path >= ? AND rel_path < ? AND gone_at IS NULL').all(placeId, prefix, prefixUpperBound(prefix)) as { rel_path: string; origin_file_id: number | null }[];
  return new Map(rows.map((r) => [driveKey(r.rel_path), r.origin_file_id]));
}

/** A lookup of loose rows (no phone row behind them) under the backup folder by name and size. */
export function looseLookup(db: Db, placeId: string, root: string): (name: string, size: number) => LooseRow[] {
  const prefix = root.replace(/\/+$/, '') + '/';
  const hi = prefixUpperBound(prefix);
  const stmt = db.prepare(
    // INDEXED BY: without it SQLite walks every row of the backup folder (rel_path range) for EACH phone file: 6,828 rows x 25,597 files took about half a minute.
    'SELECT id, rel_path, size, sha256 FROM files INDEXED BY idx_files_size_name WHERE place_id = ? AND size = ? AND name = ? AND origin_file_id IS NULL AND gone_at IS NULL AND rel_path >= ? AND rel_path < ? ORDER BY id LIMIT 5',
  );
  return (name, size) => (stmt.all(placeId, size, name, prefix, hi) as { id: number; rel_path: string; size: number; sha256: string | null }[]).map((r) => ({ id: r.id, relPath: r.rel_path, size: r.size, sha256: r.sha256 }));
}

/** The phone's rows by path (ids for the origin link). */
export function phoneRowIds(db: Db, placeId: string, relPaths: readonly string[]): Map<string, number> {
  return finishSync(phoneRowIdsSteps(db, placeId, relPaths));
}

/** `phoneRowIds` in slices (one query per file: 25,000 files took about a second in one go; see sliceWork.ts). The answer is the same. */
export function* phoneRowIdsSteps(db: Db, placeId: string, relPaths: readonly string[]): Steps<Map<string, number>> {
  const out = new Map<string, number>();
  const stmt = db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck();
  let n = 0;
  for (const rel of relPaths) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const id = stmt.get(placeId, rel) as number | undefined;
    if (id !== undefined) out.set(rel, id);
  }
  return out;
}

export interface CopyRecord {
  destPlaceId: string;
  destRel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  phoneRowId: number | null;
  runId: number;
  now: number;
}

/**
 * The index row of a finished safe copy (R1.0a design): a row at the destination with origin_file_id = the phone row, expected_sha256 =
 * the content at copy time, its date the source date, verified_how = 'read_both' (the phone's checksum and the drive's read agreed).
 * The phone's own row learns its checksum too. One transaction.
 */
export function recordCopy(db: Db, c: CopyRecord): void {
  db.transaction(() => {
    upsertFiles(db, c.destPlaceId, [{ relPath: c.destRel, size: c.size, mtimeMs: c.mtimeMs, cloudOnly: false }], c.now, true);
    db.prepare(
      `UPDATE files SET sha256 = ?, hashed_at = ?, hash_error = NULL, origin_file_id = ?, backup_run_id = ?, expected_sha256 = ?, verified_at = ?, verified_how = 'read_both', gone_at = NULL, gone_reason = NULL
       WHERE place_id = ? AND rel_path = ?`,
    ).run(c.sha256, c.now, c.phoneRowId, c.runId, c.sha256, c.now, c.destPlaceId, c.destRel);
    if (c.phoneRowId !== null) db.prepare('UPDATE files SET sha256 = ?, hashed_at = ? WHERE id = ? AND size = ?').run(c.sha256, c.now, c.phoneRowId, c.size);
  }).immediate();
}

/** A copy that was already on the drive and whose content the phone's checksum confirmed: it now points at its phone row. Never touches size, date or path. */
export function linkConfirmedCopy(db: Db, copyRowId: number, phoneRowId: number, sha256: string, runId: number, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE files SET origin_file_id = ?, expected_sha256 = ?, sha256 = coalesce(sha256, ?), verified_at = ?, verified_how = 'read_both', backup_run_id = coalesce(backup_run_id, ?)
         WHERE id = ? AND origin_file_id IS NULL`,
      )
      .run(phoneRowId, sha256, sha256, now, runId, copyRowId).changes > 0
  );
}

/** Rows this run made, for the list on the drive: destination path, the phone path they came from, size, date, checksum. `limit`: only the first rows in path order. */
export function runListRows(db: Db, runId: number, limit?: number): { destRel: string; phonePath: string; size: number; mtimeMs: number | null; sha256: string | null }[] {
  const rows = db
    .prepare(
      `SELECT c.rel_path AS destRel, p.rel_path AS phoneRel, c.size AS size, c.mtime AS mtimeMs, c.sha256 AS sha256
       FROM files c JOIN files p ON p.id = c.origin_file_id WHERE c.backup_run_id = ? ORDER BY c.rel_path${limit === undefined ? '' : ' LIMIT ' + Math.max(0, Math.floor(limit))}`,
    )
    .all(runId) as { destRel: string; phoneRel: string; size: number; mtimeMs: number | null; sha256: string | null }[];
  return rows.map((r) => ({ destRel: r.destRel, phonePath: '/' + r.phoneRel, size: r.size, mtimeMs: r.mtimeMs, sha256: r.sha256 }));
}

/** How many files this run made (the rows `runListRows` would return). */
export function runListCount(db: Db, runId: number): number {
  return db.prepare('SELECT count(*) FROM files c JOIN files p ON p.id = c.origin_file_id WHERE c.backup_run_id = ?').pluck().get(runId) as number;
}

/**
 * `runListRows` for the list on the drive, in slices: the rows are read a page at a time in the order they were made (the index of the
 * run), then put in path order in slices (see sliceWork.ts). Reading all 60,000 rows at once took about 400 ms. Path order is the order of
 * the JavaScript strings; it differs from the database's only for names with characters outside the basic plane, and the list is for reading.
 */
export function* runListRowsSteps(db: Db, runId: number): Steps<{ destRel: string; phonePath: string; size: number; mtimeMs: number | null; sha256: string | null }[]> {
  const page = db.prepare(
    `SELECT c.id AS id, c.rel_path AS destRel, p.rel_path AS phoneRel, c.size AS size, c.mtime AS mtimeMs, c.sha256 AS sha256
     FROM files c JOIN files p ON p.id = c.origin_file_id WHERE c.backup_run_id = ? AND c.id > ? ORDER BY c.id LIMIT 1000`,
  );
  const out: { destRel: string; phonePath: string; size: number; mtimeMs: number | null; sha256: string | null }[] = [];
  let after = 0;
  for (;;) {
    const rows = page.all(runId, after) as { id: number; destRel: string; phoneRel: string; size: number; mtimeMs: number | null; sha256: string | null }[];
    for (const r of rows) out.push({ destRel: r.destRel, phonePath: '/' + r.phoneRel, size: r.size, mtimeMs: r.mtimeMs, sha256: r.sha256 });
    if (rows.length < 1000) break;
    after = rows[rows.length - 1]!.id;
    yield;
  }
  yield* sortSteps(out, (a, b) => (a.destRel < b.destRel ? -1 : a.destRel > b.destRel ? 1 : 0));
  return out;
}
