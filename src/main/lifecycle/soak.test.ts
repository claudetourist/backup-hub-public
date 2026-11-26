import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import { JobService } from '../jobs/jobService';
import { answerSearch } from '../query/answerSearch';
import { openReadOnly } from '../query/queryCore';
import { runUpkeep } from '../upkeep/upkeepWork';
import { EMPTY_SEARCH, type SearchRequest } from '../../shared/search';

/**
 * [slow] Soak test (plan R0.6): 200 rounds of upkeep work, searches and a fake job on a generated catalog, sampling the heap and the
 * process size after a garbage collection. Fails when they grow more than 10% from round 20 to round 200.
 * Skipped unless BACKUPHUB_SOAK=1:   BACKUPHUB_SOAK=1 npx vitest run src/main/lifecycle/soak.test.ts
 * Optional: BACKUPHUB_SOAK_ROWS=200000 (default), BACKUPHUB_SOAK_DB=<a database file to COPY and use instead of generating rows; it is only read).
 */
const ENABLED = process.env['BACKUPHUB_SOAK'] === '1';
const ROUNDS = 200;
const BASELINE_ROUND = 20;
const MAX_GROWTH = 0.1;
/** The comparison uses the mean of this many consecutive rounds at each end, so one noisy sample does not decide. */
const WINDOW = 5;
const ROWS = Number(process.env['BACKUPHUB_SOAK_ROWS'] ?? 200_000);

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A way to run the garbage collector without starting node with --expose-gc. */
function collector(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

const searches: Partial<SearchRequest>[] = [
  { text: 'f1' },
  { text: 'd12', sort: 'date' },
  { sort: 'size' },
  { unfingerprinted: true, sort: 'name' },
  { fewCopies: true, sort: 'name' },
];

describe.skipIf(!ENABLED)('[slow] soak: 200 rounds of upkeep, search and a fake job', () => {
  let dir: string;
  let db: Db;
  let readOnly: Db;
  let jobs: JobService;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-soak-'));
    const source = process.env['BACKUPHUB_SOAK_DB'];
    if (source) {
      fs.copyFileSync(source, path.join(dir, DB_FILE_NAME));
      const opened = initDatabase(dir, silent);
      if (!opened.ok) throw new Error('the copied database did not open');
      db = opened.db;
    } else {
      const opened = initDatabase(dir, silent);
      if (!opened.ok) throw new Error('the generated database did not open');
      db = opened.db;
      const addPlace = db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at, last_looked_at) VALUES (?, 1, ?, ?, 'connected', 1, 1700000000000)");
      addPlace.run('laptop-1', 'laptop', 'This laptop');
      addPlace.run('drive-t7', 'drive', 'T7');
      insertFakeRows(db, 'laptop-1', 'Users/a/Documents', Math.floor(ROWS / 2), { fingerprinted: true });
      insertFakeRows(db, 'drive-t7', 'Backups', Math.ceil(ROWS / 2), { fingerprinted: true });
    }
    readOnly = openReadOnly(path.join(dir, DB_FILE_NAME));
    jobs = new JobService({ db, log: silent });
    jobs.register({
      kind: 'soak.job',
      heavy: false,
      resumable: true,
      async run(ctx) {
        for (let step = 1; step <= 5; step += 1) {
          ctx.progress(step, 5, { message: `Step ${step} of 5` });
          ctx.checkpoint({ step });
          ctx.log('info', `step ${step}`);
          await ctx.yield();
        }
        return 'done';
      },
    });
    jobs.start();
  }, 300_000);
  afterAll(() => {
    jobs?.shutdown();
    readOnly?.close();
    if (db) closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('heap and process size do not grow more than 10% from round 20 to round 200', async () => {
    const gc = collector();
    // The one-off backlog first (sorting every row that has no kind), so the rounds measure steady work.
    const backlog = await runUpkeep({ db, now: Date.now, shouldStop: () => false, pause: () => Promise.resolve(), log: silent });
    expect(backlog.busy).toBe(false);

    const heap: number[] = [];
    const rss: number[] = [];
    let lastRows = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      // Upkeep chunk work: fresh rows with no kind appear (a listing wrote them) and are sorted; old job history is trimmed.
      const before = Number((db.prepare('SELECT MAX(id) AS m FROM files').get() as { m: number }).m);
      insertFakeRows(db, 'laptop-1', `soak/r${round}`, 500, { fingerprinted: true });
      const summary = await runUpkeep({ db, now: Date.now, shouldStop: () => false, pause: () => Promise.resolve(), log: silent });
      expect(summary.busy).toBe(false);
      lastRows = summary.sorted;
      // The same 500 rows go away again (a drive check removes them), so the catalog stays the same size round after round.
      db.prepare('DELETE FROM files WHERE id > ?').run(before);

      // Searches, as the search worker answers them (own read-only connection).
      for (const change of searches) {
        const response = answerSearch(readOnly, { ...EMPTY_SEARCH, ...change });
        expect(response.status).not.toBe('failed');
      }

      // A fake job through the real job service.
      const id = jobs.create('soak.job', `Soak job ${round}`);
      for (let i = 0; i < 500 && jobs.get(id)?.state !== 'done'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(jobs.get(id)?.state).toBe('done');
      // Old finished jobs are trimmed the way the upkeep process trims them (the soak job rows are new, so make them old).
      if (round % 10 === 0) {
        db.prepare("DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE kind = 'soak.job')").run();
        db.prepare("DELETE FROM jobs WHERE kind = 'soak.job'").run();
      }

      gc();
      gc();
      const usage = process.memoryUsage();
      heap.push(usage.heapUsed);
      rss.push(usage.rss);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(lastRows).toBeGreaterThan(0);

    const mean = (values: number[], endRound: number): number => values.slice(endRound - WINDOW, endRound).reduce((a, b) => a + b, 0) / WINDOW;
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    const heapStart = mean(heap, BASELINE_ROUND);
    const heapEnd = mean(heap, ROUNDS);
    const rssStart = mean(rss, BASELINE_ROUND);
    const rssEnd = mean(rss, ROUNDS);
    const heapGrowth = (heapEnd - heapStart) / heapStart;
    const rssGrowth = (rssEnd - rssStart) / rssStart;
    const report = `soak: rows ${(db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n}; heapUsed round ${BASELINE_ROUND}: ${mb(heap[BASELINE_ROUND - 1]!)} MB, round ${ROUNDS}: ${mb(heap[ROUNDS - 1]!)} MB (mean of ${WINDOW}: ${mb(heapStart)} -> ${mb(heapEnd)} MB, ${(heapGrowth * 100).toFixed(1)}%); rss round ${BASELINE_ROUND}: ${mb(rss[BASELINE_ROUND - 1]!)} MB, round ${ROUNDS}: ${mb(rss[ROUNDS - 1]!)} MB (mean of ${WINDOW}: ${mb(rssStart)} -> ${mb(rssEnd)} MB, ${(rssGrowth * 100).toFixed(1)}%)`;
    console.log(report);
    const out = process.env['BACKUPHUB_SOAK_OUT'];
    if (out) fs.writeFileSync(out, JSON.stringify({ report, heap, rss }, null, 2));
    expect(heapGrowth, report).toBeLessThanOrEqual(MAX_GROWTH);
    expect(rssGrowth, report).toBeLessThanOrEqual(MAX_GROWTH);
  }, 600_000);
});
