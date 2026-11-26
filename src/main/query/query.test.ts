import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlaceCoverage } from '../../shared/fingerprint';
import { allFingerprintCounts, computeAllCoverage, placeCoverage } from '../copies/copiesIndex';
import { allFileStats } from '../listing/fileStore';
import { closeDatabase, DB_FILE_NAME, initDatabase, initDatabaseAsync, openDatabase, type Db, type IntegrityResult } from '../db';
import { createFileHasher } from '../hashing/hasher';
import { openReadOnly, statsQuery } from './queryCore';
import { COVERAGE_MIN_INTERVAL_MS, QueryService, quickCheckInWorker, STATS_MIN_INTERVAL_MS } from './queryService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const PLACES = [
  ['laptop-1', 'laptop'],
  ['drive-t7', 'drive'],
  ['onedrive-1', 'onedrive'],
  ['gdrive-1', 'gdrive'],
  ['gdrive-2', 'gdrive'],
] as const;

let dir: string;
let db: Db;

function seedPlaces(target: Db): void {
  for (const [id, kind] of PLACES) {
    target.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, id);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-query-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  seedPlaces(db);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const zero = (): PlaceCoverage => ({
  none: { files: 0, bytes: 0 },
  one: { files: 0, bytes: 0 },
  twoPlus: { files: 0, bytes: 0 },
  notFingerprinted: { files: 0, bytes: 0 },
  cloudOnly: { files: 0, bytes: 0 },
  empty: { files: 0, bytes: 0 },
});

/** A small deterministic random generator (mulberry32), so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeAllCoverage equals placeCoverage', () => {
  it('on 60 randomized catalogs (duplicates, gone rows, md5 collisions, null sizes, cloud-only, unfingerprinted)', () => {
    const insert = db.prepare(
      `INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, gone_at, cloud_only)
       VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?)`,
    );
    for (let seed = 1; seed <= 60; seed += 1) {
      db.prepare('DELETE FROM files').run();
      const next = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const rows = 40 + Math.floor(next() * 160);
      db.transaction(() => {
        for (let i = 0; i < rows; i += 1) {
          const [place, kind] = pick(PLACES);
          // Few contents, so many places share them. Content c has size 10 + c and md5 m<c>.
          const c = Math.floor(next() * 14);
          const roll = next();
          let sha: string | null = null;
          let md5: string | null = null;
          let size: number | null = 10 + c;
          if (kind === 'gdrive') {
            // Drive rows: md5 + size, never a sha256; some without size, some without md5.
            md5 = roll < 0.9 ? `m${c}` : null;
            if (roll > 0.8 && roll < 0.9) size = null;
          } else if (roll < 0.15) {
            // not fingerprinted yet (or cloud-only placeholder)
          } else if (roll < 0.2) {
            sha = `s${c}`; // sha256 without md5
          } else if (roll < 0.25) {
            sha = `s${c}`;
            md5 = `other${c}`; // a md5 that matches nothing else
          } else if (roll < 0.3) {
            md5 = `m${c}`; // md5 without sha256 on a local row
          } else {
            sha = `s${c}`;
            md5 = `m${c}`;
          }
          if (next() < 0.08) size = null;
          insert.run(place, `f/${i}`, size, sha, md5, next() < 0.12 ? 9 : null, kind === 'onedrive' && next() < 0.3 ? 1 : 0);
        }
      })();
      const all = computeAllCoverage(db);
      for (const [id] of PLACES) {
        expect(all.get(id) ?? zero(), `seed ${seed}, place ${id}`).toEqual(placeCoverage(db, id));
      }
      expect([...all.keys()].filter((k) => !PLACES.some(([p]) => p === k))).toEqual([]);
    }
  });
});

describe('statsQuery equals allFileStats + allFingerprintCounts', () => {
  it('on randomized catalogs, with gone rows, cloud-only rows and read errors', () => {
    const insert = db.prepare(
      `INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, gone_at, cloud_only, hash_error)
       VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?, ?)`,
    );
    for (let seed = 1; seed <= 20; seed += 1) {
      db.prepare('DELETE FROM files').run();
      const next = rng(seed + 100);
      for (let i = 0; i < 120; i += 1) {
        const place = PLACES[Math.floor(next() * PLACES.length)]![0];
        const hashed = next() < 0.5;
        insert.run(place, `f/${i}`, next() < 0.1 ? null : Math.floor(next() * 1000), hashed ? 's' : null, hashed ? 'm' : null, next() < 0.15 ? 9 : null, next() < 0.2 ? 1 : 0, next() < 0.1 ? 'busy' : null);
      }
      const got = statsQuery(db);
      expect(new Map(got.files)).toEqual(allFileStats(db));
      expect(new Map(got.fingerprint)).toEqual(allFingerprintCounts(db));
      for (const [place] of got.failReasons) expect(db.prepare('SELECT 1 FROM files WHERE place_id = ? AND hash_error IS NOT NULL AND gone_at IS NULL').get(place)).toBeTruthy();
    }
  }, 60_000);
});

// Takes 2-3 minutes on this laptop when the whole suite runs in parallel, long enough to trip vitest's worker RPC
// timeout; the randomized tests above already prove the results. Run it with BACKUPHUB_BENCH=1.
describe.runIf(process.env['BACKUPHUB_BENCH'] === '1')('coverage benchmark: 700,000 rows, 200,000 distinct sha256 values', () => {
  it('all places together in one pass (old per-place SQL shown for comparison)', async () => {
    const insert = db.prepare(
      `INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, cloud_only)
       VALUES (@place, @rel, @size, @sha, @md5, 1, 2, 0)`,
    );
    // Real-looking widths: 64-char sha256, 32-char md5 and ~100-char paths make the table as wide as the real one.
    const SHA = (k: number): string => crypto.createHash('sha256').update(`s${k}`).digest('hex');
    const MD5 = (k: number): string => crypto.createHash('md5').update(`s${k}`).digest('hex');
    const shaCache = new Map<number, [string, string]>();
    const hashes = (k: number): [string, string] => {
      let v = shaCache.get(k);
      if (!v) {
        v = [SHA(k), MD5(k)];
        shaCache.set(k, v);
      }
      return v;
    };
    const path100 = 'Users/someone/Documents/Pictures/2019/Holiday/Italy/Rome/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const local = (place: string, rel: string, k: number): void => {
      const [sha, md5] = hashes(k);
      insert.run({ place, rel: `${path100}/${rel}`, size: (k % 5000) + 1, sha, md5 });
    };
    // Laptop: 150k rows over 85k contents (duplicates inside the place). OneDrive: 40k. T7: 430k over all 200k contents.
    // Google Drive: 80k rows with md5 only, 10% of laptop rows not fingerprinted.
    // Written in chunks with a yield between them: one long synchronous block starves the test runner (RPC timeout).
    const fill = async (count: number, row: (i: number) => void): Promise<void> => {
      const chunk = db.transaction((from: number, to: number) => {
        for (let i = from; i < to; i += 1) row(i);
      });
      for (let at = 0; at < count; at += 50_000) {
        chunk(at, Math.min(count, at + 50_000));
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await fill(150_000, (i) => {
      if (i % 10 === 0) insert.run({ place: 'laptop-1', rel: `${path100}/D/${i}`, size: (i % 5000) + 1, sha: null, md5: null });
      else local('laptop-1', `D/${i}`, i % 85_000);
    });
    await fill(40_000, (i) => local('onedrive-1', `O/${i}`, (i * 3) % 85_000));
    await fill(430_000, (i) => local('drive-t7', `T/${i}`, i % 200_000));
    await fill(80_000, (i) => {
      const k = (i * 2) % 200_000;
      insert.run({ place: 'gdrive-1', rel: `${path100}/G/${i}`, size: (k % 5000) + 1, sha: null, md5: hashes(k)[1] });
    });
    const rows = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
    const shas = (db.prepare('SELECT count(DISTINCT sha256) AS n FROM files').get() as { n: number }).n;
    expect(rows).toBe(700_000);
    expect(shas).toBe(200_000);

    // The worker reads through its own connection; use one here too, like the real thing.
    const reader = openReadOnly(path.join(dir, DB_FILE_NAME));
    const t0 = Date.now();
    const fresh = computeAllCoverage(reader);
    const newMs = Date.now() - t0;

    // The old per-place SQL takes minutes here and starves the test runner (vitest RPC timeout); its results are already
    // compared with the new pass on 60 randomized catalogs above. Set BACKUPHUB_BENCH_OLD=1 to time it as well.
    const old = new Map<string, PlaceCoverage>();
    let oldMs: number | null = null;
    if (process.env['BACKUPHUB_BENCH_OLD'] === '1') {
      const t1 = Date.now();
      for (const id of ['laptop-1', 'onedrive-1']) old.set(id, placeCoverage(reader, id));
      oldMs = Date.now() - t1;
    }
    reader.close();

    console.log(`BENCHMARK coverage, 700k rows / 200k sha256: new, all places = ${newMs} ms${oldMs === null ? '' : `; old, 2 of the 5 places one by one = ${oldMs} ms`}`);
    for (const [id, expected] of old) expect(fresh.get(id)).toEqual(expected);
    // Target on an idle machine is about 3 s. This laptop is often busy (a real fingerprint job runs), so the guard is loose:
    // it only catches a return to per-group lookups (minutes).
    expect(newMs).toBeLessThan(30_000);
  }, 600_000);
});

describe('QueryService', () => {
  const service = (over: Partial<ConstructorParameters<typeof QueryService>[0]> = {}, clock?: { t: number }): QueryService =>
    new QueryService({
      dbFile: null,
      db,
      workerPath: null,
      log: silent,
      now: () => clock?.t ?? Date.now(),
      schedule: (fn) => fn(),
      fallbackMinIntervalMs: 0,
      ...over,
    });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
  const addRow = (place: string, rel: string, sha: string | null): void => {
    db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at) VALUES (?, ?, 5, ?, ?, 1, 2)").run(place, rel, sha, sha ? `m${sha}` : null);
  };

  it('caches, coalesces requests, and recounts only when forced (or, while a job runs, when the cache is old)', async () => {
    const clock = { t: 1_000_000 };
    const q = service({}, clock);
    let updates = 0;
    q.onUpdated(() => (updates += 1));
    addRow('laptop-1', 'a', 'x');
    q.requestCoverage();
    q.requestCoverage();
    q.requestCoverage(); // three asks, one count
    q.requestStats();
    await settle();
    expect(updates).toBe(2);
    expect(q.coverage()?.byPlace.get('laptop-1')?.none.files).toBe(1);
    expect(q.stats()?.files.get('laptop-1')).toMatchObject({ files: 1 });

    // Time alone never recounts: a plain request (the Sources poll) is free however old the cache is.
    addRow('laptop-1', 'b', null);
    clock.t += 10 * COVERAGE_MIN_INTERVAL_MS;
    for (let i = 0; i < 50; i += 1) {
      q.requestStats();
      q.requestCoverage();
    }
    await settle();
    expect(updates).toBe(2);
    expect(q.stats()?.files.get('laptop-1')).toMatchObject({ files: 1 });

    // While a long job makes progress the cache is refreshed, spaced out: stats 30 s, coverage 60 s.
    q.requestStats({ progress: true });
    await settle();
    expect(q.stats()?.files.get('laptop-1')).toMatchObject({ files: 2 });
    addRow('laptop-1', 'c', null);
    clock.t += STATS_MIN_INTERVAL_MS - 1;
    q.requestStats({ progress: true });
    await settle();
    expect(q.stats()?.files.get('laptop-1')).toMatchObject({ files: 2 }); // too early
    clock.t += 2;
    q.requestStats({ progress: true });
    await settle();
    expect(q.stats()?.files.get('laptop-1')).toMatchObject({ files: 3 });
    q.requestCoverage({ progress: true });
    await settle();
    expect(q.coverage()?.byPlace.get('laptop-1')?.notFingerprinted.files).toBe(2);

    // Forced: at once.
    addRow('laptop-1', 'd', null);
    q.requestCoverage({ force: true });
    await settle();
    expect(q.coverage()?.byPlace.get('laptop-1')?.notFingerprinted.files).toBe(3);
  });

  it('never runs two queries at once', async () => {
    let running = 0;
    let most = 0;
    const q = service({
      schedule: (fn) => {
        running += 1;
        most = Math.max(most, running);
        setTimeout(() => {
          running -= 1;
          fn();
        }, 10);
      },
    });
    q.requestCoverage({ force: true });
    q.requestStats({ force: true });
    q.requestCoverage({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(most).toBe(1);
    expect(q.coverage()).not.toBeNull();
    expect(q.stats()).not.toBeNull();
  });

  it('without a worker, counts on the main thread at most once a minute per kind, and logs it', async () => {
    const clock = { t: 5_000_000 };
    const warns: string[] = [];
    const q = service({ fallbackMinIntervalMs: 60_000, log: { info: () => {}, warn: (...a: unknown[]) => void warns.push(a.map(String).join(' ')) } }, clock);
    q.requestStats({ force: true });
    await settle();
    expect(q.stats()).not.toBeNull();
    const first = q.stats();
    q.requestStats({ force: true });
    await settle();
    expect(q.stats()).toBe(first); // refused: under a minute
    clock.t += 60_001;
    q.requestStats({ force: true });
    await settle();
    expect(q.stats()).not.toBe(first);
    expect(warns.filter((w) => w.includes('counted in the main process'))).toHaveLength(2);
  });

  it('falls back when the worker script is missing, and says why', async () => {
    const warns: string[] = [];
    const q = service({
      dbFile: path.join(dir, DB_FILE_NAME),
      workerPath: path.join(dir, 'no-such-worker.js'),
      log: { info: () => {}, warn: (...a: unknown[]) => void warns.push(a.map(String).join(' ')) },
    });
    expect(q.usesWorker).toBe(true);
    q.requestStats({ force: true });
    for (let i = 0; i < 250 && (q.usesWorker || !q.stats()); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(q.usesWorker).toBe(false);
    expect(q.stats()).not.toBeNull();
    expect(warns.some((w) => w.includes('worker thread could not start'))).toBe(true);
    q.close();
  });
});

describe('the built query worker (real worker thread, own read-only connection)', () => {
  let outDir: string;
  let workerPath: string;
  beforeAll(async () => {
    // Build it the way Forge does (a CommonJS file with better-sqlite3 left as a real require).
    outDir = path.join(process.cwd(), 'node_modules', '.cache', 'query-worker-test');
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

  it('answers coverage and stats through a worker, while the main connection keeps writing', async () => {
    db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at) VALUES ('laptop-1', 'a', 7, 's', 'm', 1, 2)").run();
    db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at) VALUES ('drive-t7', 'a', 7, 's', 'm', 1, 2)").run();
    db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, hash_error) VALUES ('onedrive-1', 'a', 7, NULL, NULL, 1, 2, 'busy')").run();
    const q = new QueryService({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    q.requestStats({ force: true });
    q.requestCoverage({ force: true });
    // The main connection writes while the worker reads.
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', 'later', 1, 1, 2)").run();
    await new Promise<void>((resolve) => {
      const check = (): void => (q.coverage() && q.stats() ? resolve() : void setTimeout(check, 20));
      check();
    });
    expect(q.usesWorker).toBe(true);
    expect(q.coverage()?.byPlace.get('laptop-1')?.one.files).toBe(1);
    expect(q.stats()?.files.get('drive-t7')).toEqual({ files: 1, totalBytes: 7, cloudOnly: 0 });
    expect(q.stats()?.failReasons.get('onedrive-1')).toBe('busy');
    q.close();
  });

  it('runs the startup quick_check on its own read-only connection', async () => {
    const file = path.join(dir, DB_FILE_NAME);
    expect(await quickCheckInWorker(workerPath, file)).toEqual({ ok: true, messages: ['ok'] });
    expect(await quickCheckInWorker(path.join(dir, 'missing.js'), file)).toBeNull();
    const missing = await quickCheckInWorker(workerPath, path.join(dir, 'not-here.db'));
    expect(missing?.ok).toBe(false);
  });
});

describe('the built hashing worker pool', () => {
  it('two wide requests run on two worker threads and share one speed cap', async () => {
    const outDir = path.join(process.cwd(), 'node_modules', '.cache', 'hash-worker-test');
    fs.rmSync(outDir, { recursive: true, force: true });
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        ssr: path.join(__dirname, '..', 'hashing', 'hashWorker.ts'),
        rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'hashWorker.js' } },
      },
    });
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    fs.writeFileSync(a, Buffer.alloc(3_000_000, 1));
    fs.writeFileSync(b, Buffer.alloc(3_000_000, 2));
    const hasher = createFileHasher({ workerPath: path.join(outDir, 'hashWorker.js'), log: silent });
    const signal = new AbortController().signal;
    const started = Date.now();
    // 3 MB/s in total: 6 MB cannot be read in much less than 1.5 s (2 s minus the half second the throttle may bank).
    const results = await Promise.all(
      [a, b].map((file) => hasher.hash({ path: file, capBytesPerSec: 3_000_000, size: 3_000_000, signal, wide: true })),
    );
    const elapsed = Date.now() - started;
    hasher.close();
    fs.rmSync(outDir, { recursive: true, force: true });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(elapsed).toBeGreaterThanOrEqual(1300);
    expect(hasher.kind).toBe('worker');
  }, 30_000);
});

describe('the read-only connection', () => {
  it('cannot write', () => {
    const reader = openReadOnly(path.join(dir, DB_FILE_NAME));
    expect(() => reader.prepare("UPDATE places SET label = 'x'").run()).toThrow(/readonly/i);
    reader.close();
  });

  it('refuses a file that does not exist (and does not create it)', () => {
    const file = path.join(dir, 'nothing.db');
    expect(() => openReadOnly(file)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('initDatabaseAsync (startup check off the main thread)', () => {
  /** Leave the file as an unclean shutdown would: running flag still 0. */
  function leaveUnclean(): string {
    const file = path.join(dir, DB_FILE_NAME);
    closeDatabase(db, silent);
    const raw = openDatabase(file);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('clean_shutdown', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();
    return file;
  }

  it('runs the check through the runner after an unclean shutdown, and opens when it passes', async () => {
    leaveUnclean();
    let asked = 0;
    let checking = 0;
    const opened = await initDatabaseAsync(
      dir,
      silent,
      (file) => {
        asked += 1;
        expect(file).toBe(path.join(dir, DB_FILE_NAME));
        return Promise.resolve<IntegrityResult>({ ok: true, messages: ['ok'] });
      },
      () => (checking += 1),
    );
    expect(asked).toBe(1);
    expect(checking).toBe(1);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.startupCheck).toMatchObject({ run: true, reason: 'unclean-shutdown' });
      db = opened.db;
    } else db = openDatabase(path.join(dir, DB_FILE_NAME));
  });

  it('does not run any check after a clean, recently checked shutdown', async () => {
    const file = path.join(dir, DB_FILE_NAME);
    db.prepare("INSERT INTO meta (key, value) VALUES ('clean_shutdown', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('last_integrity_ok_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
    closeDatabase(db, silent);
    let asked = 0;
    const opened = await initDatabaseAsync(dir, silent, () => {
      asked += 1;
      return Promise.resolve(null);
    });
    expect(asked).toBe(0);
    expect(opened.ok).toBe(true);
    db = opened.ok ? opened.db : openDatabase(file);
  });

  it('a failed check refuses to open and writes nothing', async () => {
    const file = leaveUnclean();
    const before = fs.readFileSync(file);
    const opened = await initDatabaseAsync(dir, silent, () => Promise.resolve({ ok: false, messages: ['page 3 is damaged'] }));
    expect(opened).toMatchObject({ ok: false, reason: 'integrity', messages: ['page 3 is damaged'] });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0).toBe(false);
    db = openDatabase(file);
  });

  it('checks in the main process when the worker could not run it', async () => {
    leaveUnclean();
    const logs: string[] = [];
    const opened = await initDatabaseAsync(dir, { ...silent, info: (...a: unknown[]) => void logs.push(a.join(' ')) }, () => Promise.resolve(null));
    expect(opened.ok).toBe(true);
    expect(logs.some((l) => l.includes('could not run it'))).toBe(true);
    db = opened.ok ? opened.db : openDatabase(path.join(dir, DB_FILE_NAME));
  });
});
