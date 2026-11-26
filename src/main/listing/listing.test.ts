import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isListingJobKind, LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND } from '../../shared/listing';
import type { JobChangedEvent, JobRecord, JobState } from '../../shared/jobs';
import { closeDatabase, currentSchemaVersion, initDatabase, MIGRATIONS, openDatabase, runMigrations, type Db } from '../db';
import { JobAborted, JobService, type JobContext } from '../jobs/jobService';
import { fileStatsFor, markGone, upsertFiles } from './fileStore';
import { listPlaceHandler, unpluggedMessage, type ListedPlace, type ListJobEnv, type Located } from './listJob';
import { ListingService } from './listingService';
import { RootService } from './roots';
import { toSlashes } from './skipRules';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string; // app data dir (database)
let tree: string; // the temp fixture tree that is listed
let db: Db;
let service: JobService;

const LAPTOP = '00000000-0000-4000-8000-00000000000a';
const DRIVE = '00000000-0000-4000-8000-00000000000b';
const ONEDRIVE = '00000000-0000-4000-8000-00000000000c';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-list-db-'));
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-list-tree-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  service = new JobService({ db, log: silent });
  for (const [id, kind, label] of [
    [LAPTOP, 'laptop', 'STUDY-PC'],
    [DRIVE, 'drive', 'T7'],
    [ONEDRIVE, 'onedrive', 'OneDrive'],
  ] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  }
});
afterEach(() => {
  service.shutdown();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(rel: string, content = 'x', mtime?: Date): string {
  const abs = path.join(tree, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
  return abs;
}

interface Row {
  rel_path: string;
  size: number;
  mtime: number | null;
  sha256: string | null;
  md5: string | null;
  hashed_at: number | null;
  last_seen_at: number;
  gone_at: number | null;
  cloud_only: number;
}
const rows = (placeId: string): Row[] =>
  db.prepare('SELECT rel_path, size, mtime, sha256, md5, hashed_at, last_seen_at, gone_at, cloud_only FROM files WHERE place_id = ? ORDER BY rel_path').all(placeId) as Row[];
const row = (placeId: string, rel: string): Row => {
  const r = rows(placeId).find((x) => x.rel_path === rel);
  if (!r) throw new Error(`no row ${rel}`);
  return r;
};
const live = (placeId: string): string[] => rows(placeId).filter((r) => r.gone_at === null).map((r) => r.rel_path);
const lookedAt = (placeId: string): number | null => (db.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(placeId) as { t: number | null }).t;

/** Env for the laptop: roots are absolute paths inside the temp tree. */
function laptopEnv(roots: string[], extra: Partial<ListJobEnv> = {}): ListJobEnv {
  return {
    locate: async () => ({ ok: true, base: '' }),
    excludeDirs: () => [],
    roots: async () => roots,
    ...extra,
  };
}

function driveEnv(locate: (place: ListedPlace) => Promise<Located>, roots: string[] = ['']): ListJobEnv {
  return { locate, excludeDirs: () => [], roots: async () => roots };
}

interface Harness {
  warns: string[];
  logs: string[];
  progress: { done: number; message: string | undefined }[];
  checkpoints: unknown[];
}

/** Runs the handler directly with a stand-in context (like the v1 importer tests). */
async function runHandler(
  placeId: string,
  env: ListJobEnv,
  options: { resume?: unknown; chunkSize?: number; now?: () => number; abortAfterYields?: number; streamCloud?: never } = {},
): Promise<{ message: string; h: Harness }> {
  const h: Harness = { warns: [], logs: [], progress: [], checkpoints: [] };
  let yields = 0;
  const ctx: JobContext = {
    jobId: 1,
    params: { placeId },
    resume: options.resume ?? null,
    signal: new AbortController().signal,
    progress: (done, _total, extras) => h.progress.push({ done, message: extras?.message }),
    log: (_l, text) => h.logs.push(text),
    warn: (text) => {
      h.warns.push(text);
      h.logs.push(text);
    },
    needsYou: () => Promise.reject(new Error('not used')),
    checkpoint: (value) => h.checkpoints.push(JSON.parse(JSON.stringify(value))),
    yield: async () => {
      yields += 1;
      if (yields > (options.abortAfterYields ?? Infinity)) throw new JobAborted();
    },
  };
  const handler = listPlaceHandler({ db, env, log: silent, chunkSize: options.chunkSize, now: options.now });
  const result = await handler.run(ctx);
  return { message: typeof result === 'string' ? result : '', h };
}

describe('migration 0004', () => {
  it('upgrades a v3 database that has rows: new columns default, place_roots exists, drive last looked is reset', () => {
    const file = path.join(dir, 'upgrade.db');
    const old = openDatabase(file);
    runMigrations(old, MIGRATIONS.slice(0, 3));
    expect(currentSchemaVersion(old)).toBe(3);
    old.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, last_looked_at, status, created_at) VALUES ('d1', 1, 'drive', 'T7', '{\"serial\":\"AB12\"}', 1700000000000, 'connected', 1)").run();
    old.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, last_looked_at, status, created_at) VALUES ('d2', 1, 'drive', 'Spare', 'not json', 1600000000000, 'disconnected', 1)").run();
    old.prepare("INSERT INTO places (id, profile_id, kind, label, last_looked_at, status, created_at) VALUES ('d3', 1, 'drive', 'Never', NULL, 'unknown', 1)").run();
    old.prepare("INSERT INTO places (id, profile_id, kind, label, last_looked_at, status, created_at) VALUES ('g1', 1, 'gdrive', 'Mail', 1650000000000, 'unknown', 1)").run();
    old.prepare("INSERT INTO places (id, profile_id, kind, label, last_looked_at, status, created_at) VALUES ('l1', 1, 'laptop', 'PC', 1690000000000, 'connected', 1)").run();
    old.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at) VALUES ('d1', 'a.jpg', 10, 5, 'abc', 1, 2)").run();
    old.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('g1', 'Docs/b.pdf', NULL, 1, 2)").run();

    // Only up to 0004 here; 0005 has its own test in fingerprints.test.ts.
    const result = runMigrations(old, MIGRATIONS.slice(0, 4));
    expect(result).toMatchObject({ from: 3, to: 4 });
    expect(MIGRATIONS[3]?.name).toBe('listing');

    // Old rows are untouched and get the new defaults.
    const a = old.prepare("SELECT size, mtime, sha256, cloud_only, hashed_at FROM files WHERE rel_path = 'a.jpg'").get();
    expect(a).toEqual({ size: 10, mtime: 5, sha256: 'abc', cloud_only: 0, hashed_at: null });
    expect(old.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 2 });

    // Drives: "last looked" was "seen connected"; it moves into identity.lastConnectedAt and resets.
    const d1 = old.prepare("SELECT last_looked_at, json_extract(identity_json, '$.lastConnectedAt') AS c, json_extract(identity_json, '$.serial') AS s FROM places WHERE id = 'd1'").get();
    expect(d1).toEqual({ last_looked_at: null, c: 1700000000000, s: 'AB12' });
    const d2 = old.prepare("SELECT last_looked_at, json_extract(identity_json, '$.lastConnectedAt') AS c FROM places WHERE id = 'd2'").get();
    expect(d2).toEqual({ last_looked_at: null, c: 1600000000000 });
    expect(old.prepare("SELECT last_looked_at FROM places WHERE id = 'd3'").get()).toEqual({ last_looked_at: null });
    // Other kinds keep their value.
    expect(old.prepare("SELECT last_looked_at FROM places WHERE id = 'g1'").get()).toEqual({ last_looked_at: 1650000000000 });
    expect(old.prepare("SELECT last_looked_at FROM places WHERE id = 'l1'").get()).toEqual({ last_looked_at: 1690000000000 });

    // place_roots and the partial index exist and work.
    old.prepare("INSERT INTO place_roots (place_id, root, created_at) VALUES ('d1', '', 1)").run();
    expect(() => old.prepare("INSERT INTO place_roots (place_id, root, created_at) VALUES ('d1', '', 2)").run()).toThrow();
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_files_to_hash'").get()).toEqual({ name: 'idx_files_to_hash' });
    const plan = old.prepare("EXPLAIN QUERY PLAN SELECT id FROM files WHERE place_id = 'd1' AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 ORDER BY size").all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_files_to_hash');
    closeDatabase(old, silent);
  });
});

