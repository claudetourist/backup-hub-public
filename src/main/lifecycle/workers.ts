import { Worker, type WorkerOptions } from 'node:worker_threads';

/**
 * Every worker thread the app starts is created here: it gets a memory limit (a runaway worker ends itself instead of the whole app
 * growing), and it is recorded while it lives so the shutdown routine can end all of them. Workers are meant to be reused: a service keeps
 * one and sends it requests; a one-off worker (start-up check, migration) ends itself after its single answer.
 */

export type WorkerKind = 'query' | 'search' | 'listing' | 'hashing' | 'oneShot';

/** Old-generation heap limit per worker, in MB. Counts and searches hold result lists, so they get more room than the readers. */
export const WORKER_HEAP_LIMIT_MB: Record<WorkerKind, number> = {
  query: 512,
  search: 512,
  oneShot: 512,
  listing: 256,
  hashing: 256,
};

export class WorkerRegistry {
  private readonly workers = new Set<Worker>();

  add(worker: Worker): void {
    this.workers.add(worker);
    worker.once('exit', () => this.workers.delete(worker));
  }

  get size(): number {
    return this.workers.size;
  }

  /** Ends every worker. Resolves when all have stopped (the shutdown routine bounds how long it waits). Never rejects. */
  async terminateAll(): Promise<number> {
    const all = [...this.workers];
    this.workers.clear();
    await Promise.all(all.map((worker) => worker.terminate().catch(() => undefined)));
    return all.length;
  }
}

/** The one registry of this process. */
export const workerRegistry = new WorkerRegistry();

/** Starts a worker with its heap limit, recorded in the registry. `options.resourceLimits` may add to or override the default. */
export function createWorker(kind: WorkerKind, file: string | URL, options: WorkerOptions = {}, registry: WorkerRegistry = workerRegistry): Worker {
  const worker = new Worker(file, { ...options, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_LIMIT_MB[kind], ...options.resourceLimits } });
  registry.add(worker);
  return worker;
}
