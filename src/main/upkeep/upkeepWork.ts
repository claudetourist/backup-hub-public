import { UPKEEP_CHUNK_ROWS, classifyChunk, isBusyError, type ChunkResult } from '../classify/sortKinds';
import type { Db } from '../db/connection';
import { JobStore } from '../jobs/jobStore';

/**
 * The work of the upkeep process: small, plain functions on the app's own database, each one short transaction, so they are tested
 * on a temp database and run in the invisible upkeep process (upkeepProcess.ts). Never a blocking checkpoint, never any file of the
 * person's: only the app's own rows (the kind label of file rows, job history, job log lines) and the query planner's statistics.
 */

export const OPTIMIZED_AT_KEY = 'upkeep.optimized_at';
export const OPTIMIZE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Rows per transaction, at most. */
export const CHUNK_LIMIT = UPKEEP_CHUNK_ROWS;
/** Job history rows per transaction (their log lines go with them), so one transaction stays short. */
export const JOB_CHUNK_LIMIT = 500;
/** A busy data file is waited for this many times (each wait is `BUSY_WAIT_MS`) before upkeep gives up for now. */
export const BUSY_RETRIES = 3;
export const BUSY_WAIT_MS = 2000;
/** Pause between chunks, so the process hands the disk and the processor back to everything else. */
export const CHUNK_PAUSE_MS = 25;

/** Sorts the next chunk of rows that have no kind (after `afterId`). */
export function sortChunk(db: Db, afterId: number, limit: number = CHUNK_LIMIT): ChunkResult {
  return classifyChunk(db, afterId, Math.min(limit, CHUNK_LIMIT));
}

/** True when more than a day has passed since the last `PRAGMA optimize` (or it never ran). */
export function optimizeDue(db: Db, now: number): boolean {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(OPTIMIZED_AT_KEY) as { value: string } | undefined;
  const last = row ? Number(row.value) : Number.NaN;
  return !Number.isFinite(last) || now - last >= OPTIMIZE_EVERY_MS || last > now;
}

/** `PRAGMA optimize` once a day: the time is remembered in `meta`. Returns true when it ran. */
export function optimizeIfDue(db: Db, now: number): boolean {
  if (!optimizeDue(db, now)) return false;
  // Bounded analysis (it looks at a sample of each index), so it stays short on millions of rows.
  db.pragma('analysis_limit = 1000');
  db.pragma('optimize');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OPTIMIZED_AT_KEY, String(now));
  return true;
}

/** Removes one chunk of job log lines older than 90 days (the rule of `JobStore.pruneEvents`). Returns how many went. */
export function trimEventsChunk(db: Db, now: number, limit: number = CHUNK_LIMIT): number {
  return new JobStore(db).pruneEvents(now, undefined, limit);
}

/** Removes one chunk of finished jobs older than 90 days (failed ones of the last 90 days stay). Returns how many went. */
export function trimJobsChunk(db: Db, now: number, limit: number = JOB_CHUNK_LIMIT): number {
  return new JobStore(db).pruneOldJobs(now, undefined, limit);
}

export interface UpkeepOptions {
  db: Db;
  now: () => number;
  /** Checked between chunks; true ends the run at once (the current chunk is already committed). */
  shouldStop: () => boolean;
  /** Waits between chunks (the process uses a timer so its messages are read meanwhile). */
  pause: (ms: number) => Promise<void>;
  /** Errors and notes go to the app log only. */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Rows per chunk; tests use small numbers. */
  chunkRows?: number;
  busyWaitMs?: number;
}

export interface UpkeepSummary {
  /** The run ended early because it was told to stop. */
  stopped: boolean;
  /** The data file stayed busy: nothing was lost, upkeep tries again later. */
  busy: boolean;
  sorted: number;
  eventsTrimmed: number;
  jobsTrimmed: number;
  optimized: boolean;
  /** Nothing was left to do (so there is no point in starting again soon). */
  nothingLeft: boolean;
}

/**
 * One run of upkeep, in chunks: sort old rows with no kind, trim job log lines, trim old job history, then `PRAGMA optimize` once a day.
 * Stops between chunks when `shouldStop()` says so. A chunk that did not commit is simply run again; a data file that stays busy ends
 * the run quietly.
 */
export async function runUpkeep(o: UpkeepOptions): Promise<UpkeepSummary> {
  const summary: UpkeepSummary = { stopped: false, busy: false, sorted: 0, eventsTrimmed: 0, jobsTrimmed: 0, optimized: false, nothingLeft: false };
  const limit = Math.min(o.chunkRows ?? CHUNK_LIMIT, CHUNK_LIMIT);

  /** Runs one chunk, retrying a busy file a few times. Returns null when it gave up or was told to stop. */
  const attempt = async <T>(run: () => T): Promise<T | null> => {
    for (let tries = 0; ; tries += 1) {
      if (o.shouldStop()) {
        summary.stopped = true;
        return null;
      }
      try {
        return run();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        if (tries >= BUSY_RETRIES) {
          summary.busy = true;
          o.log.info('upkeep: the data file stayed busy; trying again later');
          return null;
        }
        await o.pause(o.busyWaitMs ?? BUSY_WAIT_MS);
      }
    }
  };

  // 1. Old rows with no kind, oldest first.
  let afterId = 0;
  for (;;) {
    const chunk = await attempt(() => sortChunk(o.db, afterId, limit));
    if (chunk === null) return summary;
    if (chunk.lastId === null) break;
    afterId = chunk.lastId;
    summary.sorted += chunk.sorted;
    await o.pause(CHUNK_PAUSE_MS);
  }
  // 2. Job log lines, then job history, older than 90 days.
  for (;;) {
    const n = await attempt(() => trimEventsChunk(o.db, o.now(), limit));
    if (n === null) return summary;
    summary.eventsTrimmed += n;
    if (n < limit) break;
    await o.pause(CHUNK_PAUSE_MS);
  }
  const jobLimit = Math.min(limit, JOB_CHUNK_LIMIT);
  for (;;) {
    const n = await attempt(() => trimJobsChunk(o.db, o.now(), jobLimit));
    if (n === null) return summary;
    summary.jobsTrimmed += n;
    if (n < jobLimit) break;
    await o.pause(CHUNK_PAUSE_MS);
  }
  // 3. The planner's statistics, once a day.
  const optimized = await attempt(() => optimizeIfDue(o.db, o.now()));
  if (optimized === null) return summary;
  summary.optimized = optimized;
  summary.nothingLeft = true;
  if (summary.sorted + summary.eventsTrimmed + summary.jobsTrimmed > 0 || optimized) {
    o.log.info(`upkeep: sorted ${summary.sorted} rows, trimmed ${summary.jobsTrimmed} old jobs and ${summary.eventsTrimmed} log lines${optimized ? ', optimized the database' : ''}`);
  }
  return summary;
}
