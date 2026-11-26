import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { closeDatabase, initDatabase, type Db } from '../db';
import { turn } from '../sliceWork';
import { onlyHereInWorker, wouldLoseFilesInWorker, wouldLoseInWorker } from '../query/queryService';
import { InsightsService } from './insightsService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The window must not freeze while "What would I lose?" is worked out (CLAUDE.md: every new IPC call gets a main-thread block test,
 * limit 250 ms). A generated catalog of 1.2 million rows (the real one has about 1.1 million): the laptop 600,000, the T7 400,000 that are
 * the laptop's first 400,000 (same checksums), a phone 100,000 without fingerprints and OneDrive 100,000 with other names. The REAL
 * query worker answers; a timer on the main thread says how late it fires, which is what a frozen window is. The real numbers are printed.
 */
const MAX_BLOCK_MS = 250;

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
  outDir = path.join(process.cwd(), 'node_modules', '.cache', 'would-lose-worker-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: path.join(__dirname, '..', 'query', 'queryWorker.ts'),
      rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'queryWorker.js' } },
    },
  });
  workerPath = path.join(outDir, 'queryWorker.js');
}, 60_000);
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-loseblock-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare(
    "INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop', 1, 'laptop', 'STUDY-PC', 'connected', 1), ('t7', 1, 'drive', 'T7', 'connected', 1), ('phone', 1, 'phone', 'Poco', 'connected', 1), ('od', 1, 'onedrive', 'OneDrive', 'connected', 1), ('sea', 1, 'drive', 'Seagate2TB', 'connected', 1)",
  ).run();
});
afterEach(async () => {
  closeDatabase(db, silent);
  await new Promise((resolve) => setTimeout(resolve, 400));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('What would I lose? never blocks the main thread (real worker thread, 1.2 million rows)', () => {
  it('counts the summary and one device\'s lists, and the service answers without waiting', async () => {
    // In slices of 50,000 with a turn of the event loop between them: one long synchronous fill starves the test runner's own messages.
    const fill = async (place: string, prefix: string, count: number, options: { fingerprinted: boolean; perFolder?: number }): Promise<void> => {
      for (let start = 0; start < count; start += 50_000) {
        insertFakeRows(db, place, prefix, Math.min(50_000, count - start), { ...options, start });
        await turn();
      }
    };
    await fill('laptop', 'L', 600_000, { fingerprinted: true });
    await fill('t7', 'T', 400_000, { fingerprinted: true });
    await fill('phone', 'P', 100_000, { fingerprinted: false });
    await fill('od', 'O', 100_000, { fingerprinted: false, perFolder: 1001 });
    await fill('sea', 'S', 20_000, { fingerprinted: false });
    const file = path.join(dir, 'backuphub.db');
    const service = new InsightsService({
      db,
      places: () => [],
      runScript: () => Promise.reject(new Error('not used')),
      loseInWorker: (placeId) => wouldLoseInWorker(workerPath, file, placeId),
      loseFilesInWorker: (request) => wouldLoseFilesInWorker(workerPath, file, request),
      onlyHereInWorker: () => onlyHereInWorker(workerPath, file),
      dataVersion: { current: () => 1 },
      log: { warn: () => {} },
    });
    const report: string[] = [];
    const dog = watchdog();
    const t0 = Date.now();
    const summary = await service.onlyHere();
    report.push(`summary of 1.2 million rows: ${Date.now() - t0} ms`);
    const t1 = Date.now();
    const again = await service.onlyHere();
    report.push(`same summary again (kept, the data has not changed): ${Date.now() - t1} ms`);
    const t2 = Date.now();
    const laptop = await service.wouldLose('laptop');
    const od = await service.wouldLose('od');
    report.push(`two devices' lists: ${Date.now() - t2} ms`);
    const t3 = Date.now();
    const page = await service.wouldLoseFiles({ placeId: 'od', part: 'onlyHere', search: '', offset: 0, kind: null });
    const searched = await service.wouldLoseFiles({ placeId: 'od', part: 'onlyHere', search: 'd12 f5', offset: 0, kind: null });
    report.push(`a page of files and a searched page: ${Date.now() - t3} ms`);
    const blocked = dog.stop();
    report.push(`main thread blocked at most ${blocked} ms`);
    console.log(report.join('\n'));
    expect(blocked).toBeLessThan(MAX_BLOCK_MS);
    expect(summary.ok && again.ok && laptop.ok && od.ok && page.ok && searched.ok).toBe(true);
    if (!summary.ok || !laptop.ok || !od.ok) return;
    const of = (id: string) => summary.places.find((p) => p.placeId === id);
    // The laptop's first 400,000 are on the T7 with the same checksum; its last 200,000 have the names and sizes of other devices' files.
    expect(laptop.detail.onlyHere.files).toBe(0);
    expect(laptop.detail.maybeCopied.files).toBe(200_000);
    // The summary is for the named drives: every file of the T7 has a checked copy on the laptop; the Seagate's 20,000 have no fingerprint.
    expect(summary.places.map((p) => p.placeId)).toEqual(['sea']);
    expect(of('sea')!.files).toBe(20_000);
    expect(od.detail.onlyHere.files).toBeGreaterThan(80_000);
    expect(od.detail.notChecked.files).toBe(100_000);
    if (!page.ok || !searched.ok) return;
    expect(page.page.files).toHaveLength(100);
    expect(page.page.more).toBe(true);
    expect(searched.page.files.every((f) => f.path.includes('d12') && f.path.includes('f5'))).toBe(true);
  }, 900_000);
});
