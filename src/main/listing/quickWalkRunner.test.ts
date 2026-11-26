import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import type { FullWalkRequest } from './fullWalker';
import { inlineQuickWalkRunner, WorkerQuickWalkRunner, type QuickWalkRequest } from './quickWalkRunner';
import { toSlashes } from './skipRules';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LAPTOP = '00000000-0000-4000-8000-00000000000a';

let dir: string;
let tree: string;
let db: Db;
let outDir: string;
let workerPath: string;

beforeAll(async () => {
  // The built worker, as Forge builds it (a CommonJS file with better-sqlite3 left as a real require).
  outDir = path.join(process.cwd(), 'node_modules', '.cache', 'quickwalk-worker-test');
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
}, 60_000);
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-qwr-db-'));
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-qwr-tree-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, 'laptop', 'STUDY-PC', 'connected', 1)").run(LAPTOP);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
});

function makeTree(folders: number, filesEach: number): void {
  for (let f = 0; f < folders; f += 1) {
    const folder = path.join(tree, `f${f}`);
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < filesEach; i += 1) fs.writeFileSync(path.join(folder, `file${i}.txt`), 'x');
  }
}
const request = (): QuickWalkRequest => ({ placeId: LAPTOP, root: tree, rel: { kind: 'absolute' }, excludeDirs: [] });
const liveRels = (): string[] =>
  (db.prepare('SELECT rel_path FROM files WHERE place_id = ? AND gone_at IS NULL ORDER BY rel_path').all(LAPTOP) as { rel_path: string }[]).map((r) => r.rel_path);

describe('looking again on a worker thread', () => {
  it('saves the same files as the main-thread walk, while the main connection stays free to write', async () => {
    makeTree(5, 4);
    const runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    expect(runner.usesWorker).toBe(true);
    const run = runner.run(request());
    db.prepare("UPDATE places SET label = 'Laptop' WHERE id = ?").run(LAPTOP);
    const result = await run;
    expect(result).toMatchObject({ added: 20, complete: true, foldersRead: 6 });
    expect(liveRels()).toHaveLength(20);
    expect(liveRels()[0]).toBe(toSlashes(path.join(tree, 'f0', 'file0.txt')));
    // Same answer from the main thread on a fresh copy of the question: nothing new.
    const again = await inlineQuickWalkRunner(db).run(request());
    expect(again).toMatchObject({ added: 0, changed: 0, gone: 0 });
    runner.close();
  });

  it('reports progress and waits for the answer to each tick (that is where a job pauses)', async () => {
    makeTree(450, 1);
    const runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    const ticks: number[] = [];
    await runner.run(request(), {
      tick: async (c) => {
        ticks.push(c.foldersRead);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks).toEqual(ticks.toSorted((a, b) => a - b));
    runner.close();
  });

  it('stops when the signal is aborted, and when the tick hook throws (its error is the one reported)', async () => {
    makeTree(450, 1);
    const runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    const controller = new AbortController();
    await expect(runner.run(request(), { signal: controller.signal, tick: () => controller.abort() })).rejects.toThrow(/stopped/);
    await expect(
      runner.run(request(), {
        tick: () => {
          throw new Error('The job was cancelled');
        },
      }),
    ).rejects.toThrow('The job was cancelled');
    // The worker is still fine afterwards.
    expect(await runner.run(request())).toMatchObject({ complete: true });
    runner.close();
  });

  it('falls back to the main thread when the worker cannot start, and nothing is lost', async () => {
    makeTree(2, 3);
    const warnings: unknown[][] = [];
    const runner = new WorkerQuickWalkRunner({
      dbFile: path.join(dir, DB_FILE_NAME),
      db,
      workerPath: path.join(dir, 'missing.js'),
      log: { warn: (...args: unknown[]) => void warnings.push(args) },
    });
    expect(await runner.run(request())).toMatchObject({ added: 6 });
    expect(runner.usesWorker).toBe(false);
    expect(warnings).toHaveLength(1);
    runner.close();
  });

  it('without a database file there is no worker at all', async () => {
    makeTree(1, 2);
    const runner = new WorkerQuickWalkRunner({ dbFile: null, db, workerPath: null, log: silent });
    expect(runner.usesWorker).toBe(false);
    expect(await runner.run(request())).toMatchObject({ added: 2 });
  });
});

describe('the full listing and the counts on the same worker thread', () => {
  const full = (): FullWalkRequest => ({ placeId: LAPTOP, root: tree, rel: { kind: 'absolute' }, excludeDirs: [], oneDriveRoot: null, cloudRels: null, chunkSize: 7 });

  it('walks and saves a root, marks what was not seen as gone only when finished, and counts', async () => {
    makeTree(3, 5);
    const runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    const ticks: number[] = [];
    const runStart = Date.now() + 1000;
    // A row from an earlier listing that is not on disk any more.
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES (?, ?, 1, 1, 1, 1)').run(LAPTOP, toSlashes(path.join(tree, 'old.txt')));
    const walked = await runner.fullWalk(full(), { tick: (c) => void ticks.push(c.filesSeen) });
    expect(walked).toMatchObject({ complete: true, filesSeen: 15, denied: 0 });
    expect(ticks.length).toBeGreaterThan(1);
    expect(liveRels()).toHaveLength(16);
    // Everything seen has last_seen_at before runStart in this test, so the finish marks all 16 as gone: it never deletes.
    const finished = await runner.finishWalk({ placeId: LAPTOP, scopePrefix: `${toSlashes(tree)}/`, keepPrefixes: [], keepPaths: [], runStart, folderRoot: toSlashes(tree) });
    expect(finished.gone).toBe(16);
    expect(await runner.stats(LAPTOP)).toMatchObject({ files: 0 });
    expect((db.prepare('SELECT count(*) AS n FROM files WHERE place_id = ?').get(LAPTOP) as { n: number }).n).toBe(16);
    expect(await runner.queueTotals(LAPTOP)).toEqual({ files: 0, bytes: 0 });
    expect(await runner.checkpoint('PASSIVE')).toHaveProperty('busy');
    expect(await runner.checkpoint('TRUNCATE')).toHaveProperty('busy');
    runner.close();
  });

  it('emptying the log never waits for a reader (it held every writer for the whole wait: "database is locked")', async () => {
    const reader = new Database(path.join(dir, DB_FILE_NAME), { fileMustExist: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM places').get(); // an old snapshot the emptying would have to wait for
    db.prepare("UPDATE places SET label = 'Laptop' WHERE id = ?").run(LAPTOP);
    const started = Date.now();
    const result = await inlineQuickWalkRunner(db).checkpoint('TRUNCATE');
    expect(result.busy).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000); // the usual wait is 5 s
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000); // the normal wait is back for the next write
    reader.exec('COMMIT');
    reader.close();
    expect((await inlineQuickWalkRunner(db).checkpoint('TRUNCATE')).busy).toBe(false);
  });

  it('a stop between batches stops the walk', async () => {
    makeTree(3, 5);
    const runner = new WorkerQuickWalkRunner({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    await expect(
      runner.fullWalk(full(), {
        tick: () => {
          throw new Error('The job was cancelled');
        },
      }),
    ).rejects.toThrow('The job was cancelled');
    runner.close();
  });
});
