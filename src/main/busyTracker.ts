/**
 * What the main thread was busy with, so a freeze can be named afterwards. Every window call (IPC) is noted here by secureIpc:
 * when it started, how long its synchronous part held the main thread, and whether it is still waiting for an answer.
 * The stall monitor asks `describeBusy` for the calls that overlapped a stall, so the log says WHICH call froze the app.
 */
export interface BusyCall {
  label: string;
  startedAt: number;
  /** Time the call held the main thread before returning (its synchronous part). */
  syncMs: number;
  endedAt: number | null;
}

const KEEP = 50;

export class BusyTracker {
  private readonly recent: BusyCall[] = [];
  private readonly active = new Set<BusyCall>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Starts a call; the returned functions mark the end of its synchronous part and its answer. */
  begin(label: string): { syncDone: () => number; finished: () => void } {
    const call: BusyCall = { label, startedAt: this.now(), syncMs: 0, endedAt: null };
    this.active.add(call);
    this.recent.push(call);
    if (this.recent.length > KEEP) this.recent.shift();
    return {
      syncDone: () => (call.syncMs = this.now() - call.startedAt),
      finished: () => {
        call.endedAt = this.now();
        this.active.delete(call);
      },
    };
  }

  /** The calls that ran during the last `windowMs` (or are still running), longest main-thread hold first. */
  overlapping(windowMs: number): BusyCall[] {
    const from = this.now() - windowMs;
    return this.recent
      .filter((c) => c.endedAt === null || c.endedAt >= from || c.startedAt + c.syncMs >= from)
      .toSorted((a, b) => b.syncMs - a.syncMs);
  }

  /** One line for the log: "backups:overview held 5900 ms; phone-backup:connected (waiting)". Empty when nothing ran. */
  describe(windowMs: number): string {
    const calls = this.overlapping(windowMs).slice(0, 4);
    return calls
      .map((c) => (c.syncMs >= 50 ? `${c.label} held ${Math.round(c.syncMs)} ms` : c.endedAt === null ? `${c.label} (waiting)` : c.label))
      .join('; ');
  }
}

/** The app's one tracker (main process). */
export const busy = new BusyTracker();
