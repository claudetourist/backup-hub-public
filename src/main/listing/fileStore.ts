import type { PlaceFileStats } from '../../shared/listing';
import type { Db } from '../db';
import { makeKindResolver } from '../classify/sortKinds';
import { sliceClock, turn } from '../sliceWork';
import { prefixUpperBound } from './skipRules';

export interface ListedFile {
  relPath: string;
  size: number;
  mtimeMs: number;
  cloudOnly: boolean;
  /** The file system's id (NTFS only). Absent or null leaves the stored id as it was; a new one is saved silently (it is not a change of the file). */
  fsId?: string | null;
}

/**
 * Add or refresh listed files in ONE transaction. A row whose size or mtime changed loses its
 * fingerprints (sha256, md5, hashed_at) and its read error (hash_error), so a changed file is tried again; a row that comes back loses its gone_at. `keepCloudFlag`
 * leaves cloud_only as it was (used when the cloud check could not run). The kind of every row is set here (your own choice for the path wins),
 * so a newly listed or changed file is never left unsorted.
 */
export function upsertFiles(db: Db, placeId: string, files: readonly ListedFile[], now: number, keepCloudFlag: boolean): void {
  const write = upserter(db, placeId, now, keepCloudFlag);
  db.transaction(() => write(files)).immediate();
}

/** Rows written per transaction by `upsertFilesSliced`: about 30 ms of writing, so no single block reaches 100 ms. */
export const UPSERT_SLICE_ROWS = 500;

/**
 * Same rows, same statement, but in slices of `UPSERT_SLICE_ROWS` rows, each its own short transaction, with a turn of the event loop
 * (`pause`) whenever the main thread has worked for a moment: 60,000 rows in one transaction froze the window for about 4 seconds.
 * A stop between two slices leaves the rows written so far (each is a true fact about the file); callers that need all-or-nothing meaning
 * order their other writes after this one (see `recordLook`).
 */
export async function upsertFilesSliced(db: Db, placeId: string, files: readonly ListedFile[], now: number, keepCloudFlag: boolean, pause: () => Promise<void> = turn): Promise<void> {
  const write = upserter(db, placeId, now, keepCloudFlag);
  const due = sliceClock(pause);
  for (let i = 0; i < files.length; i += UPSERT_SLICE_ROWS) {
    const slice = files.slice(i, i + UPSERT_SLICE_ROWS);
    db.transaction(() => write(slice)).immediate();
    await due();
  }
}

