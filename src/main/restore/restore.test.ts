import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESTORE_JOB_KIND, type RestorePick, type RestorePlanView } from '../../shared/restore';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import { NeedsSignInError } from '../google/auth';
import { NetworkError } from '../google/googleHttp';
import { RestoreService } from './restoreService';
import { restoreHandler, type RestoreJobParams } from './restoreJob';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = Date.UTC(2026, 10, 26, 12);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const content = (seed: string, size: number): Buffer => {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 32) createHash('sha256').update(`${seed}:${i}`).digest().copy(out, i, 0, Math.min(32, size - i));
  return out;
};

let dir: string;
let db: Db;
let backupId: number;
/** Which places are plugged in (their folder on this computer); a place not in the map is not plugged in. */
let plugged: Map<string, string>;
/** What Google's download gives, by Drive id; a function says what to do instead. */
let googleBytes: Map<string, Buffer>;
let googleAsked: string[];
let googleBehaviour: ((extId: string) => Promise<void>) | null;
let created: { kind: string; params: RestoreJobParams }[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-restore-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'T7'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Sea'), { recursive: true });
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  const place = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, ?, ?, ?, ?, 1)');
  place.run('t7', 'drive', 'T7', '{}', 'connected');
  place.run('sea', 'drive', 'Seagate2TB', '{}', 'connected');
  place.run('g1', 'gdrive', 'Google 1', '{}', 'connected');
  place.run('ph', 'phone', 'POCO F4', '{}', 'connected');
  backupId = Number(db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (1, 'Poco F4', 'phone', 'ph', '', 'S1', 'POCO', 'size_and_date', 1)").run().lastInsertRowid);
  const dest = db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, position) VALUES (?, ?, ?, ?, ?)');
  dest.run(backupId, 't7', 'MyData/POCO', 'primary', 1);
  dest.run(backupId, 'sea', 'MyData/POCO', 'copy', 2);
  plugged = new Map([
    ['t7', path.join(dir, 'T7')],
    ['sea', path.join(dir, 'Sea')],
  ]);
  googleBytes = new Map();
  googleAsked = [];
  googleBehaviour = null;
  created = [];
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Made {
  rel: string;
  data: Buffer;
  t7: number;
}

const DAY = 'POCO-23Nov26';

/** A file of the backup on the T7 (and the Seagate, and Google when asked): bytes on disk and rows in the index. */
function backedUp(below: string, data: Buffer, where: { t7?: boolean; sea?: boolean; google?: boolean; sha?: string | null; verifiedHow?: string | null } = {}): Made {
  const { t7 = true, sea = false, google = false } = where;
  const checksum = where.sha === undefined ? sha(data) : where.sha;
  const ins = db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_at, verified_how, ext_id) VALUES (?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?, ?, ?)');
  const put = (placeId: string, folder: string): number => {
    const abs = path.join(folder, 'MyData', 'POCO', ...below.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    fs.utimesSync(abs, 1_700_000_000, 1_700_000_000); // the copy on the drive has the file's own date
    return Number(ins.run(placeId, `MyData/POCO/${below}`, data.length, 1_700_000_000_000, checksum, null, checksum, null, where.verifiedHow ?? null, null).lastInsertRowid);
  };
  let t7Id = 0;
  if (t7) t7Id = put('t7', path.join(dir, 'T7'));
  if (sea) put('sea', path.join(dir, 'Sea'));
  if (google) {
    const extId = `gid-${below.replace(/\W/g, '')}`;
    ins.run('g1', `My Drive/Backup Hub/Poco F4/${below}`, data.length, null, checksum, null, null, 1, 'google-md5', extId);
    googleBytes.set(extId, data);
  }
  return { rel: below, data, t7: t7Id };
}

const pickDay = (items: string[] = [], folder: string | null = DAY): RestorePick => ({ kind: 'date', backupId, folder, items });
const baseOf = (placeId: string): Promise<string | null> => Promise.resolve(plugged.get(placeId) ?? null);

