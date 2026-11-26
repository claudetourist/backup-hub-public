import type { Worker } from 'node:worker_threads';
import { createWorker } from '../lifecycle/workers';
import type { PlaceCoverage } from '../../shared/fingerprint';
import type { PlaceFileStats } from '../../shared/listing';
import type { FingerprintCounts } from '../copies/copiesIndex';
import type { CountCache } from '../cache/countCache';
import type { DataVersion } from '../cache/dataVersion';
import type { Db } from '../db/connection';
import type { MigrationResult } from '../db/migrate';
import type { CheckOldCountsResult } from '../../shared/phoneBackup';
import type { MirrorCountPair } from '../mirror/mirrorTypes';
import type { Behind } from '../mirror/mirrorScan';
import type { ScanGate } from './scanGate';
import { runQuery } from './queryCore';
import type { BackupSize } from '../../shared/backups';
import type { OnlyHereSummary, WouldLoseDetail, WouldLoseFilesPage, WouldLoseFilesRequest } from '../../shared/insights';
import type { BackupSizeAsk, CoverageResult, QueryOp, QueryReply, QueryRequest, QuickCheckResult, StatsResult } from './queryTypes';

/** Coverage, while a long job is making progress: counted again at most this often. */
export const COVERAGE_MIN_INTERVAL_MS = 60_000;
/** File stats and fingerprint counts, while a long job is making progress: counted again at most this often. */
export const STATS_MIN_INTERVAL_MS = 30_000;
/** Without a worker the queries run on the main thread; at most once per minute per kind. */
export const FALLBACK_MIN_INTERVAL_MS = 60_000;

export interface CoverageSnapshot {
  at: number;
  /** The data version it was counted at (0 when versions are not used). */
  version: number;
  byPlace: Map<string, PlaceCoverage>;
}

export interface StatsSnapshot {
  at: number;
  version: number;
  files: Map<string, PlaceFileStats>;
  fingerprint: Map<string, FingerprintCounts>;
  failReasons: Map<string, string>;
}

export interface QueryLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface QueryServiceOptions {
  /** The database file the worker opens read-only. Null (for example an in-memory test database) = no worker. */
  dbFile: string | null;
  /** The main connection, used only by the rate-limited fallback. */
  db: Db;
  /** Absolute path of the built queryWorker script (`queryWorker.js` next to main.js). Null = no worker. */
  workerPath: string | null;
  log: QueryLogger;
  now?: () => number;
  /** Runs the fallback off the current call; tests pass a direct call. */
  schedule?: (fn: () => void) => void;
  /** Fallback only: the least time between two main-thread counts of the same kind (default one minute). */
  fallbackMinIntervalMs?: number;
  /** With these, the last counts are saved and shown at once on the next start, and counted again only when the data changed. */
  version?: DataVersion;
  cache?: CountCache;
  /** Shared with the other heavy counts so only one runs at a time. */
  gate?: ScanGate;
}

export interface RequestOptions {
  /** Something that changes the numbers just happened (a job ended, a collection changed, the person asked): count now. */
  force?: boolean;
  /** A long job is still running and the numbers would stand still: count again if the cache is over the minimum interval old. */
  progress?: boolean;
}

type Kind = 'coverage' | 'stats';

function statsSnapshot(r: StatsResult, at: number, version: number): StatsSnapshot {
  return { at, version, files: new Map(r.files), fingerprint: new Map(r.fingerprint), failReasons: new Map(r.failReasons) };
}
type ResultReply = Extract<QueryReply, { type: 'result' }>;

