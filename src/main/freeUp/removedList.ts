/**
 * The files removed from a phone and not put back: one scan of the removal log in short slices, so a log of 50,000 lines never holds the
 * window (CLAUDE.md: the window must never freeze). The log keeps which backup a line belongs to only inside its first voucher (JSON), so
 * the filter reads that JSON per line; the scan walks the ids in blocks of `BLOCK_IDS` and gives the event loop a turn between blocks.
 */
import type { Db } from '../db/connection';
import { STEP_ITEMS, type Steps } from '../sliceWork';

/** Ids per block: about a thousand log lines, a few milliseconds even on a big log. */
const BLOCK_IDS = Math.max(STEP_ITEMS * 5, 1_000);

export interface RemovedScan {
  /** Newest removal first. */
  ids: number[];
  sizes: number[];
  totalBytes: number;
}

/** The log lines of this backup's first drive that are removed from the phone and not put back. */
export function removedFilter(first: { placeId: string; root: string } | null): { filter: string; args: (string | number)[] } {
  const prefix = first && first.root !== '' ? `${first.root}/` : '';
  return {
    // The unary plus keeps SQLite on the id range of the block (it would walk every phone line through the kind index for each block).
    filter: `+r.kind = 'phone' AND +r.undone_at IS NULL AND json_extract(r.vouchers_json, '$[0].placeId') = ? AND substr(json_extract(r.vouchers_json, '$[0].relPath'), 1, ?) = ?`,
    args: [first?.placeId ?? '', prefix.length, prefix],
  };
}

export function* scanRemoved(db: Db, first: { placeId: string; root: string } | null): Steps<RemovedScan> {
  const { filter, args } = removedFilter(first);
  const span = db.prepare('SELECT min(id) AS lo, max(id) AS hi FROM removal_log').get() as { lo: number | null; hi: number | null };
  const out: RemovedScan = { ids: [], sizes: [], totalBytes: 0 };
  if (span.lo === null || span.hi === null) return out;
  const stmt = db.prepare(`SELECT r.id, r.size FROM removal_log r WHERE r.id BETWEEN ? AND ? AND ${filter} ORDER BY r.id DESC`).raw();
  for (let hi = span.hi; hi >= span.lo; hi -= BLOCK_IDS) {
    const lo = Math.max(span.lo, hi - BLOCK_IDS + 1);
    for (const [id, size] of stmt.all(lo, hi, ...args) as [number, number][]) {
      out.ids.push(id);
      out.sizes.push(size);
      out.totalBytes += size;
    }
    yield;
  }
  return out;
}
