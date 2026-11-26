import { describe, expect, it } from 'vitest';
import { CANCELLED_MESSAGE, INTERRUPTED_MESSAGE, stoppedByApp, withErrorCode, type JobRecord, type JobState } from '../../shared/jobs';
import {
  countByFilter,
  explainInList,
  formatDateTime,
  formatDuration,
  formatFullDateTime,
  jobRowLine,
  jobStatus,
  showLiveColumns,
  splitRecent,
  visibleJobs,
  defaultSelection,
  filterJobs,
  formatElapsed,
  formatProgressText,
  formatSpeed,
  formatTimeLeft,
  formatWhen,
  jobDetail,
  mergeFresh,
  mergeJob,
  recentJobDetail,
} from './jobsModel';

function job(id: number, state: JobState, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: 'k',
    title: `Job ${id}`,
    state,
    progressDone: 0,
    progressTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
    warnings: [],
    error: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    hasCheckpoint: false,
    speed: null,
    etaSeconds: null,
    choices: [],
    paused: false,
    ...over,
  };
}

const ALL: JobRecord[] = [
  job(6, 'failed'),
  job(5, 'done_warnings'),
  job(4, 'done'),
  job(3, 'needs_you'),
  job(2, 'running'),
  job(1, 'queued'),
];

describe('filters', () => {
  it('maps chips to states: Running includes queued, Finished includes done with warnings', () => {
    expect(filterJobs(ALL, 'all')).toHaveLength(6);
    expect(filterJobs(ALL, 'running').map((j) => j.id)).toEqual([2, 1]);
    expect(filterJobs(ALL, 'needs_you').map((j) => j.id)).toEqual([3]);
    expect(filterJobs(ALL, 'failed').map((j) => j.id)).toEqual([6]);
    expect(filterJobs(ALL, 'finished').map((j) => j.id)).toEqual([5, 4]);
    expect(countByFilter(ALL)).toEqual({ all: 6, running: 2, needs_you: 1, failed: 1, finished: 2 });
  });
});

describe('merging pushed jobs', () => {
  it('replaces a job by id and keeps order', () => {
    const next = mergeJob(ALL, job(2, 'done'));
    expect(next.map((j) => `${j.id}:${j.state}`)).toEqual(['6:failed', '5:done_warnings', '4:done', '3:needs_you', '2:done', '1:queued']);
  });
  it('adds a new job at the top (highest id first)', () => {
    expect(mergeJob(ALL, job(7, 'queued'))[0]?.id).toBe(7);
  });
  it('mergeFresh takes the fresh list but keeps jobs pushed that it has not seen', () => {
    const fresh = [job(2, 'done'), job(1, 'done')];
    const pushed = [job(3, 'queued'), job(2, 'running')];
    expect(mergeFresh(fresh, pushed).map((j) => `${j.id}:${j.state}`)).toEqual(['3:queued', '2:done', '1:done']);
  });
});

describe('defaultSelection', () => {
  it('prefers needs you, then failed, then running, then the newest', () => {
    expect(defaultSelection(ALL)).toBe(3);
    expect(defaultSelection(ALL.filter((j) => j.state !== 'needs_you'))).toBe(6);
    expect(defaultSelection([job(9, 'done'), job(8, 'running')])).toBe(8);
    expect(defaultSelection([job(9, 'done'), job(8, 'done')])).toBe(9);
    expect(defaultSelection([])).toBeNull();
  });
});