function upserter(db: Db, placeId: string, now: number, keepCloudFlag: boolean): (files: readonly ListedFile[]) => void {
  const kindFor = makeKindResolver(db);
  const stmt = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, cloud_only, kind, fs_id)
     VALUES (@placeId, @relPath, @size, @mtime, @now, @now, @cloud, @kind, @fsId)
     ON CONFLICT (place_id, rel_path) DO UPDATE SET
       sha256    = CASE WHEN files.size IS excluded.size AND files.mtime IS excluded.mtime THEN files.sha256 END,
       md5       = CASE WHEN files.size IS excluded.size AND files.mtime IS excluded.mtime THEN files.md5 END,
       hashed_at = CASE WHEN files.size IS excluded.size AND files.mtime IS excluded.mtime THEN files.hashed_at END,
       hash_error = CASE WHEN files.size IS excluded.size AND files.mtime IS excluded.mtime THEN files.hash_error END,
       -- the stored kind follows size 0: a file that becomes empty, or stops being empty, gets its new kind; a row with none gets one now
       kind = CASE WHEN files.size IS excluded.size OR (files.size IS NOT 0 AND excluded.size IS NOT 0) THEN coalesce(files.kind, excluded.kind) ELSE excluded.kind END,
       size = excluded.size,
       mtime = excluded.mtime,
       last_seen_at = excluded.last_seen_at,
       gone_at = NULL,
       fs_id = coalesce(excluded.fs_id, files.fs_id),
       cloud_only = CASE WHEN @keepCloud = 1 THEN files.cloud_only ELSE excluded.cloud_only END`,
  );
  return (files) => {
    for (const f of files) {
      stmt.run({
        placeId,
        relPath: f.relPath,
        size: f.size,
        mtime: f.mtimeMs,
        now,
        cloud: f.cloudOnly ? 1 : 0,
        keepCloud: keepCloudFlag ? 1 : 0,
        kind: kindFor(placeId, f.relPath, null, f.size),
        fsId: f.fsId ?? null,
      });
    }
  };
}

export interface GoneScope {
  /** Rel path prefix ending in "/" for one folder, or '' for the whole place. */
  prefix: string;
  /** Folder prefixes (ending "/") that could not be read: their rows are left alone. */
  keepPrefixes: readonly string[];
  /** Individual files that could not be read: left alone. */
  keepPaths: readonly string[];
}

/** Most unreadable folders for which gone-marking is still precise; beyond it the root is not marked. */
export const MAX_KEEP_PREFIXES = 100;

/**
 * Mark rows in a scope that were not seen since `runStart` as gone. Never deletes. Returns how many
 * rows were marked. Call it only after the scope was walked completely.
 */
export function markGone(db: Db, placeId: string, scope: GoneScope, runStart: number, now: number): number {
  const { stmt, params } = goneStatement(db, placeId, scope, runStart, now);
  let total = 0;
  for (;;) {
    const changes = stmt.run(params).changes;
    total += changes;
    if (changes < GONE_SLICE_ROWS) return total;
  }
}

/** Same as `markGone`, but waits a moment between slices so another connection can write in between (the worker thread uses this). */
export async function markGoneSliced(db: Db, placeId: string, scope: GoneScope, runStart: number, now: number, pause: () => Promise<void>): Promise<number> {
  const { stmt, params } = goneStatement(db, placeId, scope, runStart, now);
  let total = 0;
  for (;;) {
    const changes = stmt.run(params).changes;
    total += changes;
    if (changes < GONE_SLICE_ROWS) return total;
    await pause();
  }
}

/**
 * In slices, each its own short transaction: one UPDATE over a million rows would hold the write lock for seconds,
 * and the main process (which writes job progress) would wait for it.
 */
function goneStatement(db: Db, placeId: string, scope: GoneScope, runStart: number, now: number): { stmt: ReturnType<Db['prepare']>; params: Record<string, string | number> } {
  const clauses = ['place_id = @placeId', 'gone_at IS NULL', 'last_seen_at < @runStart'];
  const params: Record<string, string | number> = { placeId, runStart, now };
  if (scope.prefix !== '') {
    clauses.push('rel_path >= @lo AND rel_path < @hi');
    params['lo'] = scope.prefix;
    params['hi'] = prefixUpperBound(scope.prefix);
  }
  scope.keepPrefixes.forEach((p, i) => {
    clauses.push(`NOT (rel_path >= @klo${i} AND rel_path < @khi${i})`);
    params[`klo${i}`] = p;
    params[`khi${i}`] = prefixUpperBound(p);
  });
  scope.keepPaths.forEach((p, i) => {
    clauses.push(`rel_path <> @kp${i}`);
    params[`kp${i}`] = p;
  });
  const sql = `UPDATE files SET gone_at = @now WHERE id IN (SELECT id FROM files WHERE ${clauses.join(' AND ')} LIMIT ${GONE_SLICE_ROWS})`;
  return { stmt: db.prepare(sql), params };
}

/** Rows marked gone per transaction (about 50 ms of writing on a big table). */
export const GONE_SLICE_ROWS = 250;

/** Mark every live row under one folder prefix as gone (used when a root is taken off the list). */
export function markFolderGone(db: Db, placeId: string, prefix: string, now: number): number {
  if (prefix === '') {
    return db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND gone_at IS NULL').run(now, placeId).changes;
  }
  return db
    .prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND gone_at IS NULL AND rel_path >= ? AND rel_path < ?')
    .run(now, placeId, prefix, prefixUpperBound(prefix)).changes;
}

/** Files, bytes and cloud-only count for live rows of every place that has any. */
export function allFileStats(db: Db): Map<string, PlaceFileStats> {
  const rows = db
    .prepare(
      `SELECT place_id, count(*) AS files, coalesce(sum(size), 0) AS bytes, coalesce(sum(cloud_only), 0) AS cloud
       FROM files WHERE gone_at IS NULL GROUP BY place_id`,
    )
    .all() as { place_id: string; files: number; bytes: number; cloud: number }[];
  return new Map(rows.map((r) => [r.place_id, { files: r.files, totalBytes: r.bytes, cloudOnly: r.cloud }]));
}

export function fileStatsFor(db: Db, placeId: string): PlaceFileStats {
  const r = db
    .prepare(
      `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes, coalesce(sum(cloud_only), 0) AS cloud
       FROM files WHERE place_id = ? AND gone_at IS NULL`,
    )
    .get(placeId) as { files: number; bytes: number; cloud: number };
  return { files: r.files, totalBytes: r.bytes, cloudOnly: r.cloud };
}
