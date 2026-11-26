import type { Statement } from 'better-sqlite3';
import type { Db } from '../db/connection';

/**
 * The write side of the search index (migration 0026). It runs on the query worker's OWN read-write connection, never on the main thread:
 * - the tail fill: every file row above `filled_to` is added to the index (the first fill of the whole catalog and, later, every row a
 *   listing added since). Resumable at any point: each slice is one short transaction that also moves `filled_to`;
 * - the dirty queue: rows moved, renamed or deleted since they were indexed (triggers fill it, see the migration) are forgotten by their
 *   OLD values and added again by their new ones.
 * A slice is small on purpose: the main thread's own writes wait for the lock while a slice runs.
 */

/** The most rows one slice may hold. */
export const FILL_SLICE_ROWS = 400;
/** The rows of the first slice, before the time one takes has been measured. */
export const FIRST_SLICE_ROWS = 25;
/** The time one slice (one write transaction) is aimed at. */
export const TARGET_SLICE_MS = 30;

/**
 * Learns how many rows make a slice of about TARGET_SLICE_MS (the way `writeSliced` in sliceWork.ts does): starts small, at most doubles after a
 * slice, shrinks at once to what the measured time says, never more than `max`. A slice slowed by an index merge makes the next ones smaller
 * for a few slices, so a writer on the main thread that waited for one is not made to wait for another long one.
 */
export class SliceSizer {
  rows: number;

  constructor(
    private readonly max: number = FILL_SLICE_ROWS,
    private readonly targetMs: number = TARGET_SLICE_MS,
    first: number = FIRST_SLICE_ROWS,
  ) {
    this.rows = Math.min(first, max);
  }

  /** What the last slice did: `handled` rows in `tookMs`. */
  learn(handled: number, tookMs: number): void {
    if (handled <= 0) return;
    const aimed = Math.floor((handled * this.targetMs) / Math.max(tookMs, 0.05));
    this.rows = Math.max(1, Math.min(this.max, handled * 2, aimed));
  }
}

export interface IndexProgress {
  /** The first fill is over: the index may answer searches. */
  ready: boolean;
  /** The highest file id in the index. */
  filledTo: number;
  /** The highest file id there is. */
  maxId: number;
  /** Rows moved, renamed or deleted that the index has not caught up with. */
  dirty: number;
  /** 0 to 100 while the first fill runs, 100 after. */
  percent: number;
}

interface StateRow {
  filled_to: number;
  ready: number;
}

/** True when the index tables exist (a database older than schema 26 has none). */
function hasIndex(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_index_state'").get() !== undefined;
}

/** How far the index is. Null when this database has no index tables. Read only. */
export function indexProgress(db: Db): IndexProgress | null {
  if (!hasIndex(db)) return null;
  const state = db.prepare('SELECT filled_to, ready FROM search_index_state WHERE id = 1').get() as StateRow | undefined;
  if (!state) return null;
  const maxId = (db.prepare('SELECT max(id) FROM files').pluck().get() as number | null) ?? 0;
  const dirty = db.prepare('SELECT count(*) FROM search_dirty').pluck().get() as number;
  const ready = state.ready === 1;
  // Ids have gaps, so this is the share of the id range, not of the rows: close enough for a progress line.
  const percent = ready || maxId === 0 ? 100 : Math.min(99, Math.floor((state.filled_to * 100) / maxId));
  return { ready, filledTo: state.filled_to, maxId, dirty, percent };
}

interface Prepared {
  state: Statement<[]>;
  dirty: Statement<[number]>;
  dropDirty: Statement<[number]>;
  row: Statement<[number]>;
  tail: Statement<[number, number]>;
  forgetName: Statement<[number, string]>;
  forgetDir: Statement<[number, string]>;
  addName: Statement<[number, string]>;
  addDir: Statement<[number, string]>;
  setState: Statement<[number, number, number]>;
}

const prepared = new WeakMap<Db, Prepared>();

function statements(db: Db): Prepared {
  let p = prepared.get(db);
  if (!p) {
    p = {
      state: db.prepare<[]>('SELECT filled_to, ready FROM search_index_state WHERE id = 1'),
      dirty: db.prepare<[number]>('SELECT id, old_name, old_rel_path FROM search_dirty ORDER BY id LIMIT ?'),
      dropDirty: db.prepare<[number]>('DELETE FROM search_dirty WHERE id = ?'),
      row: db.prepare<[number]>('SELECT name, rel_path FROM files WHERE id = ?'),
      tail: db.prepare<[number, number]>('SELECT id, name, rel_path FROM files WHERE id > ? ORDER BY id LIMIT ?'),
      forgetName: db.prepare<[number, string]>("INSERT INTO search_names (search_names, rowid, name) VALUES ('delete', ?, ?)"),
      forgetDir: db.prepare<[number, string]>("INSERT INTO search_dirs (search_dirs, rowid, rel_path) VALUES ('delete', ?, ?)"),
      addName: db.prepare<[number, string]>('INSERT INTO search_names (rowid, name) VALUES (?, ?)'),
      addDir: db.prepare<[number, string]>('INSERT INTO search_dirs (rowid, rel_path) VALUES (?, ?)'),
      setState: db.prepare<[number, number, number]>('UPDATE search_index_state SET filled_to = ?, ready = ?, updated_at = ? WHERE id = 1'),
    };
    prepared.set(db, p);
  }
  return p;
}

