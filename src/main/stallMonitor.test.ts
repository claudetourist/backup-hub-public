import { describe, expect, it } from 'vitest';
import { StallMonitor } from './stallMonitor';

describe('stall monitor', () => {
  it('says nothing while the timer fires on time, and warns with the job kinds when it fires late', () => {
    let t = 1000;
    const warnings: string[] = [];
    const stalls: number[] = [];
    const monitor = new StallMonitor({
      thresholdMs: 500,
      intervalMs: 100,
      now: () => t,
      runningKinds: () => ['list.place', 'hash.files', 'list.place'],
      warn: (m) => warnings.push(m),
      onStall: (ms) => stalls.push(ms),
    });
    monitor.start();
    monitor.stop();
    // start() took the first reading at t = 1000.
    t += 105;
    monitor.check();
    t += 100;
    monitor.check();
    expect(warnings).toEqual([]);
    expect(monitor.maxStallMs).toBeLessThan(10);
    // The loop was blocked for 900 ms.
    t += 1000;
    monitor.check();
    expect(stalls).toEqual([900]);
    expect(warnings).toEqual(['main loop stalled for 900 ms while running: list.place, hash.files']);
    expect(monitor.stalls).toBe(1);
    expect(monitor.maxStallMs).toBe(900);
  });

  it('says so when no job was running', () => {
    let t = 0;
    const warnings: string[] = [];
    const monitor = new StallMonitor({ thresholdMs: 500, intervalMs: 100, now: () => t, warn: (m) => warnings.push(m) });
    t += 700;
    monitor.check();
    expect(warnings).toEqual(['main loop stalled for 600 ms with no job running']);
  });
});
