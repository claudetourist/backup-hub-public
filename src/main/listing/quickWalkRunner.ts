import type { Worker } from 'node:worker_threads';
import { createWorker } from '../lifecycle/workers';
import type { PlaceFileStats } from '../../shared/listing';
import { BUSY_TIMEOUT_MS, type Db } from '../db/connection';
import { fullWalk, finishWalk, placeStats, type FinishRequest, type FinishResult, type FullWalkCounts, type FullWalkRequest, type FullWalkResult } from './fullWalker';
import { queueTotals, type QueueTotals } from '../hashing/queue';
import { relOfMode, type RelMode } from './relPaths';
import { quickWalk, type QuickWalkCounts, type QuickWalkResult } from './quickWalker';

/** What to look at: plain data, so the same request can run in a worker thread or on the main thread. */
export interface QuickWalkRequest {
  placeId: string;
  /** The folder to look at, as a path on this PC. */
  root: string;
  rel: RelMode;
  excludeDirs: readonly string[];
  /** The skip list (folder names, any depth, any case). Empty for a backup drive. */
  skipFolders?: readonly string[];
  /** NTFS (the laptop, OneDrive): save the file system's ids and recognise renamed or moved files. Never for a drive. */
  trustFsId?: boolean;
}

export interface WalkHooks<C> {
  signal?: AbortSignal | undefined;
  /** Every so often; the walk waits for it to finish (the job reports progress and lets other work in there). */
  tick?: ((counts: C) => Promise<void> | void) | undefined;
  /** Clock for tests; only used when the walk runs on the main thread. */
  now?: (() => number) | undefined;
}
export type QuickWalkHooks = WalkHooks<QuickWalkCounts>;

/**
 * The listing work that reads folders and saves rows: "Look again" (`run`), the full listing of one root (`fullWalk`, then
 * `finishWalk`) and the count shown when a listing ends (`stats`). The real app runs all of it on a worker thread (its own
 * database connection), because saving thousands of rows would stall the window if it happened on the main thread.
 */
export interface QuickWalkRunner {
  run(request: QuickWalkRequest, hooks?: QuickWalkHooks): Promise<QuickWalkResult>;
  fullWalk(request: FullWalkRequest, hooks?: WalkHooks<FullWalkCounts>): Promise<FullWalkResult>;
  finishWalk(request: FinishRequest): Promise<FinishResult>;
  stats(placeId: string): Promise<PlaceFileStats>;
  /** How many files (and bytes) of a place wait for a fingerprint (a count over the whole place). */
  queueTotals(placeId: string): Promise<QueueTotals>;
  /** Fold the write-ahead log back into the database file (on the worker thread, so the main one never pays for it). */
  checkpoint(mode: CheckpointMode): Promise<CheckpointResult>;
  close(): void;
}

/** What one worker call does. Plain data, so it can cross to the worker thread. */
export type WorkPayload =
  | { op: 'quick'; request: QuickWalkRequest }
  | { op: 'full'; request: FullWalkRequest }
  | { op: 'finish'; request: FinishRequest }
  | { op: 'stats'; placeId: string }
  | { op: 'queueTotals'; placeId: string }
  | { op: 'checkpoint'; mode: CheckpointMode };

/** PASSIVE copies what it can without waiting; TRUNCATE also waits for readers and empties the log file. */
export type CheckpointMode = 'PASSIVE' | 'TRUNCATE';
export interface CheckpointResult {
  /** True when something kept the checkpoint from finishing (a reader or writer was busy). */
  busy: boolean;
}

type WorkResult = QuickWalkResult | FullWalkResult | FinishResult | PlaceFileStats | QueueTotals | CheckpointResult;
type WorkTick = QuickWalkCounts | FullWalkCounts;