function service(): RestoreService {
  return new RestoreService({
    db,
    jobs: {
      create: (kind, _title, params) => {
        created.push({ kind, params: params as RestoreJobParams });
        return created.length;
      },
    },
    drives: () => Promise.resolve([...plugged.entries()].map(([placeId, root]) => ({ placeId, label: placeId === 't7' ? 'T7' : 'Seagate2TB', root }))),
    defaultParent: () => Promise.resolve(path.join(dir, 'Restored')),
    freeBytes: () => Promise.resolve(500_000_000_000),
    now: () => NOW,
    pause: () => Promise.resolve(),
  });
}

async function planOf(pick: RestorePick, mode: 'new' | 'original' = 'new'): Promise<RestorePlanView> {
  const r = await service().plan({ pick, destination: { mode } });
  if (!r.ok) throw new Error(r.message);
  return r.plan;
}

interface Run {
  message: string;
  warns: string[];
  logs: string[];
  checkpoints: { next: number; folder: string | null }[];
  error: unknown;
}

async function runPlan(pick: RestorePick, options: { resume?: unknown; abortAfterYields?: number; params?: (p: RestoreJobParams) => void } = {}): Promise<Run> {
  const svc = new RestoreService({
    db,
    jobs: {
      create: (kind, _title, params) => {
        created.push({ kind, params: params as RestoreJobParams });
        return created.length;
      },
    },
    drives: () => Promise.resolve([...plugged.entries()].map(([placeId, root]) => ({ placeId, label: placeId === 't7' ? 'T7' : 'Seagate2TB', root }))),
    defaultParent: () => Promise.resolve(path.join(dir, 'Restored')),
    freeBytes: () => Promise.resolve(500_000_000_000),
    now: () => NOW,
    pause: () => Promise.resolve(),
  });
  const planned = await svc.plan({ pick, destination: { mode: 'new' } });
  if (!planned.ok) throw new Error(planned.message);
  const started = svc.start({ planId: planned.plan.planId, confirmed: true });
  if (!started.ok) throw new Error(started.message);
  const params = created[created.length - 1]!.params;
  options.params?.(params);
  return runJob(params, options);
}

async function runJob(params: RestoreJobParams, options: { resume?: unknown; abortAfterYields?: number } = {}): Promise<Run> {
  const out: Run = { message: '', warns: [], logs: [], checkpoints: [], error: null };
  let yields = 0;
  const ctx: JobContext = {
    jobId: 1,
    params,
    resume: options.resume ?? null,
    signal: new AbortController().signal,
    progress: () => {},
    log: (_l, t) => void out.logs.push(t),
    warn: (t) => void out.warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: (v) => void out.checkpoints.push(JSON.parse(JSON.stringify(v))),
    yield: () => {
      yields += 1;
      if (yields > (options.abortAfterYields ?? Infinity)) return Promise.reject(new JobAborted());
      return Promise.resolve();
    },
  };
  const handler = restoreHandler({
    db,
    log: silent,
    baseOf,
    freeBytes: () => Promise.resolve(500_000_000_000),
    chunkBytes: 4096,
    download: async (_placeId, extId, tmpFile, o) => {
      googleAsked.push(extId);
      if (googleBehaviour) await googleBehaviour(extId);
      const bytes = googleBytes.get(extId);
      if (!bytes) throw new Error('not in the fake Google');
      fs.writeFileSync(tmpFile, bytes, { flag: 'wx' });
      if (bytes.length !== o.size) throw new Error('size');
      return bytes.length;
    },
  });
  try {
    const result = await handler.run(ctx);
    out.message = typeof result === 'string' ? result : (result?.message ?? '');
  } catch (err) {
    out.error = err;
  }
  return out;
}

