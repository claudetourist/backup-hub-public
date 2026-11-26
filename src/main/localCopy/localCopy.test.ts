import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PART_SUFFIX, type LocalCopyPlan } from '../../shared/localCopy';
import { BACKUPS_PARTS } from '../../shared/appFolders';
import { closeDatabase, initDatabase, type Db } from '../db';
import { backupsFolder } from '../places/appFolders';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import { copyToLocalHandler } from './localCopyJob';
import { LocalCopyService } from './localCopyService';
import { cleanSegment, hashLocalPlan, localDestinationFor, taggedName } from './localModel';
import { buildLocalCopyPlan, type LocalPlannerDeps } from './localPlanner';
import { protectFakeDrive, treeOf, unprotectFakeDrives } from '../writeGuard.testutil';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const slash = (p: string): string => p.replaceAll('\\', '/');

let dir: string;
let src: string;
let drive: string;
let db: Db;
let freeBytes: number | null;
let driveHere: boolean;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-lc-'));
  src = path.join(dir, 'laptop', 'Reunion');
  drive = path.join(dir, 'T7');
  fs.mkdirSync(path.join(src, 'final'), { recursive: true });
  fs.mkdirSync(drive, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  freeBytes = 500_000_000_000;
  driveHere = true;
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('laptop', 1, 'laptop', 'Laptop', '{}', 'connected', 1)").run();
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('t7', 1, 'drive', 'T7', '{}', 'connected', 1)").run();
});
afterEach(() => {
  unprotectFakeDrives();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function addFile(rel: string, size: number, seed = rel): { abs: string; md5: string; content: Buffer } {
  const abs = path.join(src, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const content = Buffer.alloc(size);
  for (let i = 0; i < size; i += 32) createHash('sha256').update(`${seed}:${i}`).digest().copy(content, i, 0, Math.min(32, size - i));
  fs.writeFileSync(abs, content);
  const md5 = createHash('md5').update(content).digest('hex');
  const mtime = Math.trunc(fs.statSync(abs).mtimeMs);
  db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, md5, sha256, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)').run('laptop', slash(abs), size, mtime, md5, md5);
  return { abs, md5, content };
}

function collection(name = 'Reunion'): number {
  const id = Number(db.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, ?, 'irreplaceable')").run(name).lastInsertRowid);
  db.prepare('INSERT INTO collection_roots (collection_id, place_id, rel_path) VALUES (?, ?, ?)').run(id, 'laptop', slash(src));
  return id;
}

const baseOf = (placeId: string): Promise<string | null> => Promise.resolve(placeId === 'laptop' ? '' : placeId === 'od' ? path.join(dir, 'OneDriveRoot') : placeId === 't7' && driveHere ? drive : null);

function plannerDeps(): LocalPlannerDeps {
  return { db, baseOf, freeBytes: () => freeBytes, now: () => 1_000_000, yieldNow: () => Promise.resolve() };
}

async function makePlan(id: number): Promise<LocalCopyPlan> {
  const result = await buildLocalCopyPlan(plannerDeps(), id, 't7');
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

interface Run {
  message: string;
  warns: string[];
  checkpoints: unknown[];
  error: unknown;
}

async function run(plan: LocalCopyPlan, options: { resume?: unknown; abortAfterYields?: number; chunkBytes?: number } = {}): Promise<Run> {
  const out: Run = { message: '', warns: [], checkpoints: [], error: null };
  let yields = 0;
  const ctx: JobContext = {
    jobId: 1,
    params: { plan },
    resume: options.resume ?? null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: (t) => void out.warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: (v) => void out.checkpoints.push(JSON.parse(JSON.stringify(v))),
    yield: () => {
      yields += 1;
      if (yields > (options.abortAfterYields ?? Infinity)) return Promise.reject(new JobAborted());
      return Promise.resolve();
    },
  };
  const handler = copyToLocalHandler({ db, log: silent, baseOf, freeBytes: () => freeBytes, now: () => 2_000_000, chunkBytes: options.chunkBytes ?? 4096 });
  try {
    const result = await handler.run(ctx);
    out.message = typeof result === 'string' ? result : (result?.message ?? '');
  } catch (err) {
    out.error = err;
  }
  return out;
}

/** Where the app's backups folder is below a drive root, with "/" (as the plan and the catalog write it). */
const BACKUPS_REL = BACKUPS_PARTS.join('/');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const partFiles = (): string[] => fs.readdirSync(drive, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(PART_SUFFIX));

describe('model', () => {
  it('cleans names for Windows and builds the destination', () => {
    expect(cleanSegment('a<b>c:d')).toBe('a_b_c_d');
    expect(cleanSegment('name. ')).toBe('name');
    expect(cleanSegment('CON')).toBe('_CON');
    expect(cleanSegment('..')).toBe('_');
    expect(localDestinationFor('Wed/ding', 'final/a.mp4')).toEqual({ folders: [...BACKUPS_PARTS, 'Wed_ding', 'final'], name: 'a.mp4' });
    expect(localDestinationFor('W', '../../x.mp4').folders).toEqual([...BACKUPS_PARTS, 'W']);
    expect(taggedName('a.mp4', 'abcdef1234')).toBe('a (abcdef12).mp4');
  });
});

describe('plan', () => {
  it('lists the files the drive lacks, with their place on the drive, and changes nothing', async () => {
    const a = addFile('final/a.mp4', 10_000);
    addFile('b.txt', 500);
    const plan = await makePlan(collection());
    expect(plan.totalFiles).toBe(2);
    expect(plan.files.map((f) => `${f.folder}/${f.name}`).toSorted()).toEqual([`${BACKUPS_REL}/Reunion/b.txt`, `${BACKUPS_REL}/Reunion/final/a.mp4`]);
    expect(plan.files.find((f) => f.name === 'a.mp4')?.md5).toBe(a.md5);
    expect(plan.hash).toBe(hashLocalPlan(plan));
    expect(plan.freeAfter).toBe(500_000_000_000 - 10_500);
    expect(fs.readdirSync(drive)).toEqual([]);
  });

  it('skips contents the drive already holds (the delta) and says so when nothing is new', async () => {
    const a = addFile('a.bin', 4000);
    addFile('b.bin', 3000);
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, md5, sha256, first_seen_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?, 1, 1)').run('t7', 'Old/copy of a.bin', 4000, a.md5, a.md5);
    const id = collection();
    const plan = await makePlan(id);
    expect(plan.files.map((f) => f.name)).toEqual(['b.bin']);
    expect(plan.alreadyThere).toEqual({ files: 1, bytes: 4000 });
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, md5, sha256, first_seen_at, last_seen_at) SELECT ?, rel_path, size, mtime, md5, sha256, 1, 1 FROM files WHERE place_id = ? AND rel_path LIKE ?').run('t7', 'laptop', '%b.bin');
    const again = await buildLocalCopyPlan(plannerDeps(), id, 't7');
    expect(again.ok).toBe(false);
  });

  it('refuses when the drive is not plugged in', async () => {
    addFile('a.bin', 100);
    driveHere = false;
    const result = await buildLocalCopyPlan(plannerDeps(), collection(), 't7');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('not plugged in');
  });

  it('lists what does not fit and files with no readable copy', async () => {
    addFile('big.bin', 3000);
    addFile('small.bin', 100);
    db.prepare("UPDATE files SET md5 = 'f00d', sha256 = 'f00d' WHERE rel_path LIKE '%small.bin'").run();
    fs.rmSync(path.join(src, 'small.bin'));
    freeBytes = 200_000_000 + 2000;
    const plan = await makePlan(collection());
    expect(plan.files).toHaveLength(0);
    expect(plan.doesNotFit.map((f) => f.name).toSorted()).toEqual(['big.bin', 'small.bin']);
    expect(plan.doesNotFit.find((f) => f.name === 'big.bin')?.reason).toContain('No room');
  });

  it('gives a different file at the same place a tagged name instead of replacing it', async () => {
    addFile('a.bin', 100);
    fs.mkdirSync(path.join(backupsFolder(drive), 'Reunion'), { recursive: true });
    fs.writeFileSync(path.join(backupsFolder(drive), 'Reunion', 'a.bin'), 'something else');
    const plan = await makePlan(collection());
    expect(plan.files[0]!.name).toMatch(/^a \([0-9a-f]{8}\)\.bin$/);
  });
});

describe('copy job', () => {
  it('T7 WRITE BAN: writes nothing, creates nothing and adds no catalog row on a protected drive', async () => {
    addFile('final/a.mp4', 4_000);
    const plan = await makePlan(collection());
    protectFakeDrive(drive, 'T7');
    const before = treeOf(drive);
    const out = await run(plan);
    expect(out.error).toBeInstanceOf(JobFailure);
    expect((out.error as Error).message).toBe('T7 is read-only (protected), so nothing is written to it.');
    expect(treeOf(drive)).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM files WHERE place_id = ?').get('t7')).toEqual({ n: 0 });
  });

  it('T7 WRITE BAN: the service lists a protected drive as read-only and refuses to plan or start for it', async () => {
    addFile('a.bin', 100);
    const id = collection();
    const created: unknown[] = [];
    const service = new LocalCopyService({
      planner: plannerDeps(),
      drives: () => Promise.resolve([{ placeId: 't7', label: 'T7', root: drive }]),
      writeProtected: () => 'T7 is read-only (protected), so nothing is written to it.',
      jobs: { create: (...args) => created.push(args), list: () => [] },
    });
    expect((await service.targets())[0]?.readOnly).toBe('T7 is read-only (protected), so nothing is written to it.');
    expect(await service.plan(id, 't7')).toEqual({ ok: false, message: 'T7 is read-only (protected), so nothing is written to it.' });
    expect(created).toEqual([]);
  });

  it('copies whole, checks, keeps the date, adds catalog rows, leaves the original alone and finds nothing new next time', async () => {
    const a = addFile('final/a.mp4', 40_000);
    const b = addFile('b.txt', 77);
    const originalMtime = fs.statSync(a.abs).mtimeMs;
    const id = collection();
    const plan = await makePlan(id);
    const out = await run(plan);
    expect(out.error).toBeNull();
    expect(out.warns).toEqual([]);
    expect(out.message).toContain('Copied and checked 2 files');
    const copy = fs.readFileSync(path.join(backupsFolder(drive), 'Reunion', 'final', 'a.mp4'));
    expect(sha(copy)).toBe(sha(a.content));
    expect(fs.readFileSync(path.join(backupsFolder(drive), 'Reunion', 'b.txt'))).toEqual(b.content);
    expect(Math.abs(fs.statSync(path.join(backupsFolder(drive), 'Reunion', 'final', 'a.mp4')).mtimeMs - originalMtime)).toBeLessThan(2);
    expect(fs.readFileSync(a.abs)).toEqual(a.content);
    expect(partFiles()).toEqual([]);
    const row = db.prepare('SELECT size, md5, sha256, mtime, gone_at FROM files WHERE place_id = ? AND rel_path = ?').get('t7', `${BACKUPS_REL}/Reunion/final/a.mp4`) as { size: number; md5: string; sha256: string; mtime: number; gone_at: number | null };
    expect(row).toMatchObject({ size: 40_000, md5: a.md5, sha256: sha(a.content), gone_at: null });
    expect(row.mtime).toBe(Math.trunc(fs.statSync(path.join(backupsFolder(drive), 'Reunion', 'final', 'a.mp4')).mtimeMs));
    const again = await buildLocalCopyPlan(plannerDeps(), id, 't7');
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.message).toContain('already holds');
  });

  it('never replaces a file that appeared at the place after the plan, and reports it', async () => {
    addFile('a.bin', 5000);
    addFile('b.bin', 5000);
    const plan = await makePlan(collection());
    const clash = path.join(backupsFolder(drive), 'Reunion', 'a.bin');
    fs.mkdirSync(path.dirname(clash), { recursive: true });
    fs.writeFileSync(clash, 'precious other file');
    const out = await run(plan);
    expect(fs.readFileSync(clash, 'utf8')).toBe('precious other file');
    expect(out.warns.join(' ')).toContain('different file');
    expect(fs.existsSync(path.join(backupsFolder(drive), 'Reunion', 'b.bin'))).toBe(true);
    expect(out.message).toContain('1 file skipped');
    expect(partFiles()).toEqual([]);
  });

  it('counts an identical file that is already at the place as already there', async () => {
    const a = addFile('a.bin', 5000);
    const plan = await makePlan(collection());
    const there = path.join(backupsFolder(drive), 'Reunion', 'a.bin');
    fs.mkdirSync(path.dirname(there), { recursive: true });
    fs.writeFileSync(there, a.content);
    const out = await run(plan);
    expect(out.error).toBeNull();
    expect(out.message).toContain('1 file already there');
    expect(db.prepare('SELECT count(*) AS n FROM files WHERE place_id = ?').get('t7')).toEqual({ n: 1 });
  });

  it('skips a source that changed after the plan and keeps no half file', async () => {
    const a = addFile('a.bin', 5000);
    addFile('b.bin', 6000);
    const plan = await makePlan(collection());
    fs.appendFileSync(a.abs, 'more');
    const out = await run(plan);
    expect(out.warns.join(' ')).toContain('changed');
    expect(fs.existsSync(path.join(backupsFolder(drive), 'Reunion', 'a.bin'))).toBe(false);
    expect(fs.existsSync(path.join(backupsFolder(drive), 'Reunion', 'b.bin'))).toBe(true);
    expect(partFiles()).toEqual([]);
  });

  it('does not keep a copy when the file no longer matches Backup Hub\'s list (same size and date)', async () => {
    const a = addFile('a.bin', 5000);
    addFile('b.bin', 100);
    // A whole-second date, so rewriting the file can restore exactly the same date.
    const whole = 1_700_000_000;
    fs.utimesSync(a.abs, whole, whole);
    db.prepare('UPDATE files SET mtime = ? WHERE rel_path = ?').run(whole * 1000, slash(a.abs));
    const plan = await makePlan(collection());
    fs.writeFileSync(a.abs, Buffer.alloc(5000, 7));
    fs.utimesSync(a.abs, whole, whole);
    const out = await run(plan);
    expect(out.warns.join(' ')).toContain('does not match Backup Hub\'s list');
    expect(fs.existsSync(path.join(backupsFolder(drive), 'Reunion', 'a.bin'))).toBe(false);
    expect(partFiles()).toEqual([]);
  });

  it('stops when the drive fills up and says what was not copied', async () => {
    addFile('a.bin', 5000);
    addFile('b.bin', 5000);
    const plan = await makePlan(collection());
    freeBytes = 200_000_000 + 100;
    const out = await run(plan);
    expect(out.error).toBeInstanceOf(JobFailure);
    expect(out.warns.join(' ')).toContain('no room');
    expect(fs.existsSync(backupsFolder(drive))).toBe(false);
  });

  it('fails clearly when the drive is gone', async () => {
    addFile('a.bin', 5000);
    const plan = await makePlan(collection());
    driveHere = false;
    const out = await run(plan);
    expect(out.error).toBeInstanceOf(JobFailure);
    expect((out.error as JobFailure).plain).toContain('not plugged in');
  });

  it('continues from its checkpoint and leaves no temporary file when cancelled', async () => {
    addFile('a.bin', 9000);
    addFile('b.bin', 9000);
    addFile('c.bin', 9000);
    const plan = await makePlan(collection());
    const first = await run(plan, { abortAfterYields: 5 });
    expect(first.error).toBeInstanceOf(JobAborted);
    expect(partFiles()).toEqual([]);
    const last = first.checkpoints.at(-1) ?? null;
    const second = await run(plan, { resume: last });
    expect(second.error).toBeNull();
    for (const n of ['a.bin', 'b.bin', 'c.bin']) expect(fs.statSync(path.join(backupsFolder(drive), 'Reunion', n)).size).toBe(9000);
  });
});