/** Does one piece of work on the given connection. Used by the worker thread, and by the inline runner. */
export async function doWork(db: Db, payload: WorkPayload, hooks: WalkHooks<WorkTick> = {}): Promise<WorkResult> {
  const common = { ...(hooks.now ? { now: hooks.now } : {}), ...(hooks.signal ? { signal: hooks.signal } : {}) };
  switch (payload.op) {
    case 'quick': {
      const { request } = payload;
      return quickWalk({
        db,
        placeId: request.placeId,
        root: request.root,
        relOf: relOfMode(request.rel),
        excludeDirs: request.excludeDirs,
        ...(request.skipFolders ? { skipFolders: request.skipFolders } : {}),
        ...(request.trustFsId === true ? { trustFsId: true } : {}),
        ...common,
        ...(hooks.tick ? { tick: hooks.tick } : {}),
      });
    }
    case 'full':
      return fullWalk({ db, request: payload.request, ...common, ...(hooks.tick ? { tick: hooks.tick } : {}) });
    case 'finish':
      return finishWalk(db, payload.request, hooks.now);
    case 'stats':
      return placeStats(db, payload.placeId);
    case 'queueTotals':
      return queueTotals(db, payload.placeId);
    case 'checkpoint': {
      // TRUNCATE holds the write lock while it waits for readers. With the usual 5 s wait that froze every writer for 5 s, and
      // sorting and other jobs died with "database is locked" (5 and 9 Nov). So it never waits: if a reader or writer is in
      // the way it answers busy at once, and WalKeeper asks again a little later.
      if (payload.mode !== 'TRUNCATE') return { busy: ((db.pragma(`wal_checkpoint(${payload.mode})`) as { busy: number }[])[0]?.busy ?? 0) !== 0 };
      db.pragma('busy_timeout = 0');
      try {
        const row = (db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0];
        return { busy: (row?.busy ?? 0) !== 0 };
      } catch (err) {
        if (/locked|busy/i.test(err instanceof Error ? err.message : '')) return { busy: true };
        throw err;
      } finally {
        db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }
    }
    default:
      throw new Error('Unknown work for the check');
  }
}

/** Runs on the calling thread (tests, and the fallback when no worker can start). */
export function inlineQuickWalkRunner(db: Db): QuickWalkRunner {
  const exec = <R extends WorkResult>(payload: WorkPayload, hooks?: WalkHooks<WorkTick>): Promise<R> => doWork(db, payload, hooks) as Promise<R>;
  return {
    run: (request, hooks) => exec<QuickWalkResult>({ op: 'quick', request }, hooks as WalkHooks<WorkTick> | undefined),
    fullWalk: (request, hooks) => exec<FullWalkResult>({ op: 'full', request }, hooks as WalkHooks<WorkTick> | undefined),
    finishWalk: (request) => exec<FinishResult>({ op: 'finish', request }),
    stats: (placeId) => exec<PlaceFileStats>({ op: 'stats', placeId }),
    queueTotals: (placeId) => exec<QueueTotals>({ op: 'queueTotals', placeId }),
    checkpoint: (mode) => exec<CheckpointResult>({ op: 'checkpoint', mode }),
    close: () => undefined,
  };
}

/** Messages between the main process and the listing worker (plain data only). */
export type QuickWalkWorkerRequest =
  | { type: 'run'; id: number; dbFile: string; payload: WorkPayload }
  | { type: 'go'; id: number }
  | { type: 'abort'; id: number };

type DoneReply = { type: 'done'; id: number; ok: true; result: WorkResult } | { type: 'done'; id: number; ok: false; message: string };

export type QuickWalkWorkerReply = { type: 'ready' } | { type: 'tick'; id: number; counts: WorkTick } | DoneReply;

export interface WorkerQuickWalkRunnerOptions {
  /** The database file the worker opens. Null (an in-memory test database) = no worker. */
  dbFile: string | null;
  /** Used only when no worker can run (the work then happens on the main thread, as before). */
  db: Db;
  /** Absolute path of the built quickWalkWorker script. Null = no worker. */
  workerPath: string | null;
  log: { warn(...args: unknown[]): void };
}

interface Call {
  hooks: WalkHooks<WorkTick>;
  finish: (reply: DoneReply) => void;
  /** Set when the tick hook threw: the walk is stopped and this is the error to report. */
  hookError: unknown;
}

/** Runs the work on a worker thread; falls back to the main thread when the worker never came up. */
export class WorkerQuickWalkRunner implements QuickWalkRunner {
  private worker: Worker | null = null;
  private everReady = false;
  private noWorker: boolean;
  private nextId = 1;
  private closed = false;
  private readonly calls = new Map<number, Call>();

