import Database from 'better-sqlite3';
import { parentPort } from 'node:worker_threads';
import { BUSY_TIMEOUT_MS, type Db } from '../db/connection';
import { doWork } from './quickWalkRunner';
import type { QuickWalkWorkerReply, QuickWalkWorkerRequest } from './quickWalkRunner';

/**
 * The listing worker thread: "Look again" AND the full listing, on its OWN read-write connection, so the folder reads and the
 * saves (new and changed files, files marked gone, folder times) never run on the main process, where big passes over a
 * big ledger froze the window. It does exactly what the job did on the main thread (see `doWork`). Talks to `WorkerQuickWalkRunner`
 * in quickWalkRunner.ts: progress ticks wait for the main side to answer "go" (that is where a job pauses or stops).
 */
const port = parentPort;
if (port) {
  let db: Db | null = null;
  let openedFile = '';
  const aborts = new Map<number, AbortController>();
  const waiting = new Map<number, () => void>();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (reply: QuickWalkWorkerReply): void => port.postMessage(reply);

  const open = (dbFile: string): Db => {
    if (!db || openedFile !== dbFile) {
      db?.close();
      // The journal mode (WAL) is stored in the file; only the per-connection settings are set here.
      db = new Database(dbFile, { fileMustExist: true });
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.pragma('synchronous = NORMAL');
      openedFile = dbFile;
    }
    return db;
  };

  const release = (id: number): void => {
    waiting.get(id)?.();
    waiting.delete(id);
  };

  const run = async (message: Extract<QuickWalkWorkerRequest, { type: 'run' }>): Promise<void> => {
    const { id, payload } = message;
    const controller = new AbortController();
    aborts.set(id, controller);
    try {
      const result = await doWork(open(message.dbFile), payload, {
        signal: controller.signal,
        tick: (counts) =>
          new Promise<void>((resolve) => {
            waiting.set(id, resolve);
            send({ type: 'tick', id, counts });
          }),
      });
      send({ type: 'done', id, ok: true, result });
    } catch (err) {
      send({ type: 'done', id, ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      aborts.delete(id);
      waiting.delete(id);
    }
  };

  port.on('message', (message: QuickWalkWorkerRequest) => {
    if (message.type === 'run') void run(message);
    else if (message.type === 'go') release(message.id);
    else {
      aborts.get(message.id)?.abort();
      release(message.id);
    }
  });
  send({ type: 'ready' });
}
