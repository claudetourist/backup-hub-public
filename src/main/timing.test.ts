import { describe, expect, it } from 'vitest';
import { formatTimingSummary, processStartEpoch, StartupTimings } from './timing';

describe('formatTimingSummary', () => {
  it('lists marks in time order with a total', () => {
    expect(
      formatTimingSummary({ appReady: 310.4, dbReady: 320, windowCreated: 338, readyToShow: 701.6, firstPaint: 742 }),
    ).toBe('startup: appReady=310ms dbReady=320ms windowCreated=338ms readyToShow=702ms firstPaint=742ms total=742ms');
  });

  it('reports missing marks', () => {
    expect(formatTimingSummary({ appReady: 100, windowCreated: 120 })).toBe(
      'startup: appReady=100ms windowCreated=120ms total=120ms (missing: dbReady, readyToShow, firstPaint)',
    );
  });

  it('handles an empty set', () => {
    expect(formatTimingSummary({})).toBe('startup: no marks recorded');
  });

  it('orders by time even when marks arrive out of the usual order', () => {
    expect(formatTimingSummary({ appReady: 10, dbReady: 15, windowCreated: 20, readyToShow: 90, firstPaint: 60 })).toBe(
      'startup: appReady=10ms dbReady=15ms windowCreated=20ms firstPaint=60ms readyToShow=90ms total=90ms',
    );
  });
});

describe('StartupTimings', () => {
  it('measures marks relative to the origin and keeps the first value', () => {
    let now = 1_000;
    const timings = new StartupTimings(1_000, () => now);
    now = 1_250;
    expect(timings.mark('appReady')).toBe(250);
    now = 1_900;
    expect(timings.mark('appReady')).toBe(250);
    expect(timings.snapshot().marks).toEqual({ appReady: 250 });
    expect(timings.snapshot().complete).toBe(false);
  });

  it('is complete once all marks are in, and the snapshot carries the summary', () => {
    const timings = new StartupTimings(0, () => 0);
    timings.mark('appReady', 100);
    timings.mark('dbReady', 115);
    timings.mark('windowCreated', 130);
    timings.mark('readyToShow', 500);
    timings.mark('firstPaint', 520);
    const snapshot = timings.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.summary).toBe(
      'startup: appReady=100ms dbReady=115ms windowCreated=130ms readyToShow=500ms firstPaint=520ms total=520ms',
    );
  });

  it('never goes negative if a clock reads before the origin', () => {
    const timings = new StartupTimings(500, () => 400);
    expect(timings.mark('appReady')).toBe(0);
  });
});

describe('processStartEpoch', () => {
  it('falls back to now minus uptime outside Electron', () => {
    const now = Date.now();
    const start = processStartEpoch(now);
    expect(start).toBeLessThanOrEqual(now);
    expect(now - start).toBeCloseTo(process.uptime() * 1000, -3);
  });
});
