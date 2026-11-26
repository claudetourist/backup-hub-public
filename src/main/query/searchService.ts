import type { Worker } from 'node:worker_threads';
import { createWorker } from '../lifecycle/workers';
import type { SearchRequest, SearchResponse } from '../../shared/search';
import type { Db } from '../db/connection';
import type { QueryLogger } from './queryService';
import type { QueryReply, QueryRequest } from './queryTypes';
import { answerSearch } from './answerSearch';

export interface SearchServiceOptions {
  /** The database file the worker opens read-only. Null (an in-memory test database) = no worker. */
  dbFile: string | null;
  /** Used only when no worker can run (it then answers on the main thread, after a tick). */
  db: Db;
  /** Absolute path of the built queryWorker script. Null = no worker. */
  workerPath: string | null;
  log: QueryLogger;
}

interface Call {
  id: number;
  request: SearchRequest;
  resolve: (response: SearchResponse) => void;
}

/**
 * One lane: its OWN worker thread and one request at a time. A newer request on the lane replaces the one in flight:
 * the replaced one is answered 'superseded' at once, and if the worker is still busy with it the worker is stopped (it
 * only ever reads) and a fresh one starts for the new request.
 */
class Lane {
  private worker: Worker | null = null;
  private everReady = false;
  private noWorker: boolean;
  private current: Call | null = null;

  constructor(
    private readonly name: string,
    private readonly opts: SearchServiceOptions,
    private readonly nextId: () => number,
  ) {
    this.noWorker = opts.dbFile === null || opts.workerPath === null;
  }

  run(request: SearchRequest): Promise<SearchResponse> {
    this.supersede();
    return new Promise<SearchResponse>((resolve) => {
      const call: Call = { id: this.nextId(), request, resolve };
      this.current = call;
      if (this.noWorker) {
        this.runOnMain(call, request);
        return;
      }
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch (err) {
        this.opts.log.warn(`search: the ${this.name} worker thread could not start; searching in the main process`, err);
        this.noWorker = true;
        this.runOnMain(call, request);
        return;
      }
      // A worker_threads port has no target origin (that rule is for window.postMessage).
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ id: call.id, op: 'search', dbFile: this.opts.dbFile!, search: request } satisfies QueryRequest);
    });
  }

  /** Answer the request in flight as replaced; stop the worker if it is still busy with it. */
  supersede(): void {
    const old = this.current;
    if (!old) return;
    this.current = null;
    old.resolve({ status: 'superseded' });
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }

  private runOnMain(call: Call, request: SearchRequest): void {
    setTimeout(() => {
      if (this.current !== call) return;
      this.current = null;
      try {
        call.resolve(answerSearch(this.opts.db, request));
      } catch (err) {
        call.resolve({ status: 'failed', message: err instanceof Error ? err.message : String(err) });
      }
    }, 0);
  }

  private finish(id: number, response: SearchResponse): void {
    const call = this.current;
    if (!call || call.id !== id) return;
    this.current = null;
    call.resolve(response);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createWorker('search', this.opts.workerPath!);
    worker.on('message', (reply: QueryReply) => {
      if (reply.type === 'ready') {
        this.everReady = true;
        return;
      }
      if (this.worker !== worker) return;
      if (!reply.ok) this.finish(reply.id, { status: 'failed', message: reply.message });
      else this.finish(reply.id, reply.result as SearchResponse);
    });
    const lost = (message: string): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      const call = this.current;
      if (!call) return;
      if (!this.everReady) {
        // The worker never came up: from now on this lane runs on the main thread.
        this.opts.log.warn(`search: the ${this.name} worker thread could not start (${message}); searching in the main process`);
        this.noWorker = true;
        this.runOnMain(call, call.request);
        return;
      }
      this.finish(call.id, { status: 'failed', message: 'The search stopped unexpectedly. Please try again.' });
    };
    worker.on('error', (err) => lost(err.message));
    worker.on('exit', (code) => lost(`exit code ${code}`));
    this.worker = worker;
    return worker;
  }

  close(): void {
    this.current?.resolve({ status: 'superseded' });
    this.current = null;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }
}

/**
 * Search on its OWN query worker threads, in two lanes so the results never wait for the counts:
 * - the page lane answers requests for results; a new search (offset 0) replaces the page in flight, and so does the
 *   counts request in flight, but "Show next 500" (offset above 0) only replaces an older page request;
 * - the counts lane answers requests for the chip numbers and the years; a counts request replaces an older counts
 *   request, and a counts request never touches a page.
 * Both lanes use the same worker script, so the packaged build needs no change.
 */
export class SearchService {
  private nextId = 1;
  private closed = false;
  private readonly pages: Lane;
  private readonly counts: Lane;

  constructor(opts: SearchServiceOptions) {
    const next = (): number => this.nextId++;
    this.pages = new Lane('results', opts, next);
    this.counts = new Lane('counts', opts, next);
  }

  run(request: SearchRequest): Promise<SearchResponse> {
    if (this.closed) return Promise.resolve({ status: 'failed', message: 'Backup Hub is closing.' });
    if (request.part === 'counts') return this.counts.run(request);
    // A new search (the first page) makes the counts of the old one useless.
    if (request.offset === 0) this.counts.supersede();
    return this.pages.run(request);
  }

  close(): void {
    this.closed = true;
    this.pages.close();
    this.counts.close();
  }
}
