import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, copyDatabase, initDatabase, type Db } from '../db';
import { openReadOnly, quickCheckQuery } from '../query/queryCore';
import { removeOldCopies, testSavedCopy, type SavedCopyActionDeps } from './savedCopyActions';
import { dbCopyFileName, driveSettingsDir, listOwnFiles, settingsFileName } from './saveToDrive';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let root: string;
let scratch: string;
let db: Db;
let keep: number;

const deps = (extra: Partial<SavedCopyActionDeps> = {}): SavedCopyActionDeps => ({
  drives: () => [{ placeId: 't7', label: 'T7', root }],
  keep: () => keep,
  checkInWorker: (file) => {
    const copy = openReadOnly(file);
    try {
      return Promise.resolve(quickCheckQuery(copy));
    } finally {
      copy.close();
    }
  },
  freeBytes: () => 10_000_000_000,
  scratchRoot: scratch,
  ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-sc-'));
  root = path.join(dir, 'T7');
  scratch = path.join(dir, 'scratch');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(driveSettingsDir(root), { recursive: true });
  keep = 3;
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** n pairs of saved files, one per day, oldest first. */
function save(n: number): void {
  for (let i = 1; i <= n; i += 1) {
    const at = new Date(2026, 9, i, 10, 0, 0);
    fs.writeFileSync(path.join(driveSettingsDir(root), settingsFileName(at)), '{"profiles":[]}');
    fs.writeFileSync(path.join(driveSettingsDir(root), dbCopyFileName(at)), 'not a database');
  }
}

describe('removeOldCopies', () => {
  it('needs the confirmation and removes nothing without it', () => {
    save(5);
    expect(removeOldCopies(deps(), 't7', false)).toMatchObject({ ok: false });
    expect(removeOldCopies(deps(), 't7', undefined)).toMatchObject({ ok: false });
    expect(fs.readdirSync(driveSettingsDir(root))).toHaveLength(10);
  });

  it('removes only our own files older than the newest few, and nothing else on the drive', () => {
    save(5);
    const other = path.join(driveSettingsDir(root), 'notes.txt');
    const lookalike = path.join(driveSettingsDir(root), 'backuphub-db-2020.db');
    const mine = path.join(root, 'MyData.txt');
    fs.writeFileSync(other, 'x');
    fs.writeFileSync(lookalike, 'x');
    fs.writeFileSync(mine, 'x');
    const result = removeOldCopies(deps(), 't7', true);
    expect(result.ok).toBe(true);
    expect(listOwnFiles(driveSettingsDir(root), /^backuphub-db-\d{8}-\d{6}\.db$/)).toHaveLength(3);
    expect(listOwnFiles(driveSettingsDir(root), /^backuphub-settings-\d{8}-\d{6}\.json$/)).toHaveLength(3);
    for (const f of [other, lookalike, mine]) expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a drive that is not plugged in', () => {
    save(5);
    expect(removeOldCopies(deps({ drives: () => [] }), 't7', true)).toMatchObject({ ok: false });
    expect(removeOldCopies(deps(), 'other', true)).toMatchObject({ ok: false });
    expect(fs.readdirSync(driveSettingsDir(root))).toHaveLength(10);
  });
});

describe('testSavedCopy', () => {
  it('opens a good database copy, reports what it holds, leaves the drive and no scratch file behind', async () => {
    const name = dbCopyFileName(new Date(2026, 9, 1, 10, 0, 0));
    await copyDatabase(db, path.join(driveSettingsDir(root), name));
    const before = fs.statSync(path.join(driveSettingsDir(root), name)).mtimeMs;
    const result = await testSavedCopy(deps(), 't7', name);
    expect(result.ok).toBe(true);
    expect(result.details?.profiles).toBeGreaterThanOrEqual(1);
    expect(fs.statSync(path.join(driveSettingsDir(root), name)).mtimeMs).toBe(before);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('says a damaged copy is damaged', async () => {
    const name = dbCopyFileName(new Date(2026, 9, 1, 10, 0, 0));
    fs.writeFileSync(path.join(driveSettingsDir(root), name), Buffer.alloc(8192, 1));
    const result = await testSavedCopy(deps({ checkInWorker: () => Promise.resolve({ ok: false, messages: ['file is not a database'] }) }), 't7', name);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('damaged');
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('refuses names that are not our saved files, and checks free space first', async () => {
    const name = dbCopyFileName(new Date(2026, 9, 1, 10, 0, 0));
    await copyDatabase(db, path.join(driveSettingsDir(root), name));
    expect((await testSavedCopy(deps(), 't7', '../../etc/passwd')).ok).toBe(false);
    expect((await testSavedCopy(deps(), 't7', 'backuphub-db-20200101-000000.db')).ok).toBe(false);
    const tight = await testSavedCopy(deps({ freeBytes: () => 1000 }), 't7', name);
    expect(tight.ok).toBe(false);
    expect(tight.message).toContain('not enough free space');
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('reads a settings file', async () => {
    save(1);
    const name = fs.readdirSync(driveSettingsDir(root)).find((n) => n.endsWith('.json'))!;
    expect((await testSavedCopy(deps(), 't7', name)).ok).toBe(true);
  });
});