  constructor(private readonly opts: WorkerQuickWalkRunnerOptions) {
    this.noWorker = opts.dbFile === null || opts.workerPath === null;
  }

  /** True when walks run on a worker thread (false = the main-thread fallback). */
  get usesWorker(): boolean {
    return !this.noWorker;
  }

  run(request: QuickWalkRequest, hooks: QuickWalkHooks = {}): Promise<QuickWalkResult> {
    return this.exec<QuickWalkResult>({ op: 'quick', request }, hooks as WalkHooks<WorkTick>);
  }

  fullWalk(request: FullWalkRequest, hooks: WalkHooks<FullWalkCounts> = {}): Promise<FullWalkResult> {
    return this.exec<FullWalkResult>({ op: 'full', request }, hooks as WalkHooks<WorkTick>);
  }

  finishWalk(request: FinishRequest): Promise<FinishResult> {
    return this.exec<FinishResult>({ op: 'finish', request }, {});
  }

  stats(placeId: string): Promise<PlaceFileStats> {
    return this.exec<PlaceFileStats>({ op: 'stats', placeId }, {});
  }

  queueTotals(placeId: string): Promise<QueueTotals> {
    return this.exec<QueueTotals>({ op: 'queueTotals', placeId }, {});
  }

  checkpoint(mode: CheckpointMode): Promise<CheckpointResult> {
    return this.exec<CheckpointResult>({ op: 'checkpoint', mode }, {});
  }

  private async exec<R extends WorkResult>(payload: WorkPayload, hooks: WalkHooks<WorkTick>): Promise<R> {
    if (this.closed) throw new Error('Backup Hub is closing.');
    if (this.noWorker) return (await doWork(this.opts.db, payload, hooks)) as R;
    const id = this.nextId++;
    const call: Call = { hooks, finish: () => undefined, hookError: undefined };
    const reply = await new Promise<DoneReply>((resolve) => {
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch (err) {
        resolve({ type: 'done', id, ok: false, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      const onAbort = (): void => this.post(worker, { type: 'abort', id });
      call.finish = (r) => {
        hooks.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      this.calls.set(id, call);
      if (hooks.signal?.aborted) queueMicrotask(onAbort);
      else hooks.signal?.addEventListener('abort', onAbort, { once: true });
      this.post(worker, { type: 'run', id, dbFile: this.opts.dbFile!, payload });
    });
    this.calls.delete(id);
    // The tick hook said stop (the job was cancelled): report that, even if the walk had just finished.
    if (call.hookError !== undefined) throw call.hookError;
    if (reply.ok) return reply.result as R;
    if (!this.everReady) {
      this.noWorker = true;
      this.opts.log.warn(`listing worker: the worker thread could not start (${reply.message}); working in the main process`);
      return (await doWork(this.opts.db, payload, hooks)) as R;
    }
    throw new Error(reply.message);
  }

  // A worker_threads port has no target origin (that rule is for window.postMessage).
  private post(worker: Worker, message: QuickWalkWorkerRequest): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage(message);
  }

  private onTick(worker: Worker, id: number, counts: WorkTick): void {
    const call = this.calls.get(id);
    if (!call) return;
    void (async () => {
      try {
        await call.hooks.tick?.(counts);
      } catch (err) {
        call.hookError = err;
        this.post(worker, { type: 'abort', id });
      }
      this.post(worker, { type: 'go', id });
    })();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createWorker('listing', this.opts.workerPath!);
    // A worker must never keep the app open.
    worker.unref();
    worker.on('message', (reply: QuickWalkWorkerReply) => {
      if (reply.type === 'ready') {
        this.everReady = true;
        return;
      }
      if (reply.type === 'tick') {
        this.onTick(worker, reply.id, reply.counts);
        return;
      }
      this.calls.get(reply.id)?.finish(reply);
    });
    const fail = (message: string): void => {
      if (this.worker === worker) this.worker = null;
      for (const [id, call] of this.calls) call.finish({ type: 'done', id, ok: false, message });
    };
    worker.on('error', (err) => fail(`The checking worker stopped (${err.message}).`));
    worker.on('exit', (code) => fail(`The checking worker exited (code ${code}).`));
    this.worker = worker;
    return worker;
  }

  close(): void {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }
}
