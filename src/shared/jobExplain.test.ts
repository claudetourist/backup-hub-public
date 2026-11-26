import { describe, expect, it } from 'vitest';
import { CLEAN_LAPTOP_JOB_KIND, CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND } from './cleanup';
import { explainJob, neverRetried, type ExplainInput } from './jobExplain';
import { CANCELLED_MESSAGE, INTERRUPTED_MESSAGE, parseJobError, stoppedByApp, withErrorCode, type JobErrorCode, type JobState } from './jobs';

function job(kind: string, state: JobState, error: string | null = null, over: Partial<ExplainInput> = {}): ExplainInput {
  return { id: 1, kind, state, error, warnings: [], message: null, paused: false, ...over };
}
const failed = (code: JobErrorCode, text: string, kind = 'hash.files', over: Partial<ExplainInput> = {}): ExplainInput => job(kind, 'failed', withErrorCode(code, text), over);

describe('error codes', () => {
  it('are stored in front of the plain words and read back', () => {
    expect(parseJobError(withErrorCode('busy', 'Too busy.'))).toEqual({ code: 'busy', text: 'Too busy.' });
    expect(parseJobError('Drive 7 is full.')).toEqual({ code: null, text: 'Drive 7 is full.' });
    expect(parseJobError('[nonsense] text')).toEqual({ code: null, text: '[nonsense] text' });
    expect(parseJobError(null)).toEqual({ code: null, text: '' });
  });
  it('"by you" is written only for the Stop button; an app stop carries its reason', () => {
    expect(parseJobError(CANCELLED_MESSAGE)).toEqual({ code: 'stopped-by-you', text: 'Stopped by you' });
    expect(parseJobError(stoppedByApp('it was using F:'))).toEqual({ code: 'stopped-by-app', text: 'Stopped by Backup Hub: it was using F:' });
  });
});

