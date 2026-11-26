import { describe, expect, it } from 'vitest';
import { BusyTracker } from './busyTracker';
import { StallMonitor } from './stallMonitor';

describe('BusyTracker', () => {
  it('names the call that held the main thread during a stall', () => {
    let t = 1000;
    const tracker = new BusyTracker(() => t);
    const quick = tracker.begin('plans:list');
    t += 5;
    quick.syncDone();
    quick.finished();
    const slow = tracker.begin('backups:overview');
    t += 6000;
    slow.syncDone();
    slow.finished();
    expect(tracker.describe(6200)).toBe('backups:overview held 6000 ms; plans:list');
  });

  it('marks a call still waiting for its answer', () => {
    let t = 0;
    const tracker = new BusyTracker(() => t);
    const c = tracker.begin('phone-backup:look');
    t += 2;
    c.syncDone();
    t += 10_000;
    expect(tracker.describe(1000)).toBe('phone-backup:look (waiting)');
    c.finished();
    expect(tracker.describe(1000)).toBe('phone-backup:look');
    t += 5000;
    expect(tracker.describe(1000)).toBe('');
  });

  it('feeds the stall line', () => {
    let t = 0;
    const lines: string[] = [];
    const tracker = new BusyTracker(() => t);
    const m = new StallMonitor({ thresholdMs: 500, intervalMs: 100, now: () => t, warn: (s) => lines.push(s), busyDuring: (w) => tracker.describe(w) });
    m.start();
    m.stop();
    const c = tracker.begin('backups:overview');
    t += 6000;
    c.syncDone();
    c.finished();
    t += 100;
    m.check();
    expect(lines[0]).toBe('main loop stalled for 6000 ms with no job running; window calls: backups:overview held 6000 ms');
  });
});
