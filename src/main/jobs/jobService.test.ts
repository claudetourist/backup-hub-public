import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANCELLED_MESSAGE,
  DISMISSED_MESSAGE,
  INTERRUPTED_MESSAGE,
  isContinuable,
  PAUSED_MESSAGE,
  PAUSING_MESSAGE,
  parseJobError,
  SLEPT_MESSAGE,
  type JobChangedEvent,
  type JobRecord,
  type JobState,
} from '../../shared/jobs';
import { closeDatabase, initDatabase, type Db } from '../db';
import { integrityHandler, snapshotHandler } from './builtinJobs';
import { JobFailure, JobService, type JobContext, type JobHandler } from './jobService';
import { JobStore } from './jobStore';
import type { ThrottleClock } from './throttle';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;
let service: JobService;
let clockNow = 1_800_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-jobs-test-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  clockNow = 1_800_000_000_000;
  service = new JobService({ db, log: silent, now: () => clockNow });
});

afterEach(() => {
  service.shutdown();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A handler the test finishes by hand. */
function gate(kind: string, heavy = false, extra: Partial<JobHandler> = {}) {
  const started: number[] = [];
  const releases = new Map<number, { ok: (r?: string) => void; fail: (e: Error) => void }>();
  const handler: JobHandler = {
    kind,
    heavy,
    ...extra,
    run: (ctx) =>
      new Promise((resolve, reject) => {
        started.push(ctx.jobId);
        releases.set(ctx.jobId, { ok: (r) => resolve(r), fail: reject });
      }),
  };
  return { handler, started, releases };
}

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const stateOf = (id: number): JobState => {
  const job = service.get(id);
  if (!job) throw new Error(`no job ${id}`);
  return job.state;
};
const waitState = (id: number, state: JobState) => until(() => stateOf(id) === state, `job ${id} -> ${state}`);
const texts = (id: number) => service.events(id).map((e) => e.text);

describe('state machine', () => {
  it('queued -> running -> done, with events and one change event per state change', async () => {
    const events: JobChangedEvent[] = [];
    service.onChanged((e) => events.push(e));
    const g = gate('test.a');
    service.register(g.handler);
    const id = service.create('test.a', 'Test A', { x: 1 });
    expect(stateOf(id)).toBe('queued');

    service.start();
    await waitState(id, 'running');
    await until(() => g.started.includes(id));
    expect(service.get(id)?.startedAt).toBe(clockNow);
    g.releases.get(id)?.ok('All good');
    await waitState(id, 'done');

    const job = service.get(id);
    expect(job).toMatchObject({ state: 'done', message: 'All good', error: null, finishedAt: clockNow });
    expect(texts(id)).toEqual(['Started', 'Finished']);
    const sequence = events.filter((e) => e.job.id === id).map((e) => `${e.reason}:${e.job.state}`);
    expect(sequence).toEqual(['created:queued', 'state:running', 'state:done']);
  });

  it('only ever stores the six states', () => {
    const id = service.create('test.none', 'x');
    expect(() => db.prepare("UPDATE jobs SET state = 'paused' WHERE id = ?").run(id)).toThrow();
  });

  it('nothing runs before start()', async () => {
    const g = gate('test.a');
    service.register(g.handler);
    const id = service.create('test.a', 'Test A');
    await new Promise((r) => setTimeout(r, 40));
    expect(stateOf(id)).toBe('queued');
    expect(g.started).toEqual([]);
    service.start();
    await until(() => g.started.length === 1);
  });

  it('ends as done_warnings when any warn() happened, keeping the warnings', async () => {
    service.register({
      kind: 'test.warn',
      heavy: false,
      run: async (ctx) => {
        ctx.warn('File A was skipped');
        ctx.warn('File B was skipped');
        return { message: 'Finished, with gaps' };
      },
    });
    service.start();
    const id = service.create('test.warn', 'Warn');
    await waitState(id, 'done_warnings');
    const job = service.get(id);
    expect(job?.warnings).toEqual(['File A was skipped', 'File B was skipped']);
    expect(job?.message).toBe('Finished, with gaps');
    expect(service.events(id).filter((e) => e.level === 'warn').map((e) => e.text)).toContain('File A was skipped');
  });

  it('failed jobs keep a plain message and put the technical detail in the job log', async () => {
    service.register({
      kind: 'test.fail',
      heavy: false,
      run: async () => {
        throw new JobFailure('Drive 7 is full.', 'HTTP 403 storageQuotaExceeded');
      },
    });
    service.register({
      kind: 'test.crash',
      heavy: false,
      run: async () => {
        throw new TypeError('x is not a function');
      },
    });
    service.start();
    const a = service.create('test.fail', 'Fail');
    const b = service.create('test.crash', 'Crash');
    await waitState(a, 'failed');
    await waitState(b, 'failed');
    expect(service.get(a)?.error).toBe('Drive 7 is full.');
    expect(texts(a).some((t) => t.includes('storageQuotaExceeded'))).toBe(true);
    // An unexpected error never leaks its message as the headline, but the log has it.
    expect(service.get(b)?.error).toMatch(/Something unexpected went wrong/);
    expect(service.get(b)?.error).not.toMatch(/not a function/);
    expect(texts(b).some((t) => t.includes('x is not a function'))).toBe(true);
  });

  it('an unexpected error stores its kind, and writes the stack and the last step into the job log at error level', async () => {
    service.register({
      kind: 'test.crash2',
      heavy: false,
      run: async (ctx) => {
        ctx.progress(3, 10, { message: 'Sorting 3 of 10' });
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
    });
    service.start();
    const id = service.create('test.crash2', 'Crash');
    await waitState(id, 'failed');
    expect(parseJobError(service.get(id)?.error ?? null).code).toBe('busy');
    const errors = service.events(id).filter((e) => e.level === 'error').map((e) => e.text);
    expect(errors.some((t) => t.startsWith('Technical detail: ') && t.includes('database is locked') && t.includes('at '))).toBe(true);
    expect(errors).toContain('Last step: Sorting 3 of 10');
    // The stored code never shows in the log line the person reads.
    expect(errors.some((t) => t.startsWith('[busy]'))).toBe(false);
  });

  it('a log line that cannot be written does not kill the job', async () => {
    service.register({
      kind: 'test.log',
      heavy: false,
      run: async (ctx) => {
        db.exec('CREATE TRIGGER no_events BEFORE INSERT ON job_events WHEN NEW.text = \'boom\' BEGIN SELECT RAISE(ABORT, \'database is locked\'); END');
        ctx.log('info', 'boom');
        ctx.log('info', 'after');
        return 'still done';
      },
    });
    service.start();
    const id = service.create('test.log', 'Log');
    await waitState(id, 'done');
    expect(texts(id)).toContain('after');
  });

  it('fails a queued job whose kind has no handler', async () => {
    service.start();
    const id = service.create('test.ghost', 'Ghost');
    await waitState(id, 'failed');
    expect(service.get(id)?.error).toMatch(/not available/);
  });
});

describe('progress and speed', () => {
  it('reports speed and time left while running and fills the bar on completion', async () => {
    let ctxRef: JobContext | null = null;
    let release: () => void = () => {};
    service.register({
      kind: 'test.p',
      heavy: false,
      run: (ctx) =>
        new Promise((resolve) => {
          ctxRef = ctx;
          release = () => resolve('done');
        }),
    });
    service.start();
    const id = service.create('test.p', 'P');
    await until(() => ctxRef !== null);
    const ctx = ctxRef as unknown as JobContext;

    ctx.progress(0, 100, { bytesDone: 0, bytesTotal: 1000 });
    clockNow += 2000;
    ctx.progress(20, 100, { bytesDone: 200, bytesTotal: 1000 });
    const live = service.get(id);
    expect(live?.speed).toMatchObject({ unit: 'bytes', perSecond: 100 });
    expect(live?.etaSeconds).toBe(8);

    release();
    await waitState(id, 'done');
    const done = service.get(id);
    expect(done).toMatchObject({ progressDone: 100, progressTotal: 100, bytesDone: 1000, bytesTotal: 1000, speed: null });
  });

  it('throttles progress events to at most 4 per second per job and never loses the last value', async () => {
    const timers: { at: number; fn: () => void }[] = [];
    let now = 0;
    const clock: ThrottleClock = {
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).toSorted((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = end;
    };

    const svc = new JobService({ db, log: silent, now: () => clockNow, throttleClock: clock });
    let ctxRef: JobContext | null = null;
    svc.register({
      kind: 'test.t',
      heavy: false,
      run: (ctx) =>
        new Promise(() => {
          ctxRef = ctx;
        }),
    });
    const events: JobChangedEvent[] = [];
    svc.onChanged((e) => events.push(e));
    svc.start();
    const id = svc.create('test.t', 'T');
    await until(() => ctxRef !== null);
    {
      const ctx = ctxRef as unknown as JobContext;
      events.length = 0;
      // 100 progress calls spread over 2 seconds (every 20 ms).
      for (let i = 1; i <= 100; i += 1) {
        ctx.progress(i, 100);
        advance(20);
      }
      advance(500);
      const progress = events.filter((e) => e.reason === 'progress' && e.job.id === id);
      expect(progress.length).toBeLessThanOrEqual(2 * 4 + 1);
      expect(progress.length).toBeGreaterThanOrEqual(7);
      expect(progress.at(-1)?.job.progressDone).toBe(100);
      svc.shutdown();
    }
  });
});

describe('needs_you', () => {
  it('waits for resolve(), then continues running with the answer', async () => {
    let answer = '';
    service.register({
      kind: 'test.ask',
      heavy: false,
      run: async (ctx) => {
        answer = await ctx.needsYou('Delete the temp folder?', ['Yes', 'No']);
        return `answered ${answer}`;
      },
    });
    service.start();
    const id = service.create('test.ask', 'Ask');
    await waitState(id, 'needs_you');
    expect(service.get(id)).toMatchObject({ message: 'Delete the temp folder?', choices: ['Yes', 'No'] });

    expect(service.resolve(id, 'Maybe')).toBe(false); // not one of the choices
    expect(stateOf(id)).toBe('needs_you');
    expect(service.resolve(id, 'No')).toBe(true);
    await waitState(id, 'done');
    expect(answer).toBe('No');
    expect(service.get(id)?.message).toBe('answered No');
    expect(texts(id)).toContain('You answered: No');
    expect(service.resolve(id, 'No')).toBe(false); // nothing waiting any more
  });

  it('the app can stop a job by itself, but then it says so and why, never "by you"', async () => {
    const g = gate('test.a', true);
    service.register(g.handler);
    service.start();
    const id = service.create('test.a', 'First');
    await until(() => g.started.length === 1);
    expect(service.cancelByApp(id, 'it was using F:, which you chose to eject')).toBe(true);
    const stored = service.get(id)?.error ?? '';
    expect(parseJobError(stored)).toEqual({ code: 'stopped-by-app', text: 'Stopped by Backup Hub: it was using F:, which you chose to eject' });
    expect(stored).not.toMatch(/by you/);
    expect(texts(id)).toContain('Stopped by Backup Hub: it was using F:, which you chose to eject');
    // A click on Stop is the only thing that writes "by you".
    const second = service.create('test.a', 'Second');
    await until(() => stateOf(second) === 'running' || stateOf(second) === 'queued');
    expect(service.cancel(second)).toBe(true);
    expect(parseJobError(service.get(second)?.error ?? null).code).toBe('stopped-by-you');
  });

  it('cancelling a job that needs you fails it as cancelled', async () => {
    service.register({ kind: 'test.ask', heavy: false, run: (ctx) => ctx.needsYou('Sure?').then(() => 'x') });
    service.start();
    const id = service.create('test.ask', 'Ask');
    await waitState(id, 'needs_you');
    expect(service.cancel(id)).toBe(true);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: CANCELLED_MESSAGE });
  });
});

describe('cancel and retry', () => {
  it('cancels a queued job without ever running it', async () => {
    const g = gate('test.a', true);
    service.register(g.handler);
    service.start();
    const first = service.create('test.a', 'First');
    const second = service.create('test.a', 'Second');
    await until(() => g.started.length === 1);
    expect(stateOf(second)).toBe('queued');
    expect(service.cancel(second)).toBe(true);
    expect(service.get(second)).toMatchObject({ state: 'failed', error: CANCELLED_MESSAGE });
    g.releases.get(first)?.ok();
    await waitState(first, 'done');
    expect(g.started).toEqual([first]);
  });

  it('cancels a running job: signal aborts, job fails as "Stopped by you", a late result is ignored', async () => {
    let signal: AbortSignal | null = null;
    let finishLate: () => void = () => {};
    service.register({
      kind: 'test.long',
      heavy: false,
      run: (ctx) =>
        new Promise((resolve) => {
          signal = ctx.signal;
          finishLate = () => resolve('late');
        }),
    });
    service.start();
    const id = service.create('test.long', 'Long');
    await until(() => signal !== null);
    expect(service.cancel(id)).toBe(true);
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: CANCELLED_MESSAGE });
    finishLate();
    await new Promise((r) => setTimeout(r, 20));
    expect(service.get(id)).toMatchObject({ state: 'failed', error: CANCELLED_MESSAGE });
    expect(service.cancel(id)).toBe(false);
  });

  it('retry creates a NEW job with the same kind and params; the old one stays as history', async () => {
    const seen: unknown[] = [];
    let fail = true;
    service.register({
      kind: 'test.r',
      heavy: false,
      run: async (ctx) => {
        seen.push(ctx.params);
        if (fail) throw new JobFailure('Nope');
        return 'ok';
      },
    });
    service.start();
    const first = service.create('test.r', 'Retry me', { folder: 'Reunion', n: 3 });
    await waitState(first, 'failed');
    fail = false;
    const second = service.retry(first);
    expect(second).not.toBe(first);
    await waitState(second, 'done');
    expect(seen).toEqual([
      { folder: 'Reunion', n: 3 },
      { folder: 'Reunion', n: 3 },
    ]);
    expect(service.get(first)?.state).toBe('failed');
    expect(service.get(second)).toMatchObject({ kind: 'test.r', title: 'Retry me' });
    expect(texts(second)).toContain(`Retry of job #${first}`);
  });

  it('refuses to retry a job that has not finished', () => {
    const id = service.create('test.r', 'Pending');
    expect(() => service.retry(id)).toThrow(/finished/);
    expect(() => service.retry(9999)).toThrow(/No job/);
  });
});