describe('service', () => {
  function service(created: unknown[]): LocalCopyService {
    return new LocalCopyService({
      planner: plannerDeps(),
      drives: () => Promise.resolve([{ placeId: 't7', label: 'T7', root: drive }]),
      jobs: {
        create: (kind, title, params) => {
          created.push({ kind, title, params });
          return created.length;
        },
        list: () => [],
      },
      now: () => 1_000_000,
    });
  }

  it('starts only a confirmed plan it made itself, once', async () => {
    addFile('a.bin', 100);
    const created: unknown[] = [];
    const s = service(created);
    const id = collection();
    expect(await s.targets()).toEqual([{ placeId: 't7', label: 'T7', freeBytes: 500_000_000_000, readOnly: null }]);
    const result = await s.plan(id, 't7');
    if (!result.ok) throw new Error(result.message);
    const { plan } = result;
    expect(s.start({ planId: plan.id, hash: plan.hash, confirmed: false })).toMatchObject({ ok: false });
    expect(s.start({ planId: plan.id, hash: 'wrong', confirmed: true })).toMatchObject({ ok: false });
    expect(s.start({ planId: 'nope', hash: plan.hash, confirmed: true })).toMatchObject({ ok: false });
    expect(created).toHaveLength(0);
    expect(s.start({ planId: plan.id, hash: plan.hash, confirmed: true })).toEqual({ ok: true, jobId: 1 });
    expect(created).toHaveLength(1);
    expect(s.start({ planId: plan.id, hash: plan.hash, confirmed: true })).toMatchObject({ ok: false });
  });

  it('refuses bad input without planning', async () => {
    const s = service([]);
    expect(await s.plan('x', 't7')).toMatchObject({ ok: false });
    expect(await s.plan(1, '')).toMatchObject({ ok: false });
    expect(s.start(null)).toMatchObject({ ok: false });
  });
});