/**
 * Heavy read queries off the main thread. Results are cached and handed out at once; a request
 * only starts a background count. Rules:
 * - one query at a time (coverage and stats queue behind each other, and behind the collection counts through the
 *   shared gate), requests coalesce;
 * - a plain request counts only when nothing is cached yet or, with a data version, when the data changed since the
 *   cached count (then not sooner than the minimum interval after it: the Sources poll asks every few seconds and must
 *   cost nothing). Without a data version cached numbers stay valid until a forced request;
 * - a forced request (a list, hash, Drive refresh, cloud copy or import job ended, a collection changed) counts at once,
 *   but with a data version only if the data really changed;
 * - a `progress` request (a job is running) also counts when the cache is over 60 s (coverage) or 30 s (stats) old;
 * - the last counts are saved (`cache`) and loaded when the service is made, so a restart shows them at once;
 * - without a working worker the same queries run on the main thread, at most once a minute each.
 */
export class QueryService {
  private readonly now: () => number;
  private worker: Worker | null = null;
  private everReady = false;
  private noWorker: boolean;
  private nextId = 1;
  private readonly calls = new Map<number, (reply: ResultReply) => void>();
  private busy = false;
  /** The kind being counted right now (a plain request for it adds nothing: that count is fresh). */
  private running: Kind | null = null;
  private readonly wanted = new Set<Kind>();
  private coverageSnap: CoverageSnapshot | null = null;
  private statsSnap: StatsSnapshot | null = null;
  private readonly fallbackAt = new Map<Kind, number>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private readonly laterTimers = new Map<Kind, NodeJS.Timeout>();

  constructor(private readonly opts: QueryServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.noWorker = opts.dbFile === null || opts.workerPath === null;
    this.restore();
  }

  /** Load the counts saved by an earlier run (what cannot be read is simply counted again). */
  private restore(): void {
    const cache = this.opts.cache;
    if (!cache) return;
    const stats = cache.load<StatsResult>('stats');
    if (stats) this.statsSnap = statsSnapshot(stats.data, stats.at, stats.version);
    const coverage = cache.load<CoverageResult>('coverage');
    if (coverage) this.coverageSnap = { at: coverage.at, version: coverage.version, byPlace: new Map(coverage.data.byPlace) };
  }

  /** True when the data changed since the snapshot was counted. Without a data version this is never known, so false. */
  private changedSince(snap: { version: number }): boolean {
    const version = this.opts.version;
    return version !== undefined && snap.version !== version.current();
  }

  // ---- What callers read -----------------------------------------------------------------------

  coverage(): CoverageSnapshot | null {
    return this.coverageSnap;
  }

  stats(): StatsSnapshot | null {
    return this.statsSnap;
  }

  /** True when queries run on a worker thread (false = the main-thread fallback). */
  get usesWorker(): boolean {
    return !this.noWorker;
  }

  onUpdated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Requests ----------------------------------------------------------------------------------

  /** Count coverage in the background: when nothing is cached or when forced (and, with `progress`, when the cache is over a minute old). */
  requestCoverage(options: RequestOptions = {}): void {
    if (this.shouldCount('coverage', this.coverageSnap, COVERAGE_MIN_INTERVAL_MS, options)) this.want('coverage');
  }

  /** Recount file stats and fingerprint counts in the background: when nothing is cached or when forced (and, with `progress`, when the cache is over 30 s old). */
  requestStats(options: RequestOptions = {}): void {
    if (this.shouldCount('stats', this.statsSnap, STATS_MIN_INTERVAL_MS, options)) this.want('stats');
  }

  private shouldCount(kind: Kind, snap: { at: number; version: number } | null, minMs: number, options: RequestOptions): boolean {
    const hasVersion = this.opts.version !== undefined;
    if (options.force) return !snap || !hasVersion || this.changedSince(snap);
    if (this.running === kind) return false;
    if (!snap) return true;
    const old = this.now() - snap.at >= minMs;
    if (options.progress === true && old && (!hasVersion || this.changedSince(snap))) return true;
    if (this.changedSince(snap)) {
      if (old) return true;
      this.countLater(kind, minMs - (this.now() - snap.at));
    }
    return false;
  }

