import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PauseStatus } from '../../shared/pause';
import { closeDatabase, initDatabase, type Db } from '../db';
import { PAUSE_SETTING_KEY, PauseState, settingsRowPauseStore, type PauseStore } from './pauseState';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function memoryStore(initial: string | null = null): PauseStore & { value: string | null } {
  const s = { value: initial, read: () => s.value, write: (v: string) => void (s.value = v) };
  return s;
}

function make(store: PauseStore, startAt = 1_800_000_000_000) {
  const clock = { now: startAt };
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const state = new PauseState({
    store,
    now: () => clock.now,
    schedule: (run, ms) => {
      const t = { at: clock.now + ms, run, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    log: silent,
  });
  const seen: PauseStatus[] = [];
  state.onChanged((s) => void seen.push(s));
  const advance = (ms: number): void => {
    clock.now += ms;
    for (const t of timers.filter((x) => !x.cancelled && x.at <= clock.now)) {
      t.cancelled = true;
      t.run();
    }
  };
  return { state, clock, seen, advance };
}

describe('PauseState', () => {
  it('starts off, and 1 hour ends by itself', () => {
    const { state, seen, advance, clock } = make(memoryStore());
    expect(state.start()).toEqual({ mode: 'off' });
    expect(state.set('hour')).toEqual({ mode: 'until', until: clock.now + 3_600_000 });
    expect(state.isOn()).toBe(true);
    advance(3_599_000);
    expect(state.isOn()).toBe(true);
    advance(2000);
    expect(state.get()).toEqual({ mode: 'off' });
    expect(seen.map((s) => s.mode)).toEqual(['until', 'off']);
  });

  it('"until I resume" stays on until it is switched off', () => {
    const { state, advance, seen } = make(memoryStore());
    state.start();
    state.set('manual');
    advance(10 * 24 * 3_600_000);
    expect(state.isOn()).toBe(true);
    state.set('off');
    expect(state.isOn()).toBe(false);
    expect(seen.map((s) => s.mode)).toEqual(['manual', 'off']);
  });

  it('"until tomorrow" ends the next morning at 8', () => {
    const { state, clock } = make(memoryStore());
    state.start();
    const s = state.set('tomorrow');
    expect(s.mode).toBe('until');
    const end = new Date((s as { until: number }).until);
    expect(end.getHours()).toBe(8);
    expect(end.getMinutes()).toBe(0);
    expect((s as { until: number }).until).toBeGreaterThan(clock.now);
    expect((s as { until: number }).until - clock.now).toBeLessThanOrEqual(32 * 3_600_000);
  });

  it('survives a restart: the saved state is read back, a timed pause keeps its end time, an expired one is off', () => {
    const store = memoryStore();
    const first = make(store);
    first.state.start();
    first.state.set('hour');
    const second = make(store, first.clock.now + 1000);
    expect(second.state.start().mode).toBe('until');
    expect(second.seen).toEqual([]); // reading the saved state is not a change
    const third = make(store, first.clock.now + 4_000_000);
    expect(third.state.start()).toEqual({ mode: 'off' });
    const manual = memoryStore(JSON.stringify({ mode: 'manual' }));
    expect(make(manual).state.start()).toEqual({ mode: 'manual' });
  });

  it('a timed pause that ran out while the computer slept ends at the next check', () => {
    const { state, clock, seen } = make(memoryStore());
    state.start();
    state.set('hour');
    clock.now += 2 * 3_600_000; // no timer fired (the computer slept)
    state.check();
    expect(state.isOn()).toBe(false);
    expect(seen.map((s) => s.mode)).toEqual(['until', 'off']);
  });

  it('unreadable saved text means off, and setting the same state twice tells listeners once', () => {
    const { state, seen } = make(memoryStore('{not json'));
    expect(state.start()).toEqual({ mode: 'off' });
    state.set('manual');
    state.set('manual');
    expect(seen).toEqual([{ mode: 'manual' }]);
  });

  it('close() stops the timer and the listeners', () => {
    const { state, seen, advance } = make(memoryStore());
    state.start();
    state.set('hour');
    state.close();
    advance(4_000_000);
    expect(seen.map((s) => s.mode)).toEqual(['until']);
  });
});

describe('the settings row', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-pause-'));
    const opened = initDatabase(dir, silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
  });
  afterEach(() => {
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the state in one row of the settings table, which the settings screen does not touch', () => {
    const store = settingsRowPauseStore(db);
    expect(store.read()).toBeNull();
    const state = new PauseState({ store });
    state.start();
    state.set('manual');
    expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(PAUSE_SETTING_KEY) as { value: string }).value).toBe('{"mode":"manual"}');
    const again = new PauseState({ store: settingsRowPauseStore(db) });
    expect(again.start()).toEqual({ mode: 'manual' });
    again.close();
    state.close();
  });
});
