import { describe, expect, it } from 'vitest';
import { describeReadError } from './hashCore';

describe('plain words for read errors', () => {
  it('say that Windows may be blocking a file that refuses access', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const { message } = describeReadError({ code });
      expect(message).toContain('Windows or another program may be blocking this file');
      expect(message).toContain(code);
    }
  });
  it('keep the other reasons and the code', () => {
    expect(describeReadError({ code: 'EBUSY' }).message).toBe('Could not read it (the file is in use by another program, EBUSY).');
    expect(describeReadError(new Error('x')).message).toBe('Could not read it (unexpected error, UNKNOWN).');
  });
});