  /** The data changed but the last count is too young: count again when it is old enough (if it still needs it). */
  private countLater(kind: Kind, ms: number): void {
    if (this.laterTimers.has(kind) || this.closed) return;
    const timer = setTimeout(() => {
      this.laterTimers.delete(kind);
      const snap = kind === 'coverage' ? this.coverageSnap : this.statsSnap;
      if (snap && this.changedSince(snap)) this.want(kind);
    }, Math.max(ms, 0) + 50);
    timer.unref();
    this.laterTimers.set(kind, timer);
  }

  private want(kind: Kind): void {
    if (this.closed) return;
    this.wanted.add(kind);
    this.pump();
  }

  private pump(): void {
    if (this.busy || this.closed) return;
    // The cheap file stats go first when nothing is cached yet, so Sources has numbers sooner.
    const next: Kind | null =
      this.wanted.has('stats') && !this.statsSnap ? 'stats' : this.wanted.has('coverage') ? 'coverage' : this.wanted.has('stats') ? 'stats' : null;
    if (!next) return;
    this.wanted.delete(next);
    this.busy = true;
    this.running = next;
    void this.execute(next).finally(() => {
      this.busy = false;
      this.running = null;
      this.pump();
    });
  }

  private async execute(kind: Kind): Promise<void> {
    const started = this.now();
    const version = this.opts.version?.current() ?? 0;
    try {
      const result = await (this.opts.gate ? this.opts.gate.run(() => this.run(kind)) : this.run(kind));
      if (result === null) return;
      this.store(kind, result, version);
      this.opts.log.info(`query: ${kind} counted in ${this.now() - started} ms (${this.noWorker ? 'main thread' : 'worker'})`);
      for (const listener of this.listeners) listener();
      // The data changed while this count was running: count again (not sooner than the minimum interval).
      const snap = kind === 'coverage' ? this.coverageSnap : this.statsSnap;
      if (snap && this.changedSince(snap)) this.countLater(kind, kind === 'coverage' ? COVERAGE_MIN_INTERVAL_MS : STATS_MIN_INTERVAL_MS);
    } catch (err) {
      this.opts.log.warn(`query: ${kind} count failed`, err);
    }
  }

  private store(kind: Kind, result: CoverageResult | StatsResult, version: number): void {
    const at = this.now();
    if (kind === 'coverage') this.coverageSnap = { at, version, byPlace: new Map((result as CoverageResult).byPlace) };
    else this.statsSnap = statsSnapshot(result as StatsResult, at, version);
    try {
      this.opts.cache?.save(kind, { version, at, data: result });
    } catch (err) {
      this.opts.log.warn(`query: could not save the ${kind} count`, err);
    }
  }

  // ---- Running -----------------------------------------------------------------------------------

  /** Null = skipped (fallback rate limit). */
  private async run(kind: Kind): Promise<CoverageResult | StatsResult | null> {
    if (!this.noWorker) {
      const reply = await this.askWorker(kind);
      if (reply.ok) return reply.result as CoverageResult | StatsResult;
      if (this.everReady) throw new Error(reply.message);
      // The worker never came up: from now on the main thread does the counting, rarely.
      this.noWorker = true;
      this.opts.log.warn(`query: the worker thread could not start (${reply.message}); counting in the main process, at most once a minute`);
    }
    return this.runOnMain(kind);
  }

