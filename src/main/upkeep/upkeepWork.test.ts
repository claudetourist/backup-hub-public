import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf } from '../../shared/fileKinds';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import { EVENT_RETENTION_DAYS } from '../jobs/jobStore';
import { CHUNK_LIMIT, OPTIMIZED_AT_KEY, OPTIMIZE_EVERY_MS, optimizeDue, optimizeIfDue, runUpkeep, sortChunk, trimEventsChunk, trimJobsChunk, type UpkeepOptions } from './upkeepWork';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-upkeep-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function addFiles(count: number): void {
  const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', ?, 1, 1, 2)");
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(`D:/Phone/DCIM/Camera/IMG_${i}.jpg`);
  })();
}
function addJob(state: string, finishedDaysAgo: number | null, kind = 'test.job'): number {
  const finished = finishedDaysAgo === null ? null : NOW - finishedDaysAgo * DAY;
  return Number(db.prepare("INSERT INTO jobs (kind, title, state, created_at, finished_at) VALUES (?, 'J', ?, 1, ?)").run(kind, state, finished).lastInsertRowid);
}
function addEvent(jobId: number, daysAgo: number): void {
  db.prepare("INSERT INTO job_events (job_id, at, level, text) VALUES (?, ?, 'info', 'x')").run(jobId, NOW - daysAgo * DAY);
}
const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const options = (over: Partial<UpkeepOptions> = {}): UpkeepOptions => ({ db, now: () => NOW, shouldStop: () => false, pause: () => Promise.resolve(), log: silent, busyWaitMs: 1, ...over });

describe('upkeep chunks', () => {
  it('sorts old rows with no kind in chunks of at most 2,000, continuing after the last id', () => {
    addFiles(5);
    expect(CHUNK_LIMIT).toBe(2000);
    expect(sortChunk(db, 0, 3)).toMatchObject({ sorted: 3 });
    const rest = sortChunk(db, 3, 1_000_000); // a bigger ask is cut to the chunk limit
    expect(rest.sorted).toBe(2);
    expect((db.prepare('SELECT kind FROM files').all() as { kind: string }[]).every((r) => r.kind === kindOf('D:/Phone/DCIM/Camera/IMG_0.jpg', 'IMG_0.jpg', null, 1))).toBe(true);
  });

  it('trims job log lines older than 90 days, a limited number at a time', () => {
    const job = addJob('done', 1);
    for (let i = 0; i < 5; i += 1) addEvent(job, EVENT_RETENTION_DAYS + 1 + i);
    addEvent(job, 10);
    expect(trimEventsChunk(db, NOW, 2)).toBe(2);
    expect(trimEventsChunk(db, NOW, 2)).toBe(2);
    expect(trimEventsChunk(db, NOW, 2)).toBe(1);
    expect(trimEventsChunk(db, NOW, 2)).toBe(0);
    expect(count('job_events')).toBe(1);
  });

  it('trims finished jobs older than 90 days with their log lines, and nothing else', () => {
    const old = addJob('done', EVENT_RETENTION_DAYS + 5);
    addEvent(old, 3);
    const oldWarn = addJob('done_warnings', EVENT_RETENTION_DAYS + 1);
    const oldFailed = addJob('failed', EVENT_RETENTION_DAYS + 200);
    const recent = addJob('done', 10);
    const recentFailed = addJob('failed', EVENT_RETENTION_DAYS - 1);
    const failedToday = addJob('failed', 0);
    const queued = addJob('queued', null);
    const running = addJob('running', null);
    const asking = addJob('needs_you', null);
    expect(trimJobsChunk(db, NOW, 2)).toBe(2);
    expect(trimJobsChunk(db, NOW, 10)).toBe(1);
    expect(trimJobsChunk(db, NOW, 10)).toBe(0);
    const left = (db.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(left).toEqual([recent, recentFailed, failedToday, queued, running, asking]);
    expect(left).not.toContain(old);
    expect(left).not.toContain(oldWarn);
    expect(left).not.toContain(oldFailed);
    expect(count('job_events')).toBe(0); // the log lines of a removed job went with it
  });

  it('PRAGMA optimize runs once a day, and the time is remembered in meta', () => {
    expect(optimizeDue(db, NOW)).toBe(true);
    expect(optimizeIfDue(db, NOW)).toBe(true);
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get(OPTIMIZED_AT_KEY) as { value: string }).value).toBe(String(NOW));
    expect(optimizeIfDue(db, NOW + OPTIMIZE_EVERY_MS - 1)).toBe(false);
    expect(optimizeIfDue(db, NOW + OPTIMIZE_EVERY_MS)).toBe(true);
    // A saved time in the future (the clock was set back) does not block it for ever.
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(NOW + 10 * DAY), OPTIMIZED_AT_KEY);
    expect(optimizeDue(db, NOW)).toBe(true);
  });
});

describe('runUpkeep', () => {
  it('does all the work in small chunks and says nothing is left', async () => {
    addFiles(7);
    const job = addJob('done', EVENT_RETENTION_DAYS + 9);
    addEvent(job, EVENT_RETENTION_DAYS + 9);
    addJob('done', 1);
    const pauses: number[] = [];
    const summary = await runUpkeep(options({ chunkRows: 3, pause: (ms) => (pauses.push(ms), Promise.resolve()) }));
    expect(summary).toMatchObject({ stopped: false, busy: false, sorted: 7, eventsTrimmed: 1, jobsTrimmed: 1, optimized: true, nothingLeft: true });
    expect(count('jobs')).toBe(1);
    expect((db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n).toBe(0);
    expect(pauses.length).toBeGreaterThanOrEqual(3); // it hands the processor back between chunks
    // A second pass has nothing to do.
    expect(await runUpkeep(options({ chunkRows: 3 }))).toMatchObject({ sorted: 0, eventsTrimmed: 0, jobsTrimmed: 0, optimized: false, nothingLeft: true });
  });

  it('stops between chunks when told to: what was sorted stays sorted, the rest waits for the next run', async () => {
    addFiles(10);
    let chunks = 0;
    const summary = await runUpkeep(options({ chunkRows: 4, shouldStop: () => chunks >= 2, pause: () => ((chunks += 1), Promise.resolve()) }));
    expect(summary).toMatchObject({ stopped: true, nothingLeft: false });
    expect(summary.sorted).toBe(8);
    expect((db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n).toBe(2);
    // The next run carries on with exactly those.
    expect(await runUpkeep(options({ chunkRows: 4 }))).toMatchObject({ stopped: false, sorted: 2 });
  });

  it('stopped before the first chunk it writes nothing at all', async () => {
    addFiles(3);
    const summary = await runUpkeep(options({ shouldStop: () => true }));
    expect(summary).toMatchObject({ stopped: true, sorted: 0, optimized: false });
    expect((db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n).toBe(3);
  });

  it('a data file that stays busy ends the run quietly (it is tried again later)', async () => {
    addFiles(3);
    // Another connection holds the write lock, and this connection does not wait for it.
    const holder = new Database(path.join(dir, DB_FILE_NAME));
    holder.exec('BEGIN IMMEDIATE');
    db.pragma('busy_timeout = 1');
    try {
      const summary = await runUpkeep(options());
      expect(summary).toMatchObject({ busy: true, stopped: false, nothingLeft: false });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('any other error is passed on (the process reports it to the log)', async () => {
    db.exec('DROP TABLE kind_overrides');
    addFiles(1);
    await expect(runUpkeep(options())).rejects.toThrow();
  });
});
