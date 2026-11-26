import type { Worker } from 'node:worker_threads';
import type { SearchIndexStatus } from '../../shared/search';
import { createWorker } from '../lifecycle/workers';
import type { QueryLogger } from './queryService';
import type { IndexReply, QueryRequest } from './queryTypes';
import type { IndexProgress } from './searchIndexFill';

export interface SearchIndexServiceOptions {
  /** The database file the worker opens read-write. Null (an in-memory test database) = no worker, no index. */
  dbFile: string | null;
  /** Absolute path of the built queryWorker script. Null = no worker. */
  workerPath: string | null;
  log: QueryLogger;
  /** Called when the status changed (the screen is told when "ready" arrives). */
  onChange?: () => void;
}

/** A worker that stopped by itself this many times in a row is not started again (it would only fail the same way). */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 5000;

/**
 * Starts the loop that keeps the search index (searchIndexKeeper.ts) on its OWN worker thread and holds the last progress it reported, which
 * the Files screen reads ("Search is getting ready: 40%"). Nothing here touches the database: all the work is in the worker.
 */
export class SearchIndexService {
  private worker: Worker | null = null;
  private progress: IndexProgress | null = null;
  private known = false;
  private restarts = 0;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private paused = false;

  constructor(private readonly opts: SearchIndexServiceOptions) {}

  start(): void {
    if (this.worker || this.closed || this.opts.dbFile === null || this.opts.workerPath === null) return;
    let worker: Worker;
    try {
      worker = createWorker('query', this.opts.workerPath);
    } catch (err) {
      this.opts.log.warn('search index: the worker thread could not start; search stays on the plain method', err);
      return;
    }
    worker.on('message', (reply: IndexReply) => {
      if (this.worker !== worker) return;
      if (reply.type === 'index') {
        this.restarts = 0;
        this.progress = reply.progress;
        this.known = true;
        this.opts.onChange?.();
      } else if (reply.type === 'indexFailed') {
        this.opts.log.warn(`search index: the fill stopped (${reply.message})`);
      }
    });
    const lost = (message: string): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.closed) return;
      this.restarts += 1;
      if (this.restarts > MAX_RESTARTS) {
        this.opts.log.warn(`search index: the worker thread keeps stopping (${message}); search stays on the plain method`);
        return;
      }
      this.timer = setTimeout(() => this.start(), RESTART_DELAY_MS);
      this.timer.unref();
    };
    worker.on('error', (err) => lost(err.message));
    worker.on('exit', (code) => lost(`exit code ${code}`));
    this.worker = worker;
    // A worker_threads port has no target origin (that rule is for window.postMessage).
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ id: 0, op: 'indexKeep', dbFile: this.opts.dbFile } satisfies QueryRequest);
    if (this.paused) this.sendPause();
  }

  /** True while a job is running: the fill waits (a slice that meets the job's own writes makes the main thread wait for it). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.sendPause();
    this.opts.onChange?.();
  }

  private sendPause(): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.worker?.postMessage({ id: 0, op: 'indexPause', dbFile: this.opts.dbFile ?? '', paused: this.paused } satisfies QueryRequest);
  }

  /** What the Files screen shows. Before the worker has reported, "not ready" at 0%. */
  status(): SearchIndexStatus {
    if (this.opts.dbFile === null || this.opts.workerPath === null) return { available: false, ready: false, percent: 0, waiting: false };
    if (this.known && this.progress === null) return { available: false, ready: false, percent: 0, waiting: false };
    return { available: true, ready: this.progress?.ready ?? false, percent: this.progress?.percent ?? 0, waiting: this.paused };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    // Ask it to stop after the slice it is in; the shutdown routine ends the thread (workerRegistry) if it has not by then.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ id: 0, op: 'indexStop', dbFile: this.opts.dbFile ?? '' } satisfies QueryRequest);
  }
}
