import { describe, expect, it } from 'vitest';
import { coveragePercents, coverageSummary, safeFraction } from './coverage';

describe('coveragePercents', () => {
  it('matches the design figures', () => {
    // Reunion 46.5 GB: 97% one backup, 3% two or more.
    expect(coveragePercents({ none: 0, one: 45.1, many: 1.4 })).toEqual({ none: 0, one: 97, many: 3 });
    // Rest of MyData 28.8 GB: 8 / 88 / 4.
    expect(coveragePercents({ none: 2.4, one: 25.2, many: 1.2 })).toEqual({ none: 8, one: 88, many: 4 });
  });
  it('always sums to 100', () => {
    for (const bytes of [
      { none: 1, one: 1, many: 1 },
      { none: 1, one: 2, many: 4 },
      { none: 7, one: 11, many: 13 },
      { none: 0, one: 0, many: 5 },
    ]) {
      const p = coveragePercents(bytes);
      expect(p.none + p.one + p.many).toBe(100);
    }
  });
  it('returns zeros for an empty or negative collection', () => {
    expect(coveragePercents({ none: 0, one: 0, many: 0 })).toEqual({ none: 0, one: 0, many: 0 });
    expect(coveragePercents({ none: -5, one: 0, many: 0 })).toEqual({ none: 0, one: 0, many: 0 });
  });
});

describe('safeFraction and summary', () => {
  it('is the 2+ backups share', () => {
    expect(safeFraction({ none: 0, one: 3, many: 1 })).toBe(0.25);
    expect(safeFraction({ none: 0, one: 0, many: 0 })).toBe(0);
  });
  it('words the summary, skipping empty parts', () => {
    expect(coverageSummary({ none: 0, one: 97, many: 3 })).toBe('97% has 1 backup, 3% has 2 or more backups');
    expect(coverageSummary({ none: 0, one: 0, many: 0 })).toBe('Empty');
  });
});
