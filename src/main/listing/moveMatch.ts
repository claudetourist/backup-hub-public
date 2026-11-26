/**
 * R1.6: a file renamed or moved on the laptop or OneDrive is the SAME file, not a new one (PLAN 3c rule 2). After a COMPLETE look (the caller runs this only then),
 * a row that vanished in the look and a row that appeared in the look with the same file-system id, the same size and a date within 2 seconds are one file:
 * the OLD row is kept (its id, its checksum, every copy and origin link that points at it) and given the new path; the freshly listed duplicate row is dropped
 * (it was made by this look and nothing points at it). The old path goes to `file_paths` (to_at set) and the new one starts there (to_at empty).
 *
 * Only where ids are trusted (NTFS: laptop, OneDrive: the callers only save an id there). Anything not clear-cut (two files with one id, a hard link that is still
 * there, a date or size that differs, a new row something already points at) is left alone: the file is then handled as before (copied if it is new). A moved AND
 * edited file differs in size or date, so it is not matched: it is a new file. Nothing in a backup is ever touched; only the index of this place changes.
 */
import type { Db } from '../db';
import { sliceClock, turn } from '../sliceWork';

/** Dates this close are one date (FAT and exFAT keep 2-second dates). */
export const MOVE_DATE_TOLERANCE_MS = 2000;
/** Most vanished rows looked at in one look; a place that lost more than this at once (a wiped folder) is not a rename, whatever matches. */
export const MAX_VANISHED = 200_000;
/** Pairs written per transaction: each drops one row and rewrites another (a dozen indexes each), about 1 ms a pair; 100 per transaction blocked a thread for 170 ms. */
const WRITE_SLICE = 20;

export interface MoveMatchOptions {
  placeId: string;
  /** When the look began: rows marked gone since then vanished in this look; rows first seen since then appeared in it. */
  runStart: number;
  now: number;
  /** A turn of the event loop between slices (the worker thread passes a short timer). */
  pause?: () => Promise<void>;
}

export interface MoveMatchResult {
  moved: number;
  /** Vanished rows that had an id but were not matched (no new row, or not clear-cut). */
  unmatched: number;
}

interface Vanished {
  id: number;
  rel_path: string;
  size: number;
  mtime: number | null;
  fs_id: string;
  first_seen_at: number;
}

interface Candidate {
  id: number;
  rel_path: string;
  size: number | null;
  mtime: number | null;
  first_seen_at: number;
  last_seen_at: number;
  gone_at: number | null;
  cloud_only: number;
  kind: string | null;
  sha256: string | null;
  md5: string | null;
  hashed_at: number | null;
}

interface Pair {
  old: Vanished;
  fresh: Candidate;
}

export async function matchMoves(db: Db, o: MoveMatchOptions): Promise<MoveMatchResult> {
  const pause = o.pause ?? turn;
  const due = sliceClock(pause);
  const vanished = db
    .prepare(
      `SELECT id, rel_path, size, mtime, fs_id, first_seen_at FROM files INDEXED BY idx_files_gone_fs
       WHERE place_id = ? AND gone_at IS NOT NULL AND gone_at >= ? AND fs_id IS NOT NULL AND (gone_reason IS NULL OR gone_reason = 'gone_from_source') AND size IS NOT NULL LIMIT ${MAX_VANISHED + 1}`,
    )
    .all(o.placeId, o.runStart) as Vanished[];
  if (vanished.length === 0) return { moved: 0, unmatched: 0 };
  if (vanished.length > MAX_VANISHED) return { moved: 0, unmatched: vanished.length };

  const byId = new Map<string, Vanished[]>();
  for (const v of vanished) {
    const list = byId.get(v.fs_id);
    if (list) list.push(v);
    else byId.set(v.fs_id, [v]);
  }
  const sameId = db.prepare(
    `SELECT id, rel_path, size, mtime, first_seen_at, last_seen_at, gone_at, cloud_only, kind, sha256, md5, hashed_at FROM files INDEXED BY idx_files_fs_id
     WHERE place_id = ? AND fs_id = ?`,
  );
  const pairs: Pair[] = [];
  for (const [fsId, olds] of byId) {
    await due();
    if (olds.length !== 1) continue;
    const old = olds[0]!;
    const rows = sameId.all(o.placeId, fsId) as Candidate[];
    const live = rows.filter((r) => r.gone_at === null);
    const fresh = live.filter((r) => r.first_seen_at >= o.runStart);
    // One new row, and no other live row with this id (a hard link that is still there makes "which one moved" a guess).
    if (fresh.length !== 1 || live.length !== 1) continue;
    const row = fresh[0]!;
    if (row.size !== old.size || row.mtime === null || old.mtime === null || Math.abs(row.mtime - old.mtime) > MOVE_DATE_TOLERANCE_MS) continue;
    if (row.rel_path === old.rel_path) continue;
    pairs.push({ old, fresh: row });
  }

  const write = writer(db, o);
  let moved = 0;
  for (let i = 0; i < pairs.length; i += WRITE_SLICE) {
    moved += write(pairs.slice(i, i + WRITE_SLICE));
    await due();
  }
  return { moved, unmatched: vanished.length - moved };
}

