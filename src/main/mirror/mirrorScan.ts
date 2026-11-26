/**
 * What the second drive is missing, read from the file list (the index) alone: no drive is touched. One paged walk over the first drive's
 * rows under the backup folder, each row asked about its counterpart at the same relative path on the second drive (one point lookup on the
 * unique (place, path) index, never a scan: see CLAUDE.md "EXPLAIN QUERY PLAN for queries inside loops"). Written once as steps (sliceWork.ts):
 * the plan runs them sliced on the main thread, the Backups counts run them whole on a worker thread.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db';
import { prefixUpperBound } from '../listing/skipRules';
import { finishSync, sortSteps, STEP_ITEMS, type Steps } from '../sliceWork';
import { MIRROR_DAMAGED_PROBLEM, MIRROR_DIFFERS_PROBLEM } from '../../shared/mirror';
import type { MirrorCountPair, MirrorItem, MirrorPair } from './mirrorTypes';

const PAGE_ROWS = 2000;

interface PageRow {
  id: number;
  rel: string;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  expected: string | null;
  origin: number | null;
  srcVerified: string | null;
  dstSize: number | null;
  dstVerified: string | null;
  known: number;
}

const cleanRoot = (root: string): string => root.replace(/^\/+|\/+$/g, '');

/** The statement that reads one page: the first drive's rows after `after`, each with the second drive's size at the same place (null: not there). */
function pageStatement(db: Db, pair: MirrorCountPair): (after: string, limit: number) => PageRow[] {
  const srcRoot = cleanRoot(pair.srcRoot);
  const dstRoot = cleanRoot(pair.dstRoot);
  const prefix = srcRoot + '/';
  const hi = prefixUpperBound(prefix);
  // substr is 1-based: the part after "<srcRoot>/" starts at srcRoot.length + 2.
  const cut = srcRoot.length + 2;
  const stmt = db.prepare(
    `SELECT a.id AS id, a.rel_path AS rel, a.size AS size, a.mtime AS mtime, a.sha256 AS sha256, a.expected_sha256 AS expected, a.origin_file_id AS origin, a.verified_how AS srcVerified,
       b.size AS dstSize, b.verified_how AS dstVerified,
       EXISTS (SELECT 1 FROM file_problems p WHERE p.file_id = a.id AND p.kind IN ('${MIRROR_DAMAGED_PROBLEM}', '${MIRROR_DIFFERS_PROBLEM}') AND p.state IN ('open', 'acknowledged')) AS known
     FROM files a LEFT JOIN files b ON b.place_id = @dst AND b.rel_path = @dstPrefix || substr(a.rel_path, @cut) AND b.gone_at IS NULL
     WHERE a.place_id = @src AND a.rel_path > @after AND a.rel_path < @hi AND a.gone_at IS NULL ORDER BY a.rel_path LIMIT @limit`,
  );
  return (after, limit) => stmt.all({ src: pair.srcPlaceId, dst: pair.dstPlaceId, dstPrefix: dstRoot + '/', cut, after: after === '' ? prefix : after, hi, limit }) as PageRow[];
}

export interface PairScan {
  copy: MirrorItem[];
  /** Same size on the second drive and not proven yet: only counted here (the copy never reads them); the check job lists them. */
  same: { files: number; bytes: number };
  /** Same size on the second drive and already proven (verified copy). */
  proven: number;
  different: MirrorItem[];
  /** Files already asked about (a damaged copy, a different file): left out of every list. */
  knownProblems: number;
}