describe('scheduling', () => {
  it('runs heavy jobs one at a time, in order', async () => {
    const g = gate('test.heavy', true);
    service.register(g.handler);
    service.start();
    const ids = [1, 2, 3].map((n) => service.create('test.heavy', `Heavy ${n}`));
    await until(() => g.started.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(g.started).toEqual([ids[0]]);
    expect(ids.slice(1).map(stateOf)).toEqual(['queued', 'queued']);

    g.releases.get(ids[0] as number)?.ok();
    await until(() => g.started.length === 2);
    expect(g.started).toEqual([ids[0], ids[1]]);
    expect(stateOf(ids[2] as number)).toBe('queued');

    g.releases.get(ids[1] as number)?.fail(new Error('boom'));
    await until(() => g.started.length === 3); // a failure also frees the slot
    g.releases.get(ids[2] as number)?.ok();
    await waitState(ids[2] as number, 'done');
  });

  it('runs at most 2 light jobs together, and light jobs run alongside a heavy one', async () => {
    const light = gate('test.light');
    const heavy = gate('test.heavy', true);
    service.register(light.handler);
    service.register(heavy.handler);
    service.start();
    const h = service.create('test.heavy', 'H');
    const l = [1, 2, 3].map((n) => service.create('test.light', `L${n}`));
    await until(() => heavy.started.length === 1 && light.started.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(light.started).toEqual([l[0], l[1]]);
    expect(stateOf(l[2] as number)).toBe('queued');
    expect(stateOf(h)).toBe('running');

    light.releases.get(l[0] as number)?.ok();
    await until(() => light.started.length === 3);
    for (const [, r] of light.releases) r.ok();
    heavy.releases.get(h)?.ok();
    await waitState(h, 'done');
  });

  it('a heavy job waiting for the user keeps its slot, so heavy jobs stay serialized', async () => {
    service.register({ kind: 'test.askheavy', heavy: true, run: (ctx) => ctx.needsYou('OK?').then(() => 'x') });
    const g = gate('test.heavy', true);
    service.register(g.handler);
    service.start();
    const asker = service.create('test.askheavy', 'Asker');
    const next = service.create('test.heavy', 'Next');
    await waitState(asker, 'needs_you');
    await new Promise((r) => setTimeout(r, 30));
    expect(stateOf(next)).toBe('queued');
    service.resolve(asker, 'continue');
    await until(() => g.started.length === 1);
  });

  it('pauses on sleep (nothing new starts), logs it, and continues on wake', async () => {
    const g = gate('test.a');
    service.register(g.handler);
    service.start();
    const running = service.create('test.a', 'Running');
    await until(() => g.started.length === 1);

    service.suspend();
    const waiting = service.create('test.a', 'Waiting');
    await new Promise((r) => setTimeout(r, 30));
    expect(stateOf(waiting)).toBe('queued');

    service.resumeAfterSleep();
    expect(texts(running)).toContain(SLEPT_MESSAGE);
    await until(() => g.started.length === 2);
    expect(g.started[1]).toBe(waiting);
  });
});

describe('resume at startup', () => {
  function insertLeftover(kind: string, state: 'running' | 'needs_you', resume: string | null): number {
    const info = db
      .prepare("INSERT INTO jobs (kind, title, state, created_at, started_at, resume_json) VALUES (?, ?, ?, 1, 1, ?)")
      .run(kind, `Left ${kind}`, state, resume);
    return Number(info.lastInsertRowid);
  }

  it('a retried interrupted job no longer stays interrupted: it says it was retried, and by which job', async () => {
    service.register({ kind: 'test.plain', heavy: false, run: async () => 'A copy from the last 24 hours already exists' });
    const old = insertLeftover('test.plain', 'running', null);
    service.recoverInterrupted();
    expect(service.get(old)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE });
    expect(service.get(old)?.retriedBy ?? null).toBeNull();
    service.start();
    const again = service.retry(old);
    await waitState(again, 'done');
    expect(service.get(old)?.retriedBy).toBe(again);
    expect(service.list().find((j) => j.id === old)?.retriedBy).toBe(again);
    expect(texts(old)).toContain(`Retried as job #${again}`);
    // A second retry of the same job points at the newest one.
    const third = service.retry(old);
    expect(service.get(old)?.retriedBy).toBe(third);
  });

  it('ends every leftover job as interrupted, keeps checkpoints, and starts nothing', () => {
    service.register({ kind: 'test.resumable', heavy: false, resumable: true, run: async () => 'x' });
    service.register({ kind: 'test.plain', heavy: false, run: async () => 'x' });

    const resumableRunning = insertLeftover('test.resumable', 'running', '{"at":5}');
    const resumableAsking = insertLeftover('test.resumable', 'needs_you', '{"at":9}');
    const resumableNoCheckpoint = insertLeftover('test.resumable', 'running', null);
    const notResumable = insertLeftover('test.plain', 'running', '{"at":1}');
    const unknownKind = insertLeftover('test.removed', 'running', '{"at":1}');
    const queuedAlready = Number(
      db.prepare("INSERT INTO jobs (kind, title, state, created_at) VALUES ('test.plain', 'Q', 'queued', 1)").run().lastInsertRowid,
    );

    // A job that was still queued is held like the others (it never starts by itself).
    expect(service.recoverInterrupted()).toEqual({ interrupted: 6 });
    for (const id of [resumableRunning, resumableAsking, resumableNoCheckpoint, notResumable, unknownKind, queuedAlready]) {
      expect(service.get(id)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE });
    }
    // The checkpoints are kept (Continue needs them).
    expect(service.get(resumableRunning)?.hasCheckpoint).toBe(true);
    expect(service.get(resumableAsking)?.hasCheckpoint).toBe(true);
    expect(service.get(resumableNoCheckpoint)?.hasCheckpoint).toBe(false);
    expect(stateOf(queuedAlready)).toBe('failed');
  });

  it('a leftover job does not run after start(): nothing continues without Continue', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.resumable', heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) });
    const id = insertLeftover('test.resumable', 'running', '{"at":5}');
    service.recoverInterrupted();
    service.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toEqual([]);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE, hasCheckpoint: true });
  });

  it('Continue runs the job from its checkpoint, only for a resumable kind with a checkpoint that was not dismissed', async () => {
    const resumes: unknown[] = [];
    service.register({
      kind: 'test.resumable',
      heavy: false,
      resumable: true,
      run: async (ctx) => {
        resumes.push(ctx.resume);
        return 'finished';
      },
    });
    service.register({ kind: 'test.plain', heavy: false, run: async () => 'x' });
    const id = insertLeftover('test.resumable', 'running', '{"step":7}');
    const noCheckpoint = insertLeftover('test.resumable', 'running', null);
    const plain = insertLeftover('test.plain', 'running', '{"step":1}');
    const dismissed = insertLeftover('test.resumable', 'running', '{"step":2}');
    service.recoverInterrupted();
    service.start();
    expect(service.dismissInterrupted(dismissed)).toBe(true);
    expect(service.continueInterrupted(noCheckpoint)).toBe(false);
    expect(service.continueInterrupted(plain)).toBe(false);
    expect(service.continueInterrupted(dismissed)).toBe(false);
    expect(service.continueInterrupted(99_999)).toBe(false);
    expect(resumes).toEqual([]);
    expect(service.continueInterrupted(id)).toBe(true);
    await waitState(id, 'done');
    expect(resumes).toEqual([{ step: 7 }]);
    expect(service.get(id)?.error).toBeNull();
    expect(texts(id)).toContain('Continued by you from the last checkpoint');
    // A finished job cannot be continued again.
    expect(service.continueInterrupted(id)).toBe(false);
  });

  it('Dismiss marks an interrupted job as seen: the row and its checkpoint stay, Continue goes, a second Dismiss does nothing', () => {
    service.register({ kind: 'test.resumable', heavy: false, resumable: true, run: async () => 'x' });
    const id = insertLeftover('test.resumable', 'running', '{"at":1}');
    service.recoverInterrupted();
    expect(isContinuable(service.get(id)!)).toBe(true);
    expect(service.dismissInterrupted(id)).toBe(true);
    const job = service.get(id)!;
    expect(job).toMatchObject({ state: 'failed', hasCheckpoint: true, message: DISMISSED_MESSAGE });
    expect(isContinuable(job)).toBe(false);
    expect(service.dismissInterrupted(id)).toBe(false);
    expect(service.list().some((j) => j.id === id)).toBe(true);
    // Not an interrupted job: nothing to dismiss.
    const done = Number(db.prepare("INSERT INTO jobs (kind, title, state, created_at) VALUES ('test.plain', 'D', 'done', 1)").run().lastInsertRowid);
    expect(service.dismissInterrupted(done)).toBe(false);
  });

  it('a continued job goes through the queue like any job (while everything is paused it waits)', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.resumable', heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) });
    const id = insertLeftover('test.resumable', 'running', '{"at":1}');
    service.recoverInterrupted();
    service.start();
    service.setHeld(true);
    expect(service.continueInterrupted(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toEqual([]);
    expect(stateOf(id)).toBe('queued');
    service.setHeld(false);
    await waitState(id, 'done');
    expect(ran).toEqual([id]);
  });

  it('a continued job receives its checkpoint', async () => {
    const resumes: unknown[] = [];
    service.register({
      kind: 'test.resumable',
      heavy: false,
      resumable: true,
      run: async (ctx) => {
        resumes.push(ctx.resume);
        return 'finished';
      },
    });
    const id = insertLeftover('test.resumable', 'running', '{"step":7}');
    service.recoverInterrupted();
    service.start();
    service.continueInterrupted(id);
    await waitState(id, 'done');
    expect(resumes).toEqual([{ step: 7 }]);
    expect(texts(id)).toContain('Continuing from the last checkpoint');
  });

  it('checkpoint() persists the value for the next start', async () => {
    let ctxRef: JobContext | null = null;
    service.register({
      kind: 'test.cp',
      heavy: false,
      resumable: true,
      run: (ctx) =>
        new Promise(() => {
          ctxRef = ctx;
        }),
    });
    service.start();
    const id = service.create('test.cp', 'CP');
    await until(() => ctxRef !== null);
    (ctxRef as unknown as JobContext).checkpoint({ offset: 123 });
    expect(new JobStore(db).getStored(id)?.resumeJson).toBe('{"offset":123}');
    expect(service.get(id)?.hasCheckpoint).toBe(true);
  });

  it('shutdown leaves running jobs as running so the next start can resume or fail them', async () => {
    const g = gate('test.a', false, { resumable: true });
    service.register(g.handler);
    service.start();
    const id = service.create('test.a', 'A');
    await until(() => g.started.length === 1);
    service.shutdown();
    g.releases.get(id)?.fail(new Error('aborted'));
    await new Promise((r) => setTimeout(r, 20));
    expect(new JobStore(db).get(id)?.state).toBe('running');
  });
});

