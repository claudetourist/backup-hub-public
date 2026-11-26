import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SEARCH, type SearchRequest, type SearchResponse } from '../../shared/search';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import { personRanges, personWhere, rootRange } from './personScope';
import { searchQuery } from './searchQuery';
import { SearchService } from './searchService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ ...EMPTY_SEARCH, ...over });

let dir: string;
let db: Db;

/** You (1), Mom (2), Sam (3). Sam has a phone and a backup folder on the T7; Mom has a Google account and a backup folder; the laptop is shared. */
function seedPeople(): void {
  db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Mom', '#7a4fb5', 1), (3, 'Sam', '#a63d6e', 1)").run();
  const place = db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, ?, ?, ?, 'connected', 1)");
  place.run('laptop', 1, 'laptop', 'STUDY-PC');
  place.run('t7', 1, 'drive', 'T7');
  place.run('phone-sam', 3, 'phone', 'Sam phone');
  place.run('phone-you', 1, 'phone', 'Poco F4');
  place.run('g-mom', 2, 'gdrive', 'mom@example.com');
  place.run('g-you', 1, 'gdrive', 'you@example.com');
  const backup = db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, folder_prefix, change_rule, created_at) VALUES (?, ?, ?, 'phone', 'x', 'size_and_date', 1)");
  backup.run(1, 1, 'Poco F4');
  backup.run(2, 3, 'Sam phone');
  backup.run(3, 2, 'Mom phone');
  const dest = db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root) VALUES (?, 't7', ?)");
  dest.run(1, 'MyData/POCO');
  dest.run(2, 'MyData/Sam phone');
  dest.run(3, 'MyData/Mom phone');
}

