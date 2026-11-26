import type { CoverageBucket, FileCopy, PlaceCoverage } from '../../shared/fingerprint';
import type { Db } from '../db';

/**
 * The copies index: a query module over `files`, no table of its own.
 * - Local to local: same SHA-256.
 * - Local to Google Drive (and Drive to Drive): same MD5 and same size. Drive rows have an MD5 but
 *   no SHA-256, and every fingerprinted local file has both.
 * - Rows marked gone never count. A file that is only in the cloud (OneDrive placeholder) has no
 *   fingerprint until it is on this PC, so it matches nothing and is reported on its own.
 */

interface FileRow {
  id: number;
  place_id: string;
  size: number | null;
  sha256: string | null;
  md5: string | null;
  gone_at: number | null;
}

interface CopyRow {
  id: number;
  place_id: string;
  label: string;
  kind: string;
  rel_path: string;
  size: number | null;
  cloud_only: number;
}

/**
 * Every other place and path that holds the same content as file `fileId` (other paths in the same
 * place are included too, so a duplicate inside one place is visible). Empty when the file is gone,
 * not fingerprinted, or unknown.
 */
export function copiesFor(db: Db, fileId: number): FileCopy[] {
  const me = db.prepare('SELECT id, place_id, size, sha256, md5, gone_at FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
  // An empty file (size 0) is not a copy of any other empty file.
  if (!me || me.gone_at !== null || me.size === 0) return [];
  const found = new Map<number, FileCopy>();
  const collect = (rows: CopyRow[], match: FileCopy['match']): void => {
    for (const r of rows) {
      if (found.has(r.id)) continue;
      found.set(r.id, {
        fileId: r.id,
        placeId: r.place_id,
        placeLabel: r.label,
        placeKind: r.kind,
        relPath: r.rel_path,
        size: r.size,
        match,
        cloudOnly: r.cloud_only === 1,
      });
    }
  };
  const select = `SELECT f.id, f.place_id, p.label, p.kind, f.rel_path, f.size, f.cloud_only
                    FROM files f JOIN places p ON p.id = f.place_id`;
  if (me.sha256 !== null) {
    collect(
      db.prepare(`${select} WHERE f.sha256 = ? AND f.gone_at IS NULL AND f.id <> ? ORDER BY p.label, f.rel_path`).all(me.sha256, me.id) as CopyRow[],
      'sha256',
    );
  }
  if (me.md5 !== null && me.size !== null) {
    // A row with its own SHA-256 was already matched (or not) by SHA-256: MD5 only decides for rows without one.
    const needsNoSha = me.sha256 === null ? '' : 'AND f.sha256 IS NULL';
    collect(
      db
        .prepare(`${select} WHERE f.md5 = ? AND f.size = ? AND f.gone_at IS NULL AND f.id <> ? ${needsNoSha} ORDER BY p.label, f.rel_path`)
        .all(me.md5, me.size, me.id) as CopyRow[],
      'md5+size',
    );
  }
  return [...found.values()];
}

const emptyBucket = (): CoverageBucket => ({ files: 0, bytes: 0 });

/** Rows of one place grouped by content, with the number of OTHER places that hold that content. */
const COVERAGE_SQL = `
WITH mine AS (
  SELECT sha256, md5, size, count(*) AS files, coalesce(sum(size), 0) AS bytes
    FROM files
   WHERE place_id = @placeId AND gone_at IS NULL AND size IS NOT 0 AND (sha256 IS NOT NULL OR md5 IS NOT NULL)
   GROUP BY sha256, md5, size
)
SELECT m.files, m.bytes,
  CASE WHEN m.sha256 IS NULL THEN 0 ELSE
    (SELECT count(DISTINCT o.place_id) FROM files o
      WHERE o.sha256 = m.sha256 AND o.gone_at IS NULL AND o.place_id <> @placeId)
  END
  +
  CASE WHEN m.md5 IS NULL OR m.size IS NULL THEN 0 ELSE
    (SELECT count(DISTINCT o.place_id) FROM files o
      WHERE o.md5 = m.md5 AND o.size = m.size AND o.gone_at IS NULL AND o.place_id <> @placeId
        AND (m.sha256 IS NULL OR o.sha256 IS NULL))
  END AS others
FROM mine m
`;

/**
 * For one place: its live files and bytes with 0, 1, and 2 or more copies in OTHER places (counted
 * as places, not as files), plus the files not fingerprinted yet and the cloud-only ones. The
 * content groups are looked up once each, so thousands of identical empty files cost one lookup.
 */
export function placeCoverage(db: Db, placeId: string): PlaceCoverage {
  const out: PlaceCoverage = {
    none: emptyBucket(),
    one: emptyBucket(),
    twoPlus: emptyBucket(),
    notFingerprinted: emptyBucket(),
    cloudOnly: emptyBucket(),
    empty: emptyBucket(),
  };
  const add = (bucket: CoverageBucket, files: number, bytes: number): void => {
    bucket.files += files;
    bucket.bytes += bytes;
  };
  for (const r of db.prepare(COVERAGE_SQL).all({ placeId }) as { files: number; bytes: number; others: number }[]) {
    add(r.others === 0 ? out.none : r.others === 1 ? out.one : out.twoPlus, r.files, r.bytes);
  }
  const rest = db
    .prepare(
      `SELECT cloud_only AS cloud, count(*) AS files, coalesce(sum(size), 0) AS bytes FROM files
        WHERE place_id = ? AND gone_at IS NULL AND size IS NOT 0 AND sha256 IS NULL AND md5 IS NULL GROUP BY cloud_only`,
    )
    .all(placeId) as { cloud: number; files: number; bytes: number }[];
  for (const r of rest) add(r.cloud === 1 ? out.cloudOnly : out.notFingerprinted, r.files, r.bytes);
  out.empty.files = (db.prepare('SELECT count(*) AS n FROM files WHERE place_id = ? AND gone_at IS NULL AND size = 0').get(placeId) as { n: number }).n;
  return out;
}

/** Per place: files that can be fingerprinted (not cloud-only), how many are, and how many failed. */
export interface FingerprintCounts {
  fileCount: number;
  fingerprintedFiles: number;
  totalBytes: number;
  fingerprintedBytes: number;
  failedFiles: number;
}

/** One pass over the live rows of every place. */
export function allFingerprintCounts(db: Db): Map<string, FingerprintCounts> {
  const rows = db
    .prepare(
      `SELECT place_id,
              count(*) AS files,
              sum(sha256 IS NOT NULL) AS done,
              coalesce(sum(size), 0) AS bytes,
              coalesce(sum(CASE WHEN sha256 IS NOT NULL THEN size END), 0) AS doneBytes,
              sum(hash_error IS NOT NULL) AS failed
         FROM files WHERE gone_at IS NULL AND cloud_only = 0 GROUP BY place_id`,
    )
    .all() as { place_id: string; files: number; done: number; bytes: number; doneBytes: number; failed: number }[];
  return new Map(
    rows.map((r) => [
      r.place_id,
      { fileCount: r.files, fingerprintedFiles: r.done, totalBytes: r.bytes, fingerprintedBytes: r.doneBytes, failedFiles: r.failed },
    ]),
  );
}

const EMPTY_UNFINGERPRINTED_SQL = `
SELECT place_id, count(*) AS files FROM files WHERE gone_at IS NULL AND size = 0 AND sha256 IS NULL AND md5 IS NULL GROUP BY place_id`;

const NO_FINGERPRINT_SQL = `
SELECT place_id, cloud_only AS cloud, count(*) AS files, coalesce(sum(size), 0) AS bytes FROM files
 WHERE gone_at IS NULL AND size IS NOT 0 AND sha256 IS NULL AND md5 IS NULL GROUP BY place_id, cloud_only`;

/**
 * Coverage of EVERY place in one pass (same answer as `placeCoverage` for each place; that function
 * is kept as the reference the tests compare against). No query per content group:
 * 1. SHA-256 values held by two or more places (one ordered walk of the covering index).
 * 2. Rows without a SHA-256 that have an MD5 and a size (Drive rows): the places per (md5, size).
 * 3. One walk over the fingerprinted rows; each row adds its files and bytes to a bucket by the
 *    number of OTHER places, worked out from the sets above (the row's own place is always in its
 *    own set, so it is subtracted, never looked up). The walk also notes which places hold each
 *    (md5, size) a Drive row has; Drive rows are bucketed once the walk is done.
 * Meant for the query worker: on 700k rows this takes seconds, not milliseconds.
 */
export function computeAllCoverage(db: Db): Map<string, PlaceCoverage> {
  const out = new Map<string, PlaceCoverage>();
  const of = (placeId: string): PlaceCoverage => {
    let c = out.get(placeId);
    if (!c) {
      c = { none: emptyBucket(), one: emptyBucket(), twoPlus: emptyBucket(), notFingerprinted: emptyBucket(), cloudOnly: emptyBucket(), empty: emptyBucket() };
      out.set(placeId, c);
    }
    return c;
  };
  const add = (bucket: CoverageBucket, files: number, bytes: number): void => {
    bucket.files += files;
    bucket.bytes += bytes;
  };

  // 1. SHA-256 values that more than one place holds (everything else has 0 other places by SHA-256).
  const shaPlaces = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT sha256, count(DISTINCT place_id) AS n FROM files
        WHERE sha256 IS NOT NULL AND gone_at IS NULL GROUP BY sha256 HAVING n > 1`,
    )
    .raw()
    .iterate() as Iterable<[string, number]>) {
    shaPlaces.set(r[0], r[1]);
  }

  // 2. Rows without SHA-256 (Drive): the places per (md5, size) among those rows only.
  const key = (md5: string, size: number): string => `${md5}|${size}`;
  const noShaPlaces = new Map<string, Set<string>>();
  for (const [md5, size, placeId] of db
    .prepare('SELECT md5, size, place_id FROM files WHERE gone_at IS NULL AND sha256 IS NULL AND md5 IS NOT NULL AND size IS NOT NULL')
    .raw()
    .iterate() as Iterable<[string, number, string]>) {
    const k = key(md5, size);
    const set = noShaPlaces.get(k);
    if (set) set.add(placeId);
    else noShaPlaces.set(k, new Set([placeId]));
  }
  // Places holding a (md5, size) that some Drive row has, with or without a SHA-256 (filled during the walk).
  const holders = new Map<string, Set<string>>();
  for (const k of noShaPlaces.keys()) holders.set(k, new Set());
  const driveRows: [string, number][] = []; // [key, bytes] of rows without SHA-256, bucketed after the walk
  const driveRowPlace: string[] = [];

  // 3. The walk.
  for (const [placeId, sha256, md5, size] of db
    .prepare('SELECT place_id, sha256, md5, size FROM files WHERE gone_at IS NULL AND (sha256 IS NOT NULL OR md5 IS NOT NULL)')
    .raw()
    .iterate() as Iterable<[string, string | null, string | null, number | null]>) {
    // Empty files (size 0) are their own bucket: never unprotected, never a copy of each other.
    if (size === 0) {
      add(of(placeId).empty, 1, 0);
      continue;
    }
    let others = 0;
    if (sha256 !== null) others += (shaPlaces.get(sha256) ?? 1) - 1;
    if (md5 !== null && size !== null) {
      const k = key(md5, size);
      holders.get(k)?.add(placeId);
      if (sha256 === null) {
        // A row without SHA-256 (Drive): every other place holding the same MD5 and size counts, with or without a
        // SHA-256. Not all of them have been seen yet, so this row is bucketed after the walk.
        driveRows.push([k, size]);
        driveRowPlace.push(placeId);
        continue;
      }
      // A row with its own SHA-256 only matches rows that have none.
      const u = noShaPlaces.get(k);
      if (u) others += u.size - (u.has(placeId) ? 1 : 0);
    }
    add(others === 0 ? of(placeId).none : others === 1 ? of(placeId).one : of(placeId).twoPlus, 1, size ?? 0);
  }
  for (let i = 0; i < driveRows.length; i += 1) {
    const [k, bytes] = driveRows[i]!;
    const others = (holders.get(k)?.size ?? 1) - 1;
    const c = of(driveRowPlace[i]!);
    add(others === 0 ? c.none : others === 1 ? c.one : c.twoPlus, 1, bytes);
  }

  // Empty files that were never fingerprinted (the walk above only sees the fingerprinted ones).
  for (const r of db.prepare(EMPTY_UNFINGERPRINTED_SQL).all() as { place_id: string; files: number }[]) add(of(r.place_id).empty, r.files, 0);
  for (const r of db.prepare(NO_FINGERPRINT_SQL).all() as { place_id: string; cloud: number; files: number; bytes: number }[]) {
    add(r.cloud === 1 ? of(r.place_id).cloudOnly : of(r.place_id).notFingerprinted, r.files, r.bytes);
  }
  return out;
}
