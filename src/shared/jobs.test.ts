import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  DISMISSED_MESSAGE,
  isContinuable,
  computeEtaSeconds,
  computeSpeed,
  CANCELLED_MESSAGE,
  INTERRUPTED_MESSAGE,
  stoppedByApp,
  withErrorCode,
  isCancelled,
  isFinished,
  isQuietSystemJob,
  isSystemJob,
  pickMeasure,
  progressPercent,
  SPEED_WINDOW_MS,
  type JobState,
  type RateSample,
} from './jobs';

describe('computeSpeed (sliding window)', () => {
  it('needs two samples spanning at least a second', () => {
    expect(computeSpeed([], 10_000)).toBeNull();
    expect(computeSpeed([{ at: 9000, done: 0 }], 10_000)).toBeNull();
    expect(
      computeSpeed(
        [
          { at: 9500, done: 0 },
          { at: 10_000, done: 500 },
        ],
        10_000,
      ),
    ).toBeNull();
  });

  it('is units per second between the oldest and newest sample in the window', () => {
    const samples: RateSample[] = [
      { at: 0, done: 0 },
      { at: 2000, done: 200 },
      { at: 4000, done: 600 },
    ];
    expect(computeSpeed(samples, 4000)).toBe(150);
  });

  it('forgets samples older than the window, so a slow start does not drag the speed down', () => {
    const samples: RateSample[] = [
      { at: 0, done: 0 },
      { at: 5000, done: 50 }, // slow first part
      { at: 20_000, done: 50 + 1500 },
      { at: 25_000, done: 50 + 2000 }, // 100/s over the last 5 s
    ];
    // A 10 s window ending at 25 s keeps only the last two samples.
    expect(computeSpeed(samples, 25_000, 10_000)).toBe(100);
    expect(SPEED_WINDOW_MS).toBe(10_000);
  });

  it('is null when nothing moved or progress went backwards', () => {
    expect(
      computeSpeed(
        [
          { at: 0, done: 100 },
          { at: 3000, done: 100 },
        ],
        3000,
      ),
    ).toBeNull();
    expect(
      computeSpeed(
        [
          { at: 0, done: 100 },
          { at: 3000, done: 40 },
        ],
        3000,
      ),
    ).toBeNull();
  });
});

describe('computeEtaSeconds', () => {
  it('rounds up the remaining time at the current speed', () => {
    expect(computeEtaSeconds(200, 1000, 100)).toBe(8);
    expect(computeEtaSeconds(0, 1000, 300)).toBe(4);
  });
  it('is null when unknown or finished', () => {
    expect(computeEtaSeconds(0, 1000, null)).toBeNull();
    expect(computeEtaSeconds(0, 1000, 0)).toBeNull();
    expect(computeEtaSeconds(0, 0, 50)).toBeNull();
    expect(computeEtaSeconds(1000, 1000, 50)).toBeNull();
  });
});

describe('pickMeasure and progressPercent', () => {
  const base = { bytesDone: 0, bytesTotal: 0, progressDone: 0, progressTotal: 0 };
  it('prefers bytes, falls back to items, and is null without totals', () => {
    expect(pickMeasure({ ...base, bytesDone: 5, bytesTotal: 10, progressDone: 1, progressTotal: 4 })).toEqual({
      unit: 'bytes',
      done: 5,
      total: 10,
    });
    expect(pickMeasure({ ...base, progressDone: 1, progressTotal: 4 })).toEqual({ unit: 'items', done: 1, total: 4 });
    expect(pickMeasure(base)).toBeNull();
  });
  it('gives a clamped percentage', () => {
    expect(progressPercent({ ...base, progressDone: 1, progressTotal: 4 })).toBe(25);
    expect(progressPercent({ ...base, progressDone: 9, progressTotal: 4 })).toBe(100);
    expect(progressPercent(base)).toBeNull();
  });
});

