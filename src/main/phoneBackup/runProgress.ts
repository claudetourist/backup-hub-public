/**
 * What a running phone backup is doing, kept in memory for the window (read only): the file being copied now, the files still waiting in
 * copy order, the ones done and the ones that were not copied with their reason. It never decides anything and writes nothing; the run
 * tells it what happened. Lists are capped (the rest is counted), so 100,000 files stay small.
 */
import { PROGRESS_FAILED_LIMIT, PROGRESS_NEXT_LIMIT, PROGRESS_RECENT_LIMIT, type PhoneBackupProgress, type ProgressFailed } from '../../shared/phoneBackup';

export interface ProgressItem {
  path: string;
  size: number;
}

/** Most failures kept with their reason (the count is always exact). */
const KEEP_FAILED = 2000;

export class RunProgress {
  private readonly items: readonly ProgressItem[];
  /** Index of the file being copied, or -1. Files before `cursor` are finished; files after it are waiting. */
  private cursor: number;
  private copying = false;
  private doneCount = 0;
  private failedCount = 0;
  private readonly failedKept: ProgressFailed[] = [];
  /** Indexes of the last files done, oldest first. */
  private readonly recentIdx: number[] = [];
  private over = false;

  /** `startAt` and `earlierFailed` are for a run that carries on after a restart: the files before `startAt` are finished already. */
  constructor(items: readonly ProgressItem[], startAt = 0, earlierFailed: readonly { path: string; reason: string }[] = []) {
    this.items = items;
    this.cursor = Math.min(Math.max(0, startAt), items.length);
    const reasons = new Map(earlierFailed.map((f) => [f.path, f.reason]));
    for (let i = 0; i < this.cursor; i += 1) {
      const reason = reasons.get(items[i]!.path);
      if (reason === undefined) this.doneCount += 1;
      else this.addFailed(items[i]!, reason);
    }
  }

  /** The file at `index` is being copied now. */
  begin(index: number): void {
    this.cursor = index;
    this.copying = index >= 0 && index < this.items.length;
  }

  /** The file being copied is finished (copied and checked, or already on the drive). */
  done(): void {
    if (!this.copying) return;
    this.copying = false;
    this.doneCount += 1;
    this.recentIdx.push(this.cursor);
    if (this.recentIdx.length > PROGRESS_RECENT_LIMIT) this.recentIdx.shift();
    this.cursor += 1;
  }

  /** The file being copied was not copied, for this reason. */
  fail(reason: string): void {
    if (!this.copying) return;
    this.copying = false;
    this.addFailed(this.items[this.cursor]!, reason);
    this.cursor += 1;
  }

  /** The run is over: nothing is being copied any more. */
  end(): void {
    this.copying = false;
    this.over = true;
  }

  private addFailed(item: ProgressItem, reason: string): void {
    this.failedCount += 1;
    this.failedKept.push({ path: item.path, size: item.size, reason });
    if (this.failedKept.length > KEEP_FAILED) this.failedKept.shift();
  }

  snapshot(jobId: number): PhoneBackupProgress {
    const total = this.items.length;
    const firstWaiting = this.copying ? this.cursor + 1 : this.cursor;
    const current = this.copying ? this.items[this.cursor]! : null;
    return {
      jobId,
      total,
      done: this.doneCount,
      waiting: Math.max(0, total - firstWaiting),
      failedCount: this.failedCount,
      current: current && { path: current.path, size: current.size },
      next: this.items.slice(firstWaiting, firstWaiting + PROGRESS_NEXT_LIMIT).map((i) => ({ path: i.path, size: i.size })),
      recent: this.recentIdx.toReversed().map((i) => ({ path: this.items[i]!.path, size: this.items[i]!.size })),
      failed: this.failedKept.slice(-PROGRESS_FAILED_LIMIT).toReversed(),
      finished: this.over,
    };
  }
}
