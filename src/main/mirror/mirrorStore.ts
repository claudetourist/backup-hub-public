/**
 * The index side of a mirror (R1.3). The only writer of: the second drive's rows a copy or a link makes, the mirror's problems (file_problems of
 * kind mirror_damaged / mirror_differs), the confirmed list and the report kept in `meta` (never in `settings`: that table is read whole).
 * backup_runs rows are made and closed through runStore's startRun / finishRun. Nothing here deletes a row of a file.
 */
import type { Db } from '../db';
import { upsertFiles } from '../listing/fileStore';
import { sortSteps, type Steps } from '../sliceWork';
import { MIRROR_DAMAGED_PROBLEM, MIRROR_DIFFERS_PROBLEM, type MirrorReport } from '../../shared/mirror';
import type { ListRow } from '../phoneBackup/runCsv';
import type { MirrorCheckReport } from '../../shared/mirrorCheck';
import type { MirrorItem, MirrorPair } from './mirrorTypes';

const META_RUN = 'mirror.run.';
const META_REPORT = 'mirror.report.';
const META_CHECK_REPORT = 'mirror.checkReport.';

const metaGet = (db: Db, key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
const metaSet = (db: Db, key: string, value: string): void => void db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** What the person confirmed: the pairs, and exactly the files to copy, check and report as different. */
export interface ConfirmedMirror {
  planId: string;
  pairs: MirrorPair[];
  items: MirrorItem[];
}

const CHUNK = 1000;
const chunkKey = (planId: string, n: number): string => `${META_RUN}${planId}.i.${n}`;

/** Stored in pieces of CHUNK (a run of 60,000 files is megabytes of text: one value blocked the main thread); the head is written LAST. */
export function* saveConfirmedSteps(db: Db, run: ConfirmedMirror): Steps<void> {
  const chunks = Math.ceil(run.items.length / CHUNK);
  for (let n = 0; n < chunks; n += 1) {
    metaSet(db, chunkKey(run.planId, n), JSON.stringify(run.items.slice(n * CHUNK, (n + 1) * CHUNK)));
    yield;
  }
  metaSet(db, META_RUN + run.planId, JSON.stringify({ planId: run.planId, pairs: run.pairs, chunks }));
}

export function* loadConfirmedSteps(db: Db, planId: string): Steps<ConfirmedMirror | null> {
  const text = metaGet(db, META_RUN + planId);
  if (text === null) return null;
  let head: { planId: string; pairs: MirrorPair[]; chunks: number };
  try {
    head = JSON.parse(text) as typeof head;
  } catch {
    return null;
  }
  if (!Array.isArray(head.pairs) || typeof head.chunks !== 'number') return null;
  const items: MirrorItem[] = [];
  try {
    for (let n = 0; n < head.chunks; n += 1) {
      const piece = metaGet(db, chunkKey(planId, n));
      if (piece === null) return null;
      for (const i of JSON.parse(piece) as MirrorItem[]) items.push(i);
      yield;
    }
  } catch {
    return null;
  }
  return { planId: head.planId, pairs: head.pairs, items };
}

export const dropConfirmed = (db: Db, planId: string): void => {
  const pieces = `${META_RUN}${planId}.`;
  db.prepare('DELETE FROM meta WHERE key = ? OR substr(key, 1, ?) = ?').run(META_RUN + planId, pieces.length, pieces);
};

export const saveReport = (db: Db, jobId: number, report: MirrorReport): void => metaSet(db, META_REPORT + jobId, JSON.stringify(report));

export function loadReport(db: Db, jobId: number): MirrorReport | null {
  const text = metaGet(db, META_REPORT + jobId);
  if (text === null) return null;
  try {
    return JSON.parse(text) as MirrorReport;
  } catch {
    return null;
  }
}

export const saveCheckReport = (db: Db, jobId: number, report: MirrorCheckReport): void => metaSet(db, META_CHECK_REPORT + jobId, JSON.stringify(report));

export function loadCheckReport(db: Db, jobId: number): MirrorCheckReport | null {
  const text = metaGet(db, META_CHECK_REPORT + jobId);
  if (text === null) return null;
  try {
    return JSON.parse(text) as MirrorCheckReport;
  } catch {
    return null;
  }
}

export interface MirrorCopyRecord {
  dstPlaceId: string;
  dstRel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  /** The phone's row the first drive's copy came from (null: none). */
  originId: number | null;
  srcRowId: number;
  runId: number;
  now: number;
}

/**
 * The row of a finished safe copy on the second drive: origin_file_id = the phone's row (when the first drive's copy has one), expected_sha256 =
 * the checksum the two drives agreed on, verified_how = 'read_both', its date the source's. The first drive's own row learns its checksum when it
 * had none. One transaction; called only after the last flush.
 */
export function recordMirrorCopy(db: Db, c: MirrorCopyRecord): void {
  db.transaction(() => {
    upsertFiles(db, c.dstPlaceId, [{ relPath: c.dstRel, size: c.size, mtimeMs: c.mtimeMs, cloudOnly: false }], c.now, true);
    db.prepare(
      `UPDATE files SET sha256 = ?, hashed_at = ?, hash_error = NULL, origin_file_id = ?, backup_run_id = ?, expected_sha256 = ?, verified_at = ?, verified_how = 'read_both', gone_at = NULL, gone_reason = NULL
       WHERE place_id = ? AND rel_path = ?`,
    ).run(c.sha256, c.now, c.originId, c.runId, c.sha256, c.now, c.dstPlaceId, c.dstRel);
    learnSourceChecksum(db, c.srcRowId, c.size, c.sha256, c.now);
  }).immediate();
}

/**
 * A file already on the second drive whose content equals the first drive's: its row now points at the phone's row (when it had none) and counts
 * as verified. Its own size, date and path are never touched; a row that is not in the index yet is made from the listed facts.
 */
export function linkMirrorCopy(db: Db, c: MirrorCopyRecord): void {
  db.transaction(() => {
    const row = db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(c.dstPlaceId, c.dstRel) as number | undefined;
    if (row === undefined) upsertFiles(db, c.dstPlaceId, [{ relPath: c.dstRel, size: c.size, mtimeMs: c.mtimeMs, cloudOnly: false }], c.now, true);
    db.prepare(
      `UPDATE files SET sha256 = ?, hashed_at = ?, hash_error = NULL, origin_file_id = coalesce(origin_file_id, ?), backup_run_id = ?, expected_sha256 = ?, verified_at = ?, verified_how = 'read_both', gone_at = NULL, gone_reason = NULL
       WHERE place_id = ? AND rel_path = ?`,
    ).run(c.sha256, c.now, c.originId, c.runId, c.sha256, c.now, c.dstPlaceId, c.dstRel);
    learnSourceChecksum(db, c.srcRowId, c.size, c.sha256, c.now);
  }).immediate();
}

function learnSourceChecksum(db: Db, srcRowId: number, size: number, sha256: string, now: number): void {
  db.prepare('UPDATE files SET sha256 = ?, hashed_at = ? WHERE id = ? AND size = ? AND sha256 IS NULL').run(sha256, now, srcRowId, size);
}

/** Records a case for "Needs your decision" once per file and kind (an open or already seen one is not repeated). Returns true when a new one was made. */
export function addMirrorProblem(db: Db, srcRowId: number, kind: typeof MIRROR_DAMAGED_PROBLEM | typeof MIRROR_DIFFERS_PROBLEM, now: number): boolean {
  if (db.prepare("SELECT 1 FROM file_problems WHERE file_id = ? AND kind = ? AND state IN ('open', 'acknowledged')").get(srcRowId, kind)) return false;
  db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, ?, ?, 'open')").run(srcRowId, kind, now);
  return true;
}