  private async runOnMain(kind: Kind): Promise<CoverageResult | StatsResult | null> {
    const at = this.now();
    const last = this.fallbackAt.get(kind);
    if (last !== undefined && at - last < (this.opts.fallbackMinIntervalMs ?? FALLBACK_MIN_INTERVAL_MS)) return null;
    this.fallbackAt.set(kind, at);
    await new Promise<void>((resolve) => (this.opts.schedule ?? ((fn) => void setTimeout(fn, 0)))(resolve));
    this.opts.log.warn(`query: ${kind} is being counted in the main process (the window may stall for a moment)`);
    return runQuery(this.opts.db, kind) as CoverageResult | StatsResult;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createWorker('query', this.opts.workerPath!);
    worker.on('message', (reply: QueryReply) => {
      if (reply.type === 'ready') {
        this.everReady = true;
        return;
      }
      const resolve = this.calls.get(reply.id);
      if (!resolve) return;
      this.calls.delete(reply.id);
      resolve(reply);
    });
    const fail = (message: string): void => {
      if (this.worker === worker) this.worker = null;
      for (const [id, resolve] of this.calls) {
        this.calls.delete(id);
        resolve({ type: 'result', id, ok: false, message });
      }
    };
    worker.on('error', (err) => fail(`The query worker stopped (${err.message}).`));
    worker.on('exit', (code) => fail(`The query worker exited (code ${code}).`));
    this.worker = worker;
    return worker;
  }

  private askWorker(op: QueryOp): Promise<ResultReply> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch (err) {
        resolve({ type: 'result', id, ok: false, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.calls.set(id, resolve);
      // A worker_threads port has no target origin (that rule is for window.postMessage).
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ id, op, dbFile: this.opts.dbFile! } satisfies QueryRequest);
    });
  }

  close(): void {
    this.closed = true;
    for (const timer of this.laterTimers.values()) clearTimeout(timer);
    this.laterTimers.clear();
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }
}

/**
 * Starts a worker only to have it load the SQLite addon (see queryWorker.ts), then stops it. Call it while the window is still
 * loading, before the main thread opens the database. Best effort: when it cannot run, the main thread loads the addon itself.
 */
export function warmSqliteInWorker(workerPath: string): void {
  try {
    const worker = createWorker('oneShot', workerPath);
    worker.once('message', () => void worker.terminate());
    worker.once('error', () => void worker.terminate());
  } catch {
    // The addon is then loaded by the first connection, as before.
  }
}

/** What a one-off worker answered: the result, or why it failed. Null (from `runOneShot`) = the worker could not start or crashed. */
type OneShotReply = { ok: true; result: Extract<QueryReply, { type: 'result'; ok: true }>['result'] } | { ok: false; message: string };

/** Starts a worker for ONE request and stops it after the answer. Null when the worker cannot start or dies without answering. */
function runOneShot(workerPath: string, op: QueryOp, dbFile: string, extra: { backupId?: number; mirror?: MirrorCountPair; sizes?: BackupSizeAsk[]; lose?: { placeId: string | null; files?: WouldLoseFilesRequest } } = {}): Promise<OneShotReply | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = createWorker('oneShot', workerPath);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: OneShotReply | null): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve(value);
    };
    worker.on('message', (reply: QueryReply) => {
      if (reply.type === 'ready') {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage({ id: 1, op, dbFile, ...extra } satisfies QueryRequest);
        return;
      }
      finish(reply.ok ? { ok: true, result: reply.result } : { ok: false, message: reply.message });
    });
    worker.on('error', () => finish(null));
    worker.on('exit', () => finish(null));
  });
}

/**
 * The startup integrity check on a worker thread with its own read-only connection, so the window
 * paints while it runs. Resolves null when the worker cannot start or crashes (the caller then
 * decides what to do; nothing has been written by then either way).
 */
export async function quickCheckInWorker(workerPath: string, dbFile: string, mode: 'quick' | 'full' = 'quick'): Promise<QuickCheckResult | null> {
  const reply = await runOneShot(workerPath, mode === 'full' ? 'fullCheck' : 'quickCheck', dbFile);
  if (reply === null) return null;
  return reply.ok ? (reply.result as QuickCheckResult) : { ok: false, messages: [reply.message] };
}

/** What `migrateInWorker` answers: the migrations it ran, or the plain reason they failed (the file is then as it was before the failed one). */
export type MigrateReply = { ok: true; result: MigrationResult } | { ok: false; message: string };