// ---- Batch 10a: OneDrive files, online-only files and a laptop folder as the place that takes the copy ----------------------

describe('OneDrive and a laptop folder (Batch 10a)', () => {
  let oneDrive: string;
  let folder: string;

  beforeEach(() => {
    oneDrive = path.join(dir, 'OneDriveRoot');
    folder = path.join(dir, 'LaptopFolder');
    fs.mkdirSync(oneDrive, { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('od', 1, 'onedrive', 'OneDrive', '{}', 'connected', 1)").run();
  });

  const baseWithOneDrive = (placeId: string): Promise<string | null> => (placeId === 'od' ? Promise.resolve(oneDrive) : baseOf(placeId));
  const depsWithOneDrive = (): LocalPlannerDeps => ({ ...plannerDeps(), baseOf: baseWithOneDrive });

  function addOneDriveFile(rel: string, size: number, opts: { onlineOnly?: boolean } = {}): Buffer {
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i += 32) createHash('sha256').update(`${rel}:${i}`).digest().copy(content, i, 0, Math.min(32, size - i));
    const md5 = createHash('md5').update(content).digest('hex');
    if (!opts.onlineOnly) {
      const abs = path.join(oneDrive, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, md5, sha256, cloud_only, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)').run(
      'od',
      rel,
      size,
      opts.onlineOnly ? 1 : Math.trunc(fs.statSync(path.join(oneDrive, ...rel.split('/'))).mtimeMs),
      opts.onlineOnly ? null : md5,
      opts.onlineOnly ? null : sha(content),
      opts.onlineOnly ? 1 : 0,
    );
    return content;
  }

  function oneDrivePlan(): number {
    const id = Number(db.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, 'OneDrive', 'important')").run().lastInsertRowid);
    db.prepare("INSERT INTO collection_roots (collection_id, place_id, rel_path) VALUES (?, 'od', '')").run(id);
    return id;
  }

  it('copies OneDrive files that are on this PC and lists the online-only ones as "not on this PC", never reading them', async () => {
    addOneDriveFile('Pictures/a.jpg', 3000);
    addOneDriveFile('Documents/b.docx', 2000);
    addOneDriveFile('Videos/big.mp4', 9000, { onlineOnly: true });
    addOneDriveFile('Videos/big2.mp4', 7000, { onlineOnly: true });
    const result = await buildLocalCopyPlan(depsWithOneDrive(), oneDrivePlan(), 't7');
    if (!result.ok) throw new Error(result.message);
    const plan = result.plan;
    expect(plan.files.map((f) => `${f.folder}/${f.name}`).toSorted()).toEqual([`${BACKUPS_REL}/OneDrive/Documents/b.docx`, `${BACKUPS_REL}/OneDrive/Pictures/a.jpg`]);
    expect(plan.files.every((f) => f.sourcePlaceId === 'od')).toBe(true);
    const online = plan.doesNotFit.filter((f) => f.reason.startsWith('Not on this PC (online only)'));
    expect(online.map((f) => f.name).toSorted()).toEqual(['big.mp4', 'big2.mp4']);
    expect(plan.notes.join(' ')).toContain('2 files (0 MB) are not on this PC (online only)');
    // the job reads only the local files and the drive gets exactly those
    const done = await run(plan);
    expect(done.error).toBeNull();
    expect(fs.readdirSync(path.join(backupsFolder(drive), 'OneDrive'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jpg') || f.endsWith('.docx') || f.endsWith('.mp4')).toSorted()).toEqual([
      path.join('Documents', 'b.docx'),
      path.join('Pictures', 'a.jpg'),
    ]);
  });

  it('says so when only online-only files are left, and still names them', async () => {
    addOneDriveFile('Videos/big.mp4', 9000, { onlineOnly: true });
    const result = await buildLocalCopyPlan(depsWithOneDrive(), oneDrivePlan(), 't7');
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('unexpected');
    expect(result.message).toContain('nothing new to copy');
    expect(result.message).toContain('not on this PC (online only)');
  });

  it('a laptop folder takes the copy: same layout, no catalog row, an existing same-size file counts as already there', async () => {
    addFile('final/a.mp4', 10_000);
    addFile('b.txt', 500);
    const id = collection();
    const first = await buildLocalCopyPlan(plannerDeps(), id, '', folder);
    if (!first.ok) throw new Error(first.message);
    expect(first.plan).toMatchObject({ targetPlaceId: '', targetFolder: folder, targetLabel: 'the laptop folder' });
    expect(first.plan.hash).toBe(hashLocalPlan(first.plan));
    const before = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
    const done = await run(first.plan);
    expect(done.error).toBeNull();
    expect(fs.existsSync(path.join(backupsFolder(folder), 'Reunion', 'final', 'a.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(backupsFolder(folder), 'Reunion', 'b.txt'))).toBe(true);
    expect(fs.readdirSync(drive)).toEqual([]); // the drive was not touched
    expect((db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBe(before); // nothing in the catalog
    const again = await buildLocalCopyPlan(plannerDeps(), id, '', folder);
    expect(again).toMatchObject({ ok: false });
    expect(partFiles()).toEqual([]);
  });

  it('refuses a laptop folder that is not there', async () => {
    addFile('b.txt', 500);
    const result = await buildLocalCopyPlan(plannerDeps(), collection(), '', path.join(dir, 'nowhere'));
    expect(result).toMatchObject({ ok: false });
  });

  it('the service makes a folder plan only for main (planToFolder) and starts it with a plain line', async () => {
    addFile('b.txt', 500);
    const created: { startedBy: string | null }[] = [];
    const service = new LocalCopyService({
      planner: plannerDeps(),
      drives: () => Promise.resolve([]),
      jobs: { create: (_k, _t, _p, startedBy) => (created.push({ startedBy: startedBy ?? null }), 1), list: () => [] },
      now: () => 1_000_000,
    });
    const made = await service.planToFolder(collection(), folder);
    if (!made.ok) throw new Error(made.message);
    expect(service.start({ planId: made.plan.id, hash: made.plan.hash, confirmed: true }, { startedBy: 'Started by you: Back up now' })).toMatchObject({ ok: true });
    expect(created).toEqual([{ startedBy: 'Started by you: Back up now' }]);
  });
});
