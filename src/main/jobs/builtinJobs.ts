import path from 'node:path';
import type { DemoJobOptions } from '../../shared/jobs';
import type { IntegrityResult } from '../db/connection';
import { createSnapshotAsync, DB_FILE_NAME, SnapshotRefused, markFullCheckPassed, probeIntegrity, pruneSnapshots, snapshotIsDue, snapshotsDir, type Db, type SnapshotResult } from '../db';
import { JobFailure, type JobContext, type JobHandler, type JobService, type JobServiceLogger } from './jobService';

export const KIND_INTEGRITY = 'db.integrityCheck';
export const KIND_SNAPSHOT = 'db.snapshot';
export const KIND_DEMO = 'dev.demo';
export const KIND_DEMO_HEAVY = 'dev.demoHeavy';

export interface BuiltinDeps {
  db: Db;
  dataDir: string;
  log: JobServiceLogger;
  /**
   * Runs the full integrity check on a worker thread (resolves null when the worker cannot start). Without it the check
   * runs on the main thread, which freezes the window for as long as it takes (tests only).
   */
  checkInWorker?: ((file: string) => Promise<IntegrityResult | null>) | undefined;
  /** A plain sentence when there is not enough room on the data disk for a saved copy, else null. */
  copyRefusal?: (() => string | null) | undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Full `PRAGMA integrity_check` through a read-only connection (the startup path only runs quick_check). */
export function integrityHandler(deps: BuiltinDeps): JobHandler {
  return {
    kind: KIND_INTEGRITY,
    heavy: true,
    async run(ctx) {
      const file = path.join(deps.dataDir, DB_FILE_NAME);
      ctx.log('info', 'Checking every page of the database (read only)');
      await ctx.yield();
      const result = (deps.checkInWorker ? await deps.checkInWorker(file) : null) ?? probeIntegrity(file, 'full');
      if (!result.ok) {
        throw new JobFailure(
          'The database did not pass its full safety check. Your files are not affected; please tell Claude. Daily copies of the database are in the snapshots folder.',
          result.messages.join('\n'),
        );
      }
      markFullCheckPassed(deps.db, Date.now());
      return 'The database passed its full safety check';
    },
  };
}

/** One copy per 24 h, keep 7 (as F2's `snapshotIfDue`), copied in steps so the app stays responsive. */
export function snapshotHandler(deps: BuiltinDeps): JobHandler {
  return {
    kind: KIND_SNAPSHOT,
    heavy: false,
    async run(ctx) {
      await ctx.yield();
      const dir = snapshotsDir(deps.dataDir);
      if (!snapshotIsDue(dir, new Date())) return 'A copy from the last 24 hours already exists';
      let result: SnapshotResult;
      try {
        result = await createSnapshotAsync(deps.db, deps.dataDir, new Date(), deps.copyRefusal);
      } catch (err) {
        if (err instanceof SnapshotRefused) {
          // Not an error of the database: the disk is short of room. The job ends with a warning, and Home shows the same advice.
          ctx.warn(err.message);
          return 'No daily copy was made (not enough room on the disk)';
        }
        throw new JobFailure('The daily copy of the database could not be written. The database itself is fine.', (err as Error).message);
      }
      const pruned = pruneSnapshots(dir);
      deps.log.info(`db snapshot: ${result.created ? 'wrote' : 'already had'} ${result.path}; pruned ${pruned.length}`);
      return result.created ? 'Wrote a daily copy of the database' : 'A copy for this moment already existed';
    },
  };
}

/** Dev only: counts to N with sleeps so every state can be seen. */
export function demoHandler(kind: string, heavy: boolean): JobHandler {
  return {
    kind,
    heavy,
    resumable: true,
    async run(ctx: JobContext) {
      const o = (ctx.params ?? {}) as DemoJobOptions;
      const steps = Math.max(1, Math.min(500, Math.floor(o.steps ?? 10)));
      const stepMs = Math.max(0, Math.min(10_000, Math.floor(o.stepMs ?? 400)));
      const bytesPerStep = Math.max(0, Math.floor(o.bytesPerStep ?? 0));
      const mode = o.mode ?? 'ok';
      const resume = ctx.resume as { step?: number; asked?: boolean } | null;
      let asked = resume?.asked ?? false;
      const startAt = Math.min(steps, Math.max(0, resume?.step ?? 0));
      ctx.log('info', `Demo job: ${steps} steps, ${stepMs} ms each, mode ${mode}`);
      for (let step = startAt; step < steps; step += 1) {
        await sleep(stepMs, ctx.signal);
        await ctx.yield();
        const n = step + 1;
        ctx.progress(n, steps, {
          bytesDone: n * bytesPerStep,
          bytesTotal: steps * bytesPerStep,
          message: `Step ${n} of ${steps}`,
        });
        ctx.checkpoint({ step: n, asked });
        const halfway = Math.floor(steps / 2);
        if (n === 3 && mode === 'warn') ctx.warn('Demo warning: one file was skipped because it was in use');
        if (n === halfway && mode === 'fail') {
          throw new JobFailure(
            'The demo job was told to fail halfway, so it stopped.',
            `Error: demo failure at step ${n}\n    at demoHandler (builtinJobs.ts)`,
          );
        }
        if (n === halfway && mode === 'ask' && !asked) {
          asked = true;
          const answer = await ctx.needsYou('Demo question: keep going with the second half?', ['Keep going', 'Stop here']);
          if (answer === 'Stop here') throw new JobFailure('You chose to stop the demo here.');
        }
      }
      return mode === 'warn' ? 'Demo finished (with a warning)' : 'Demo finished';
    },
  };
}

/** Register the app's own job kinds. `dev` adds the demo kinds. */
export function registerBuiltinJobs(service: JobService, deps: BuiltinDeps, dev: boolean): void {
  service.register(integrityHandler(deps));
  service.register(snapshotHandler(deps));
  if (dev) {
    service.register(demoHandler(KIND_DEMO, false));
    service.register(demoHandler(KIND_DEMO_HEAVY, true));
  }
}

/** Dev only: one job in each state, for screenshots and eyeballing (BACKUPHUB_DEMO_JOBS=1). */
export function seedDemoJobs(service: JobService): void {
  service.create(KIND_DEMO_HEAVY, 'Copy Reunion folder to T7 (demo)', {
    steps: 60,
    stepMs: 1500,
    bytesPerStep: 420_000_000,
  } satisfies DemoJobOptions);
  service.create(KIND_DEMO_HEAVY, 'Hash Poco F4 camera (demo, waits for the copy)', {
    steps: 20,
    stepMs: 500,
  } satisfies DemoJobOptions);
  service.create(KIND_DEMO, 'Check phone storage (demo, asks you)', {
    steps: 8,
    stepMs: 400,
    mode: 'ask',
  } satisfies DemoJobOptions);
  service.create(KIND_DEMO, 'Check OneDrive files (demo, finishes cleanly)', { steps: 5, stepMs: 300 } satisfies DemoJobOptions);
  service.create(KIND_DEMO, 'Scan Spare phone backup (demo, with a warning)', {
    steps: 8,
    stepMs: 300,
    mode: 'warn',
  } satisfies DemoJobOptions);
  service.create(KIND_DEMO, 'Upload to Drive account 7 (demo, fails)', {
    steps: 8,
    stepMs: 300,
    mode: 'fail',
  } satisfies DemoJobOptions);
}