describe('formatting', () => {
  it('formats speed in bytes or items', () => {
    expect(formatSpeed({ unit: 'bytes', perSecond: 8_400_000 })).toBe('8.4 MB/s');
    expect(formatSpeed({ unit: 'items', perSecond: 12.4 })).toBe('12 items/s');
    expect(formatSpeed({ unit: 'items', perSecond: 2.5 })).toBe('2.5 items/s');
    expect(formatSpeed(null)).toBe('');
    expect(formatSpeed({ unit: 'bytes', perSecond: 0 })).toBe('');
  });
  it('formats time left', () => {
    expect(formatTimeLeft(null)).toBe('');
    expect(formatTimeLeft(0.2)).toBe('1 s left');
    expect(formatTimeLeft(45)).toBe('45 s left');
    expect(formatTimeLeft(200)).toBe('3 min left');
    expect(formatTimeLeft(3600)).toBe('1 h left');
    expect(formatTimeLeft(5400)).toBe('1 h 30 min left');
  });
  it('formats elapsed time', () => {
    expect(formatElapsed(12_400)).toBe('12 s');
    expect(formatElapsed(185_000)).toBe('3 min 05 s');
    expect(formatElapsed(7_800_000)).toBe('2 h 10 min');
  });
  it('formats when: time today, Yesterday, else date', () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 9, 30, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatWhen(new Date(2026, 9, 29, 23, 59).getTime(), now)).toBe('Yesterday 23:59');
    expect(formatWhen(new Date(2026, 9, 20, 8, 0).getTime(), now)).toBe('20 Oct 08:00');
    expect(formatWhen(null, now)).toBe('');
  });
  it('describes progress by bytes first, then items', () => {
    expect(formatProgressText(job(1, 'running', { bytesDone: 420_000_000, bytesTotal: 25_200_000_000 }))).toBe('420 MB of 25.2 GB');
    expect(formatProgressText(job(1, 'running', { progressDone: 12, progressTotal: 60 }))).toBe('12 of 60');
    expect(formatProgressText(job(1, 'running'))).toBe('');
  });
  it('gives a plain one-line detail per state', () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    expect(jobDetail(job(1, 'queued'), now)).toBe('Waiting for its turn');
    expect(jobDetail(job(1, 'failed', { error: 'Drive 7 is full' }), now)).toBe('Drive 7 is full');
    expect(jobDetail(job(1, 'failed', { error: withErrorCode('busy', 'The data file was busy.') }), now)).toBe('The data file was busy.');
    expect(jobDetail(job(1, 'done_warnings', { message: 'Scanned', warnings: ['a', 'b'] }), now)).toBe('Scanned · 2 warnings');
    expect(jobDetail(job(1, 'done_warnings', { warnings: ['a'] }), now)).toBe('Finished · 1 warning');
    const done = job(1, 'done', { message: '5 videos copied', finishedAt: new Date(2026, 9, 30, 10, 40).getTime() });
    expect(recentJobDetail(done, now)).toBe('5 videos copied · 10:40');
  });
});

describe('system jobs in Jobs and Home', () => {
  const list = [
    job(8, 'done', { kind: 'db.snapshot' }),
    job(7, 'failed', { kind: 'settings.saveToDrive', error: 'The drive card does not match.' }),
    job(6, 'running', { kind: 'files.classify' }),
    job(5, 'failed', { kind: 'db.integrityCheck', error: CANCELLED_MESSAGE }),
    job(4, 'done', { kind: 'list.place' }),
    job(3, 'done_warnings', { kind: 'db.snapshot', warnings: ['w'] }),
  ];
  it('hides quiet system jobs by default and shows everything with the switch', () => {
    expect(visibleJobs(list, false).map((j) => j.id)).toEqual([7, 6, 4, 3]);
    expect(visibleJobs(list, true).map((j) => j.id)).toEqual([8, 7, 6, 5, 4, 3]);
  });
  it('the counts follow the switch', () => {
    expect(countByFilter(visibleJobs(list, false)).all).toBe(4);
    expect(countByFilter(visibleJobs(list, false)).finished).toBe(2);
    expect(countByFilter(visibleJobs(list, true)).all).toBe(6);
  });
});

describe('columns that depend on the rows', () => {
  it('Progress, Speed and Time left only when something runs, waits or needs you', () => {
    expect(showLiveColumns([job(1, 'done'), job(2, 'failed'), job(3, 'done_warnings')])).toBe(false);
    expect(showLiveColumns([job(1, 'done'), job(2, 'queued')])).toBe(true);
    expect(showLiveColumns([job(1, 'running')])).toBe(true);
    expect(showLiveColumns([job(1, 'needs_you')])).toBe(true);
    expect(showLiveColumns([])).toBe(false);
  });
});