const restoredFolder = (n = 1): string => path.join(dir, 'Restored', n === 1 ? 'Poco F4-2026-11-26' : `Poco F4-2026-11-26 (${n})`);
const read = (...p: string[]): Buffer => fs.readFileSync(path.join(...p));
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isFile()) out[rel] = `${fs.statSync(abs).size}:${sha(fs.readFileSync(abs))}:${Math.trunc(fs.statSync(abs).mtimeMs)}`;
  }
  return out;
};
const leftovers = (): string[] => (fs.existsSync(path.join(dir, 'Restored')) ? fs.readdirSync(path.join(dir, 'Restored'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.bhtmp')) : []);

describe('Get files back from a drive', () => {
  it('lists the days, then a folder with sizes and what cannot come back', async () => {
    backedUp(`${DAY}/DCIM/a.jpg`, content('a', 3000));
    backedUp(`${DAY}/DCIM/Camera/b.jpg`, content('b', 2000));
    backedUp(`${DAY}/notes.txt`, content('n', 100), { sha: null });
    backedUp('POCO-20Nov26/old.txt', content('o', 50));
    const svc = service();
    const dates = await svc.dates(backupId);
    expect(dates.ok && dates.dates.map((d) => d.folder)).toEqual([DAY, 'POCO-20Nov26']);
    const top = await svc.browse({ backupId, folder: DAY, path: '' });
    expect(top.ok && top.entries.map((e) => [e.name, e.folder, e.files, e.bytes, e.held])).toEqual([
      ['DCIM', true, 2, 5000, 0],
      ['notes.txt', false, 1, 100, 1],
    ]);
    const deeper = await svc.browse({ backupId, folder: DAY, path: 'DCIM' });
    expect(deeper.ok && deeper.entries.map((e) => e.name)).toEqual(['Camera', 'a.jpg']);
    expect((await svc.browse({ backupId, folder: DAY, path: '../x' })).ok).toBe(false);
    expect((await svc.browse({ backupId, folder: 'NOT-A-DAY', path: '' })).ok).toBe(false);
  });

  it('copies the ticked folder into a new folder, checks every file and never touches the drive', async () => {
    const a = backedUp(`${DAY}/DCIM/a.jpg`, content('a', 9000));
    const b = backedUp(`${DAY}/DCIM/Camera/b.jpg`, content('b', 5000));
    backedUp(`${DAY}/other/c.txt`, content('c', 700));
    const before = snapshot(path.join(dir, 'T7'));
    const plan = await planOf(pickDay(['DCIM/']));
    expect(plan).toMatchObject({ files: 2, bytes: 14_000, fromGoogle: 0, fromWords: 'T7 and Seagate2TB', notAvailable: 0 });
    expect(plan.toWords).toBe(restoredFolder());
    const run = await runPlan(pickDay(['DCIM/']));
    expect(run.error).toBeNull();
    expect(run.message).toMatch(/^Got back 2 files \(14 KB\)/);
    expect(run.message).toContain('Nothing was overwritten or deleted');
    expect(read(restoredFolder(), 'DCIM', 'a.jpg').equals(a.data)).toBe(true);
    expect(read(restoredFolder(), 'DCIM', 'Camera', 'b.jpg').equals(b.data)).toBe(true);
    expect(fs.existsSync(path.join(restoredFolder(), 'other'))).toBe(false);
    expect(Math.trunc(fs.statSync(path.join(restoredFolder(), 'DCIM', 'a.jpg')).mtimeMs)).toBe(1_700_000_000_000);
    expect(snapshot(path.join(dir, 'T7'))).toEqual(before); // the drive is exactly as it was
    expect(leftovers()).toEqual([]);
  });

  it('a second restore goes into a new folder with (2); nothing already there is replaced', async () => {
    backedUp(`${DAY}/a.txt`, content('a', 500));
    await runPlan(pickDay());
    fs.writeFileSync(path.join(restoredFolder(), 'a.txt'), 'edited by the person');
    const again = await runPlan(pickDay());
    expect(again.error).toBeNull();
    expect(read(restoredFolder(), 'a.txt').toString()).toBe('edited by the person');
    expect(read(restoredFolder(2), 'a.txt').length).toBe(500);
  });

  it('a name already in the folder stays as it is ("already there")', async () => {
    backedUp(`${DAY}/a.txt`, content('a', 500));
    backedUp(`${DAY}/b.txt`, content('b', 600));
    fs.mkdirSync(restoredFolder(), { recursive: true });
    fs.writeFileSync(path.join(restoredFolder(), 'a.txt'), 'mine');
    const run = await runPlan(pickDay(), { resume: { next: 0, folder: restoredFolder() } });
    expect(run.error).toBeNull();
    expect(run.message).toContain('1 file already there, kept as it is');
    expect(run.message).toContain('Got back 1 file');
    expect(read(restoredFolder(), 'a.txt').toString()).toBe('mine');
    expect(read(restoredFolder(), 'b.txt').length).toBe(600);
  });

  it('the newest copy of every file comes back once', async () => {
    backedUp('POCO-20Nov26/x.txt', content('old', 100));
    const fresh = backedUp('POCO-23Nov26/x.txt', content('new', 100));
    backedUp('POCO-20Nov26/only-old.txt', content('o', 40));
    const run = await runPlan({ kind: 'newest', backupId });
    expect(run.message).toMatch(/^Got back 2 files/);
    expect(read(restoredFolder(), 'x.txt').equals(fresh.data)).toBe(true);
    expect(fs.existsSync(path.join(restoredFolder(), 'only-old.txt'))).toBe(true);
  });

  it('a file with no known checksum, or found different, is held back and listed', async () => {
    backedUp(`${DAY}/good.txt`, content('g', 300));
    backedUp(`${DAY}/unchecked.txt`, content('u', 300), { sha: null });
    backedUp(`${DAY}/different.txt`, content('d', 300), { verifiedHow: 'differs' });
    const plan = await planOf(pickDay());
    expect(plan.files).toBe(1);
    expect(plan.held.count).toBe(2);
    expect(plan.held.examples.map((h) => h.path).toSorted()).toEqual(['different.txt', 'unchecked.txt']);
    const run = await runPlan(pickDay());
    expect(run.message).toContain('2 files not brought back (1 never checked, 1 found different)');
    expect(run.warns.some((w) => w.startsWith('unchecked.txt:'))).toBe(true);
    expect(fs.existsSync(path.join(restoredFolder(), 'unchecked.txt'))).toBe(false);
  });
});

describe('Get files back: the next copy', () => {
  it('a drive copy that no longer matches its checksum is thrown away and the next drive is used', async () => {
    const a = backedUp(`${DAY}/a.bin`, content('a', 8000), { sea: true });
    backedUp(`${DAY}/b.bin`, content('b', 8000), { sea: true });
    fs.writeFileSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, 'a.bin'), content('rotten', 8000)); // same size, other bytes
    const run = await runPlan(pickDay());
    expect(run.error).toBeNull();
    expect(read(restoredFolder(), 'a.bin').equals(a.data)).toBe(true);
    expect(run.message).toContain('Got back 2 files');
    expect(run.message).toContain('1 from the next drive because the first copy did not match');
    expect(run.warns).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('when every copy is bad the file is not brought back, and nothing wrong is left in the new folder', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 8000), { sea: true });
    backedUp(`${DAY}/ok.bin`, content('ok', 100));
    fs.writeFileSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, 'a.bin'), content('rotten1', 8000));
    fs.writeFileSync(path.join(dir, 'Sea', 'MyData', 'POCO', DAY, 'a.bin'), content('rotten2', 8000));
    const run = await runPlan(pickDay());
    expect(run.message).toContain('1 file not brought back (1 did not match their checksum)');
    expect(fs.existsSync(path.join(restoredFolder(), 'a.bin'))).toBe(false);
    expect(fs.existsSync(path.join(restoredFolder(), 'ok.bin'))).toBe(true);
    expect(run.warns.join(' ')).toContain('a.bin: No copy could be used');
    expect(leftovers()).toEqual([]);
  });

  it('the Seagate is used when the T7 is not plugged in', async () => {
    const a = backedUp(`${DAY}/a.bin`, content('a', 4000), { sea: true });
    plugged.delete('t7');
    const plan = await planOf(pickDay());
    expect(plan.fromWords).toBe('Seagate2TB');
    const run = await runPlan(pickDay());
    expect(run.message).toMatch(/^Got back 1 file/);
    expect(read(restoredFolder(), 'a.bin').equals(a.data)).toBe(true);
  });

  it('Google is used (a download, checked against the SHA-256) when no drive copy can be used, and says so', async () => {
    const a = backedUp(`${DAY}/a.bin`, content('a', 5000), { google: true });
    const b = backedUp(`${DAY}/b.bin`, content('b', 6000), { google: true });
    plugged.clear();
    const plan = await planOf(pickDay());
    expect(plan).toMatchObject({ files: 2, fromGoogle: 2, fromWords: 'Google' });
    const run = await runPlan(pickDay());
    expect(run.error).toBeNull();
    expect(run.message).toMatch(/^Got back 2 files \(11 KB\), 2 from Google/);
    expect(read(restoredFolder(), 'a.bin').equals(a.data)).toBe(true);
    expect(read(restoredFolder(), 'b.bin').equals(b.data)).toBe(true);
    expect(Math.trunc(fs.statSync(path.join(restoredFolder(), 'a.bin')).mtimeMs)).toBe(1_700_000_000_000);
    expect(googleAsked).toHaveLength(2);
    expect(leftovers()).toEqual([]);
  });

  it('a drive copy is used before Google, and Google only after the drive copies failed', async () => {
    const a = backedUp(`${DAY}/a.bin`, content('a', 5000), { google: true });
    backedUp(`${DAY}/b.bin`, content('b', 5000), { google: true });
    fs.writeFileSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, 'b.bin'), content('rotten', 5000));
    plugged.delete('sea');
    const run = await runPlan(pickDay());
    expect(run.message).toMatch(/^Got back 2 files \(10 KB\), 1 from Google/);
    expect(googleAsked).toHaveLength(1);
    expect(googleAsked[0]).toContain('bbin');
    expect(read(restoredFolder(), 'a.bin').equals(a.data)).toBe(true);
  });

  it('a Google download with wrong bytes is thrown away: nothing is kept, nothing is left behind', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 5000), { google: true });
    backedUp(`${DAY}/ok.bin`, content('ok', 100));
    plugged.delete('sea');
    plugged.set('t7', path.join(dir, 'T7'));
    fs.rmSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, 'a.bin')); // the T7 lost it
    for (const [id] of googleBytes) googleBytes.set(id, content('someone else', 5000)); // Google serves other bytes of the same size
    const run = await runPlan(pickDay());
    expect(run.message).toContain('1 file not brought back (1 did not match their checksum)');
    expect(fs.existsSync(path.join(restoredFolder(), 'a.bin'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('Google out of reach: after three failures it is not asked again, and the report says why', async () => {
    for (let i = 0; i < 6; i += 1) {
      backedUp(`${DAY}/f${i}.bin`, content(`f${i}`, 1000), { google: true });
      fs.rmSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, `f${i}.bin`)); // the T7 lost them: only Google has them
    }
    backedUp(`${DAY}/here.bin`, content('here', 1000));
    googleBehaviour = () => Promise.reject(new NetworkError('offline'));
    const run = await runPlan(pickDay());
    expect(googleAsked).toHaveLength(3);
    expect(run.warns.filter((w) => w.startsWith('Google could not be reached'))).toHaveLength(1);
    expect(run.message).toContain('6 files not brought back');
    expect(run.message).toMatch(/^Got back 1 file/);
  });

  it('a Google account that is not signed in is a reason, not a crash', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 1000), { google: true });
    backedUp(`${DAY}/ok.bin`, content('ok', 100));
    fs.rmSync(path.join(dir, 'T7', 'MyData', 'POCO', DAY, 'a.bin'));
    googleBehaviour = () => Promise.reject(new NeedsSignInError('g1'));
    const run = await runPlan(pickDay());
    expect(run.error).toBeNull();
    expect(run.warns.join(' ')).toContain('not signed in');
  });

  it('with no plugged-in drive and no Google copy the pick is refused with a plain sentence', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 1000));
    plugged.clear();
    const r = await service().plan({ pick: pickDay(), destination: { mode: 'new' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('No copy can be reached now');
  });
});

