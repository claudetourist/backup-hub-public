import Database from 'better-sqlite3';
import { computeAllCoverage, type FingerprintCounts } from '../copies/copiesIndex';
import { BUSY_TIMEOUT_MS, checkIntegrity, type Db } from '../db/connection';
import type { PlaceFileStats } from '../../shared/listing';
import type { CoverageResult, QueryOp, QuickCheckResult, StatsResult } from './queryTypes';

/** Open a connection that can only read (WAL lets it run beside the main connection's writes). */
export function openReadOnly(file: string): Db {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

export function coverageQuery(db: Db): CoverageResult {
  return { byPlace: [...computeAllCoverage(db)] };
}

/**
 * File stats, fingerprint counts and the first read error per place in ONE pass over the live rows
 * (same numbers as `allFileStats` and `allFingerprintCounts`, which stay as the reference).
 */
export function statsQuery(db: Db): StatsResult {
  const rows = db
    .prepare(
      `SELECT place_id, cloud_only, count(*), coalesce(sum(size), 0), sum(sha256 IS NOT NULL),
              coalesce(sum(CASE WHEN sha256 IS NOT NULL THEN size END), 0), sum(hash_error IS NOT NULL), min(hash_error)
         FROM files WHERE gone_at IS NULL GROUP BY place_id, cloud_only`,
    )
    .raw()
    .all() as [string, number, number, number, number, number, number, string | null][];
  const files = new Map<string, PlaceFileStats>();
  const fingerprint = new Map<string, FingerprintCounts>();
  const failReasons = new Map<string, string>();
  for (const [place, cloud, n, bytes, done, doneBytes, failed, reason] of rows) {
    const f = files.get(place) ?? { files: 0, totalBytes: 0, cloudOnly: 0 };
    f.files += n;
    f.totalBytes += bytes;
    if (cloud === 1) f.cloudOnly += n;
    files.set(place, f);
    // Files that can be fingerprinted exclude the cloud-only ones.
    if (cloud === 0) {
      fingerprint.set(place, { fileCount: n, fingerprintedFiles: done, totalBytes: bytes, fingerprintedBytes: doneBytes, failedFiles: failed });
    }
    if (reason !== null && !failReasons.has(place)) failReasons.set(place, reason);
  }
  return { files: [...files], fingerprint: [...fingerprint], failReasons: [...failReasons] };
}

export function quickCheckQuery(db: Db): QuickCheckResult {
  return checkIntegrity(db, 'quick');
}

/** The full `PRAGMA integrity_check` (every page, every index): on a 600 MB catalog it takes tens of seconds. */
export function fullCheckQuery(db: Db): QuickCheckResult {
  return checkIntegrity(db, 'full');
}

/** Run one query kind on a connection. Used by the worker and by the main-thread fallback. */
export function runQuery(db: Db, op: Exclude<QueryOp, 'search' | 'migrate'>): CoverageResult | StatsResult | QuickCheckResult {
  if (op === 'coverage') return coverageQuery(db);
  if (op === 'stats') return statsQuery(db);
  if (op === 'fullCheck') return fullCheckQuery(db);
  return quickCheckQuery(db);
}
