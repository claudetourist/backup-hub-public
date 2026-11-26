import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openReadOnly } from '../../src/main/query/queryCore';
import { searchQuery } from '../../src/main/query/searchQuery';
import { EMPTY_SEARCH, type SearchRequest } from '../../src/shared/search';
import { BENCH_ROOT, ensureGeneratedDb, GENERATED_DB } from './genDb';

/**
 * Budget: the first page of a search answers in under 150 ms, any filter or sort, on 2,000,000 rows. Runs the same SQL the query
 * worker runs (searchQuery on a read-only connection), straight in Node. Each scenario runs 3 times; the worst counts. A scenario whose
 * run is already far over the budget is not repeated (the verdict is settled, and a slow search takes many seconds).
 * Started by scripts/bench.mjs with BACKUPHUB_BENCH_SEARCH_OUT naming where the numbers go.
 */
const RUNS = 3;
const NOT_WORTH_REPEATING_MS = 750;

const scenarios: [string, Partial<SearchRequest>][] = [
  ['word "holiday", by name', { text: 'holiday' }],
  ['word "holiday", newest first', { text: 'holiday', sort: 'date' }],
  ['word "invoice", biggest first', { text: 'invoice', sort: 'size' }],
  ['rare word "zebra"', { text: 'zebra' }],
  ['word "report" in the T7 only', { text: 'report', placeIds: ['drive-t7'] }],
  ['photos, newest first', { category: 'photos', sort: 'date' }],
  ['camera photos, by name', { kind: 'photo-camera', sort: 'name' }],
  ['everything, biggest first', { sort: 'size' }],
  ['word "photo", few copies', { text: 'photo', fewCopies: true, sort: 'name' }],
  ['pdf files from 2015, newest first', { extensions: ['pdf'], folder: '2015', sort: 'date' }],
  ['not fingerprinted yet, by name', { unfingerprinted: true, sort: 'name' }],
  ['word "budget", fewest copies first', { text: 'budget', sort: 'copies' }],
];

describe('bench: search on the generated 2,000,000-row database', () => {
  it('measures the first page of every scenario', async () => {
    const outFile = process.env['BACKUPHUB_BENCH_SEARCH_OUT'] ?? '';
    expect(path.resolve(outFile).startsWith(BENCH_ROOT + path.sep)).toBe(true);
    const info = ensureGeneratedDb((line) => console.log(line));
    fs.rmSync(`${outFile}.progress`, { force: true });
    const db = openReadOnly(GENERATED_DB);
    const results: { name: string; runsMs: number[]; worstMs: number; hits: number; total: number; status: string }[] = [];
    try {
      for (const [name, change] of scenarios) {
        const request: SearchRequest = { ...EMPTY_SEARCH, ...change };
        const runsMs: number[] = [];
        let status = 'done';
        let hits = 0;
        let total: number | null = 0;
        for (let run = 0; run < RUNS; run += 1) {
          const started = performance.now();
          const response = searchQuery(db, request);
          runsMs.push(Math.round((performance.now() - started) * 10) / 10);
          status = response.status;
          if (response.status === 'done') {
            hits = response.hits.length;
            total = response.total;
          }
          if (runsMs[run]! > NOT_WORTH_REPEATING_MS) break;
        }
        results.push({ name, runsMs, worstMs: Math.max(...runsMs), hits, total, status });
        fs.appendFileSync(`${outFile}.progress`, `${name}: ${runsMs.join(', ')} ms, ${total} found\n`);
        // A slow search blocks this thread for many seconds; let vitest's own messages through in between.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      db.close();
    }
    fs.writeFileSync(outFile, JSON.stringify({ info, rows: info.rows, results }, null, 2));
    expect(results.length).toBe(scenarios.length);
  });
});