function addFiles(rows: [string, string][]): void {
  const insert = db.prepare('INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, gone_at) VALUES (?, ?, 10, 1, 1, ?)');
  db.transaction(() => {
    for (const [placeId, rel] of rows) insert.run(placeId, rel.replace('#gone', ''), rel.endsWith('#gone') ? 9 : null);
  })();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-person-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  seedPeople();
});
afterEach(async () => {
  closeDatabase(db, silent);
  // The search worker lets go of its file a moment after it is stopped (Windows refuses to remove a file in use).
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const namesOf = (over: Partial<SearchRequest>): string[] => {
  const res = searchQuery(db, req({ text: 'f', ...over }));
  if (res.status !== 'done') throw new Error(JSON.stringify(res));
  return res.hits.map((h) => h.name).toSorted();
};

describe('the ranges of a person', () => {
  it('a folder root becomes a prefix range that cannot leak into a folder with a longer name', () => {
    expect(rootRange('t7', 'MyData/Sam phone')).toEqual({ placeId: 't7', from: 'MyData/Sam phone/', to: 'MyData/Sam phone0' });
    expect(rootRange('t7', '\\MyData\\Sam phone\\')).toEqual({ placeId: 't7', from: 'MyData/Sam phone/', to: 'MyData/Sam phone0' });
    expect(rootRange('t7', '')).toEqual({ placeId: 't7', from: null, to: null });
  });

  it('a person has their phones and accounts whole, and the folders of their backups; nothing else', () => {
    expect(personRanges(db, 3)).toEqual([
      { placeId: 'phone-sam', from: null, to: null },
      { placeId: 't7', from: 'MyData/Sam phone/', to: 'MyData/Sam phone0' },
    ]);
    expect(personRanges(db, 2).map((r) => r.placeId)).toEqual(['g-mom', 't7']);
    expect(personRanges(db, 1).map((r) => r.placeId).toSorted()).toEqual(['g-you', 'phone-you', 't7']);
    expect(personRanges(db, 99)).toEqual([]);
    expect(personWhere([])).toEqual({ sql: '0', params: [] });
    expect(personWhere(personRanges(db, 3)).params).toEqual(['phone-sam', 't7', 'MyData/Sam phone/', 'MyData/Sam phone0']);
  });

  it('a backup that saves to the whole drive makes the whole drive theirs (and the narrower ranges are dropped)', () => {
    db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root) VALUES (2, 't7', '')").run();
    expect(personRanges(db, 3).filter((r) => r.placeId === 't7')).toEqual([{ placeId: 't7', from: null, to: null }]);
  });
});

describe('Files of one person (search in the query worker\'s code path)', () => {
  beforeEach(() => {
    addFiles([
      ['phone-sam', '/sdcard/DCIM/f-sam-1.jpg'],
      ['phone-sam', '/sdcard/DCIM/f-sam-2.jpg#gone'],
      ['phone-you', '/sdcard/DCIM/f-you-phone.jpg'],
      ['t7', 'MyData/Sam phone/Sam-phone-12Nov26/DCIM/f-sam-backup.jpg'],
      ['t7', 'MyData/Sam phone 2/f-other-folder.jpg'],
      ['t7', 'MyData/Sam phone/f-100%_odd name.jpg'],
      ['t7', 'MyData/POCO/POCO-17Jul26/f-poco.jpg'],
      ['t7', 'MyData/Mom phone/f-mom-backup.jpg'],
      ['t7', 'Photos/2022/f-loose.jpg'],
      ['laptop', 'D:/Pictures/f-laptop.jpg'],
      ['g-mom', 'My Drive/f-mom-drive.jpg'],
      ['g-you', 'My Drive/f-you-drive.jpg'],
    ]);
  });

  it("shows Sam's phone, and the folder their backup saves to, and nothing next to it", () => {
    expect(namesOf({ person: 3 })).toEqual(['f-100%_odd name.jpg', 'f-sam-1.jpg', 'f-sam-backup.jpg']);
  });

  it('shows Mom her Google account and her backup folder; You, the Poco, your account and the Poco folder', () => {
    expect(namesOf({ person: 2 })).toEqual(['f-mom-backup.jpg', 'f-mom-drive.jpg']);
    expect(namesOf({ person: 1 })).toEqual(['f-poco.jpg', 'f-you-drive.jpg', 'f-you-phone.jpg']);
  });

  it('Everyone is every file, a person with nothing finds nothing, and the laptop is in no one scope', () => {
    expect(namesOf({ person: null })).toHaveLength(11);
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (4, 'Aunt', '#5b7a1f', 1)").run();
    expect(namesOf({ person: 4 })).toEqual([]);
    for (const person of [1, 2, 3]) expect(namesOf({ person })).not.toContain('f-laptop.jpg');
  });

  it('combines with the other filters and the sort, and counts (chips, total) stay inside the person', () => {
    expect(namesOf({ person: 3, text: 'backup' })).toEqual(['f-sam-backup.jpg']);
    expect(namesOf({ person: 3, sort: 'name', text: '' })).toEqual(['f-100%_odd name.jpg', 'f-sam-1.jpg', 'f-sam-backup.jpg']);
    expect(namesOf({ person: 3, placeIds: ['t7'] })).toEqual(['f-100%_odd name.jpg', 'f-sam-backup.jpg']);
    const counts = searchQuery(db, req({ text: 'f', person: 3, part: 'counts' }));
    expect(counts.status === 'counts' && counts.total).toBe(3);
    expect(counts.status === 'counts' && counts.facets?.places).toEqual({ 't7': 2, 'phone-sam': 1 });
  });

  it('walks in index order too (sorted by date, by size) with the same people', () => {
    for (const sort of ['date', 'size'] as const) {
      const res = searchQuery(db, req({ person: 3, sort }), 50_000, { walk: true });
      expect(res.status === 'done' && res.hits.map((h) => h.name).toSorted()).toEqual(['f-100%_odd name.jpg', 'f-sam-1.jpg', 'f-sam-backup.jpg']);
    }
  });

  it('the plan reads the place + path index (no scan of the whole table) for a person\'s folder', () => {
    const { sql, params } = personWhere(personRanges(db, 3));
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT f.id FROM files f WHERE f.gone_at IS NULL AND ${sql}`).all(...params) as { detail: string }[];
    const text = plan.map((p) => p.detail).join('\n');
    expect(text).toMatch(/SEARCH f USING (COVERING )?INDEX sqlite_autoindex_files_1 \(place_id=\? AND rel_path>\? AND rel_path<\?\)/);
  });
});

/**
 * The window must not freeze when a person is picked on Files. The REAL search worker answers a person's search on a generated catalog of
 * 450,000 files; a timer on the main thread says how late it fires, which is exactly what a frozen window is.
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

describe('picking a person on Files never blocks the main thread (real worker, big generated catalog)', () => {
  let outDir: string;
  let workerPath: string;
  beforeAll(async () => {
    outDir = path.join(process.cwd(), 'node_modules', '.cache', 'person-scope-worker-test');
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

  it('answers the page and the counts of a person\'s search while a timer on the main thread keeps firing', async () => {
    insertFakeRows(db, 'laptop', 'D:/Users/someone/Documents', 250_000, { fingerprinted: true });
    insertFakeRows(db, 't7', 'MyData/POCO/POCO-17Jul26', 80_000, { fingerprinted: true });
    insertFakeRows(db, 't7', 'MyData/Sam phone/Sam-phone-12Nov26', 60_000, { fingerprinted: true });
    insertFakeRows(db, 'phone-sam', '/sdcard/DCIM', 20_000, { fingerprinted: false });
    insertFakeRows(db, 'g-mom', 'My Drive', 40_000, { fingerprinted: true });
    const service = new SearchService({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    const seen: string[] = [];
    try {
      for (const person of [3, 2, null]) {
        const dog = watchdog();
        const started = Date.now();
        const page: Promise<SearchResponse> = service.run(req({ text: 'f1', person }));
        const counts: Promise<SearchResponse> = service.run(req({ text: 'f1', person, part: 'counts' }));
        const [p, c] = await Promise.all([page, counts]);
        const blocked = dog.stop();
        seen.push(`person ${String(person)}: ${Date.now() - started} ms, main thread blocked at most ${blocked} ms`);
        expect(p.status).toBe('done');
        expect(c.status).toBe('counts');
        expect(blocked).toBeLessThan(MAX_BLOCK_MS);
        if (p.status === 'done' && person === 3) {
          expect(p.hits.length).toBeGreaterThan(0);
          // Every content found has a copy in the person's scope (its other copies, elsewhere, are listed as they always are).
          for (const hit of p.hits) {
            expect(hit.copies.some((copy) => copy.placeId === 'phone-sam' || (copy.placeId === 't7' && copy.relPath.startsWith('MyData/Sam phone/')))).toBe(true);
          }
        }
      }
    } finally {
      service.close();
    }
    console.log(seen.join('\n'));
  }, 180_000);
});