function writer(db: Db, o: MoveMatchOptions): (pairs: Pair[]) => number {
  const getOld = db.prepare('SELECT gone_at, rel_path, fs_id FROM files WHERE id = ?');
  const getFresh = db.prepare('SELECT gone_at, rel_path, fs_id, first_seen_at FROM files WHERE id = ?');
  const pointedAt = db.prepare('SELECT (SELECT 1 FROM files WHERE origin_file_id = @id LIMIT 1) IS NOT NULL OR (SELECT 1 FROM file_problems WHERE file_id = @id LIMIT 1) IS NOT NULL').pluck();
  const dropFresh = db.prepare('DELETE FROM files WHERE id = ?');
  const moveOld = db.prepare(
    `UPDATE files SET rel_path = @rel, size = @size, mtime = @mtime, last_seen_at = @seen, gone_at = NULL, gone_reason = NULL, cloud_only = @cloud,
       kind = coalesce(@kind, kind),
       hashed_at = CASE WHEN sha256 IS NULL AND @sha IS NOT NULL THEN @hashedAt ELSE hashed_at END,
       sha256 = coalesce(sha256, @sha), md5 = coalesce(md5, @md5)
     WHERE id = @id`,
  );
  const closePath = db.prepare('UPDATE file_paths SET to_at = ? WHERE file_id = ? AND to_at IS NULL');
  const addPath = db.prepare('INSERT INTO file_paths (file_id, rel_path, from_at, to_at) VALUES (?, ?, ?, ?)');
  const one = (p: Pair): boolean => {
    const old = getOld.get(p.old.id) as { gone_at: number | null; rel_path: string; fs_id: string | null } | undefined;
    const fresh = getFresh.get(p.fresh.id) as { gone_at: number | null; rel_path: string; fs_id: string | null; first_seen_at: number } | undefined;
    // Re-read inside the transaction: another connection may have written since the pairs were made.
    if (!old || old.gone_at === null || old.rel_path !== p.old.rel_path || old.fs_id !== p.old.fs_id) return false;
    if (!fresh || fresh.gone_at !== null || fresh.rel_path !== p.fresh.rel_path || fresh.fs_id !== p.old.fs_id || fresh.first_seen_at < o.runStart) return false;
    if ((pointedAt.get({ id: p.fresh.id }) as number) === 1) return false;
    dropFresh.run(p.fresh.id);
    moveOld.run({ id: p.old.id, rel: p.fresh.rel_path, size: p.fresh.size, mtime: p.fresh.mtime, seen: p.fresh.last_seen_at, cloud: p.fresh.cloud_only, kind: p.fresh.kind, sha: p.fresh.sha256, md5: p.fresh.md5, hashedAt: p.fresh.hashed_at });
    // The path history: close the path the row had (or start the history with it), then open the new one.
    if (closePath.run(o.now, p.old.id).changes === 0) addPath.run(p.old.id, p.old.rel_path, p.old.first_seen_at, o.now);
    addPath.run(p.old.id, p.fresh.rel_path, o.now, null);
    return true;
  };
  return (pairs) => {
    let n = 0;
    db.transaction(() => {
      for (const p of pairs) if (one(p)) n += 1;
    }).immediate();
    return n;
  };
}
