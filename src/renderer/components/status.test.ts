import { describe, expect, it } from 'vitest';
import { copyCountLabel, copyCountTone, JOB_STATES, jobStateLabel, jobStateTone } from './status';

describe('job state labels', () => {
  it('uses plain language for all six states', () => {
    expect(JOB_STATES.map(jobStateLabel)).toEqual([
      'Queued',
      'Running',
      'Needs you',
      'Done',
      'Done with warnings',
      'Failed',
    ]);
  });
  it('gives every state a tone, and warnings are not shown as plain success', () => {
    expect(jobStateTone('done')).toBe('ok');
    expect(jobStateTone('done_warnings')).not.toBe('ok');
    expect(jobStateTone('failed')).toBe('crit');
    expect(jobStateTone('needs_you')).toBe('warn');
  });
});

describe('copy counts', () => {
  it('labels none, one and two or more', () => {
    expect(copyCountLabel(0)).toBe('No backup');
    expect(copyCountLabel(1)).toBe('1 backup');
    expect(copyCountLabel(2)).toBe('2 backups');
    expect(copyCountLabel(9)).toBe('9 backups');
  });
  it('treats negative or invalid counts as no backup', () => {
    expect(copyCountLabel(-1)).toBe('No backup');
    expect(copyCountLabel(Number.NaN)).toBe('No backup');
  });
  it('escalates tone as protection drops', () => {
    expect([0, 1, 2].map(copyCountTone)).toEqual(['crit', 'warn', 'ok']);
  });
});