describe('retention and housekeeping', () => {
  it('prunes job log lines older than 90 days and keeps newer ones', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const id = service.create('test.none', 'Old');
    const store = new JobStore(db);
    store.addEvent(id, clockNow - 91 * DAY, 'info', 'ancient');
    store.addEvent(id, clockNow - 89 * DAY, 'info', 'recent');
    expect(service.pruneOldEvents()).toBe(1);
    expect(texts(id)).toEqual(['recent']);
    expect(service.get(id)).not.toBeNull(); // the job row itself stays
  });

  it('ensureRecurring creates a job only when none is active and the last one is old enough', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    service.register({ kind: 'test.daily', heavy: false, run: async () => 'ok' });
    const first = service.ensureRecurring('test.daily', 'Daily', DAY);
    expect(first).not.toBeNull();
    expect(service.ensureRecurring('test.daily', 'Daily', DAY)).toBeNull(); // already queued
    service.start();
    await waitState(first as number, 'done');
    expect(service.ensureRecurring('test.daily', 'Daily', DAY)).toBeNull(); // finished just now
    clockNow += DAY + 1000;
    expect(service.ensureRecurring('test.daily', 'Daily', DAY)).not.toBeNull();
  });

  it('list() filters by state and returns newest first', async () => {
    service.register({ kind: 'test.ok', heavy: false, run: async () => 'ok' });
    service.register({
      kind: 'test.bad',
      heavy: false,
      run: async () => {
        throw new JobFailure('bad');
      },
    });
    service.start();
    const a = service.create('test.ok', 'A');
    const b = service.create('test.bad', 'B');
    const c = service.create('test.ok', 'C');
    await waitState(c, 'done');
    await waitState(b, 'failed');
    expect(service.list().map((j: JobRecord) => j.id)).toEqual([c, b, a]);
    expect(service.list({ states: ['failed'] }).map((j) => j.id)).toEqual([b]);
    expect(service.list({ limit: 1 }).map((j) => j.id)).toEqual([c]);
  });
});

