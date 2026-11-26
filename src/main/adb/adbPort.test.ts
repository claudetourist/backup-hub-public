import { describe, expect, it } from 'vitest';
import { adbCandidates } from './adbPort';

describe('adb', () => {
  it('finds adb in the usual places only when it exists', () => {
    expect(adbCandidates({ PATH: 'C:\\tools' }).some((c) => c.endsWith('adb.exe'))).toBe(true);
  });
});