describe('file store', () => {
  it('clears fingerprints when size or mtime changed, keeps them when not, and clears gone_at when a file reappears', () => {
    const f = (size: number, mtimeMs: number) => ({ relPath: 'D:/a.txt', size, mtimeMs, cloudOnly: false });
    upsertFiles(db, LAPTOP, [f(10, 1000)], 100, false);
    db.prepare("UPDATE files SET sha256 = 's', md5 = 'm', hashed_at = 50 WHERE place_id = ?").run(LAPTOP);

    upsertFiles(db, LAPTOP, [f(10, 1000)], 200, false);
    expect(row(LAPTOP, 'D:/a.txt')).toMatchObject({ sha256: 's', md5: 'm', hashed_at: 50, last_seen_at: 200 });

    upsertFiles(db, LAPTOP, [f(11, 1000)], 300, false);
    expect(row(LAPTOP, 'D:/a.txt')).toMatchObject({ size: 11, sha256: null, md5: null, hashed_at: null, last_seen_at: 300 });

    db.prepare("UPDATE files SET sha256 = 's', md5 = 'm', hashed_at = 50 WHERE place_id = ?").run(LAPTOP);
    upsertFiles(db, LAPTOP, [f(11, 2000)], 400, false);
    expect(row(LAPTOP, 'D:/a.txt')).toMatchObject({ mtime: 2000, sha256: null, md5: null, hashed_at: null });

    db.prepare('UPDATE files SET gone_at = 450 WHERE place_id = ?').run(LAPTOP);
    upsertFiles(db, LAPTOP, [f(11, 2000)], 500, false);
    expect(row(LAPTOP, 'D:/a.txt').gone_at).toBeNull();
    expect(db.prepare("SELECT first_seen_at AS t FROM files WHERE place_id = ?").get(LAPTOP)).toEqual({ t: 100 });
  });

  it('keeps the cloud flag as it was when the cloud check could not run', () => {
    upsertFiles(db, ONEDRIVE, [{ relPath: 'a', size: 1, mtimeMs: 1, cloudOnly: true }], 1, false);
    upsertFiles(db, ONEDRIVE, [{ relPath: 'a', size: 1, mtimeMs: 1, cloudOnly: false }], 2, true);
    expect(row(ONEDRIVE, 'a').cloud_only).toBe(1);
    upsertFiles(db, ONEDRIVE, [{ relPath: 'a', size: 1, mtimeMs: 1, cloudOnly: false }], 3, false);
    expect(row(ONEDRIVE, 'a').cloud_only).toBe(0);
  });

  it('marks gone only inside the prefix and spares unreadable folders and files', () => {
    const mk = (relPath: string) => ({ relPath, size: 1, mtimeMs: 1, cloudOnly: false });
    upsertFiles(db, LAPTOP, ['D:/MyData/a', 'D:/MyData/locked/b', 'D:/MyData/c', 'D:/MyData2/z', 'D:/Other/o'].map(mk), 10, false);
    const n = markGone(db, LAPTOP, { prefix: 'D:/MyData/', keepPrefixes: ['D:/MyData/locked/'], keepPaths: ['D:/MyData/c'] }, 20, 30);
    expect(n).toBe(1);
    expect(rows(LAPTOP).filter((r) => r.gone_at !== null).map((r) => r.rel_path)).toEqual(['D:/MyData/a']);
    expect(live(LAPTOP)).toEqual(['D:/MyData/c', 'D:/MyData/locked/b', 'D:/MyData2/z', 'D:/Other/o']);
  });

  it('counts files, bytes and cloud-only for live rows only', () => {
    upsertFiles(db, ONEDRIVE, [
      { relPath: 'a', size: 100, mtimeMs: 1, cloudOnly: true },
      { relPath: 'b', size: 50, mtimeMs: 1, cloudOnly: false },
      { relPath: 'c', size: 5, mtimeMs: 1, cloudOnly: false },
    ], 1, false);
    db.prepare("UPDATE files SET gone_at = 9 WHERE rel_path = 'c'").run();
    expect(fileStatsFor(db, ONEDRIVE)).toEqual({ files: 2, totalBytes: 150, cloudOnly: 1 });
    expect(fileStatsFor(db, DRIVE)).toEqual({ files: 0, totalBytes: 0, cloudOnly: 0 });
  });
});

