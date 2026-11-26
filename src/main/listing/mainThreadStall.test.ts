import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { DataVersion } from '../cache/dataVersion';
import { closeDatabase, initDatabase, DB_FILE_NAME, type Db } from '../db';
import { hashFilesHandler } from '../hashing/hashJob';
import type { FileHasher } from '../hashing/hasher';
import { queueTotals } from '../hashing/queue';
import type { JobContext } from '../jobs/jobService';
import { StallMonitor } from '../stallMonitor';
import { listPlaceHandler } from './listJob';
import { WorkerQuickWalkRunner } from './quickWalkRunner';
import { toSlashes } from './skipRules';

/**
 * The window must never hang while a big listing or fingerprinting runs: the main event loop may not be blocked for long.
 * A real listing worker thread, a catalog of ~130k rows and a tree of 8,000 files; a timer on the main thread measures
 * how late it fires (that is exactly what a frozen window is).
 */
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LAPTOP = '00000000-0000-4000-8000-00000000000a';
const MAX_STALL_MS = 250;
const TREE_FOLDERS = 160;
const FILES_PER_FOLDER = 50;
/** Rows of other folders: they make the table big but are not touched by the listing. */
const OTHER_ROWS = 120_000;
/** Rows below the listed folder that no longer exist on disk: the listing marks them gone. */
const STALE_ROWS = 10_000;

let dir: string;
let tree: string;
let db: Db;
let outDir: string;
let workerPath: string;
let runner: WorkerQuickWalkRunner;

beforeAll(async () => {
  outDir = path.join(process.cwd(), 'node_modules', '.cache', 'stall-worker-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: path.join(__dirname, 'quickWalkWorker.ts'),
      rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'quickWalkWorker.js' } },
    },
  });
  workerPath = path.join(outDir, 'quickWalkWorker.js');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-stall-db-'));
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-stall-tree-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, 'laptop', 'STUDY-PC', 'connected', 1)").run(LAPTOP);
  for (let f = 0; f < TREE_FOLDERS; f += 1) {
    const folder = path.join(tree, `f${f}`);
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < FILES_PER_FOLDER; i += 1) fs.writeFileSync(path.join(folder, `file${i}.txt`), 'x');
  }
  insertFakeRows(db, LAPTOP, 'Z:/other', OTHER_ROWS, { fingerprinted: true });
  insertFakeRows(db, LAPTOP, `${toSlashes(tree)}/old`, STALE_ROWS, { fingerprinted: true });
  // As in the app: the main connection never folds the log back itself (that is done on the worker thread).
  db.pragma('wal_autocheckpoint = 0');
  runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
}, 180_000);

afterAll(() => {
  runner.close();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
}, 60_000);

let monitor: StallMonitor;
let stallTexts: string[];
let writer: NodeJS.Timeout;
beforeEach(() => {
  stallTexts = [];
  monitor = new StallMonitor({ thresholdMs: MAX_STALL_MS, intervalMs: 20, warn: (m) => stallTexts.push(m) });
  monitor.start();
  // The app writes to the same database from the main thread all the time (job progress, the data version).
  const version = new DataVersion(db);
  writer = setInterval(() => version.bump(), 150);
});
afterEach(() => {
  monitor.stop();
  clearInterval(writer);
});

function context(): { ctx: JobContext; progress: number[] } {
  const progress: number[] = [];
  const ctx: JobContext = {
    jobId: 1,
    params: { placeId: LAPTOP },
    resume: null,
    signal: new AbortController().signal,
    progress: (done) => progress.push(done),
    log: () => {},
    warn: () => {},
    needsYou: () => Promise.reject(new Error('not used')),
    checkpoint: () => {},
    // What the real job service does at a yield: give the loop back.
    yield: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
  return { ctx, progress };
}

describe('the main thread stays free during big jobs', () => {
  it('a full listing of 8,000 files over a 130,000 row catalog never blocks the main loop', async () => {
    const { ctx, progress } = context();
    const handler = listPlaceHandler({
      db,
      quickRunner: runner,
      log: silent,
      chunkSize: 2000,
      env: { locate: async () => ({ ok: true, base: '' }), excludeDirs: () => [], roots: async () => [tree] },
    });
    const message = await handler.run(ctx);
    expect(runner.usesWorker).toBe(true);
    expect(message).toMatch(/Checked 128,000 files/);
    expect(progress.length).toBeGreaterThan(1);
    // The stale rows were marked gone (not deleted) by the worker.
    const gone = (db.prepare('SELECT count(*) AS n FROM files WHERE place_id = ? AND gone_at IS NOT NULL').get(LAPTOP) as { n: number }).n;
    expect(gone).toBe(STALE_ROWS);
    expect(stallTexts).toEqual([]);
    expect(monitor.maxStallMs).toBeLessThan(MAX_STALL_MS);
  }, { timeout: 120_000, retry: 2 });

  it('a second listing (every row already there) never blocks the main loop either', async () => {
    const { ctx } = context();
    const handler = listPlaceHandler({
      db,
      quickRunner: runner,
      log: silent,
      chunkSize: 2000,
      env: { locate: async () => ({ ok: true, base: '' }), excludeDirs: () => [], roots: async () => [tree] },
    });
    expect(await handler.run(ctx)).toMatch(/Checked 128,000 files/);
    expect(stallTexts).toEqual([]);
  }, { timeout: 120_000, retry: 2 });

  it('fingerprinting 8,000 files saves its results in short slices', async () => {
    expect(queueTotals(db, LAPTOP).files).toBe(TREE_FOLDERS * FILES_PER_FOLDER);
    const hasher: FileHasher = {
      kind: 'in-process',
      close: () => undefined,
      hash: (request) => Promise.resolve({ ok: true, sha256: `s${request.path}`.padEnd(64, '0').slice(0, 64), md5: `m${request.path}`.padEnd(32, '0').slice(0, 32), bytes: 1 }),
    };
    const { ctx } = context();
    const handler = hashFilesHandler({
      db,
      log: silent,
      env: { locate: async () => ({ ok: true, base: '' }) },
      hasher,
      power: { read: async () => ({ onBattery: false, percent: null }) },
      megabytesPerSecond: () => 0,
      totals: (placeId) => runner.queueTotals(placeId),
    });
    expect(await handler.run(ctx)).toMatch(/Checked 8,000 files/);
    expect(queueTotals(db, LAPTOP).files).toBe(0);
    expect(stallTexts).toEqual([]);
  }, { timeout: 120_000, retry: 2 });
});