describe('built-in kinds', () => {
  it('db.integrityCheck is heavy and passes on a healthy database', async () => {
    const handler = integrityHandler({ db, dataDir: dir, log: silent });
    expect(handler.heavy).toBe(true);
    service.register(handler);
    service.start();
    const id = service.create('db.integrityCheck', 'Check');
    await waitState(id, 'done');
    expect(service.get(id)?.message).toMatch(/passed/);
    // The startup check relies on this record (skipped when a full check passed in the last 7 days).
    const row = db.prepare("SELECT value FROM meta WHERE key = 'last_integrity_ok_at'").get() as { value: string } | undefined;
    expect(Number(row?.value)).toBeGreaterThan(0);
  });

  it('db.integrityCheck runs the full check through the worker when one is given (and on the main thread when it cannot start)', async () => {
    const asked: string[] = [];
    service.register(integrityHandler({ db, dataDir: dir, log: silent, checkInWorker: (file) => (asked.push(file), Promise.resolve({ ok: true, messages: ['ok'] })) }));
    service.start();
    const id = service.create('db.integrityCheck', 'Check');
    await waitState(id, 'done');
    expect(asked).toEqual([path.join(dir, 'backuphub.db')]);
    expect(Number((db.prepare("SELECT value FROM meta WHERE key = 'last_integrity_ok_at'").get() as { value: string } | undefined)?.value)).toBeGreaterThan(0);

    const second = new JobService({ db, log: silent });
    second.register(integrityHandler({ db, dataDir: dir, log: silent, checkInWorker: () => Promise.resolve(null) }));
    second.start();
    const again = second.create('db.integrityCheck', 'Check again');
    for (let i = 0; i < 200 && second.get(again)?.state !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(second.get(again)?.state).toBe('done');
    second.shutdown();
  });

  it('db.integrityCheck fails with a plain message on a damaged file, leaving the technical text in the log', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-jobs-bad-'));
    try {
      fs.writeFileSync(path.join(copy, 'backuphub.db'), Buffer.concat([Buffer.from('not sqlite'), Buffer.alloc(8192, 7)]));
      service.register(integrityHandler({ db, dataDir: copy, log: silent }));
      service.start();
      const id = service.create('db.integrityCheck', 'Check');
      await waitState(id, 'failed');
      expect(service.get(id)?.error).toMatch(/did not pass its full safety check/);
      expect(service.events(id).some((e) => e.text.startsWith('Technical detail:'))).toBe(true);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'last_integrity_ok_at'").get()).toBeUndefined();
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('db.snapshot writes a copy once and then reports one already exists', async () => {
    service.register(snapshotHandler({ db, dataDir: dir, log: silent }));
    service.start();
    const first = service.create('db.snapshot', 'Snap');
    await waitState(first, 'done');
    expect(service.get(first)?.message).toMatch(/Wrote/);
    expect(fs.readdirSync(path.join(dir, 'snapshots'))).toHaveLength(1);
    const second = service.create('db.snapshot', 'Snap');
    await waitState(second, 'done');
    expect(service.get(second)?.message).toMatch(/already exists/);
    expect(fs.readdirSync(path.join(dir, 'snapshots'))).toHaveLength(1);
  });
});

describe('pause and resume', () => {
  /** A heavy handler that does steps, yielding between them; `steps` shows how far each job got. */
  function stepper(kind: string, total = 1000) {
    const steps = new Map<number, number>();
    const resumes: unknown[] = [];
    const handler: JobHandler = {
      kind,
      heavy: true,
      resumable: true,
      run: async (ctx) => {
        resumes.push(ctx.resume);
        let i = (ctx.resume as { i: number } | null)?.i ?? 0;
        for (; i < total; i += 1) {
          steps.set(ctx.jobId, i);
          ctx.checkpoint({ i });
          await ctx.yield();
          await new Promise((r) => setTimeout(r, 1));
        }
        return 'done';
      },
    };
    return { handler, steps, resumes };
  }

  it('a running job stops at its next yield without losing its place, and goes on after Resume', async () => {
    const s = stepper('test.step', 400);
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 3, 'some steps');
    expect(service.pause(id)).toBe(true);
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true });
    await new Promise((r) => setTimeout(r, 30));
    const frozenAt = s.steps.get(id)!;
    await new Promise((r) => setTimeout(r, 40));
    expect(s.steps.get(id)).toBe(frozenAt);
    expect(service.pause(id)).toBe(false); // already paused
    expect(service.resume(id)).toBe(true);
    await until(() => (s.steps.get(id) ?? 0) > frozenAt + 3, 'steps after resume');
    expect(s.resumes).toEqual([null]); // one run, never restarted
    expect(service.get(id)).toMatchObject({ state: 'running', paused: false });
    expect(texts(id)).toEqual(expect.arrayContaining(['Paused by you', 'Resumed by you']));
    service.cancel(id);
  });

  it('the time a job spent paused is kept apart (pausedMs), so the time left is worked out from active time only', async () => {
    const s = stepper('test.step', 400);
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 3, 'some steps');
    expect(service.get(id)?.pausedMs ?? 0).toBe(0);
    expect(service.pause(id)).toBe(true);
    clockNow += 3_600_000; // an hour on the clock while it is paused
    expect(service.resume(id)).toBe(true);
    await until(() => service.get(id)?.state === 'running', 'running again');
    expect(service.get(id)?.pausedMs).toBe(3_600_000);
    // A second pause adds to the first.
    expect(service.pause(id)).toBe(true);
    clockNow += 60_000;
    expect(service.resume(id)).toBe(true);
    await until(() => service.get(id)?.state === 'running', 'running again after the second pause');
    expect(service.get(id)?.pausedMs).toBe(3_660_000);
    service.cancel(id);
  });

  it('a queued job can be paused, is skipped by the runner, and starts after Resume', async () => {
    const g = gate('test.heavy', true);
    service.register(g.handler);
    service.start();
    const first = service.create('test.heavy', 'First');
    await until(() => g.started.includes(first), 'first running');
    const second = service.create('test.heavy', 'Second');
    expect(service.pause(second)).toBe(true);
    g.releases.get(first)!.ok();
    await waitState(first, 'done');
    await new Promise((r) => setTimeout(r, 30));
    expect(g.started).toEqual([first]);
    expect(service.get(second)).toMatchObject({ state: 'queued', paused: true });
    expect(service.resume(second)).toBe(true);
    await until(() => g.started.includes(second), 'second running');
    g.releases.get(second)!.ok();
    await waitState(second, 'done');
  });

  it('a paused job gives up the heavy slot; on Resume it waits for the slot again', async () => {
    const s = stepper('test.step', 100000);
    const g = gate('test.heavy', true);
    service.register(s.handler);
    service.register(g.handler);
    service.start();
    const a = service.create('test.step', 'A');
    await until(() => (s.steps.get(a) ?? 0) > 2, 'A running');
    const b = service.create('test.heavy', 'B');
    await new Promise((r) => setTimeout(r, 20));
    expect(g.started).toEqual([]); // the one heavy slot is taken
    service.pause(a);
    await until(() => g.started.includes(b), 'B takes the slot');
    const frozen = s.steps.get(a)!;
    expect(service.resume(a)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(service.get(a)).toMatchObject({ state: 'queued', paused: false }); // waiting for its turn
    expect(s.steps.get(a)).toBeLessThanOrEqual(frozen + 1);
    g.releases.get(b)!.ok();
    await waitState(b, 'done');
    await until(() => (s.steps.get(a) ?? 0) > frozen + 3, 'A goes on');
    expect(service.get(a)?.state).toBe('running');
    service.cancel(a);
  });

  it('a job paused when the app closes is still paused after the restart, and continues from its checkpoint on Resume', async () => {
    const s = stepper('test.step', 100000);
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 5, 'some steps');
    service.pause(id);
    await new Promise((r) => setTimeout(r, 20));
    service.shutdown();

    const again = new JobService({ db, log: silent, now: () => clockNow });
    const s2 = stepper('test.step', 100000);
    again.register(s2.handler);
    expect(again.recoverInterrupted()).toEqual({ interrupted: 0 });
    again.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(s2.resumes).toEqual([]); // not auto-resumed
    expect(again.get(id)).toMatchObject({ state: 'queued', paused: true });
    expect(again.resume(id)).toBe(true);
    await until(() => s2.resumes.length === 1, 'resumed run');
    expect((s2.resumes[0] as { i: number }).i).toBeGreaterThan(0);
    again.cancel(id);
    again.shutdown();
    service = new JobService({ db, log: silent, now: () => clockNow }); // for afterEach
  });

  it('Cancel works on a paused job, and a job that has finished is not pausable', async () => {
    const s = stepper('test.step', 100000);
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 2, 'running');
    service.pause(id);
    expect(service.cancel(id)).toBe(true);
    await waitState(id, 'failed');
    expect(service.pause(id)).toBe(false);
    expect(service.resume(id)).toBe(false);
  });
});

