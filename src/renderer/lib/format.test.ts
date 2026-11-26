import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, plural } from './format';

describe('formatBytes', () => {
  it('uses decimal units and trims a trailing .0', () => {
    expect(formatBytes(46_500_000_000)).toBe('46.5 GB');
    expect(formatBytes(51_000_000_000)).toBe('51 GB');
    expect(formatBytes(322_000_000_000)).toBe('322 GB');
    expect(formatBytes(931e9)).toBe('931 GB');
    expect(formatBytes(3_600_000_000)).toBe('3.6 GB');
  });
  it('handles small, zero and invalid values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatCount and plural', () => {
  it('groups thousands', () => {
    expect(formatCount(403410)).toBe('403,410');
    expect(formatCount(7)).toBe('7');
  });
  it('picks singular only for exactly one', () => {
    expect(plural(1, 'thing', 'things')).toBe('thing');
    expect(plural(0, 'thing', 'things')).toBe('things');
    expect(plural(3, 'thing', 'things')).toBe('things');
  });
});
