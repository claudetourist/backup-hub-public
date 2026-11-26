import type { Db } from '../db';

/** A row waiting for its fingerprint. */
export interface QueueRow {
  id: number;
  rel_path: string;
  size: number;
  mtime: number | null;
}

/** Where the walk through the queue stands: rows come smallest first, ties by id. */
export interface QueueCursor {
  size: number;
  id: number;
}

export const START_CURSOR: QueueCursor = { size: -1, id: 0 };

/**
 * The next rows to fingerprint for one place, smallest first. This is the same condition as the
 * partial index idx_files_to_hash (no fingerprint, not gone, not cloud-only, no read error), so
 * errored rows are never in the queue. The cursor makes rows that were skipped in this run (changed,
 * cloud-only, unplugged) come up only once.
 */
export function nextBatch(db: Db, placeId: string, cursor: QueueCursor, limit: number): QueueRow[] {
  return db
    .prepare(
      `SELECT id, rel_path, size, mtime FROM files
        WHERE place_id = @placeId AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL
          AND (size, id) > (@size, @id)
        ORDER BY size, id LIMIT @limit`,
    )
    .all({ placeId, size: cursor.size, id: cursor.id, limit }) as QueueRow[];
}

export interface QueueTotals {
  files: number;
  bytes: number;
}

/** How many rows (and bytes) of one place are waiting for a fingerprint. */
export function queueTotals(db: Db, placeId: string): QueueTotals {
  const r = db
    .prepare(
      `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM files
        WHERE place_id = ? AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL`,
    )
    .get(placeId) as QueueTotals;
  return r;
}

export interface HashedResult {
  id: number;
  size: number;
  mtime: number | null;
  sha256: string;
  md5: string;
}

/** What one flush writes. */
export interface PendingWrites {
  hashed: HashedResult[];
  errors: { id: number; message: string }[];
  cloudOnly: number[];
}

export const emptyWrites = (): PendingWrites => ({ hashed: [], errors: [], cloudOnly: [] });

/** Write the results in ONE small transaction. A row is only updated if it still looks like the one that was read. */
export function writeResults(db: Db, writes: PendingWrites, now: number): void {
  const hashed = db.prepare(
    `UPDATE files SET sha256 = @sha256, md5 = @md5, hashed_at = @now, hash_error = NULL
      WHERE id = @id AND sha256 IS NULL AND size IS @size AND mtime IS @mtime`,
  );
  const failed = db.prepare('UPDATE files SET hash_error = ? WHERE id = ? AND sha256 IS NULL');
  const cloud = db.prepare('UPDATE files SET cloud_only = 1 WHERE id = ?');
  db.transaction(() => {
    for (const h of writes.hashed) hashed.run({ ...h, now });
    for (const e of writes.errors) failed.run(e.message, e.id);
    for (const id of writes.cloudOnly) cloud.run(id);
  })();
}

/** Put every errored file of a place back in the queue ("Try again"). Returns how many. */
export function clearErrors(db: Db, placeId: string): number {
  return db.prepare('UPDATE files SET hash_error = NULL WHERE place_id = ? AND hash_error IS NOT NULL AND gone_at IS NULL').run(placeId).changes;
}
