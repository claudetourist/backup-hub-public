import type { UpkeepCommand, UpkeepReport } from './upkeepProtocol';

/**
 * Decides when the invisible upkeep process may run, and stops it fast. A pure class: the clock, the idle time, the power source, the
 * job queue, Pause everything and the process itself are all passed in, so every rule is tested without Electron.
 *
 * It may start only when ALL of these hold: the computer has been idle for 3 minutes, it is on mains power, no job is queued or running,
 * and Pause everything is off. It looks every 30 seconds; while the process runs it looks every second, and the moment any condition
 * ends (the person touches the keyboard, a job is created, Pause everything is switched on) it tells the process to stop. The process
 * finishes the chunk in hand (one short transaction) and exits; if it has not exited after a few seconds it is ended (SQLite rolls back
 * an unfinished transaction, nothing is lost). Errors go to the app log only. Nothing here is ever shown in Activity or on Home.
 */

/** The computer must have been idle this long (seconds of no keyboard or mouse). */
export const IDLE_NEEDED_SECONDS = 180;
export const CHECK_EVERY_MS = 30_000;
/** While the process runs, the conditions are looked at this often. */
export const WATCH_EVERY_MS = 1000;
/** A process told to stop that has not exited by then is ended. */
export const STOP_GRACE_MS = 5000;
/** After a pass that found nothing left to do, wait this long before the next one. */
export const RERUN_AFTER_NOTHING_LEFT_MS = 60 * 60 * 1000;
/** After a failure or a busy data file, wait this long. */
export const RERUN_AFTER_TROUBLE_MS = 10 * 60 * 1000;

/** The process as the scheduler sees it. The Electron wrapper (electronUpkeep.ts) and the test fake both implement this. */
export interface UpkeepChild {
  postMessage(command: UpkeepCommand): void;
  /** Ends the process at once. */
  kill(): void;
  /** Called with the process id once it has started (the id is not known before). */
  onSpawn(listener: (pid: number) => void): void;
  onMessage(listener: (report: UpkeepReport) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface UpkeepSchedulerDeps {
  /** Epoch ms. */
  now(): number;
  /** Seconds since the last keyboard or mouse input (powerMonitor.getSystemIdleTime). */
  idleSeconds(): number;
  /** True on battery power (powerMonitor.isOnBatteryPower). */
  onBattery(): boolean;
  /** A job is queued or running. */
  jobsBusy(): boolean;
  /** Pause everything is on. */
  paused(): boolean;
  /** Starts the process; null when it cannot be started (no database file). */
  spawn(): UpkeepChild | null;
  /** The database file the process opens. */
  dbFile: string;
  /** Lowers the process's priority (os.setPriority with PRIORITY_LOW). */
  lowerPriority(pid: number): void;
  /** One-shot timer; returns its cancel function. */
  schedule(run: () => void, ms: number): () => void;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export class UpkeepScheduler {
  private child: UpkeepChild | null = null;
  private report: UpkeepReport | null = null;
  private stopAskedAt: number | null = null;
  private cancelKill: (() => void) | null = null;
  private cancelLoop: (() => void) | null = null;
  private nextAllowedAt = 0;
  private running = false;

  constructor(private readonly d: UpkeepSchedulerDeps) {}

  /** Begin looking every 30 seconds. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm(CHECK_EVERY_MS);
  }

  /** The app is closing (or upkeep is switched off): stop looking and ask a running process to stop. */
  stop(): void {
    this.running = false;
    this.cancelLoop?.();
    this.cancelLoop = null;
    if (this.child) this.requestStop();
  }

  /** The app is shutting down: stop looking and end the process at once (SQLite rolls back an unfinished short transaction; nothing is lost). */
  endNow(): void {
    this.running = false;
    this.cancelLoop?.();
    this.cancelLoop = null;
    this.cancelKill?.();
    this.cancelKill = null;
    const child = this.child;
    this.child = null;
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  /** True when every condition for running upkeep holds right now. Cheapest checks first. */
  conditionsHold(): boolean {
    return !this.d.paused() && !this.d.onBattery() && this.d.idleSeconds() >= IDLE_NEEDED_SECONDS && !this.d.jobsBusy();
  }

  /**
   * Look now: start the process when it is allowed, or ask a running one to stop when a condition has ended. The timer calls this;
   * main also calls it at once when a job is created or Pause everything changes, so the stop does not wait for the next second.
   */
  check(): void {
    if (!this.running) return;
    if (this.child) {
      if (!this.conditionsHold()) this.requestStop();
      return;
    }
    if (this.d.now() < this.nextAllowedAt || !this.conditionsHold()) return;
    this.launch();
  }

  private arm(ms: number): void {
    this.cancelLoop?.();
    this.cancelLoop = this.d.schedule(() => {
      this.cancelLoop = null;
      this.check();
      if (this.running) this.arm(this.child ? WATCH_EVERY_MS : CHECK_EVERY_MS);
    }, ms);
  }

  private launch(): void {
    let child: UpkeepChild | null = null;
    try {
      child = this.d.spawn();
    } catch (err) {
      this.d.log.error('upkeep: the process could not be started', err);
    }
    if (child === null) {
      this.nextAllowedAt = this.d.now() + RERUN_AFTER_TROUBLE_MS;
      return;
    }
    this.child = child;
    this.report = null;
    this.stopAskedAt = null;
    child.onSpawn((pid) => {
      try {
        this.d.lowerPriority(pid);
      } catch (err) {
        this.d.log.warn('upkeep: could not lower the priority of the process', err);
      }
    });
    child.onMessage((report) => {
      this.report = report;
    });
    child.onExit((code) => this.exited(child, code));
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    child.postMessage({ type: 'start', dbFile: this.d.dbFile });
    this.arm(WATCH_EVERY_MS);
  }

  private requestStop(): void {
    const child = this.child;
    if (!child || this.stopAskedAt !== null) return;
    this.stopAskedAt = this.d.now();
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      child.postMessage({ type: 'stop' });
    } catch {
      // The process is already gone; its exit is reported next.
    }
    this.cancelKill = this.d.schedule(() => {
      if (this.child === child) {
        this.d.log.warn('upkeep: the process did not stop in time and was ended');
        child.kill();
      }
    }, STOP_GRACE_MS);
  }

  private exited(child: UpkeepChild, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.cancelKill?.();
    this.cancelKill = null;
    const report = this.report;
    const now = this.d.now();
    if (report?.type === 'finished') {
      if (report.summary.busy) this.nextAllowedAt = now + RERUN_AFTER_TROUBLE_MS;
      else if (report.summary.nothingLeft && !report.summary.stopped) this.nextAllowedAt = now + RERUN_AFTER_NOTHING_LEFT_MS;
      else this.nextAllowedAt = now;
    } else {
      this.d.log.error(`upkeep: the process ended without finishing (${report?.type === 'failed' ? report.message : `exit code ${code ?? 'none'}`})`);
      this.nextAllowedAt = now + RERUN_AFTER_TROUBLE_MS;
    }
    if (this.running) this.arm(CHECK_EVERY_MS);
  }
}