describe('Get files back: the Files screen', () => {
  it('a file picked by its id (a drive copy, or the Google row) comes back from the best copy', async () => {
    const a = backedUp(`${DAY}/a.bin`, content('a', 2000), { google: true });
    const gRow = db.prepare("SELECT id FROM files WHERE place_id = 'g1'").pluck().get() as number;
    const plan = await planOf({ kind: 'files', fileIds: [a.t7, gRow] });
    expect(plan.files).toBe(1); // the same file once
    const run = await runPlan({ kind: 'files', fileIds: [gRow] });
    expect(run.error).toBeNull();
    expect(read(restoredFolder(), 'a.bin').equals(a.data)).toBe(true);
  });
});

describe('Get files back: the job', () => {
  it('stops cleanly and continues where it was: every file once, none twice', async () => {
    for (let i = 0; i < 12; i += 1) backedUp(`${DAY}/f${String(i).padStart(2, '0')}.bin`, content(`f${i}`, 3000));
    const first = await runPlan(pickDay(), { abortAfterYields: 20 });
    expect(first.error).toBeInstanceOf(JobAborted);
    const last = first.checkpoints[first.checkpoints.length - 1]!;
    expect(last.folder).toBe(restoredFolder());
    const params = created[created.length - 1]!.params;
    const second = await runJob(params, { resume: JSON.parse(JSON.stringify(last)) });
    expect(second.error).toBeNull();
    expect(fs.readdirSync(restoredFolder()).filter((n) => n.endsWith('.bin'))).toHaveLength(12);
    expect(fs.existsSync(restoredFolder(2))).toBe(false); // it went on in the same folder
    expect(leftovers()).toEqual([]);
  });

  it('fails plainly when nothing could be brought back', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 100), { sha: null });
    const plan = await service().plan({ pick: pickDay(), destination: { mode: 'new' } });
    expect(plan.ok).toBe(false); // the list itself says so before anything starts
  });

  it('runs only as the kind the job service knows', () => {
    expect(restoreHandler({ db, log: silent, baseOf, freeBytes: () => Promise.resolve(null) })).toMatchObject({ kind: RESTORE_JOB_KIND, heavy: true, resumable: true });
    expect(JobFailure.name).toBe('JobFailure');
  });
});

