import { describe, expect, it } from 'vitest';
import { CANCELLED_MESSAGE, INTERRUPTED_MESSAGE, type JobChangedEvent, type JobRecord } from '../../shared/jobs';
import { toastFor } from './notifications';

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: 1,
    kind: 'k',
    title: 'Copy Reunion',
    state: 'done',
    progressDone: 0,
    progressTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
    warnings: [],
    error: null,
    createdAt: 0,
    startedAt: 1000,
    finishedAt: 1000 + 60_000,
    hasCheckpoint: false,
    speed: null,
    etaSeconds: null,
    choices: [],
    paused: false,
    ...over,
  };
}
const ev = (j: JobRecord, reason: JobChangedEvent['reason'] = 'state'): JobChangedEvent => ({ reason, job: j });

describe('toastFor', () => {
  it('never toasts a clean finish, however long the job ran', () => {
    expect(toastFor(ev(job({})))).toBeNull();
    expect(toastFor(ev(job({ finishedAt: 1000 + 3_600_000 })))).toBeNull();
    expect(toastFor(ev(job({ finishedAt: 5000 })))).toBeNull();
  });
  it('always toasts warnings, failures and questions, whatever the duration', () => {
    expect(toastFor(ev(job({ state: 'done_warnings', finishedAt: 2000, warnings: ['1 file skipped'] })))?.body).toBe(
      '1 file skipped',
    );
    expect(toastFor(ev(job({ state: 'failed', finishedAt: 2000, error: 'Drive is full' })))).toEqual({
      title: 'Copy Reunion failed',
      body: 'Drive is full',
    });
    expect(toastFor(ev(job({ state: 'needs_you', message: 'Keep both?' })))?.body).toBe('Keep both?');
  });
  it('stays quiet for cancelled or interrupted jobs, queued/running, and progress events', () => {
    expect(toastFor(ev(job({ state: 'failed', error: CANCELLED_MESSAGE })))).toBeNull();
    expect(toastFor(ev(job({ state: 'failed', error: INTERRUPTED_MESSAGE })))).toBeNull();
    expect(toastFor(ev(job({ state: 'running' })))).toBeNull();
    expect(toastFor(ev(job({ state: 'queued' })))).toBeNull();
    expect(toastFor(ev(job({ state: 'failed', error: 'x' }), 'progress'))).toBeNull();
  });
});
