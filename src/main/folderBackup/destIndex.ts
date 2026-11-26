/**
 * What the backup folder on the drive already holds, from the index (read only, in slices): every live row under the backup folder, found two ways
 * so the old tool's copies and Backup Hub's own are both recognised: by the row's source link (`origin_file_id`, set by the history import and by every
 * copy made here) and by its place ("<dated folder>/<path below the backed-up folder>"). Nothing is written.
 */
import type { Db } from '../db';
import { judgeChange, type ChangeRule } from '../look/compare';
import { prefixUpperBound } from '../listing/skipRules';
import { STEP_ITEMS, type Steps } from '../sliceWork';
import { nameKey, parseSessionRel } from './folderPaths';

/** One copy of a file in the backup (a dated folder holds one version of it). */
export interface DestVersion {
  id: number;
  relPath: string;
  size: number | null;
  mtimeMs: number | null;
  /** The checksum the index holds for the copy (its own, else the one it must have). */
  sha256: string | null;
  /** read_both: Backup Hub read both sides. The history import and the old tool's copies are 'imported' or unknown. */
  verified: boolean;
  sessionAt: number;
  origin: number | null;
  /** The path below its dated folder (where the file was when it was backed up), or null for a copy not under a dated folder. */
  rest: string | null;
}

export interface DestIndex {
  /** Copies by the lower-case path below the dated folder. A key with one copy holds it directly. */
  byKey: Map<string, DestVersion | DestVersion[]>;
  /** Copies by the source row they came from. */
  byOrigin: Map<number, DestVersion[]>;
  /** Flat layout: name (lower case, below the folder) -> size and row. */
  flat: Map<string, { id: number; size: number | null }>;
  rows: number;
}

const PAGE = 5000;

interface Row {
  id: number;
  rel_path: string;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  expected_sha256: string | null;
  origin_file_id: number | null;
  verified_how: string | null;
}

/** Reads the backup folder's rows a page at a time (the caller runs the steps in slices). `prefix` is the backup's folder prefix ("OneDrive"); `flat` skips dated folders. */
export function* loadDestSteps(db: Db, o: { placeId: string; root: string; prefix: string; flat: boolean }): Steps<DestIndex> {
  const index: DestIndex = { byKey: new Map(), byOrigin: new Map(), flat: new Map(), rows: 0 };
  const base = o.root.replace(/\/+$/, '') + '/';
  const hi = prefixUpperBound(base);
  const page = db.prepare(
    `SELECT id, rel_path, size, mtime, sha256, expected_sha256, origin_file_id, verified_how FROM files
     WHERE place_id = ? AND rel_path > ? AND rel_path < ? AND gone_at IS NULL ORDER BY rel_path LIMIT ${PAGE}`,
  );
  let last = base;
  let n = 0;
  for (;;) {
    const rows = page.all(o.placeId, last, hi) as Row[];
    for (const r of rows) {
      if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
      index.rows += 1;
      const below = r.rel_path.slice(base.length);
      if (o.flat) {
        index.flat.set(nameKey(below), { id: r.id, size: r.size });
        continue;
      }
      // A copy "Check old copies" read and found different never counts as backed up.
      if (r.verified_how === 'differs') continue;
      const parsed = parseSessionRel(o.prefix, below);
      const v: DestVersion = { id: r.id, relPath: r.rel_path, size: r.size, mtimeMs: r.mtime, sha256: r.sha256 ?? r.expected_sha256, verified: r.verified_how === 'read_both', sessionAt: parsed?.sessionAt ?? 0, origin: r.origin_file_id, rest: parsed?.rest ?? null };
      if (parsed !== null) {
        const key = nameKey(parsed.rest);
        const have = index.byKey.get(key);
        if (have === undefined) index.byKey.set(key, v);
        else if (Array.isArray(have)) have.push(v);
        else index.byKey.set(key, [have, v]);
      }
      if (r.origin_file_id !== null) {
        const list = index.byOrigin.get(r.origin_file_id);
        if (list) list.push(v);
        else index.byOrigin.set(r.origin_file_id, [v]);
      }
    }
    if (rows.length < PAGE) return index;
    last = rows[rows.length - 1]!.rel_path;
    yield;
  }
}

export interface Wanted {
  size: number;
  mtimeMs: number;
  sha256: string | null;
}

export type CopyMatch = { kind: 'same'; copy: DestVersion } | { kind: 'confirm'; copy: DestVersion };

/**
 * Is the file, as it is now, already in the backup? 'same': a copy with the same size and date (the change rule decides: folders copy again when size OR
 * date differs; dates within 2 seconds are one date), or whose checksum equals the file's. 'confirm': same size and a date off by exact whole hours
 * (time zone, summer time): only a checksum can say, so the run reads it and decides. Null: no copy of this version.
 */
export function findCopy(rule: ChangeRule, now: Wanted, copies: readonly DestVersion[]): CopyMatch | null {
  let confirm: DestVersion | null = null;
  let best: DestVersion | null = null;
  for (const c of copies) {
    if (c.size === null || c.size !== now.size) continue;
    const sameContent = now.sha256 !== null && c.sha256 !== null && now.sha256 === c.sha256;
    const verdict = sameContent ? 'same' : judgeChange(rule, { size: c.size, mtimeMs: c.mtimeMs }, { size: now.size, mtimeMs: now.mtimeMs });
    if (verdict === 'same') {
      if (best === null || (c.verified && !best.verified)) best = c;
    } else if (verdict === 'confirm' && confirm === null) confirm = c;
  }
  if (best !== null) return { kind: 'same', copy: best };
  return confirm !== null ? { kind: 'confirm', copy: confirm } : null;
}

/** All the copies a file might have: those that name it as their source, and those at its place in a dated folder. */
export function copiesOf(index: DestIndex, rowId: number | null, rel: string): DestVersion[] {
  const out: DestVersion[] = [];
  if (rowId !== null) {
    const o = index.byOrigin.get(rowId);
    if (o) out.push(...o);
  }
  const k = index.byKey.get(nameKey(rel));
  if (k !== undefined) {
    if (Array.isArray(k)) {
      for (const v of k) if (!out.includes(v)) out.push(v);
    } else if (!out.includes(k)) out.push(k);
  }
  return out;
}
