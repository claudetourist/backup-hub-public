import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY_TO_LOCAL_JOB_KIND } from '../../shared/localCopy';
import { HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { LIST_PLACE_JOB_KIND } from '../../shared/listing';
import { CountCache } from '../cache/countCache';
import { DataVersion } from '../cache/dataVersion';
import { closeDatabase, initDatabase, type Db } from '../db';
import { COVERAGE_MIN_INTERVAL_MS, QueryService, STATS_MIN_INTERVAL_MS } from './queryService';
import { PROGRESS_BUMP_MS, wireRecountOnJobEnd } from './recountOnJobEnd';
import { ScanGate } from './scanGate';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-faststart-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
  db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', 'D:/x/a.txt', 10, 1, 2)").run();
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts how often each kind of count really ran. */
function counter() {
  const counted = { stats: 0, coverage: 0 };
  const log = {
    info: (...a: unknown[]) => {
      const line = String(a[0]);
      if (line.startsWith('query: stats counted')) counted.stats += 1;
      if (line.startsWith('query: coverage counted')) counted.coverage += 1;
    },
    warn: () => {},
  };
  return { counted, log };
}

function services(now: () => number = Date.now) {
  const { counted, log } = counter();
  const version = new DataVersion(db);
  const cache = new CountCache(db);
  const gate = new ScanGate();
  const query = new QueryService({ dbFile: null, db, workerPath: null, log, schedule: (fn) => fn(), fallbackMinIntervalMs: 0, version, cache, gate, now });
  return { counted, version, cache, query };
}

describe('DataVersion and CountCache', () => {
  it('counts up, remembers the number in the database and tells listeners', () => {
    const v = new DataVersion(db);
    const seen: number[] = [];
    v.onBump((n) => seen.push(n));
    const start = v.current();
    v.bump();
    v.bump();
    expect(v.current()).toBe(start + 2);
    expect(seen).toEqual([start + 1, start + 2]);
    expect(new DataVersion(db).current()).toBe(start + 2);
  });

  it('saves and loads a count, replaces an older one and treats unreadable text as nothing saved', () => {
    const cache = new CountCache(db);
    expect(cache.load('stats')).toBeNull();
    cache.save('stats', { version: 3, at: 100, data: { files: [['a', 1]] } });
    cache.save('stats', { version: 4, at: 200, data: { files: [] } });
    expect(cache.load('stats')).toEqual({ version: 4, at: 200, data: { files: [] } });
    db.prepare("UPDATE count_cache SET json = '{broken' WHERE key = 'stats'").run();
    expect(cache.load('stats')).toBeNull();
  });
});

describe('ScanGate', () => {
  it('runs tasks one at a time in the order they were asked, even when one fails', async () => {
    const gate = new ScanGate();
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const task = (name: string, fail = false) => async () => {
      running += 1;
      most = Math.max(most, running);
      order.push(`start ${name}`);
      await settle(5);
      order.push(`end ${name}`);
      running -= 1;
      if (fail) throw new Error('boom');
      return name;
    };
    const results = await Promise.allSettled([gate.run(task('a')), gate.run(task('b', true)), gate.run(task('c'))]);
    expect(most).toBe(1);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('the last counts are shown at once on the next start', () => {
  it('counts everything once, saves it, and a restart shows it with no new scan when nothing changed', async () => {
    const first = services();
    first.query.requestStats();
    first.query.requestCoverage();
    await settle(120);
    expect(first.counted).toEqual({ stats: 1, coverage: 1 });

    const second = services();
    // At once, before anything is asked: the saved numbers.
    expect(second.query.stats()?.files.get('laptop-1')).toMatchObject({ files: 1, totalBytes: 10 });
    expect(second.query.coverage()).not.toBeNull();
    // Asking again (the Sources poll, the window opening) starts nothing: the data did not change.
    for (let i = 0; i < 50; i += 1) {
      second.query.requestStats();
      second.query.requestCoverage();
    }
    await settle(80);
    expect(second.counted).toEqual({ stats: 0, coverage: 0 });
  });

  it('counts again after the data version moved on, and only after the saved count is old enough', async () => {
    let clock = 1_000_000;
    const first = services(() => clock);
    first.query.requestStats();
    first.query.requestCoverage();
    await settle(120);

    clock += 10 * 60_000;
    const second = services(() => clock);
    second.version.bump();
    second.query.requestStats();
    second.query.requestCoverage();
    await settle(120);
    expect(second.counted).toEqual({ stats: 1, coverage: 1 });
  });

  it('a count that is too young waits for the minimum interval and then runs by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let clock = 1_000_000;
    const s = services(() => clock);
    s.query.requestStats();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.counted.stats).toBe(1);
    s.version.bump();
    clock += 5000;
    s.query.requestStats();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.counted.stats).toBe(1);
    clock += STATS_MIN_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS + 100);
    expect(s.counted.stats).toBe(2);
  });

  it('a forced recount does nothing when the data did not change, and counts at once when it did', async () => {
    const s = services();
    s.query.requestStats();
    await settle(80);
    const before = { ...s.counted };
    s.query.requestStats({ force: true });
    await settle(60);
    expect(s.counted).toEqual(before);
    s.version.bump();
    s.query.requestStats({ force: true });
    await settle(80);
    expect(s.counted.stats).toBe(before.stats + 1);
  });


  it('the coverage minimum interval is longer than the stats one (the counts that cost more are spaced further apart)', () => {
    expect(COVERAGE_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(STATS_MIN_INTERVAL_MS);
  });
});

describe('one heavy count at a time', () => {

  it('stats and coverage both go through the gate, so never more than one runs at a time', async () => {
    const gate = new ScanGate();
    let running = 0;
    let most = 0;
    const log = { info: () => {}, warn: () => {} };
    const query = new QueryService({ dbFile: null, db, workerPath: null, log, schedule: (fn) => fn(), fallbackMinIntervalMs: 0, gate });
    const original = gate.run.bind(gate);
    gate.run = <T>(task: () => Promise<T>): Promise<T> =>
      original(async () => {
        running += 1;
        most = Math.max(most, running);
        try {
          return await task();
        } finally {
          running -= 1;
        }
      });
    query.requestStats();
    query.requestCoverage();
    await settle(150);
    expect(most).toBe(1);
  });
});

describe('what moves the data version', () => {
  const job = (kind: string, state: JobRecord['state'] = 'done'): JobRecord => ({ id: 1, kind, title: kind, state, paused: false, message: null, speed: null, finishedAt: 5 }) as unknown as JobRecord;

  function wired(now: () => number = Date.now) {
    const bus = new EventEmitter();
    const jobs = { onChanged: (l: (e: JobChangedEvent) => void) => (bus.on('e', l), () => bus.off('e', l)) };
    const version = new DataVersion(db);
    const calls: string[] = [];
    const query = { requestStats: () => calls.push('stats'), requestCoverage: () => calls.push('coverage') };
    wireRecountOnJobEnd(jobs, query, version, now);
    const emit = (kind: string, reason: JobChangedEvent['reason'] = 'state', state: JobRecord['state'] = 'done'): void => void bus.emit('e', { reason, job: job(kind, state) } satisfies JobChangedEvent);
    return { version, calls, emit };
  }

  it.each([HASH_FILES_JOB_KIND, COPY_TO_LOCAL_JOB_KIND])('a finished %s job bumps it', (kind) => {
    const { version, emit } = wired();
    const before = version.current();
    emit(kind);
    expect(version.current()).toBe(before + 1);
  });

  it('a finished listing does not bump it by itself (the listing says when it changed something)', () => {
    const { version, emit } = wired();
    const before = version.current();
    emit(LIST_PLACE_JOB_KIND);
    expect(version.current()).toBe(before);
  });

  it('unfinished jobs and jobs that change no numbers bump nothing', () => {
    const { version, emit } = wired();
    const before = version.current();
    emit(HASH_FILES_JOB_KIND, 'state', 'running');
    emit('db.snapshot');
    emit('settings.saveToDrive');
    expect(version.current()).toBe(before);
  });

  it('a checksum job that keeps running moves it now and then, not on every progress report', () => {
    let clock = 10_000;
    const { version, emit } = wired(() => clock);
    const before = version.current();
    for (let i = 0; i < 50; i += 1) emit(HASH_FILES_JOB_KIND, 'progress', 'running');
    expect(version.current()).toBe(before + 1);
    clock += PROGRESS_BUMP_MS;
    emit(HASH_FILES_JOB_KIND, 'progress', 'running');
    expect(version.current()).toBe(before + 2);
  });
});