/** Walks one pair. `b` is the pair's index in the plan. */
export function* scanPairSteps(db: Db, pair: MirrorCountPair, b: number): Steps<PairScan> {
  const page = pageStatement(db, pair);
  const out: PairScan = { copy: [], same: { files: 0, bytes: 0 }, proven: 0, different: [], knownProblems: 0 };
  const prefixLen = cleanRoot(pair.srcRoot).length + 1;
  let after = '';
  for (;;) {
    const rows = page(after, PAGE_ROWS);
    for (const r of rows) {
      const size = r.size ?? 0;
      if (r.known === 1) {
        out.knownProblems += 1;
        continue;
      }
      if (r.dstSize === size) {
        if (r.dstVerified === 'read_both') out.proven += 1;
        else {
          out.same.files += 1;
          out.same.bytes += size;
        }
        continue;
      }
      const item: MirrorItem = {
        b,
        rel: r.rel.slice(prefixLen),
        size,
        mtimeMs: r.mtime ?? 0,
        srcRowId: r.id,
        originId: r.origin,
        sha256: r.expected ?? r.sha256,
        expected: r.expected !== null,
        kind: r.dstSize === null ? 'copy' : 'different',
      };
      (item.kind === 'copy' ? out.copy : out.different).push(item);
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.rel;
    yield;
  }
  return out;
}

export interface CheckScan {
  items: MirrorItem[];
  /** Same size on the second drive, already proven. */
  proven: number;
  knownProblems: number;
}

/**
 * The files of one pair that are on the second drive with the same size and not proven yet, each with the first drive's checksum when it is KNOWN
 * (the phone's expected one, or one proven earlier: verified_how read_both); null = the first drive's file has to be read as well.
 */
export function* checkScanSteps(db: Db, pair: MirrorCountPair, b: number): Steps<CheckScan> {
  const page = pageStatement(db, pair);
  const out: CheckScan = { items: [], proven: 0, knownProblems: 0 };
  const prefixLen = cleanRoot(pair.srcRoot).length + 1;
  let after = '';
  for (;;) {
    const rows = page(after, PAGE_ROWS);
    for (const r of rows) {
      const size = r.size ?? 0;
      if (r.dstSize !== size) continue;
      if (r.known === 1) {
        out.knownProblems += 1;
        continue;
      }
      if (r.dstVerified === 'read_both') {
        out.proven += 1;
        continue;
      }
      const sha256 = r.expected ?? (r.srcVerified === 'read_both' ? r.sha256 : null);
      out.items.push({ b, rel: r.rel.slice(prefixLen), size, mtimeMs: r.mtime ?? 0, srcRowId: r.id, originId: r.origin, sha256, expected: sha256 !== null, kind: 'check' });
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.rel;
    yield;
  }
  return out;
}

export interface Behind {
  files: number;
  bytes: number;
}

/** How many files the second drive lacks (not there, or there with another size) and how many bytes: the "behind by" of Home and Backups. */
export function* behindSteps(db: Db, pair: MirrorCountPair): Steps<Behind> {
  const page = pageStatement(db, pair);
  const out: Behind = { files: 0, bytes: 0 };
  let after = '';
  for (;;) {
    const rows = page(after, PAGE_ROWS);
    for (const r of rows) {
      const size = r.size ?? 0;
      if (r.dstSize !== size) {
        out.files += 1;
        out.bytes += size;
      }
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.rel;
    yield;
  }
  return out;
}

/** The same count all at once (the worker thread, tests, scripts). */
export const behindOf = (db: Db, pair: MirrorCountPair): Behind => finishSync(behindSteps(db, pair));

export interface PlanData {
  copy: MirrorItem[];
  /** Same size on the second drive, not proven yet (counted, not listed: see checkScanSteps). */
  same: { files: number; bytes: number };
  proven: number;
  different: MirrorItem[];
  knownProblems: number;
  /** Per pair: files and bytes to copy. */
  perPair: { files: number; bytes: number }[];
  hash: string;
}

const bySizeThenPath = (a: MirrorItem, b: MirrorItem): number => b.size - a.size || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.b - b.b);

/** The plan of all pairs: what to copy (largest first), how many same-size files are not proven yet (counted only), what is different, and the hash that ties the screen to this list. */
export function* planSteps(db: Db, pairs: readonly MirrorPair[]): Steps<PlanData> {
  const data: PlanData = { copy: [], same: { files: 0, bytes: 0 }, proven: 0, different: [], knownProblems: 0, perPair: pairs.map(() => ({ files: 0, bytes: 0 })), hash: '' };
  for (const [b, pair] of pairs.entries()) {
    const scan = yield* scanPairSteps(db, pair, b);
    for (const i of scan.copy) data.copy.push(i);
    data.same.files += scan.same.files;
    data.same.bytes += scan.same.bytes;
    data.proven += scan.proven;
    for (const i of scan.different) data.different.push(i);
    data.knownProblems += scan.knownProblems;
    for (const i of scan.copy) {
      data.perPair[b]!.files += 1;
      data.perPair[b]!.bytes += i.size;
    }
    yield;
  }
  yield* sortSteps(data.copy, bySizeThenPath);
  const sha = createHash('sha256');
  let n = 0;
  for (const i of data.copy) {
    sha.update(`${i.b}|${i.rel}|${i.size}\n`);
    if (++n % STEP_ITEMS === 0) yield;
  }
  sha.update(`c${data.same.files}|d${data.different.length}`);
  data.hash = sha.digest('hex');
  return data;
}

/** The id of a row on the screen and in an untick. */
export const rowId = (b: number, rel: string): string => `${b}:${rel}`;