/**
 * One slice: up to `rows` entries of the dirty queue, then (with the room left) the next rows above `filled_to`. One write transaction,
 * so a stop at any moment leaves a consistent index. Returns how many rows it handled (0 = nothing to do).
 */
export function fillSlice(db: Db, rows: number = FILL_SLICE_ROWS, now: number = Date.now()): number {
  if (!hasIndex(db)) return 0;
  const p = statements(db);
  const run = db.transaction((): number => {
    const state = p.state.get() as StateRow;
    let handled = 0;
    const dirty = p.dirty.all(rows) as { id: number; old_name: string; old_rel_path: string }[];
    for (const d of dirty) {
      p.forgetName.run(d.id, d.old_name);
      p.forgetDir.run(d.id, d.old_rel_path);
      const current = p.row.get(d.id) as { name: string; rel_path: string } | undefined;
      if (current) {
        p.addName.run(d.id, current.name);
        p.addDir.run(d.id, current.rel_path);
      }
      p.dropDirty.run(d.id);
      handled += 1;
    }
    let filledTo = state.filled_to;
    let ready = state.ready;
    const room = rows - handled;
    if (room > 0) {
      const tail = p.tail.all(filledTo, room) as { id: number; name: string; rel_path: string }[];
      for (const r of tail) {
        p.addName.run(r.id, r.name);
        p.addDir.run(r.id, r.rel_path);
        filledTo = r.id;
      }
      handled += tail.length;
      // The tail came up short: the fill has reached the end of the table.
      if (tail.length < room) ready = 1;
      if (tail.length > 0 || ready !== state.ready) p.setState.run(filledTo, ready, now);
    }
    return handled;
  });
  return run.immediate();
}

/** Runs slices until there is nothing left (tests and the benchmark; the app's worker sleeps between slices instead). */
export function catchUp(db: Db, rows: number = FILL_SLICE_ROWS): number {
  let total = 0;
  for (;;) {
    const n = fillSlice(db, rows);
    if (n === 0) return total;
    total += n;
  }
}

const FTS_TABLES = ['search_names', 'search_dirs'] as const;

/**
 * FTS5 merges its segments inside the commit of the write that made too many (automerge), and one such commit held the write lock for up to
 * 740 ms (5 s once) on the real-size copy, whatever the number of rows in it. So during the first fill the merging is taken out of the commits
 * and done in steps of its own (`mergeStep`), each a short transaction: 'fill' turns automerge off and sets crisismerge so high it cannot fire;
 * 'normal' puts back FTS5's defaults (automerge 4, crisismerge 16) for the small writes after the fill. Safe to repeat.
 */
export function setMergeMode(db: Db, mode: 'fill' | 'normal'): void {
  const automerge = mode === 'fill' ? 0 : 4;
  const crisis = mode === 'fill' ? 1_000_000 : 16;
  for (const table of FTS_TABLES) {
    db.exec(`INSERT INTO ${table} (${table}, rank) VALUES ('automerge', ${automerge})`);
    db.exec(`INSERT INTO ${table} (${table}, rank) VALUES ('crisismerge', ${crisis})`);
  }
}

/** The pages one merge step starts with, before the time one takes has been measured. */
export const FIRST_MERGE_PAGES = 16;
/** The most pages one merge step may merge. */
export const MAX_MERGE_PAGES = 256;

/**
 * One bounded merge step on both index tables, in ONE short transaction: FTS5's 'merge' command with `pages` pages of work. Returns whether
 * either table still had something to merge (a table with nothing to do changes one row, the documented "changes() unchanged" test).
 */
export function mergeStep(db: Db, pages: number): boolean {
  if (!hasIndex(db)) return false;
  const total = db.prepare<[]>('SELECT total_changes()').pluck();
  let work = false;
  db.transaction(() => {
    for (const table of FTS_TABLES) {
      const before = total.get() as number;
      db.exec(`INSERT INTO ${table} (${table}, rank) VALUES ('merge', ${Math.max(1, Math.floor(pages))})`);
      if ((total.get() as number) - before >= 2) work = true;
    }
  }).immediate();
  return work;
}