describe('dates, duration and state wording', () => {
  const now = new Date(2026, 10, 1, 15, 0).getTime();
  it('formats date and time', () => {
    expect(formatDateTime(new Date(2026, 10, 1, 14, 5).getTime(), now)).toBe('Today 14:05');
    expect(formatDateTime(new Date(2026, 9, 31, 23, 9).getTime(), now)).toBe('Yesterday 23:09');
    expect(formatDateTime(new Date(2026, 9, 28, 8, 0).getTime(), now)).toBe('28 Oct 08:00');
    expect(formatDateTime(new Date(2025, 11, 2, 8, 0).getTime(), now)).toBe('2 Dec 2025 08:00');
    expect(formatDateTime(null, now)).toBe('');
    expect(formatFullDateTime(new Date(2026, 9, 31, 14, 5, 7).getTime())).toBe('Saturday 31 October 2026, 14:05:07');
  });
  it('formats how long a job took, or has taken so far', () => {
    const t = new Date(2026, 10, 1, 14, 0, 0).getTime();
    expect(formatDuration({ startedAt: t, finishedAt: t + 130_000 }, now)).toBe('2 min 10 s');
    expect(formatDuration({ startedAt: t, finishedAt: t + 400 }, now)).toBe('Under 1 s');
    expect(formatDuration({ startedAt: t, finishedAt: null }, t + 45_000)).toBe('45 s');
    expect(formatDuration({ startedAt: null, finishedAt: null }, now)).toBe('');
  });
  it('words each state', () => {
    const st = (state: JobState, over: Partial<JobRecord> = {}) => jobStatus(job(1, state, over));
    expect(st('done_warnings')).toEqual({ label: 'Done with warnings', tone: 'amber' });
    expect(st('failed', { error: CANCELLED_MESSAGE })).toEqual({ label: 'Stopped by you', tone: 'neutral' });
    expect(st('failed', { error: stoppedByApp('the drive was ejected') })).toEqual({ label: 'Stopped by Backup Hub', tone: 'amber' });
    expect(st('failed', { error: INTERRUPTED_MESSAGE })).toEqual({ label: 'Interrupted', tone: 'amber' });
    expect(st('failed', { error: INTERRUPTED_MESSAGE, retriedBy: 9 })).toEqual({ label: 'Retried', tone: 'neutral' });
    expect(st('failed', { error: withErrorCode('refused', 'T7 is not the named T7.') })).toEqual({ label: 'Not started', tone: 'amber' });
    // A job that really failed keeps saying Failed after a retry; only the interrupted one is shown as Retried.
    expect(st('failed', { error: 'Drive 7 is full.', retriedBy: 9 })).toEqual({ label: 'Failed', tone: 'crit' });
    expect(st('failed', { error: 'Drive full' })).toEqual({ label: 'Failed', tone: 'crit' });
    expect(st('queued', { paused: true }).label).toBe('Paused');
    expect(st('queued', { paused: true, pausing: true }).label).toBe('Pausing');
    expect(st('queued').label).toBe('Waiting');
  });
});

describe('the Activity list: chips, the last 7 days, one line per job', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime();
  const day = 86_400_000;
  const at = (daysAgo: number) => now - daysAgo * day;
  const list = [
    job(9, 'running', { createdAt: at(30), message: 'Sorting', progressDone: 1, progressTotal: 4 }),
    job(8, 'failed', { error: withErrorCode('busy', 'The data file was busy.'), finishedAt: at(1) }),
    job(7, 'failed', { error: CANCELLED_MESSAGE, finishedAt: at(1) }),
    job(6, 'failed', { error: INTERRUPTED_MESSAGE, finishedAt: at(2) }),
    job(5, 'done', { finishedAt: at(3) }),
    job(4, 'done_warnings', { finishedAt: at(6) }),
    job(3, 'needs_you', { createdAt: at(40) }),
    job(2, 'done', { finishedAt: at(8) }),
    job(1, 'failed', { error: 'x', finishedAt: at(20) }),
  ];
  it('the five chips: a stop or an interruption is Finished, not Failed', () => {
    const counts = countByFilter(list);
    expect(counts).toEqual({ all: 9, running: 1, needs_you: 1, failed: 2, finished: 5 });
    expect(filterJobs(list, 'failed').map((j) => j.id)).toEqual([8, 1]);
    expect(filterJobs(list, 'finished').map((j) => j.id)).toEqual([7, 6, 5, 4, 2]);
  });
  it('the last 7 days plus anything running or waiting for you; the rest is "older"', () => {
    const { recent, older } = splitRecent(list, now);
    expect(recent.map((j) => j.id)).toEqual([9, 8, 7, 6, 5, 4, 3]);
    expect(older.map((j) => j.id)).toEqual([2, 1]);
  });
  it('one plain line per job; the percentage only while it runs', () => {
    expect(jobRowLine(list[0]!, list)).toBe('Sorting · 25%');
    expect(jobRowLine(list[1]!, list)).toBe('The data file was busy with another task for too long.');
    expect(jobRowLine(list[2]!, list)).toBe('Stopped by you');
  });
  it('an interrupted job is offered Retry only while no newer run of the same kind has finished', () => {
    const interrupted = job(6, 'failed', { kind: 'db.snapshot', error: INTERRUPTED_MESSAGE });
    expect(explainInList(interrupted, [interrupted]).retry.allowed).toBe(true);
    const newer = job(7, 'done', { kind: 'db.snapshot', finishedAt: new Date(2026, 10, 9).getTime() });
    const other = job(8, 'done', { kind: 'list.place' });
    expect(explainInList(interrupted, [other, newer, interrupted]).retry).toEqual({ allowed: false, why: 'A newer one finished on 9 Nov, so there is nothing to catch up on.' });
    expect(explainInList(interrupted, [other, interrupted]).retry.allowed).toBe(true);
  });
});