describe('explainJob: one test per rule', () => {
  it('stopped by you: stopped, not a failure, no Retry', () => {
    const x = explainJob(job('hash.files', 'failed', CANCELLED_MESSAGE));
    expect(x).toMatchObject({ status: 'stopped', headline: 'Stopped by you', retry: { allowed: false } });
    expect(x.whatWasNotChanged).toMatch(/not changed/);
  });

  it('stopped by the app: says so and why, never "by you"; Retry is fine', () => {
    const x = explainJob(job('hash.files', 'failed', stoppedByApp('it was using T7, which you chose to eject')));
    expect(x.status).toBe('stopped');
    expect(x.headline).toBe('Stopped by Backup Hub: it was using T7, which you chose to eject');
    expect(x.headline).not.toMatch(/by you/);
    expect(x.retry.allowed).toBe(true);
  });

  it('interrupted: amber, Retry when nothing newer finished', () => {
    const x = explainJob(job('db.snapshot', 'failed', INTERRUPTED_MESSAGE));
    expect(x).toMatchObject({ status: 'interrupted', headline: 'Interrupted when the app closed', retry: { allowed: true } });
  });

  it('interrupted with a checkpoint: Continue or Dismiss, nothing continues by itself, no Retry until it is dismissed', () => {
    const left = failed('interrupted', 'Interrupted when the app closed', 'hash.files', { hasCheckpoint: true });
    const x = explainJob(left);
    expect(x).toMatchObject({ status: 'interrupted', retry: { allowed: false } });
    expect(x.whatToDo).toMatch(/Nothing continues by itself.*Continue.*Dismiss/);
    expect(explainJob({ ...left, message: 'Dismissed' }).retry.allowed).toBe(true);
  });

  it('interrupted: a newer finished run replaces Retry with the date', () => {
    const finishedAt = new Date(2026, 10, 9, 12, 0).getTime();
    const x = explainJob(job('db.snapshot', 'failed', INTERRUPTED_MESSAGE), { newerFinished: { id: 70, finishedAt } });
    expect(x.status).toBe('interrupted');
    expect(x.retry).toEqual({ allowed: false, why: 'A newer one finished on 9 Nov, so there is nothing to catch up on.' });
  });

  it('interrupted and already retried: no second Retry', () => {
    const x = explainJob(job('db.snapshot', 'failed', INTERRUPTED_MESSAGE, { retriedBy: 9 }));
    expect(x.retry.allowed).toBe(false);
    expect(x.whatToDo).toMatch(/job #9/);
  });

  it('refused by a safety rule (drive identity, USB trouble, read-only drive, start gate): no Retry, and the fix is named', () => {
    for (const text of [
      'T7 is not the named T7 any more, so nothing was written.',
      'Seagate2TB has USB errors. Nothing was copied.',
      'F: is write-protected. Nothing was written.',
      'There is less than 2 GB free on the data disk, so this did not start.',
    ]) {
      const x = explainJob(failed('refused', text, 'copy.toLocal'));
      expect(x.status).toBe('failed');
      expect(x.headline).toBe(text);
      expect(x.retry.allowed).toBe(false);
      expect(x.whatToDo).toMatch(/Fix what the line above says/);
    }
  });

  it('clean-up kinds never retry, whatever went wrong', () => {
    for (const kind of [CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND, CLEAN_LAPTOP_JOB_KIND, 'clean.somethingNew']) {
      expect(neverRetried(kind)).toBe(true);
      for (const code of ['network', 'busy', 'unexpected', 'interrupted', 'stopped-by-app'] as const) {
        expect(explainJob(failed(code, 'x. y.', kind)).retry.allowed, `${kind} ${code}`).toBe(false);
      }
      expect(explainJob(job(kind, 'done_warnings', null, { warnings: ['a'] })).retry.allowed).toBe(false);
    }
  });

  it('transient trouble (network, busy file, drive gone, Windows access) offers Retry with a plain next step', () => {
    for (const code of ['network', 'busy', 'drive-gone', 'access', 'disk-full', 'google'] as const) {
      const x = explainJob(failed(code, 'Plain text. More.'));
      expect(x.status, code).toBe('failed');
      expect(x.retry.allowed, code).toBe(true);
      expect(x.whatToDo.length).toBeGreaterThan(10);
    }
    expect(explainJob(failed('network', 'x')).headline).toBe('The internet connection was lost.');
  });

  it('an unexpected error says so and offers Retry plus the details', () => {
    const x = explainJob(failed('unexpected', 'Something unexpected went wrong and this job stopped.'));
    expect(x).toMatchObject({ status: 'failed', headline: 'Something unexpected went wrong.', retry: { allowed: true } });
    expect(x.whatToDo).toMatch(/technical details/);
  });

  it('a job that chose its own words (no code) keeps the first sentence as the headline and the rest as the next step', () => {
    const x = explainJob(job('list.place', 'failed', 'That place no longer exists, so there is nothing to check. Add it again under Devices.'));
    expect(x.headline).toBe('That place no longer exists, so there is nothing to check.');
    expect(x.whatToDo).toBe('Add it again under Devices.');
  });

  it('done with warnings is a warning, not a failure, and says what to do', () => {
    const x = explainJob(job('settings.saveToDrive', 'done_warnings', null, { message: 'Skipped T7: not the named drive, nothing was written', warnings: ['Skipped T7: the drive in F: is not the named T7 any more, so nothing was written'] }));
    expect(x.status).toBe('warning');
    expect(x.headline).toBe('Skipped T7: not the named drive, nothing was written, with 1 thing to look at');
    expect(x.retry.allowed).toBe(true);
  });

  it('running, waiting, paused, needs you and done have no Retry', () => {
    expect(explainJob(job('hash.files', 'running', null, { message: 'Working on 12 of 40' }))).toMatchObject({ status: 'running', headline: 'Working on 12 of 40', retry: { allowed: false } });
    expect(explainJob(job('hash.files', 'queued')).status).toBe('waiting');
    expect(explainJob(job('hash.files', 'queued', null, { paused: true })).status).toBe('paused');
    expect(explainJob(job('hash.files', 'queued', null, { paused: true })).headline).toBe('Paused — safe to close the app');
    expect(explainJob(job('hash.files', 'queued', null, { paused: true, pausing: true })).headline).toBe('Pausing: saving your place…');
    expect(explainJob(job('hash.files', 'needs_you', null, { message: 'Which drive?' })).headline).toBe('Which drive?');
    expect(explainJob(job('hash.files', 'done', null, { message: 'Sorted 5 files' }))).toMatchObject({ status: 'done', headline: 'Sorted 5 files', retry: { allowed: false } });
  });
});

describe('explainJob: the cases found in the real history (as the new code records them)', () => {
  it('sorting files stopped by a busy data file (was "Something unexpected", jobs 88, 92, 107)', () => {
    const x = explainJob(failed('busy', 'The data file was busy with another task for too long, so this job stopped. Nothing was deleted. Run it again.', 'files.classify'));
    expect(x).toMatchObject({ status: 'failed', headline: 'The data file was busy with another task for too long.', retry: { allowed: true } });
  });
  it('the app stopped a fingerprint job (was blamed on you, jobs 89, 93, 94)', () => {
    const x = explainJob(job('hash.files', 'failed', stoppedByApp('something else needed the drive')));
    expect(x.status).toBe('stopped');
    expect(x.headline).not.toMatch(/you/);
  });
  it('the daily database copy interrupted by closing the app (job 68)', () => {
    expect(explainJob(job('db.snapshot', 'failed', INTERRUPTED_MESSAGE)).status).toBe('interrupted');
  });
  it('saving settings to the wrong drive in F: is a warning (job 49)', () => {
    expect(explainJob(job('settings.saveToDrive', 'done_warnings', null, { warnings: ['x'] })).status).toBe('warning');
  });
  it('file read errors stay warnings (jobs 17, 36)', () => {
    const x = explainJob(job('hash.files', 'done_warnings', null, { message: 'Fingerprinted 90 files', warnings: ['a.txt: Could not read it (the file is in use by another program, EBUSY).'] }));
    expect(x).toMatchObject({ status: 'warning', retry: { allowed: true } });
  });
});