describe('safe pause: pausing, then paused', () => {
  /** A job of files: each file is several turns (the middle of a file), the safe point is between files. `finishFile` lets the current file end. */
  function fileJob(kind: string, files = 50) {
    const done: number[] = [];
    const insideTurns: number[] = [];
    let release: (() => void) | null = null;
    const saves: string[] = [];
    const handler: JobHandler = {
      kind,
      heavy: true,
      resumable: true,
      onStop: (resume) => ({ ...(resume as object), inFlight: [] }),
      run: async (ctx) => {
        ctx.beforeHold?.(async () => {
          saves.push('save');
          ctx.checkpoint({ done: done.length, inFlight: [], saved: true });
        });
        for (let f = done.length; f < files; f += 1) {
          await ctx.yield(); // the safe point, between files
          // one file: waits for the test, taking turns (never a pause hold) while it does
          await new Promise<void>((resolve) => (release = resolve));
          for (let t = 0; t < 3; t += 1) {
            await ctx.turn?.();
            insideTurns.push(f);
          }
          done.push(f);
          ctx.checkpoint({ done: done.length, inFlight: [{ key: 'x' }] });
        }
        return 'done';
      },
    };
    return {
      handler,
      done,
      insideTurns,
      saves,
      finishFile: async () => {
        await until(() => release !== null, 'a file to be on its way');
        const r = release!;
        release = null;
        r();
      },
      onItsWay: () => release !== null,
    };
  }

  it('Pause while a file is on its way: Pausing until the file is finished and the place saved, then Paused', async () => {
    const j = fileJob('test.files');
    service.register(j.handler);
    service.start();
    const id = service.create('test.files', 'Files');
    await until(() => j.onItsWay(), 'first file');
    expect(service.pause(id)).toBe(true);
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true, pausing: true, message: PAUSING_MESSAGE });
    await new Promise((r) => setTimeout(r, 30));
    expect(service.get(id)?.pausing).toBe(true); // still on its file
    await j.finishFile(); // the file ends: all its turns ran (a pause did not hold in the middle of it)
    await until(() => service.get(id)?.pausing === false, 'held');
    expect(j.done).toEqual([0]);
    expect(j.insideTurns).toEqual([0, 0, 0]);
    expect(j.saves).toEqual(['save']);
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true, pausing: false, message: PAUSED_MESSAGE });
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id) as string)).toMatchObject({ done: 1, saved: true });
    expect(j.onItsWay()).toBe(false); // nothing goes on while paused
    // Resume: the next file starts, the first was not repeated.
    expect(service.resume(id)).toBe(true);
    await until(() => j.onItsWay(), 'second file');
    await j.finishFile();
    await until(() => j.done.length === 2, 'second file done');
    expect(j.done).toEqual([0, 1]);
    service.cancel(id);
  });

  it('a pausing job keeps its heavy slot until it is held; then another job may start', async () => {
    const j = fileJob('test.files');
    const g = gate('test.heavy', true);
    service.register(j.handler);
    service.register(g.handler);
    service.start();
    const a = service.create('test.files', 'A');
    await until(() => j.onItsWay(), 'A on a file');
    const b = service.create('test.heavy', 'B');
    service.pause(a);
    await new Promise((r) => setTimeout(r, 40));
    expect(g.started).toEqual([]); // A is still writing its file
    await j.finishFile();
    await until(() => g.started.includes(b), 'B starts once A is held');
    expect(service.get(a)).toMatchObject({ paused: true, pausing: false });
    g.releases.get(b)!.ok();
    await waitState(b, 'done');
    service.cancel(a);
  });

  it('Resume while still pausing just goes on (no deadlock, no wait for a slot)', async () => {
    const j = fileJob('test.files');
    service.register(j.handler);
    service.start();
    const id = service.create('test.files', 'Files');
    await until(() => j.onItsWay(), 'first file');
    service.pause(id);
    expect(service.resume(id)).toBe(true);
    expect(service.get(id)).toMatchObject({ state: 'running', paused: false });
    await j.finishFile();
    await until(() => j.onItsWay() && j.done.length === 1, 'next file');
    expect(service.get(id)).toMatchObject({ state: 'running', paused: false });
    expect(j.saves).toEqual([]); // never held, so nothing to save
    service.cancel(id);
  });

  it('pause, close the app, open it again: still paused, and Resume continues from the saved place', async () => {
    const j = fileJob('test.files');
    service.register(j.handler);
    service.start();
    const id = service.create('test.files', 'Files');
    await until(() => j.onItsWay(), 'first file');
    service.pause(id);
    await j.finishFile();
    await until(() => service.get(id)?.pausing === false, 'held');
    service.shutdown();
    const again = new JobService({ db, log: silent, now: () => clockNow });
    const j2 = fileJob('test.files');
    again.register(j2.handler);
    expect(again.recoverInterrupted()).toEqual({ interrupted: 0 });
    again.start();
    expect(again.get(id)).toMatchObject({ state: 'queued', paused: true });
    expect(again.get(id)?.pausing).toBeFalsy();
    again.resume(id);
    await until(() => j2.onItsWay(), 'run after the restart');
    again.cancel(id);
    again.shutdown();
    service = new JobService({ db, log: silent, now: () => clockNow }); // for afterEach
  });

  it('progress lines of the handler do not overwrite the Pausing / Paused line', async () => {
    let ctxOf: JobContext | null = null;
    let letGo: (() => void) | null = null;
    service.register({
      kind: 'test.say',
      heavy: true,
      run: async (ctx) => {
        ctxOf = ctx;
        await new Promise<void>((resolve) => (letGo = resolve));
        await ctx.yield();
        await new Promise<void>((resolve) => (letGo = resolve));
        return 'x';
      },
    });
    service.start();
    const id = service.create('test.say', 'Say');
    await until(() => letGo !== null, 'running');
    service.pause(id);
    ctxOf!.progress(1, 2, { message: 'Copying a.jpg' });
    expect(service.get(id)?.message).toBe(PAUSING_MESSAGE);
    letGo!();
    await until(() => service.get(id)?.pausing === false, 'held');
    ctxOf!.progress(2, 2, { message: 'Copying b.jpg' });
    expect(service.get(id)?.message).toBe(PAUSED_MESSAGE);
    expect(db.prepare('SELECT message FROM jobs WHERE id = ?').pluck().get(id)).toBe(PAUSED_MESSAGE);
    expect(service.get(id)).toMatchObject({ progressDone: 2 }); // the numbers still move
    service.cancel(id);
  });

  it('Stop is abrupt and the kind drops its half-done work from the checkpoint (running job and paused job after a restart)', async () => {
    const j = fileJob('test.files');
    service.register(j.handler);
    service.start();
    const id = service.create('test.files', 'Files');
    await until(() => j.onItsWay(), 'first file');
    await j.finishFile();
    await until(() => j.onItsWay(), 'second file on its way');
    // the checkpoint of the finished file lists a file on its way
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id) as string).inFlight).toHaveLength(1);
    expect(service.cancel(id)).toBe(true);
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id) as string).inFlight).toEqual([]);
    expect(service.get(id)?.state).toBe('failed');
    await j.finishFile(); // the stopped handler unwinds (its file is abandoned) and the heavy slot is free again
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id) as string).inFlight).toEqual([]); // a late checkpoint of the stopped job is ignored

    // a paused job, closed, opened again, stopped from the list
    const id2 = service.create('test.files', 'Files again');
    await until(() => j.onItsWay(), 'file of the second job');
    await j.finishFile();
    await until(() => j.done.length >= 2 && j.onItsWay(), 'next file on its way');
    service.pause(id2);
    await j.finishFile();
    await until(() => service.get(id2)?.pausing === false, 'held');
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id2) as string).inFlight).toEqual([]); // the pause save
    db.prepare('UPDATE jobs SET resume_json = ? WHERE id = ?').run(JSON.stringify({ done: 3, inFlight: [{ key: 'y' }] }), id2);
    service.shutdown();
    const again = new JobService({ db, log: silent, now: () => clockNow });
    again.register(fileJob('test.files').handler);
    again.start();
    expect(again.cancel(id2)).toBe(true);
    expect(JSON.parse(db.prepare('SELECT resume_json FROM jobs WHERE id = ?').pluck().get(id2) as string)).toMatchObject({ done: 3, inFlight: [] });
    again.shutdown();
    service = new JobService({ db, log: silent, now: () => clockNow });
  });
});

describe('which backups a job works on', () => {
  it('a job over several backups names each of them, and a one-backup job names its backup', () => {
    service.setBackupsResolver((_kind, params) => {
      const p = (params ?? {}) as { backupId?: unknown; backupIds?: unknown };
      const ids = Array.isArray(p.backupIds) ? (p.backupIds as number[]) : [];
      return typeof p.backupId === 'number' && !ids.includes(p.backupId) ? [...ids, p.backupId] : ids;
    });
    const all = service.create('mirror.copy', 'Copy 3 backups', { backupIds: [1, 2, 3] });
    const one = service.create('phone.look', 'Look', { backupId: 2 });
    const none = service.create('db.snapshot', 'Snapshot', {});
    expect(service.get(all)!.backupIds).toEqual([1, 2, 3]);
    expect(service.get(one)!.backupIds).toEqual([2]);
    expect(service.get(none)!.backupIds).toBeUndefined();
  });
});
