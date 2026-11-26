import { parentPort } from 'node:worker_threads';
import { loadSqliteAddon, type Db } from '../db/connection';
import { migrateFile } from '../db/migrate';
import { openReadOnly, runQuery } from './queryCore';
import { answerSearch } from './answerSearch';
import { keepIndex } from './searchIndexKeeper';
import { checkOldCountsOf } from '../phoneBackup/checkOld';
import { behindOf } from '../mirror/mirrorScan';
import { backupSizesOf } from './backupSizes';
import { onlyHereSummaryOf, wouldLoseFilesOf, wouldLoseOf } from './wouldLose';
import type { IndexReply, QueryReply, QueryRequest } from './queryTypes';

/**
 * The query worker thread: runs the heavy read-only queries (coverage, file stats, the startup
 * quick_check, search, the Backups card's counts) on its OWN read-only connection, so the window never waits for them. It talks to
 * `QueryService` in queryService.ts. It writes nothing, with one exception: the one-off `migrate` request (a worker started
 * only for it, see `migrateInWorker`) opens the file read-write and brings it up to the latest version, so a migration of a big
 * database does not block the main loop.
 */
const port = parentPort;
if (port) {
  // Loads the SQLite addon on this thread first. Loading the DLL is slow (about 100 ms) and process-wide, so when the main thread
  // opens its own connection later (see warmSqliteInWorker) the addon is already in memory and the main loop does not stall.
  loadSqliteAddon();
  let db: Db | null = null;
  let openedFile = '';
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (reply: QueryReply): void => port.postMessage(reply);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const sendIndex = (reply: IndexReply): void => port.postMessage(reply);
  let stopKeeping = false;
  let pauseKeeping = false;
  port.on('message', (request: QueryRequest) => {
    const started = Date.now();
    try {
      if (request.op === 'indexKeep') {
        // A worker started for this alone: it never answers other requests. The loop writes the search index (own read-write connection).
        stopKeeping = false;
        keepIndex(request.dbFile, (progress) => sendIndex({ type: 'index', progress }), () => stopKeeping, {}, () => pauseKeeping).catch((err: unknown) => sendIndex({ type: 'indexFailed', message: err instanceof Error ? err.message : String(err) }));
        return;
      }
      if (request.op === 'indexPause') {
        pauseKeeping = request.paused === true;
        return;
      }
      if (request.op === 'indexStop') {
        stopKeeping = true;
        return;
      }
      if (request.op === 'migrate') {
        const result = migrateFile(request.dbFile);
        send({ type: 'result', id: request.id, ok: true, result, ms: Date.now() - started });
        return;
      }
      if (!db || openedFile !== request.dbFile) {
        db?.close();
        db = openReadOnly(request.dbFile);
        openedFile = request.dbFile;
      }
      const result =
        request.op === 'search' ? answerSearch(db, request.search!) : request.op === 'checkOldCounts' ? checkOldCountsOf(db, request.backupId) : request.op === 'mirrorBehind' ? behindOf(db, request.mirror!) : request.op === 'backupSizes' ? backupSizesOf(db, request.sizes ?? []) : request.op === 'wouldLose' ? (request.lose?.files ? wouldLoseFilesOf(db, request.lose.files) : request.lose?.placeId ? wouldLoseOf(db, request.lose.placeId) : onlyHereSummaryOf(db)) : runQuery(db, request.op);
      send({ type: 'result', id: request.id, ok: true, result, ms: Date.now() - started });
    } catch (err) {
      send({ type: 'result', id: request.id, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
  send({ type: 'ready' });
}
