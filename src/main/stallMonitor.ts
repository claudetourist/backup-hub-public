/**
 * Notices when the main process stops answering for a while (a long synchronous slice somewhere) and says so in the log with
 * the kinds of jobs that were running, so a "Not responding" window can be diagnosed from the log afterwards.
 * It is a timer that expects to fire every `intervalMs`; when it fires much later, the loop was blocked in between.
 */
export interface StallMonitorOptions {
  /** A stall at least this long is reported. */
  thresholdMs: number;
  /** How often the timer is expected to fire. */
  intervalMs?: number;
  /** The job kinds running now (for the log line). */
  runningKinds?: () => string[];
  /** What else was busy (the window calls that overlapped the stall), for the log line; empty when nothing. */
  busyDuring?: (windowMs: number) => string;
  /** Where the warning goes. */
  warn?: (message: string) => void;
  /** Called for every stall at or over the threshold (tests). */
  onStall?: (ms: number, kinds: string[]) => void;
  /** Clock; tests may pass a fake. */
  now?: () => number;
}

export class StallMonitor {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private longest = 0;
  private count = 0;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly o: StallMonitorOptions) {
    this.intervalMs = o.intervalMs ?? 100;
    this.now = o.now ?? Date.now;
  }

  /** The longest stall seen so far (ms over the expected interval). */
  get maxStallMs(): number {
    return this.longest;
  }

  /** How many stalls at or over the threshold were seen. */
  get stalls(): number {
    return this.count;
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    // Watching must never keep the app open.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by the timer; exposed so tests can drive it with a fake clock. */
  check(): void {
    const t = this.now();
    const late = t - this.last - this.intervalMs;
    this.last = t;
    if (late > this.longest) this.longest = late;
    if (late < this.o.thresholdMs) return;
    this.count += 1;
    const kinds = this.o.runningKinds?.() ?? [];
    this.o.onStall?.(late, kinds);
    const doing = kinds.length > 0 ? `while running: ${[...new Set(kinds)].join(', ')}` : 'with no job running';
    const during = this.o.busyDuring?.(late + this.intervalMs * 2) ?? '';
    this.o.warn?.(`main loop stalled for ${Math.round(late)} ms ${doing}${during ? `; window calls: ${during}` : ''}`);
  }
}
