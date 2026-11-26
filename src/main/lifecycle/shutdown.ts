/**
 * The one way out. Every exit (quit, last window closed, a crash we can survive long enough to tidy, a terminal signal, a Windows log-off
 * or shut-down, a dead renderer or GPU process) calls `run`. The steps run once, in order, each guarded: a step that throws or hangs
 * never stops the ones after it. A hard limit (5 s) ends the app whatever is still running. Pure: the clock, the timer and the exit are
 * passed in, so every trigger and the limit are tested without Electron.
 */

export const SHUTDOWN_LIMIT_MS = 5000;

export interface ShutdownStep {
  name: string;
  run(): void | Promise<unknown>;
  /** The most this step may take before the routine moves on to the next one. */
  maxMs?: number;
}

export interface ShutdownDeps {
  /** In the order they run. */
  steps: readonly ShutdownStep[];
  /** Ends the process at once (app.exit). Called on the hard limit, and after the steps when a caller asked for an exit. */
  exit(code: number): void;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  hardLimitMs?: number;
  /** One-shot timer, returns its cancel function (default setTimeout, unref'd). */
  schedule?: (run: () => void, ms: number) => () => void;
}

export interface RunOptions {
  /** After the steps, end the process with this code (a crash or a signal). Without it the caller carries on (a normal quit asks Electron to quit again). */
  exitCode?: number;
}

export interface Shutdown {
  /** Idempotent: the first call starts the steps, later calls return the same promise (and may still ask for the exit). Never rejects. */
  run(reason: string, options?: RunOptions): Promise<void>;
  readonly started: boolean;
  readonly finished: boolean;
}

const realSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const schedule = deps.schedule ?? realSchedule;
  const hardLimit = deps.hardLimitMs ?? SHUTDOWN_LIMIT_MS;
  let promise: Promise<void> | null = null;
  let finished = false;
  let exitCode: number | null = null;
  let exited = false;

  const exitOnce = (): void => {
    if (exited || exitCode === null) return;
    exited = true;
    try {
      deps.exit(exitCode);
    } catch (err) {
      deps.log.error('shutdown: exit failed', err);
    }
  };

  const guardedStep = async (step: ShutdownStep, cancelled: () => boolean): Promise<void> => {
    let cancelStepTimer: (() => void) | null = null;
    try {
      const work = Promise.resolve().then(() => step.run());
      const racers: Promise<unknown>[] = [work];
      if (step.maxMs !== undefined) {
        racers.push(
          new Promise<void>((resolve) => {
            cancelStepTimer = schedule(() => {
              deps.log.warn(`shutdown: "${step.name}" took more than ${step.maxMs} ms; moving on`);
              resolve();
            }, step.maxMs!);
          }),
        );
      }
      await Promise.race(racers);
    } catch (err) {
      if (!cancelled()) deps.log.warn(`shutdown: "${step.name}" failed`, err);
    } finally {
      (cancelStepTimer as (() => void) | null)?.();
    }
  };

  return {
    run(reason, options = {}) {
      if (options.exitCode !== undefined && exitCode === null) exitCode = options.exitCode;
      if (promise) {
        if (finished) exitOnce();
        return promise;
      }
      deps.log.info(`shutdown: starting (${reason})`);
      let limitHit = false;
      promise = new Promise<void>((resolve) => {
        const cancelLimit = schedule(() => {
          limitHit = true;
          deps.log.warn(`shutdown: hard limit of ${hardLimit} ms reached; ending the app now`);
          finished = true;
          exitCode ??= 0;
          exitOnce();
          resolve();
        }, hardLimit);
        void (async () => {
          for (const step of deps.steps) {
            if (limitHit) return;
            await guardedStep(step, () => limitHit);
          }
          if (limitHit) return;
          cancelLimit();
          finished = true;
          deps.log.info('shutdown: done');
          exitOnce();
          resolve();
        })();
      });
      return promise;
    },
    get started() {
      return promise !== null;
    },
    get finished() {
      return finished;
    },
  };
}

/** What the app hands to the routine; each one is a no-op when the thing was never built (a quit before the database opened). */
export interface AppShutdownParts {
  /** Stops the repeating timers: drive polling, USB health, the log keeper, the stall monitor and the upkeep scheduler's own loop. */
  stopTimers(): void;
  /** Stops running jobs at their next safe point (they keep their last checkpoint and show as interrupted at the next start) and waits for them, up to maxMs. */
  pauseJobs(maxMs: number): Promise<unknown>;
  /** Ends the upkeep process at once (an unfinished short transaction is rolled back by SQLite). */
  stopUpkeepProcess(): void;
  /** Closes the services that own a worker or a handle (query, search, quick listing, vault, pause). */
  closeServices(): void;
  /** Ends every worker thread still alive (search, query, listing, hashing). */
  terminateWorkers(): Promise<unknown>;
  /** adb kill-server when adb.exe exists. */
  releaseAdb(): Promise<unknown>;
  /** Ends every program the app started and still waits for (PowerShell, adb). */
  endChildren(): void;
  /** Records the clean shutdown and closes the database. */
  closeDatabase(): void;
}

/** The steps in the order that is safe: nothing new starts, jobs stop, workers and helpers end, the database closes last. Worst case adds up to under the hard limit. */
export function buildShutdownSteps(parts: AppShutdownParts): ShutdownStep[] {
  return [
    { name: 'stop timers', run: () => parts.stopTimers() },
    { name: 'pause running jobs at a checkpoint', run: () => parts.pauseJobs(1500), maxMs: 1700 },
    { name: 'stop the upkeep process', run: () => parts.stopUpkeepProcess() },
    { name: 'close services', run: () => parts.closeServices() },
    { name: 'end worker threads', run: () => parts.terminateWorkers(), maxMs: 800 },
    { name: 'let go of the phone', run: () => parts.releaseAdb(), maxMs: 1200 },
    { name: 'end helper processes', run: () => parts.endChildren() },
    { name: 'close the database', run: () => parts.closeDatabase() },
  ];
}
