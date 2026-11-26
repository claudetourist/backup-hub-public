import { describe, expect, it } from 'vitest';
import { KeyedThrottle, type ThrottleClock } from './throttle';

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock: ThrottleClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { clock, advance, timers };
}

describe('KeyedThrottle', () => {
  it('emits the first value at once, merges the rest and sends the latest when the interval ends', () => {
    const { clock, advance } = fakeClock();
    const got: [string, number][] = [];
    const t = new KeyedThrottle<string, number>(250, (k, v) => got.push([k, v]), clock);
    t.push('a', 1);
    t.push('a', 2);
    t.push('a', 3);
    expect(got).toEqual([['a', 1]]);
    advance(249);
    expect(got).toHaveLength(1);
    advance(1);
    expect(got).toEqual([
      ['a', 1],
      ['a', 3],
    ]);
  });

  it('never exceeds 4 events per second per key even with a push every millisecond', () => {
    const { clock, advance } = fakeClock();
    const stamps: number[] = [];
    const t = new KeyedThrottle<string, number>(250, () => stamps.push(clock.now()), clock);
    for (let i = 0; i < 3000; i += 1) {
      t.push('job', i);
      advance(1);
    }
    advance(300);
    for (let start = 0; start < 3000; start += 100) {
      const inWindow = stamps.filter((s) => s >= start && s < start + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(4);
    }
    expect(stamps.length).toBeGreaterThanOrEqual(11);
  });

  it('keeps keys independent and drop() cancels what was waiting', () => {
    const { clock, advance, timers } = fakeClock();
    const got: string[] = [];
    const t = new KeyedThrottle<string, number>(250, (k, v) => got.push(`${k}${v}`), clock);
    t.push('a', 1);
    t.push('b', 1);
    t.push('a', 2);
    t.drop('a');
    expect(timers).toHaveLength(0);
    advance(1000);
    expect(got).toEqual(['a1', 'b1']);
  });
});