/** "Leave it as it is": the person has seen the case. The file stays as it is on both drives and is not offered again. */
export function acknowledgeMirror(db: Db, problemId: number): number {
  return db.prepare("UPDATE file_problems SET state = 'acknowledged' WHERE id = ? AND kind IN ('mirror_damaged', 'mirror_differs') AND state = 'open'").run(problemId).changes;
}

/** Open cases of one backup's mirror (the number the status line shows). */
export function openMirrorProblems(db: Db, srcPlaceId: string, srcRoot: string): number {
  const prefix = srcRoot.replace(/^\/+|\/+$/g, '') + '/';
  return db
    .prepare(
      `SELECT count(*) FROM file_problems p JOIN files f ON f.id = p.file_id
       WHERE p.kind IN ('mirror_damaged', 'mirror_differs') AND p.state = 'open' AND f.place_id = ? AND substr(f.rel_path, 1, ?) = ?`,
    )
    .pluck()
    .get(srcPlaceId, prefix.length, prefix) as number;
}

/**
 * Rows a run made or linked, for the list on the second drive (same five columns as the phone backup's list; the second column is the phone path
 * when the copy came from the phone, else empty). Read a page at a time, then put in path order in slices.
 */
export function* listRowsSteps(db: Db, runId: number): Steps<ListRow[]> {
  const page = db.prepare(
    `SELECT c.id AS id, c.rel_path AS destRel, p.rel_path AS phoneRel, c.size AS size, c.mtime AS mtimeMs, c.sha256 AS sha256
     FROM files c LEFT JOIN files p ON p.id = c.origin_file_id WHERE c.backup_run_id = ? AND c.id > ? ORDER BY c.id LIMIT 1000`,
  );
  const out: ListRow[] = [];
  let after = 0;
  for (;;) {
    const rows = page.all(runId, after) as { id: number; destRel: string; phoneRel: string | null; size: number; mtimeMs: number | null; sha256: string | null }[];
    for (const r of rows) out.push({ destRel: r.destRel, phonePath: r.phoneRel === null ? '' : '/' + r.phoneRel, size: r.size, mtimeMs: r.mtimeMs, sha256: r.sha256 });
    if (rows.length < 1000) break;
    after = rows[rows.length - 1]!.id;
    yield;
  }
  yield* sortSteps(out, (a, b) => (a.destRel < b.destRel ? -1 : a.destRel > b.destRel ? 1 : 0));
  return out;
}


