import type { Db } from '../db/connection';
import type { UpkeepCommand, UpkeepReport } from './upkeepProtocol';
import { runUpkeep } from './upkeepWork';

/**
 * The logic of the upkeep process, with everything it touches passed in, so a test can run it against a fake port and a temp database.
 * The real entry (upkeepProcess.ts) is only the glue to Electron's `process.parentPort` and the database file.
 */

export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: UpkeepReport): void;
}

export interface UpkeepProcessDeps {
  /** Opens the database read-write with its own connection (busy timeout set). */
  open: (file: string) => Db;
  now: () => number;
  /** Ends the process once the last report is sent. */
  exit: (code: number) => void;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

const quiet = { info: () => undefined, warn: () => undefined };

export function isUpkeepCommand(value: unknown): value is UpkeepCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; dbFile?: unknown };
  return v.type === 'stop' || (v.type === 'start' && typeof v.dbFile === 'string' && v.dbFile.length > 0);
}

/** Listens for `start` and `stop`, runs one upkeep pass, reports, exits. Returns a promise that settles when the pass is over (tests await it). */
export function runUpkeepProcess(port: ParentPortLike, deps: UpkeepProcessDeps): Promise<void> {
  let stop = false;
  let started = false;
  const log = deps.log ?? quiet;
  return new Promise<void>((resolve) => {
    const end = (report: UpkeepReport, code: number): void => {
      try {
        port.postMessage(report);
      } finally {
        deps.exit(code);
        resolve();
      }
    };
    port.on('message', (event) => {
      const command = event.data;
      if (!isUpkeepCommand(command)) return;
      if (command.type === 'stop') {
        stop = true;
        // Told to stop before it began: nothing to do.
        if (!started) end({ type: 'finished', summary: { stopped: true, busy: false, sorted: 0, eventsTrimmed: 0, jobsTrimmed: 0, optimized: false, nothingLeft: false } }, 0);
        return;
      }
      if (started) return;
      started = true;
      void (async () => {
        let db: Db | null = null;
        try {
          db = deps.open(command.dbFile);
          const summary = await runUpkeep({
            db,
            now: deps.now,
            shouldStop: () => stop,
            // A timer, not an immediate: the event loop reads the "stop" message while it waits.
            pause: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
            log,
          });
          db.close();
          db = null;
          end({ type: 'finished', summary }, 0);
        } catch (err) {
          try {
            db?.close();
          } catch {
            // The connection was already unusable; the process ends next.
          }
          end({ type: 'failed', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 1);
        }
      })();
    });
  });
}