describe('attentionCount (rail badge)', () => {
  const now = 1_000_000_000_000;
  const H = 3_600_000;
  it('counts needs_you plus failures from the last 24 hours only', () => {
    expect(
      attentionCount(
        [
          { state: 'needs_you', finishedAt: null, error: null },
          { state: 'failed', finishedAt: now - 2 * H, error: 'x' },
          { state: 'failed', finishedAt: now - 23 * H, error: null },
          { state: 'failed', finishedAt: now - 25 * H, error: 'x' },
          { state: 'done', finishedAt: now - H, error: null },
          { state: 'done_warnings', finishedAt: now - H, error: null },
          { state: 'running', finishedAt: null, error: null },
          { state: 'queued', finishedAt: null, error: null },
        ],
        now,
      ),
    ).toBe(3);
  });

  it('a stop or an interruption is not a failure and does not raise the badge', () => {
    const job = (error: string) => ({ state: 'failed' as const, finishedAt: now - H, error });
    expect(attentionCount([job(CANCELLED_MESSAGE), job(stoppedByApp('x')), job(INTERRUPTED_MESSAGE)], now)).toBe(0);
    expect(attentionCount([job(withErrorCode('busy', 'x'))], now)).toBe(1);
  });
});

describe('interrupted jobs that wait for Continue or Dismiss', () => {
  const now = 1_000_000_000_000;
  const left = { state: 'failed' as const, finishedAt: now - 3_600_000, error: INTERRUPTED_MESSAGE, hasCheckpoint: true, message: null, retriedBy: null };
  it('is continuable only when interrupted, with a checkpoint, not dismissed and not retried', () => {
    expect(isContinuable(left)).toBe(true);
    expect(isContinuable({ ...left, hasCheckpoint: false })).toBe(false);
    expect(isContinuable({ ...left, message: DISMISSED_MESSAGE })).toBe(false);
    expect(isContinuable({ ...left, retriedBy: 7 })).toBe(false);
    expect(isContinuable({ ...left, error: CANCELLED_MESSAGE })).toBe(false);
    expect(isContinuable({ ...left, state: 'done' })).toBe(false);
    expect(isContinuable({ state: 'failed', error: INTERRUPTED_MESSAGE })).toBe(false);
  });
  it('raises the rail badge until it is dismissed, however old it is', () => {
    expect(attentionCount([left], now)).toBe(1);
    expect(attentionCount([{ ...left, finishedAt: now - 30 * 86_400_000 }], now)).toBe(1);
    expect(attentionCount([{ ...left, message: DISMISSED_MESSAGE }], now)).toBe(0);
  });
});

describe('isFinished', () => {
  it('is true only for done, done_warnings and failed', () => {
    const states: JobState[] = ['queued', 'running', 'needs_you', 'done', 'done_warnings', 'failed'];
    expect(states.map(isFinished)).toEqual([false, false, false, true, true, true]);
  });
});

describe('system jobs', () => {
  it('knows the upkeep jobs of the app and nothing the user starts', () => {
    for (const kind of ['settings.saveToDrive', 'db.snapshot', 'db.integrityCheck', 'files.classify', 'list.lookAgain']) expect(isSystemJob(kind), kind).toBe(true);
    for (const kind of ['list.place', 'hash.files', 'drive.refresh', 'import.fleetV1', 'copy.toLocal', 'dev.demo']) expect(isSystemJob(kind), kind).toBe(false);
  });

  it('a system job is quiet only while done or stopped by the user', () => {
    const quiet = (kind: string, state: JobState, error: string | null = null): boolean => isQuietSystemJob({ kind, state, error });
    expect(quiet('db.snapshot', 'done')).toBe(true);
    expect(quiet('db.snapshot', 'failed', CANCELLED_MESSAGE)).toBe(true);
    for (const state of ['queued', 'running', 'needs_you', 'done_warnings'] as const) expect(quiet('db.snapshot', state), state).toBe(false);
    expect(quiet('settings.saveToDrive', 'failed', 'The drive card does not match.')).toBe(false);
    expect(quiet('list.place', 'done')).toBe(false);
    expect(quiet('copy.toLocal', 'failed', CANCELLED_MESSAGE)).toBe(false);
  });

  it('isCancelled is a failed job with a stop code (from you or from the app)', () => {
    expect(isCancelled({ state: 'failed', error: CANCELLED_MESSAGE })).toBe(true);
    expect(isCancelled({ state: 'failed', error: stoppedByApp('the drive was ejected') })).toBe(true);
    expect(isCancelled({ state: 'failed', error: INTERRUPTED_MESSAGE })).toBe(false);
    expect(isCancelled({ state: 'failed', error: 'x' })).toBe(false);
    expect(isCancelled({ state: 'done', error: CANCELLED_MESSAGE })).toBe(false);
  });
});
