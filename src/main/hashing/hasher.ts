import type { Worker } from 'node:worker_threads';
import { createWorker } from '../lifecycle/workers';
import { hashFile, SharedThrottle, threadThrottle, type HashResult } from './hashCore';

export type { HashResult } from './hashCore';

/** Messages between the main process and the hashing worker. */
export type WorkerRequest =
  | { type: 'hash'; id: number; path: string; capBytesPerSec: number; size?: number }
  | { type: 'cancel'; id: number };
export type WorkerReply =
  | { type: 'ready' }
  | { type: 'bytes'; id: number; bytes: number }
  | { type: 'done'; id: number; result: HashResult };

export interface HashRequest {
  path: string;
  capBytesPerSec: number;
  /** The size the listing saw; small files are then read in one go. */
  size?: number;
  /** Aborting stops the read soon after and the result is `ABORTED`. */
  signal: AbortSignal;
  onBytes?: (bytes: number) => void;
  /** A big file read while two big files are allowed: it may use the second worker thread (and so the second core). */
  wide?: boolean;
}

/** Reads one file at a time and returns its fingerprints. Never throws for a read problem. */
export interface FileHasher {
  readonly kind: 'worker' | 'in-process';
  hash(request: HashRequest): Promise<HashResult>;
  close(): void;
}

/** Fallback and test hasher: the same code as the worker, run with async streams in this thread. */
export function inProcessHasher(): FileHasher {
  return {
    kind: 'in-process',
    hash: (request) =>
      hashFile(request.path, {
        capBytesPerSec: request.capBytesPerSec,
        throttle: threadThrottle,
        ...(request.size !== undefined ? { sizeHint: request.size } : {}),
        isCancelled: () => request.signal.aborted,
        ...(request.onBytes ? { onBytes: request.onBytes } : {}),
      }),
    close: () => undefined,
  };
}

interface Pending {
  onBytes: ((bytes: number) => void) | undefined;
  resolve: (result: HashResult) => void;
  slot: number;
}

const crashed = (message: string): HashResult => ({ ok: false, code: 'WORKER', message });

/** Most worker threads: two big files can be read at once, one per core. */
export const MAX_HASH_WORKERS = 2;

/**
 * Worker threads for reading. Ordinary requests all go to the first one; a `wide` request (a big
 * file while two are allowed) goes to the least busy of up to two workers, started when needed.
 * All workers share one reading budget (shared memory), so the speed cap holds for the total.
 * A crash fails that worker's current files and a new worker starts for the next one.
 */
class WorkerHasher implements FileHasher {
  readonly kind = 'worker';
  private readonly workers: (Worker | null)[] = Array.from({ length: MAX_HASH_WORKERS }, () => null);
  private readonly load: number[] = Array.from({ length: MAX_HASH_WORKERS }, () => 0);
  private readonly pending = new Map<number, Pending>();
  private readonly throttle = SharedThrottle.createShared();
  private nextId = 1;
  /** Becomes true once a worker said it is ready; false means none ever started (fall back). */
  everReady = false;
  startError: string | null = null;

  constructor(private readonly workerPath: string) {}

  private ensure(slot: number): Worker {
    const existing = this.workers[slot];
    if (existing) return existing;
    const worker = createWorker('hashing', this.workerPath, { workerData: { throttle: this.throttle } });
    worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'ready') {
        this.everReady = true;
        return;
      }
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      if (reply.type === 'bytes') {
        entry.onBytes?.(reply.bytes);
        return;
      }
      this.pending.delete(reply.id);
      this.load[entry.slot]! -= 1;
      entry.resolve(reply.result);
    });
    const fail = (message: string): void => {
      if (!this.everReady) this.startError = message;
      if (this.workers[slot] === worker) this.workers[slot] = null;
      for (const [id, entry] of this.pending) {
        if (entry.slot !== slot) continue;
        this.pending.delete(id);
        this.load[slot]! -= 1;
        entry.resolve(crashed(message));
      }
    };
    worker.on('error', (err) => fail(`The hashing worker stopped (${err.message}).`));
    worker.on('exit', (code) => {
      if (this.workers[slot] === worker) fail(`The hashing worker exited (code ${code}).`);
    });
    this.workers[slot] = worker;
    return worker;
  }

  private pickSlot(wide: boolean): number {
    if (!wide) return 0;
    return this.load[1]! < this.load[0]! ? 1 : 0;
  }

  hash(request: HashRequest): Promise<HashResult> {
    return new Promise((resolve) => {
      const slot = this.pickSlot(request.wide === true);
      let worker: Worker;
      try {
        worker = this.ensure(slot);
      } catch (err) {
        this.startError = err instanceof Error ? err.message : String(err);
        resolve(crashed(this.startError));
        return;
      }
      const id = this.nextId++;
      // A worker_threads port: it has no target origin (that rule is for window.postMessage).
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      const onAbort = (): void => worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
      this.load[slot]! += 1;
      this.pending.set(id, {
        onBytes: request.onBytes,
        slot,
        resolve: (result) => {
          request.signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      });
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
      const message = {
        type: 'hash',
        id,
        path: request.path,
        capBytesPerSec: request.capBytesPerSec,
        ...(request.size !== undefined ? { size: request.size } : {}),
      } satisfies WorkerRequest;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(message);
    });
  }

  close(): void {
    for (let i = 0; i < this.workers.length; i += 1) {
      const worker = this.workers[i];
      this.workers[i] = null;
      void worker?.terminate();
    }
  }
}

export interface CreateHasherOptions {
  /** Absolute path of the built hashWorker script (`hashWorker.js` next to main.js). */
  workerPath: string;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/**
 * The hasher the app uses: a worker thread, with a permanent fallback to async streams in the main
 * process if the worker cannot start at all (for example the script is missing from the build).
 */
export function createFileHasher(options: CreateHasherOptions): FileHasher {
  const worker = new WorkerHasher(options.workerPath);
  const fallback = inProcessHasher();
  let useFallback = false;
  return {
    get kind() {
      return useFallback ? 'in-process' : 'worker';
    },
    async hash(request) {
      if (!useFallback) {
        const result = await worker.hash(request);
        if (!(!result.ok && result.code === 'WORKER' && !worker.everReady)) return result;
        useFallback = true;
        options.log?.warn(`hashing: the worker thread could not start (${worker.startError ?? 'unknown reason'}); reading files in the main process instead`);
      }
      return fallback.hash(request);
    },
    close: () => worker.close(),
  };
}