describe('Get files back: where it may write', () => {
  it('refuses a MyData folder and a folder that was not handed out; accepts one it handed out', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 100));
    const svc = service();
    expect(svc.chooseFolder('F:\\MyData\\x')).toMatchObject({ ok: false, canceled: false });
    expect(svc.chooseFolder('D:\\MyData')).toMatchObject({ ok: false });
    expect(svc.chooseFolder(null)).toMatchObject({ ok: false, canceled: true });
    const sneaky = await svc.plan({ pick: pickDay(), destination: { mode: 'new', parent: path.join(dir, 'somewhere') } });
    expect(sneaky.ok).toBe(false);
    const chosen = svc.chooseFolder(path.join(dir, 'Elsewhere'));
    expect(chosen.ok).toBe(true);
    const ok = await svc.plan({ pick: pickDay(), destination: { mode: 'new', parent: path.join(dir, 'Elsewhere') } });
    expect(ok.ok).toBe(true);
  });

  it('"back to where they were" is only offered for a folder backup', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 100));
    const r = await service().plan({ pick: pickDay(), destination: { mode: 'original' } });
    expect(!r.ok && r.message).toContain('cannot be put back where it was');
  });

  it('start needs the confirmed list main made', () => {
    const svc = service();
    expect(svc.start({ planId: 'nope', confirmed: true }).ok).toBe(false);
    expect(svc.start({ planId: 'nope', confirmed: false })).toMatchObject({ ok: false });
    expect(created).toEqual([]);
  });
});

describe('the days and the folders of a drive that is not plugged in', () => {
  it('are still listed from the index', async () => {
    backedUp(`${DAY}/a.bin`, content('a', 100), { google: true });
    plugged.clear();
    const svc = service();
    const info = await svc.info(backupId);
    expect(info).toMatchObject({ ok: true, from: null });
    expect(info.ok && info.message).toContain('Google');
    const dates = await svc.dates(backupId);
    expect(dates.ok && dates.dates).toHaveLength(1);
    const top = await svc.browse({ backupId, folder: DAY, path: '' });
    expect(top.ok && top.entries.map((e) => e.name)).toEqual(['a.bin']);
  });
});

export type { Made, RestorePlanView };