/** A same-size file of the second drive that was read and found equal to the first drive's checksum. */
export interface CheckedLink {
  dstPlaceId: string;
  dstRel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  originId: number | null;
  srcRowId: number;
  /** The first drive's file was read too (its row learns the checksum when it had none). */
  srcRead: boolean;
  now: number;
}

/**
 * The index side of "Check old copies", a batch in ONE transaction (the caller makes batches of a few hundred and gives the window a turn between them):
 * every equal file becomes a verified copy exactly as linkMirrorCopy makes it (checksum, verified_how 'read_both', points at the phone's row when it had
 * none; its own size, date and path are never touched), every different one becomes a "Needs your decision" case. Nothing is deleted or replaced.
 */
export function recordCheckedBatch(db: Db, links: readonly CheckedLink[], differs: readonly { srcRowId: number; now: number }[]): void {
  const update = db.prepare(
    `UPDATE files SET sha256 = ?, hashed_at = ?, hash_error = NULL, origin_file_id = coalesce(origin_file_id, ?), expected_sha256 = ?, verified_at = ?, verified_how = 'read_both', gone_at = NULL, gone_reason = NULL
     WHERE place_id = ? AND rel_path = ?`,
  );
  const learn = db.prepare('UPDATE files SET sha256 = ?, hashed_at = ? WHERE id = ? AND size = ? AND sha256 IS NULL');
  db.transaction(() => {
    for (const c of links) {
      if (update.run(c.sha256, c.now, c.originId, c.sha256, c.now, c.dstPlaceId, c.dstRel).changes === 0) {
        upsertFiles(db, c.dstPlaceId, [{ relPath: c.dstRel, size: c.size, mtimeMs: c.mtimeMs, cloudOnly: false }], c.now, true);
        update.run(c.sha256, c.now, c.originId, c.sha256, c.now, c.dstPlaceId, c.dstRel);
      }
      if (c.srcRead) learn.run(c.sha256, c.now, c.srcRowId, c.size);
    }
    for (const d of differs) addMirrorProblem(db, d.srcRowId, MIRROR_DIFFERS_PROBLEM, d.now);
  }).immediate();
}
