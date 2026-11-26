import type { Db } from './connection';
import type { CheckpointMode, CheckpointResult } from '../listing/quickWalkRunner';

/**
 * Keeps the write-ahead log (`backuphub.db-wal`) small without the main thread doing the work.
 * SQLite folds the log back into the database file when a commit finds it past ~4 MB, and that commit pays for it:
 * on a big database that was a long stop in the main process, and on 6 Nov the log reached 583 MB. So the main connection
 * does not do it any more (`wal_autocheckpoint = 0`); a worker thread's own connection does it, every `intervalMs` (PASSIVE:
 * copies what it can without waiting) and after big jobs (TRUNCATE: also empties the log file, so it does not stay huge).
 * If the worker cannot do it, the main connection goes back to checkpointing by itself.
 */
export interface WalKeeperOptions {
  db: Db;
  /** Runs `PRAGMA wal_checkpoint(mode)` on another thread's connection. */
  checkpoint: (mode: CheckpointMode) => Promise<CheckpointResult>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  intervalMs?: number;
  /** When the emptying found a reader or writer in the way, it asks again after this long (default 10 s), up to `maxRetries` times. */
  retryMs?: number;
  maxRetries?: number;
}

export class WalKeeper {
  private timer: NodeJS.Timeout | null = null;
  private failed = false;
  private truncating = false;
  private truncateAgain = false;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: WalKeeperOptions) {}

  start(): void {
    if (this.timer) return;
    this.o.db.pragma('wal_autocheckpoint = 0');
    this.timer = setInterval(() => void this.run('PASSIVE'), this.o.intervalMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A big job ended (listing, fingerprints, sorting, migration): empty the log file once nothing else is using it. */
  truncateSoon(): void {
    this.retries = 0;
    this.truncate();
  }

  private truncate(): void {
    if (this.truncating) {
      this.truncateAgain = true;
      return;
    }
    this.truncating = true;
    void this.run('TRUNCATE').then((busy) => this.afterTruncate(busy));
  }

  private afterTruncate(busy: boolean): void {
    this.truncating = false;
    if (this.truncateAgain) {
      this.truncateAgain = false;
      this.truncate();
    } else if (busy && this.retries < (this.o.maxRetries ?? 30) && this.timer !== null) {
      // Something was reading or writing: the emptying does not wait for it (that froze every writer). Ask again soon.
      this.retries += 1;
      this.retryTimer = setTimeout(() => this.truncate(), this.o.retryMs ?? 10_000);
      this.retryTimer.unref();
    }
  }

  /** Resolves true when the checkpoint could not finish because something was in the way. */
  private async run(mode: CheckpointMode): Promise<boolean> {
    if (this.failed || !this.o.db.open) return false;
    try {
      return (await this.o.checkpoint(mode)).busy;
    } catch (err) {
      this.failed = true;
      this.o.log.warn('db: the log checkpoint could not run on the worker thread; the main connection does it again', err);
      try {
        if (this.o.db.open) this.o.db.pragma('wal_autocheckpoint = 1000');
      } catch {
        // The database is closing; nothing to restore.
      }
      return false;
    }
  }
}
