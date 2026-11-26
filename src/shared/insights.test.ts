import { describe, expect, it } from 'vitest';
import { verdictOf, type HealthFacts } from './insights';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26);
const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  kind: 'drive', status: 'connected', lastSeenAt: NOW, freeBytes: 500, capacityBytes: 1000, smart: 'good', windowsErrors: 0, usbTroubles: 0, readErrors: 0, damaged: 0, differs: 0, ...over,
});

describe('the verdict of a drive', () => {
  it('Healthy when nothing is wrong, and when Windows could not tell', () => {
    expect(verdictOf(facts(), NOW)).toEqual({ verdict: 'healthy', reasons: [] });
    expect(verdictOf(facts({ smart: 'unknown', windowsErrors: null }), NOW).verdict).toBe('healthy');
    expect(verdictOf(facts({ kind: 'phone', smart: null, windowsErrors: null }), NOW).verdict).toBe('healthy');
  });

  it('Problem: a failing disk, a drive Windows cannot read, a damaged copy (and it comes first in the reasons)', () => {
    expect(verdictOf(facts({ smart: 'bad' }), NOW).verdict).toBe('problem');
    expect(verdictOf(facts({ status: 'problem' }), NOW).verdict).toBe('problem');
    const both = verdictOf(facts({ damaged: 2, usbTroubles: 1 }), NOW);
    expect(both).toEqual({ verdict: 'problem', reasons: ['2 copies are damaged', 'Paused 1 time for USB trouble in 30 days'] });
  });

  it('Check soon: each of the softer signs on its own', () => {
    const one = (over: Partial<HealthFacts>): string[] => {
      const v = verdictOf(facts(over), NOW);
      expect(v.verdict).toBe('check-soon');
      return v.reasons;
    };
    expect(one({ smart: 'warning' })).toEqual(['Windows warns about this disk']);
    expect(one({ windowsErrors: 1 })).toEqual(['Windows logged 1 disk error in 30 days']);
    expect(one({ usbTroubles: 4 })).toEqual(['Paused 4 times for USB trouble in 30 days']);
    expect(one({ readErrors: 3 })).toEqual(['3 files could not be read in the last check']);
    expect(one({ differs: 1 })).toEqual(['1 copy differs from the first drive']);
    expect(one({ freeBytes: 99 })).toEqual(['Almost full']);
    expect(one({ kind: 'gdrive', status: 'needs_signin' })).toEqual(['Needs signing in again']);
    expect(one({ status: 'disconnected', lastSeenAt: NOW - 30 * DAY })).toEqual(['Not seen for 30 days']);
  });

  it('a drive away for 29 days, or the laptop and a Google account away, is not "not seen"; nothing known about the size is not "almost full"', () => {
    expect(verdictOf(facts({ status: 'disconnected', lastSeenAt: NOW - 29 * DAY }), NOW).verdict).toBe('healthy');
    expect(verdictOf(facts({ kind: 'gdrive', status: 'disconnected', lastSeenAt: NOW - 90 * DAY }), NOW).verdict).toBe('healthy');
    expect(verdictOf(facts({ status: 'disconnected', lastSeenAt: null }), NOW).verdict).toBe('healthy');
    expect(verdictOf(facts({ freeBytes: null, capacityBytes: null }), NOW).verdict).toBe('healthy');
  });
});
