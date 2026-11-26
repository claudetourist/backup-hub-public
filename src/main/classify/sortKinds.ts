import { isFileKind, kindOf, type FileKind } from '../../shared/fileKinds';
import type { Db } from '../db/connection';

/**
 * Sorting files into kinds (`files.kind`). It is not a job any more: the code that writes a `files` row sets the kind itself
 * (`makeKindResolver`), and the invisible upkeep process (src/main/upkeep) sorts old rows that still have none, in small chunks.
 * It only ever writes the `kind` column of rows whose kind is NULL; a row whose name, path or size changes gets its new kind from the
 * code that changes it. Nothing is deleted. "Rows with no kind" IS the work list, so a restart simply continues.
 */

/** Rows per chunk when the sorting runs on the calling thread (tests, tools): about 130 ms on 700k rows. */
export const CHUNK_ROWS = 5000;

/** Rows per chunk in the upkeep process: short write transactions, so a write from the main process never waits long. */
export const UPKEEP_CHUNK_ROWS = 2000;

interface Unsorted {
  id: number;
  rel_path: string;
  name: string;
  mime: string | null;
  size: number | null;
  /** The kind you gave this file yourself (table `kind_overrides`), or null. */
  chosen: string | null;
}

/** True when any row (live or gone) still has no kind. Reads only the small index of unsorted rows. */
export function hasUnclassified(db: Db): boolean {
  return db.prepare('SELECT 1 FROM files WHERE kind IS NULL LIMIT 1').get() !== undefined;
}

/** How many rows have no kind yet. */
export function countUnclassified(db: Db): number {
  return (db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n;
}

export interface ChunkResult {
  sorted: number;
  lastId: number | null;
}

/**
 * Sort one chunk: the next `limit` rows with no kind after `afterId`, in one transaction. A kind you chose yourself
 * (`kind_overrides`) always wins over the automatic one, so changing a kind survives sorting again. Returns how many were sorted
 * and the last id seen (null when nothing was left). The read and the writes share the transaction, so a row changed
 * meanwhile is never given a kind worked out from old data.
 */
export function classifyChunk(db: Db, afterId: number, limit: number = CHUNK_ROWS): ChunkResult {
  const select = db.prepare(
    `SELECT f.id, f.rel_path, f.name, f.mime, f.size, o.kind AS chosen FROM files f
       LEFT JOIN kind_overrides o ON o.place_id = f.place_id AND o.rel_path = f.rel_path
      WHERE f.kind IS NULL AND f.id > ? ORDER BY f.id LIMIT ?`,
  );
  const update = db.prepare('UPDATE files SET kind = ? WHERE id = ? AND kind IS NULL');
  // IMMEDIATE: the write lock is taken at BEGIN, where the busy timeout makes this wait for other writers. A plain (deferred)
  // transaction starts with a read, and when another connection wrote before its first UPDATE it failed at once with
  // SQLITE_BUSY_SNAPSHOT ("database is locked") without waiting.
  return db
    .transaction(() => {
      const rows = select.all(afterId, limit) as Unsorted[];
      for (const row of rows) update.run(isFileKind(row.chosen) ? row.chosen : kindOf(row.rel_path, row.name, row.mime, row.size), row.id);
      return { sorted: rows.length, lastId: rows.length > 0 ? rows[rows.length - 1]!.id : null };
    })
    .immediate();
}

/** True for "database is locked" (SQLITE_BUSY and its kin): another writer held the file for the whole wait. */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) || (err instanceof Error && /database is locked/i.test(err.message));
}

/** The file name of a stored path: what the generated `files.name` column holds (everything after the last "/"). */
export function nameOfRelPath(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/**
 * The kind a row gets when it is written: your own choice for that path (`kind_overrides`) when there is one, else the automatic kind
 * from the path, the mime type and the size. One prepared look-up on the primary key per row. The code that writes `files` rows calls
 * this so normally no row is left without a kind.
 */
export function makeKindResolver(db: Db): (placeId: string, relPath: string, mime: string | null, size: number | null) => FileKind {
  const chosen = db.prepare('SELECT kind FROM kind_overrides WHERE place_id = ? AND rel_path = ?').pluck();
  return (placeId, relPath, mime, size) => {
    const own = chosen.get(placeId, relPath);
    return isFileKind(own) ? own : kindOf(relPath, nameOfRelPath(relPath), mime, size);
  };
}
