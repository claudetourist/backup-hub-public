import { describe, expect, it } from 'vitest';
import { GoogleApiError, NetworkError } from '../google/googleHttp';
import { describeError, JobFailure } from './jobService';

describe('job errors in plain words', () => {
  it('keeps the words a job chose', () => {
    expect(describeError(new JobFailure('The drive is full.')).plain).toBe('The drive is full.');
  });

  it('every surprise says what happened, that nothing was deleted, and what to do', () => {
    const cases: unknown[] = [
      new NetworkError('fetch failed'),
      new GoogleApiError(500, 'backendError', 'Google said no'),
      Object.assign(new Error('x'), { code: 'ENOSPC' }),
      Object.assign(new Error('x'), { code: 'EPERM' }),
      Object.assign(new Error('x'), { code: 'EIO' }),
      new TypeError('cannot read properties of undefined'),
      'a string',
    ];
    for (const err of cases) {
      const { plain, detail } = describeError(err);
      expect(plain, String(err)).toMatch(/Nothing .*deleted/);
      expect(plain, String(err)).toMatch(/[Rr]un it again|[Tt]ry again|Free some space/);
      expect(plain).not.toMatch(/undefined|TypeError|ENOSPC|EPERM|fetch failed/);
      expect(detail.length).toBeGreaterThan(0);
    }
  });
});
