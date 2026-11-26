import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '../shared/cleanup';
import { CleanStore } from './cleanup/cleanStore';
import { quarantineFolder } from './places/appFolders';
import { laptopCleanHandler, laptopConfirmed } from './cleanup/laptopCleanJob';
import { buildLaptopCleanPlan } from './cleanup/laptopCleanPlanner';
import { emptyQuarantine, undoLaptopRemoval, type QuarantineDeps } from './cleanup/quarantine';
import { hashConfirmed } from './danger';
import { closeDatabase, initDatabase, type Db } from './db';
import { DriveWriteProtectedError } from './fsutil';
import { JobFailure, type JobContext } from './jobs/jobService';
import { SettingsStore } from './settings/settingsStore';
import { writeSettingsExport } from './settings/exportImport';
import { KEY_FILE_NAME, VaultService, type KeyProtector } from './vault/vaultService';
import { protectFakeDrive, treeOf, unprotectFakeDrives } from './writeGuard.testutil';

/**
 * Behaviour on a fake protected drive ("T7" in a temp folder): the clean-up quarantine, the laptop clean-up job, the vault key
 * file and the settings export all REFUSE and leave every file on the drive exactly as it was (names, sizes, bytes).
 */
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = Date.now();
const LINE = 'T7 is read-only (protected), so nothing is written to it.';

