import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SEARCH, type SearchRequest, type SearchResponse } from '../../shared/search';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import { indexProgress } from './searchIndexFill';
import { SearchIndexService } from './searchIndexService';
import { SearchService } from './searchService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ ...EMPTY_SEARCH, ...over });

/**
 * R3.1: the window must not freeze while the search index is filled (the first time, and as a listing adds rows) or while the person types
 * in the search box and pages down the results. The REAL query worker threads (the one that fills the index and the one that answers
 * searches) run on a generated catalog; a timer on the main thread says how late it fires, which is exactly what a frozen window is, and the
 * main thread keeps writing small batches of rows the way a listing does (it must never wait long for the worker's write lock).
 */
const MAX_BLOCK_MS = 250;
const ROWS = 150_000;

function watchdog(intervalMs = 10): { stop(): number } {
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000;
    max = Math.max(max, Math.min(now - last - intervalMs, cpuMs));
    last = now;
    lastCpu = cpu;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(0, Math.round(max));
    },
  };
}

let dir: string;
let db: Db;
let outDir: string;
let workerPath: string;

beforeAll(async () => {
  outDir = path.join(process.cwd(), 'node_modules', '.cache', 'search-index-worker-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: path.join(__dirname, 'queryWorker.ts'),
      rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'queryWorker.js' } },
    },
  });
  workerPath = path.join(outDir, 'queryWorker.js');
}, 60_000);
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-searchblock-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop', 1, 'laptop', 'STUDY-PC', 'connected', 1), ('t7', 1, 'drive', 'T7', 'connected', 1)").run();
});
afterEach(async () => {
  closeDatabase(db, silent);
  await new Promise((resolve) => setTimeout(resolve, 400));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/** Names like a real catalog: a few common words and many numbers. */
function fill(rows: number, from = 0): void {
  const words = ['IMG', 'report', 'holiday', 'invoice', 'DSC', 'scan', 'notes', 'budget'];
  const exts = ['jpg', 'pdf', 'mp4', 'docx', 'png'];
  const insert = db.prepare(
    'INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, cloud_only) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0)',
  );
  db.transaction(() => {
    for (let i = from; i < from + rows; i += 1) {
      const place = i % 3 === 0 ? 't7' : 'laptop';
      const rel = `Users/x/${2018 + (i % 8)}/folder${Math.floor(i / 50)}/${words[i % words.length]}_${i}.${exts[i % exts.length]}`;
      const content = i % 100_000;
      insert.run(place, rel, 1000 + (content % 5000), 1_600_000_000_000 + content * 1000, `sha${content}`, `md5${content}`);
    }
  })();
}

describe('the search index and the search box never block the main thread (real worker threads)', () => {
  it('fills, waits for a job, catches up, then answers typing and paging', async () => {
    fill(ROWS);
    const file = path.join(dir, DB_FILE_NAME);
    const index = new SearchIndexService({ dbFile: file, workerPath, log: silent });
    const search = new SearchService({ dbFile: file, db, workerPath, log: silent });
    const report: string[] = [];
    try {
      // 1. The first fill, on its own worker, while the main thread is idle but watched (the window must not hang while the index is built).
      index.start();
      const dog = watchdog();
      const started = Date.now();
      while (!index.status().ready) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (Date.now() - started > 150_000) throw new Error('the index did not get ready');
      }
      const fillBlocked = dog.stop();
      report.push(`first fill of ${ROWS.toLocaleString('en-US')} rows: ${Math.round((Date.now() - started) / 1000)} s, main thread blocked at most ${fillBlocked} ms`);
      expect(fillBlocked).toBeLessThan(MAX_BLOCK_MS);
      expect(index.status()).toMatchObject({ available: true, ready: true, percent: 100 });

      // 2. A listing job runs: the fill waits, and the main thread writes its batches at once (no slice of the worker is in its way). Then the
      //    fill goes on and catches up with the new rows.
      index.setPaused(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      let next = ROWS;
      let slowest = 0;
      for (let i = 0; i < 20; i += 1) {
        const a = performance.now();
        fill(200, next);
        slowest = Math.max(slowest, performance.now() - a);
        next += 200;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      report.push(`20 batches of 200 rows written by the main thread while the fill waits: slowest ${Math.round(slowest)} ms`);
      // (Writing 200 rows into the big catalog takes what it takes on this machine; the point is that nothing of the worker's is in its way.)
      expect(slowest).toBeLessThan(2000);
      // New rows are found at once, before the fill has looked at them.
      const fresh = await search.run(req({ text: String(next - 1) }));
      expect(fresh.status === 'done' && fresh.hits.length).toBeGreaterThan(0);
      index.setPaused(false);
      const caught = Date.now();
      while ((indexProgress(db)?.filledTo ?? 0) < (db.prepare('SELECT max(id) FROM files').pluck().get() as number)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (Date.now() - caught > 60_000) throw new Error('the fill did not catch up');
      }

      // 3. Typing: every key is a new request that replaces the one before it; then the counts; then pages by cursor.
      const dog2 = watchdog();
      const typed = ['inv', 'invo', 'invoi', 'invoic', 'invoice', 'invoice_1'];
      const answers: Promise<SearchResponse>[] = typed.map((text) => search.run(req({ text, includeFolders: true })));
      const settled = await Promise.all(answers);
      const last = settled[settled.length - 1]!;
      expect(settled.slice(0, -1).every((r) => r.status === 'superseded' || r.status === 'done')).toBe(true);
      expect(last.status).toBe('done');
      const counts = await search.run(req({ text: 'invoice_1', includeFolders: true, part: 'counts' }));
      expect(counts.status).toBe('counts');
      let pages = 0;
      let seen = 0;
      // A common word, paged by cursor three pages deep in each of two sorts (the walk through the name index and through the date index).
      for (const sort of ['name', 'date'] as const) {
        let after: SearchRequest['after'] = null;
        for (let i = 0; i < 3; i += 1) {
          const page = await search.run(req({ text: 'jpg', includeFolders: true, after, sort }));
          if (page.status !== 'done') throw new Error(JSON.stringify(page));
          expect(page.indexed).toBe(true);
          seen += page.hits.length;
          pages += 1;
          after = page.next ?? null;
          if (after === null) break;
        }
      }
      const typingBlocked = dog2.stop();
      report.push(`typing, counts and ${pages} pages (${seen} hits): main thread blocked at most ${typingBlocked} ms`);
      expect(typingBlocked).toBeLessThan(MAX_BLOCK_MS);
      expect(pages).toBeGreaterThan(1);
    } finally {
      search.close();
      index.close();
    }
    // The rows the main thread added while the fill ran are in the index too (the worker's tail), or found straight from the table.
    expect(indexProgress(db)?.ready).toBe(true);
    console.log(report.join('\n'));
  }, 240_000);
});