describe('list.place on the laptop (absolute roots)', () => {
  it('lists a temp tree, records size and mtime, skips the skip list and excluded folders, never lists the link target', async () => {
    const stamp = new Date('2026-01-02T03:04:05Z');
    write('Docs/a.txt', 'hello', stamp);
    write('Docs/sub/b.txt', 'hi');
    write('Docs/desktop.ini');
    write('Docs/$RECYCLE.BIN/x');
    write('OneDriveLike/c.txt');
    const result = await runHandler(LAPTOP, laptopEnv([path.join(tree, 'Docs')], { excludeDirs: () => [path.join(tree, 'OneDriveLike')] }));
    const rel = (p: string) => toSlashes(path.join(tree, p));
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt'), rel('Docs/sub/b.txt')]);
    expect(row(LAPTOP, rel('Docs/a.txt'))).toMatchObject({ size: 5, mtime: stamp.getTime(), gone_at: null, cloud_only: 0, sha256: null });
    expect(result.message).toMatch(/^Checked 2 files/);
    expect(result.h.warns).toEqual([]);
    expect(lookedAt(LAPTOP)).not.toBeNull();
  });

  it('lists several roots, checkpoints after each, and a laptop root outside the exclude list is walked even when named like one', async () => {
    write('A/a.txt');
    write('B/b.txt');
    const { h } = await runHandler(LAPTOP, laptopEnv([path.join(tree, 'A'), path.join(tree, 'B')]));
    expect(live(LAPTOP)).toHaveLength(2);
    expect(h.checkpoints.map((c) => (c as { nextRoot: number }).nextRoot)).toEqual([1, 2]);
  });

  it('writes in chunks and reports progress as files seen', async () => {
    for (let i = 0; i < 25; i += 1) write(`R/f${i}.txt`);
    const { h } = await runHandler(LAPTOP, laptopEnv([path.join(tree, 'R')]), { chunkSize: 10 });
    expect(h.progress.map((p) => p.done)).toEqual([10, 20, 25]);
    expect(live(LAPTOP)).toHaveLength(25);
  });

  it('marks a file gone only after a complete walk, and un-gones it when it reappears', async () => {
    const root = path.join(tree, 'R');
    const a = write('R/a.txt');
    write('R/b.txt');
    let t = 1_000;
    const now = () => (t += 10);
    await runHandler(LAPTOP, laptopEnv([root]), { now });
    expect(live(LAPTOP)).toHaveLength(2);

    // b disappears; a complete walk marks it gone but keeps the row.
    const bAbs = path.join(root, 'b.txt');
    fs.rmSync(bAbs);
    await runHandler(LAPTOP, laptopEnv([root]), { now });
    const bKey = toSlashes(bAbs);
    expect(row(LAPTOP, bKey).gone_at).not.toBeNull();
    expect(rows(LAPTOP)).toHaveLength(2);

    // b comes back.
    fs.writeFileSync(bAbs, 'back');
    await runHandler(LAPTOP, laptopEnv([root]), { now });
    expect(row(LAPTOP, bKey)).toMatchObject({ gone_at: null, size: 4 });
    expect(row(LAPTOP, toSlashes(a)).gone_at).toBeNull();
  });

  it('does NOT mark anything gone when the walk was not complete, and does not count it as a full listing', async () => {
    const root = path.join(tree, 'R');
    write('R/ok/a.txt');
    write('R/bad/b.txt');
    await runHandler(LAPTOP, laptopEnv([root]));
    db.prepare('UPDATE places SET last_looked_at = NULL WHERE id = ?').run(LAPTOP);
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (String(p).endsWith('bad')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return real(p, o);
    });
    const { h } = await runHandler(LAPTOP, laptopEnv([root]));
    expect(live(LAPTOP)).toHaveLength(2); // bad/b.txt still alive
    expect(lookedAt(LAPTOP)).toBeNull();
    expect(h.warns.join(' ')).toMatch(/does not count as a full check/);
  });

  it('turns access-denied folders into warnings, keeps their old rows alive and still counts as listed', async () => {
    const root = path.join(tree, 'R');
    write('R/ok/a.txt');
    write('R/locked/b.txt');
    write('R/gone.txt');
    await runHandler(LAPTOP, laptopEnv([root]));
    fs.rmSync(path.join(root, 'gone.txt'));
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (String(p).endsWith('locked')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, o);
    });
    const { h, message } = await runHandler(LAPTOP, laptopEnv([root]));
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/Could not read folder .*locked.*access denied/);
    expect(live(LAPTOP).some((p) => p.endsWith('locked/b.txt'))).toBe(true);
    expect(live(LAPTOP).some((p) => p.endsWith('gone.txt'))).toBe(false); // truly missing file is marked
    expect(message).toMatch(/Checked 2 files/);
    expect(lookedAt(LAPTOP)).not.toBeNull();
  });

  it('caps the individual access-denied warnings and adds one summary', async () => {
    const root = path.join(tree, 'R');
    for (let i = 0; i < 14; i += 1) write(`R/d${i}/f.txt`);
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (/d\d+$/.test(String(p))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, o);
    });
    const { h } = await runHandler(LAPTOP, laptopEnv([root]));
    expect(h.warns).toHaveLength(11);
    expect(h.warns[10]).toMatch(/4 more entries could not be read/);
  });

  it('clears fingerprints on a changed file during a real listing but keeps them on an unchanged one', async () => {
    const root = path.join(tree, 'R');
    const a = write('R/a.txt', 'one', new Date('2026-01-01T00:00:00Z'));
    const b = write('R/b.txt', 'two', new Date('2026-01-01T00:00:00Z'));
    await runHandler(LAPTOP, laptopEnv([root]));
    db.prepare("UPDATE files SET sha256 = 's', md5 = 'm', hashed_at = 5 WHERE place_id = ?").run(LAPTOP);
    fs.writeFileSync(a, 'three!');
    fs.utimesSync(a, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    await runHandler(LAPTOP, laptopEnv([root]));
    expect(row(LAPTOP, toSlashes(a))).toMatchObject({ sha256: null, md5: null, hashed_at: null, size: 6 });
    expect(row(LAPTOP, toSlashes(b))).toMatchObject({ sha256: 's', md5: 'm', hashed_at: 5 });
  });

  it('resumes after the finished roots using the checkpoint, keeping the original run start', async () => {
    write('A/a.txt');
    write('B/b.txt');
    const roots = [path.join(tree, 'A'), path.join(tree, 'B')];
    const first = await runHandler(LAPTOP, laptopEnv(roots), { abortAfterYields: 2 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(JobAborted);
    // Simulate the stored checkpoint of the first finished root.
    const resume = { placeId: LAPTOP, runStartedAt: 5, nextRoot: 1, filesSeen: 1, incompleteRoots: 0, deniedCount: 0 };
    const { logs } = (await runHandler(LAPTOP, laptopEnv(roots), { resume })).h;
    expect(logs.some((l) => /Continuing after folder 1/.test(l))).toBe(true);
    expect(live(LAPTOP)).toHaveLength(2);
  });

  it('fails plainly with no roots or a missing place', async () => {
    await expect(runHandler(LAPTOP, laptopEnv([]))).rejects.toThrow(/no folders on the list/);
    await expect(runHandler('nope', laptopEnv([]))).rejects.toThrow(/no longer exists/);
    await expect(runHandler(LAPTOP, laptopEnv([])).catch((e: Error) => e.name)).resolves.toBe('JobFailure');
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('gd', 1, 'gdrive', 'Mail', 'unknown', 1)").run();
    await expect(runHandler('gd', laptopEnv([]))).rejects.toThrow(/Only the laptop/);
  });

  it('skips a root that no longer exists with a warning and does not count the listing as full', async () => {
    write('A/a.txt');
    const { h } = await runHandler(LAPTOP, laptopEnv([path.join(tree, 'A'), path.join(tree, 'Missing')]));
    expect(h.warns.join(' ')).toMatch(/Missing was not found/);
    expect(lookedAt(LAPTOP)).toBeNull();
    expect(live(LAPTOP)).toHaveLength(1);
  });
});

describe('list.place on a named drive and OneDrive (relative roots)', () => {
  it('stores paths relative to the drive root and treats a sub-folder root as its own scope', async () => {
    write('Photos/2024/a.jpg');
    write('Photos/2025/b.jpg');
    write('Other/c.txt');
    const env = driveEnv(async () => ({ ok: true, base: tree }), ['Photos']);
    await runHandler(DRIVE, env);
    expect(live(DRIVE)).toEqual(['Photos/2024/a.jpg', 'Photos/2025/b.jpg']);

    // A file on the list earlier outside the roots is not touched by a Photos-only run.
    upsertFiles(db, DRIVE, [{ relPath: 'Other/c.txt', size: 1, mtimeMs: 1, cloudOnly: false }], 1, false);
    fs.rmSync(path.join(tree, 'Photos', '2024', 'a.jpg'));
    await runHandler(DRIVE, env);
    expect(live(DRIVE)).toEqual(['Other/c.txt', 'Photos/2025/b.jpg']);
  });

  it('ends as done with warnings when the drive is unplugged during the run, marking nothing gone and not counting a full listing', async () => {
    write('Photos/a.jpg');
    await runHandler(DRIVE, driveEnv(async () => ({ ok: true, base: tree })));
    expect(live(DRIVE)).toEqual(['Photos/a.jpg']);
    upsertFiles(db, DRIVE, [{ relPath: 'Old/x.txt', size: 1, mtimeMs: 1, cloudOnly: false }], 1, false);
    db.prepare('UPDATE places SET last_looked_at = NULL WHERE id = ?').run(DRIVE);

    // The first look (start of the run) finds the drive; the look after the walk does not.
    let looks = 0;
    const gone = driveEnv(async (place) => {
      looks += 1;
      return looks === 1 ? { ok: true, base: tree } : { ok: false, reason: 'unplugged', message: unpluggedMessage(place.label) };
    });
    const result = await runHandler(DRIVE, gone);
    expect(result.message).toBe('T7 was unplugged; nothing was lost. Plug it in again and choose Check everything to finish.');
    expect(result.h.warns).toEqual([result.message]);
    expect(live(DRIVE)).toContain('Old/x.txt');
    expect(lookedAt(DRIVE)).toBeNull();
  });

  it('ends as done with warnings when the drive is not there at the start', async () => {
    const env = driveEnv(async (place) => ({ ok: false, reason: 'unplugged', message: unpluggedMessage(place.label) }));
    const { message, h } = await runHandler(DRIVE, env);
    expect(message).toContain('T7 was unplugged');
    expect(h.warns).toHaveLength(1);
    expect(rows(DRIVE)).toEqual([]);
  });

  it('through the job service an unplug ends in done_warnings, and a good run in done', async () => {
    write('Photos/a.jpg');
    let plugged = true;
    const env = driveEnv(async (place) => (plugged ? { ok: true, base: tree } : { ok: false, reason: 'unplugged', message: unpluggedMessage(place.label) }));
    service.register(listPlaceHandler({ db, env, log: silent }));
    service.start();
    const finish = async (id: number): Promise<JobRecord> => {
      for (let i = 0; i < 400; i += 1) {
        const job = service.get(id);
        if (job && ['done', 'done_warnings', 'failed'].includes(job.state)) return job;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('job did not finish');
    };
    const ok = await finish(service.create(LIST_PLACE_JOB_KIND, 'List T7', { placeId: DRIVE }));
    expect(ok.state satisfies JobState).toBe('done');
    expect(ok.message).toMatch(/^Checked 1 file/);
    plugged = false;
    const warned = await finish(service.create(LIST_PLACE_JOB_KIND, 'List T7', { placeId: DRIVE }));
    expect(warned.state).toBe('done_warnings');
    expect(warned.warnings).toEqual(['T7 was unplugged; nothing was lost. Plug it in again and choose Check everything to finish.']);
  });

  it('OneDrive: flags cloud-only files from the helper, never downloads, and a failing helper keeps old flags with a warning', async () => {
    write('Docs/local.txt');
    write('Docs/cloud.docx');
    const base = tree;
    const env = driveEnv(async () => ({ ok: true, base }));
    const cloudPath = path.join(tree, 'Docs', 'cloud.docx');
    const streamCloud = vi.fn(async (_root: string, onPath: (p: string) => void) => {
      onPath(cloudPath);
    });
    const handler = (stream: typeof streamCloud) => listPlaceHandler({ db, env, log: silent, streamCloud: stream });
    const run = async (stream: typeof streamCloud) => {
      const warns: string[] = [];
      const ctx = {
        jobId: 1,
        params: { placeId: ONEDRIVE },
        resume: null,
        signal: new AbortController().signal,
        progress: () => undefined,
        log: () => undefined,
        warn: (t: string) => warns.push(t),
        needsYou: () => Promise.reject(new Error('x')),
        checkpoint: () => undefined,
        yield: async () => undefined,
      } as JobContext;
      await handler(stream).run(ctx);
      return warns;
    };
    expect(await run(streamCloud)).toEqual([]);
    expect(row(ONEDRIVE, 'Docs/cloud.docx').cloud_only).toBe(1);
    expect(row(ONEDRIVE, 'Docs/local.txt').cloud_only).toBe(0);
    expect(fileStatsFor(db, ONEDRIVE)).toMatchObject({ files: 2, cloudOnly: 1 });

    const failing = vi.fn(async () => {
      throw new Error('PowerShell is missing');
    });
    const warns = await run(failing);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/Could not tell which OneDrive files are only in the cloud/);
    expect(row(ONEDRIVE, 'Docs/cloud.docx').cloud_only).toBe(1); // flags stay as they were

    // The file got downloaded: the next successful check clears the flag.
    const none = vi.fn(async () => undefined);
    expect(await run(none as never)).toEqual([]);
    expect(row(ONEDRIVE, 'Docs/cloud.docx').cloud_only).toBe(0);
  });
});

describe('RootService', () => {
  const oneDrive = () => path.join(tree, 'OneDrive');
  let roots: RootService;
  let listing = false;
  const known = vi.fn(async () => [
    { label: 'Documents', path: path.join(oneDrive(), 'Documents') },
    { label: 'Desktop', path: path.join(oneDrive(), 'Desktop') },
    { label: 'Pictures', path: path.join(oneDrive(), 'Pictures') },
    { label: 'Videos', path: path.join(tree, 'Videos') },
    { label: 'Missing', path: path.join(tree, 'NoSuchFolder') },
  ]);
  beforeEach(() => {
    for (const p of ['OneDrive/Documents', 'OneDrive/Desktop', 'OneDrive/Pictures', 'Videos', 'MyData', 'Work']) fs.mkdirSync(path.join(tree, p), { recursive: true });
    listing = false;
    known.mockClear();
    roots = new RootService({
      db,
      readKnownFolders: known,
      oneDriveFolders: () => [oneDrive()],
      appFolders: () => [path.join(dir, 'appdata')],
      isListing: () => listing,
      defaultDataFolder: path.join(tree, 'MyData'),
    });
  });

  it('seeds the laptop once: the data folder and known folders that exist and are not inside OneDrive', async () => {
    const first = await roots.ensureDefaults({ id: LAPTOP, kind: 'laptop' });
    expect(first).toEqual([path.join(tree, 'MyData'), path.join(tree, 'Videos')].toSorted());
    // A removed default is not brought back.
    roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Videos'), true);
    const second = await roots.ensureDefaults({ id: LAPTOP, kind: 'laptop' });
    expect(second).toEqual([path.join(tree, 'MyData')]);
    expect(known).toHaveBeenCalledTimes(1);
  });

  it('retries seeding later when the registry could not be read', async () => {
    known.mockRejectedValueOnce(new Error('no PowerShell'));
    const first = await roots.ensureDefaults({ id: LAPTOP, kind: 'laptop' });
    expect(first).toEqual([path.join(tree, 'MyData')]);
    const second = await roots.ensureDefaults({ id: LAPTOP, kind: 'laptop' });
    expect(second).toEqual([path.join(tree, 'MyData'), path.join(tree, 'Videos')].toSorted());
  });

  it('gives drives and OneDrive the whole place as their one root', async () => {
    expect(await roots.ensureDefaults({ id: DRIVE, kind: 'drive' })).toEqual(['']);
    expect(await roots.ensureDefaults({ id: ONEDRIVE, kind: 'onedrive' })).toEqual(['']);
    expect(await roots.ensureDefaults({ id: DRIVE, kind: 'drive' })).toEqual(['']);
  });

  it('refuses a folder inside OneDrive (or OneDrive itself) with a plain reason', () => {
    for (const p of [oneDrive(), path.join(oneDrive(), 'Documents')]) {
      expect(roots.addLaptopRoot(LAPTOP, p)).toMatchObject({ ok: false, message: expect.stringContaining('inside OneDrive') });
    }
    expect(roots.list(LAPTOP)).toEqual([]);
  });

  it('refuses nested, duplicate and enclosing roots, and the app own folders', () => {
    fs.mkdirSync(path.join(tree, 'Work', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'appdata', 'logs'), { recursive: true });
    expect(roots.addLaptopRoot(LAPTOP, path.join(tree, 'Work'))).toMatchObject({ ok: true });
    expect(roots.addLaptopRoot(LAPTOP, path.join(tree, 'Work'))).toMatchObject({ ok: false, message: 'That folder is already on the list.' });
    expect(roots.addLaptopRoot(LAPTOP, path.join(tree, 'Work', 'sub'))).toMatchObject({ ok: false, message: expect.stringContaining('is inside') });
    expect(roots.addLaptopRoot(LAPTOP, tree)).toMatchObject({ ok: false, message: expect.stringContaining('contains') });
    expect(roots.addLaptopRoot(LAPTOP, path.join(dir, 'appdata'))).toMatchObject({ ok: false, message: expect.stringContaining("Backup Hub's own data") });
    expect(roots.addLaptopRoot(LAPTOP, path.join(dir, 'appdata', 'logs'))).toMatchObject({ ok: false });
    expect(roots.addLaptopRoot(LAPTOP, dir)).toMatchObject({ ok: false, message: expect.stringContaining("Backup Hub's own data") });
    expect(roots.addLaptopRoot(LAPTOP, path.join(tree, 'nope'))).toMatchObject({ ok: false, message: 'That folder could not be found.' });
    expect(roots.addLaptopRoot(LAPTOP, 'relative/path')).toMatchObject({ ok: false });
    expect(roots.addLaptopRoot(DRIVE, path.join(tree, 'Work'))).toMatchObject({ ok: false });
    expect(roots.list(LAPTOP)).toEqual([path.join(tree, 'Work')]);
  });

  it('removing a root needs confirmation, marks its files gone (never deletes) and leaves other roots alone', () => {
    roots.addLaptopRoot(LAPTOP, path.join(tree, 'Work'));
    roots.addLaptopRoot(LAPTOP, path.join(tree, 'MyData'));
    const mk = (abs: string) => ({ relPath: toSlashes(abs), size: 1, mtimeMs: 1, cloudOnly: false });
    upsertFiles(db, LAPTOP, [mk(path.join(tree, 'Work', 'a.txt')), mk(path.join(tree, 'Work2', 'x.txt')), mk(path.join(tree, 'MyData', 'b.txt'))], 1, false);

    expect(roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Work'), false)).toMatchObject({ ok: false });
    expect(roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Work'), 'yes')).toMatchObject({ ok: false });
    expect(roots.list(LAPTOP)).toHaveLength(2);

    listing = true;
    expect(roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Work'), true)).toMatchObject({ ok: false, message: expect.stringContaining('being checked') });
    listing = false;

    expect(roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Work'), true)).toEqual({ ok: true, filesMarkedGone: 1 });
    expect(roots.list(LAPTOP)).toEqual([path.join(tree, 'MyData')]);
    expect(rows(LAPTOP)).toHaveLength(3); // nothing deleted
    expect(live(LAPTOP).map((p) => path.basename(p)).toSorted()).toEqual(['b.txt', 'x.txt']);
    expect(roots.removeLaptopRoot(LAPTOP, path.join(tree, 'Work'), true)).toMatchObject({ ok: false });
  });
});

describe('ListingService', () => {
  let connected: Set<string>;
  let nowMs: number;
  let svc: ListingService;

  beforeEach(() => {
    connected = new Set([LAPTOP, DRIVE, ONEDRIVE]);
    nowMs = 1_800_000_000_000;
    // The jobs are queued but never run in these tests (the queue is not started).
    svc = new ListingService({ db, jobs: service, isConnected: (id) => connected.has(id), now: () => nowMs });
  });

  const activeJobs = () => service.list({ states: ['queued', 'running'] }).filter((j) => isListingJobKind(j.kind));

  it('starts one job per place on "Check everything" and tracks the state', () => {
    const result = svc.listNow(DRIVE);
    expect(result).toMatchObject({ ok: true });
    expect(svc.stateOf(DRIVE)).toBe('queued');
    expect(svc.stateOf(LAPTOP)).toBe('idle');
    expect(svc.listNow(DRIVE)).toMatchObject({ ok: false, message: expect.stringContaining('already being checked') });
    expect(activeJobs()).toHaveLength(1);
    expect(service.params(activeJobs()[0]!.id)).toEqual({ placeId: DRIVE });
  });

  it('"Look again" queues a quick job of its own kind for the laptop and named drives only', () => {
    expect(svc.lookAgain(DRIVE)).toMatchObject({ ok: true });
    const job = activeJobs()[0]!;
    expect(job).toMatchObject({ kind: LOOK_AGAIN_JOB_KIND, title: 'Check T7' });
    expect(service.params(job.id)).toEqual({ placeId: DRIVE, quick: true });
    expect(svc.stateOf(DRIVE)).toBe('queued');
    expect(svc.lookAgain(DRIVE)).toMatchObject({ ok: false, message: expect.stringContaining('already being checked') });
    expect(svc.lookAgain(ONEDRIVE)).toMatchObject({ ok: false, message: expect.stringContaining('Check everything') });
    connected.delete(LAPTOP);
    expect(svc.lookAgain(LAPTOP)).toMatchObject({ ok: false, message: expect.stringContaining('not connected') });
    expect(svc.lookAgain(7)).toMatchObject({ ok: false });
  });

  it('refuses places that are not connected, not listable or unknown', () => {
    connected.delete(DRIVE);
    expect(svc.listNow(DRIVE)).toMatchObject({ ok: false, message: 'T7 is not connected, so it cannot be checked now.' });
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('gd', 1, 'gdrive', 'Mail', 'unknown', 1)").run();
    expect(svc.listNow('gd')).toMatchObject({ ok: false, message: expect.stringContaining('Only the laptop') });
    expect(svc.listNow('nope')).toMatchObject({ ok: false });
    expect(svc.listNow(42)).toMatchObject({ ok: false });
    expect(activeJobs()).toHaveLength(0);
  });

  it('goes back to idle when the job finishes or is cancelled', () => {
    const r = svc.listNow(LAPTOP);
    if (!r.ok) throw new Error('should start');
    expect(svc.isListing(LAPTOP)).toBe(true);
    service.cancel(r.jobId);
    expect(svc.stateOf(LAPTOP)).toBe('idle');
  });

  it('knows about jobs queued before it started (resumed after a restart)', () => {
    const id = service.create(LIST_PLACE_JOB_KIND, 'List T7', { placeId: DRIVE });
    const fresh = new ListingService({ db, jobs: service, isConnected: () => true });
    expect(fresh.stateOf(DRIVE)).toBe('queued');
    fresh.noteStarted(id, DRIVE);
    expect(fresh.stateOf(DRIVE)).toBe('running');
  });

  it('has no automatic start at all: no timer, no plug-in trigger', () => {
    expect((svc as unknown as Record<string, unknown>)['checkAuto']).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>)['onDrivesConnected']).toBeUndefined();
    expect(activeJobs()).toHaveLength(0);
  });

  it('announces state changes so Sources can refresh', () => {
    const changed = vi.fn();
    const watching = new ListingService({ db, jobs: service, isConnected: () => true, onStateChanged: changed });
    watching.listNow(LAPTOP);
    expect(changed).toHaveBeenCalled();
  });
});

describe('listing progress for Sources (P4b-1 follow-up)', () => {
  it('the job message shows files so far and files per second instead of an empty total', async () => {
    for (let i = 0; i < 6; i += 1) write(`Photos/f${i}.jpg`);
    let t = 0;
    const { h } = await runHandler(DRIVE, driveEnv(async () => ({ ok: true, base: tree })), { chunkSize: 2, now: () => (t += 1500) });
    const messages = h.progress.map((p) => p.message ?? '');
    expect(messages[0]).toMatch(/^Checking T7: 2 files so far/);
    expect(messages.at(-1)).toMatch(/^Checking T7: 6 files so far · [\d,]+ files per second$/);
  });

  it('ListingService hands the running message to Sources, only while the job is running, and pushes at most every few seconds', () => {
    const listeners: ((e: JobChangedEvent) => void)[] = [];
    const jobs = {
      create: () => 7,
      list: () => [] as JobRecord[],
      params: () => ({ placeId: DRIVE }),
      onChanged: (l: (e: JobChangedEvent) => void) => {
        listeners.push(l);
        return () => undefined;
      },
    };
    let nowMs = 1_000_000;
    let pushes = 0;
    const svc = new ListingService({ db, jobs, isConnected: () => true, now: () => nowMs, onStateChanged: () => (pushes += 1) });
    expect(svc.listNow(DRIVE)).toEqual({ ok: true, jobId: 7 });
    expect(svc.detailOf(DRIVE)).toBeNull(); // queued: nothing to say yet
    const job = (message: string, state: JobRecord['state']): JobRecord =>
      ({ id: 7, kind: LIST_PLACE_JOB_KIND, state, message, warnings: [] }) as unknown as JobRecord;
    listeners[0]!({ reason: 'state', job: job('Started', 'running') });
    const before = pushes;
    listeners[0]!({ reason: 'progress', job: job('Checking T7: 2,000 files so far · 900 files per second', 'running') });
    expect(svc.detailOf(DRIVE)).toBe('Checking T7: 2,000 files so far · 900 files per second');
    expect(pushes).toBe(before + 1);
    nowMs += 1000;
    listeners[0]!({ reason: 'progress', job: job('Checking T7: 4,000 files so far · 950 files per second', 'running') });
    expect(pushes).toBe(before + 1); // under 3 s since the last push
    expect(svc.detailOf(DRIVE)).toBe('Checking T7: 4,000 files so far · 950 files per second');
    nowMs += 3000;
    listeners[0]!({ reason: 'progress', job: job('Checking T7: 6,000 files so far', 'running') });
    expect(pushes).toBe(before + 2);
    listeners[0]!({ reason: 'state', job: job('done', 'done') });
    expect(svc.detailOf(DRIVE)).toBeNull();
  });
});