let dir: string;
let t7: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-guardb-'));
  t7 = path.join(dir, 'T7');
  fs.mkdirSync(t7);
  fs.mkdirSync(path.join(dir, 'data'));
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES ('lap', 1, 'laptop', 'This laptop', '{}', 'connected', ?, 1)").run(NOW - 1000);
});
afterEach(() => {
  unprotectFakeDrives();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Everything on the drive: relative path, size and a hash of the bytes (folders have none). */
function snapshot(folder: string): string[] {
  return treeOf(folder).map((rel) => {
    const abs = path.join(folder, rel);
    const st = fs.statSync(abs);
    return st.isDirectory() ? `${rel}/` : `${rel}:${st.size}:${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
  });
}

const rel = (abs: string): string => abs.replaceAll('\\', '/');

function addFile(folder: string, name: string, seed: string, ageSeconds: number): string {
  const abs = path.join(folder, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const data = Buffer.alloc(2048, seed);
  fs.writeFileSync(abs, data);
  const t = new Date(NOW - ageSeconds * 1000);
  fs.utimesSync(abs, t, t);
  db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)').run(
    'lap',
    rel(abs),
    2048,
    Math.trunc(fs.statSync(abs).mtimeMs),
    createHash('sha256').update(data).digest('hex'),
    createHash('md5').update(data).digest('hex'),
  );
  return abs;
}

function ctxFor(params: unknown): JobContext {
  return {
    jobId: 9,
    params,
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: () => {},
    needsYou: () => Promise.resolve('continue'),
    checkpoint: () => {},
    yield: () => Promise.resolve(),
  };
}

const jobDeps = (qroot: string) => ({ db, log: silent, quarantine: { rootFor: () => qroot, now: () => NOW } as QuarantineDeps, oneDriveRoots: () => [] as string[], driveRoots: () => Promise.resolve([] as string[]), now: () => NOW });
const plannerDeps = () => ({ db, oneDriveRoots: () => [] as string[], driveRoots: () => Promise.resolve([] as string[]), now: () => NOW, yieldNow: () => Promise.resolve() });

async function removeParams(keepName: string, removeName: string) {
  const r = await buildLaptopCleanPlan(plannerDeps());
  if (!r.ok) throw new Error(r.message);
  const g = r.plan.groups[0]!;
  const keep = g.members.find((m) => m.relPath.endsWith(`/${keepName}`))!;
  const gone = g.members.find((m) => m.relPath.endsWith(`/${removeName}`))!;
  const files = [{ relPath: gone.relPath, size: g.size, sha256: g.id, mtime: gone.mtime, keep: keep.relPath, keepSize: g.size, keepMtime: keep.mtime }];
  return { listId: 'test-list', listHash: hashConfirmed(laptopConfirmed(files)), files };
}

describe('laptop clean-up job on a protected drive', () => {
  it('moves nothing when the file or the quarantine folder is on the protected drive, and says so', async () => {
    const files = path.join(t7, 'photos');
    const qroot = quarantineFolder(t7);
    addFile(files, 'a.jpg', 'a', 5000);
    const dup = addFile(files, 'b.jpg', 'a', 10);
    protectFakeDrive(t7);
    const before = snapshot(t7);
    const params = await removeParams('a.jpg', 'b.jpg');
    const warns: string[] = [];
    const ctx = { ...ctxFor(params), warn: (t: string) => void warns.push(t) };
    await expect(laptopCleanHandler(jobDeps(qroot)).run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join('\n')).toContain(LINE);
    expect(snapshot(t7)).toEqual(before);
    expect(fs.existsSync(dup)).toBe(true);
    expect(fs.existsSync(qroot)).toBe(false);
    // The log line written before a move is taken back, the catalog row still live, no lock left behind.
    expect(db.prepare('SELECT count(*) AS n FROM removal_log').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM files WHERE gone_at IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('moves nothing when only the quarantine folder is on the protected drive (file on the laptop)', async () => {
    const laptop = path.join(dir, 'laptop');
    const qroot = quarantineFolder(t7);
    addFile(laptop, 'a.jpg', 'q', 5000);
    const dup = addFile(laptop, 'b.jpg', 'q', 10);
    protectFakeDrive(t7);
    const before = snapshot(t7);
    const params = await removeParams('a.jpg', 'b.jpg');
    await expect(laptopCleanHandler(jobDeps(qroot)).run(ctxFor(params))).rejects.toBeInstanceOf(JobFailure);
    expect(snapshot(t7)).toEqual(before);
    expect(fs.existsSync(dup)).toBe(true);
  });
});

describe('quarantine undo and emptying on a protected drive', () => {
  it('Undo and Empty refuse and leave every file where it is', async () => {
    const laptop = path.join(dir, 'laptop');
    const qroot = path.join(dir, 'quarantine');
    addFile(laptop, 'a.jpg', 'u', 5000);
    addFile(laptop, 'b.jpg', 'u', 10);
    const params = await removeParams('a.jpg', 'b.jpg');
    await laptopCleanHandler(jobDeps(qroot)).run(ctxFor(params)); // moved while the drive was not protected
    const row = db.prepare("SELECT id, quarantine_path AS q, removed_at AS t FROM removal_log WHERE kind = 'laptop'").get() as { id: number; q: string; t: number };
    expect(fs.existsSync(row.q)).toBe(true);

    // The same folders now count as a protected drive: its quarantine is frozen.
    protectFakeDrive(dir, 'T7');
    const quarantineBefore = snapshot(qroot);
    const store = (now: number) => new CleanStore(db, () => now);
    const deps: QuarantineDeps = { rootFor: () => qroot, now: () => NOW };
    const undo = await undoLaptopRemoval(deps, store(NOW), row.id);
    expect(undo.ok).toBe(false);
    expect(undo.message).toContain(LINE);
    const day = new Date(row.t);
    const dateText = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const late: QuarantineDeps = { rootFor: () => qroot, now: () => NOW + 31 * DAY_MS };
    const empty = await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 1, 2048);
    expect(empty.ok).toBe(false);
    expect(fs.existsSync(row.q)).toBe(true);
    expect(snapshot(qroot)).toEqual(quarantineBefore);
    expect(fs.existsSync(path.join(dir, 'laptop', 'b.jpg'))).toBe(false); // Undo did not put it back
  });
});

function fakeProtector(): KeyProtector {
  const machineKey = randomBytes(32);
  return {
    isAvailable: () => true,
    protect: (plain) => Buffer.concat([machineKey.subarray(0, 4), plain]),
    unprotect: (blob) => blob.subarray(4),
  };
}

describe('vault key file on a protected drive', () => {
  it('is not written there; the secrets stay as they were', async () => {
    const vaultDir = path.join(t7, 'data');
    fs.mkdirSync(vaultDir);
    protectFakeDrive(t7);
    const before = snapshot(t7);
    const vault = new VaultService({ db, dataDir: vaultDir, protector: fakeProtector(), kdf: { N: 1024, r: 8, p: 1 } });
    try {
      let outcome: unknown;
      try {
        outcome = await vault.setPassphrase('correct horse battery staple');
      } catch (err) {
        outcome = err;
      }
      expect(outcome).toMatchObject({ ok: false });
      expect(JSON.stringify(outcome)).toContain('Nothing was changed');
      expect(fs.existsSync(path.join(vaultDir, KEY_FILE_NAME))).toBe(false);
      expect(() => vault.forgetEverything(true)).toThrow(DriveWriteProtectedError);
      expect(fs.existsSync(path.join(vaultDir, KEY_FILE_NAME))).toBe(false);
    } finally {
      vault.close();
    }
    expect(snapshot(t7)).toEqual(before);
  });
});

describe('settings export on a protected drive', () => {
  it('refuses a file on the protected drive and creates nothing there', () => {
    protectFakeDrive(t7);
    const before = snapshot(t7);
    const target = path.join(t7, 'backuphub-settings.json');
    expect(() => writeSettingsExport(target, db, new SettingsStore(db), '1.0.0')).toThrow(DriveWriteProtectedError);
    expect(() => writeSettingsExport(path.join(t7, 'new-folder', 'x.json'), db, new SettingsStore(db), '1.0.0')).toThrow(LINE);
    expect(snapshot(t7)).toEqual(before);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still writes to an ordinary folder', () => {
    protectFakeDrive(t7);
    const target = path.join(dir, 'export.json');
    const counts = writeSettingsExport(target, db, new SettingsStore(db), '1.0.0');
    expect(counts.profiles).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).format).toBe('backuphub-settings');
  });
});