/**
 * Brings the database file up to the latest version on a worker thread (its own read-write connection), so a migration of a big
 * database never blocks the main loop. Nothing else may have the file open for writing meanwhile: call it before the main
 * connection opens. Resolves null when the worker cannot start or dies; the caller may then migrate on the main thread (a
 * migration that did not finish was rolled back, so nothing is half done).
 */
export async function migrateInWorker(workerPath: string, dbFile: string): Promise<MigrateReply | null> {
  const reply = await runOneShot(workerPath, 'migrate', dbFile);
  if (reply === null) return null;
  return reply.ok ? { ok: true, result: reply.result as MigrationResult } : reply;
}

/**
 * The Backups card's counts ("how many files have a checked copy") on a worker thread with its own read-only connection: reading
 * 200,000 copy rows took 2 to 4 s on the main thread. Null = the worker could not start or died (the caller then counts in slices on
 * the main thread); a plain refusal ("not a phone backup") comes back as the result itself.
 */
export async function checkOldCountsInWorker(workerPath: string, dbFile: string, backupId: number): Promise<CheckOldCountsResult | null> {
  const reply = await runOneShot(workerPath, 'checkOldCounts', dbFile, { backupId });
  if (reply === null) return null;
  return reply.ok ? (reply.result as CheckOldCountsResult) : { ok: false, message: 'The numbers for this backup could not be read.' };
}

/**
 * How far behind the second drive is ("behind by N files"), counted from the file list on a worker thread with its own read-only connection.
 * Null = the worker could not start or died (the caller then counts in slices on the main thread).
 */
export async function behindInWorker(workerPath: string, dbFile: string, pair: MirrorCountPair): Promise<Behind | null> {
  const reply = await runOneShot(workerPath, 'mirrorBehind', dbFile, { mirror: { srcPlaceId: pair.srcPlaceId, srcRoot: pair.srcRoot, dstPlaceId: pair.dstPlaceId, dstRoot: pair.dstRoot } });
  if (reply === null || !reply.ok) return null;
  return reply.result as Behind;
}

/**
 * How many files and bytes each backup holds on its first drive, counted from the file list on a worker thread with its own read-only connection
 * (the Backups list shows the numbers when they arrive). Null = the worker could not start or died: the numbers simply stay unknown.
 */
export async function backupSizesInWorker(workerPath: string, dbFile: string, asks: BackupSizeAsk[]): Promise<BackupSize[] | null> {
  const reply = await runOneShot(workerPath, 'backupSizes', dbFile, { sizes: asks });
  if (reply === null || !reply.ok) return null;
  return reply.result as BackupSize[];
}

/**
 * What only lives on one device (its files without a checked copy elsewhere, by kind and folder), counted on a worker thread with its own
 * read-only connection. Null = the worker could not start or died: the screen then says it could not be counted.
 */
export async function wouldLoseInWorker(workerPath: string, dbFile: string, placeId: string): Promise<WouldLoseDetail | null> {
  const reply = await runOneShot(workerPath, 'wouldLose', dbFile, { lose: { placeId } });
  if (reply === null || !reply.ok) return null;
  return reply.result as WouldLoseDetail;
}

/** The one-line summary ("12.3 GB only here") of every device, counted the same way in one pass. Null = could not be counted. */
export async function onlyHereInWorker(workerPath: string, dbFile: string): Promise<OnlyHereSummary[] | null> {
  const reply = await runOneShot(workerPath, 'wouldLose', dbFile, { lose: { placeId: null } });
  if (reply === null || !reply.ok) return null;
  return reply.result as OnlyHereSummary[];
}

/** One page of the files of a device that have no checked copy elsewhere (biggest first, with the words typed). Null = could not be counted. */
export async function wouldLoseFilesInWorker(workerPath: string, dbFile: string, request: WouldLoseFilesRequest): Promise<WouldLoseFilesPage | null> {
  const reply = await runOneShot(workerPath, 'wouldLose', dbFile, { lose: { placeId: request.placeId, files: request } });
  if (reply === null || !reply.ok) return null;
  return reply.result as WouldLoseFilesPage;
}
