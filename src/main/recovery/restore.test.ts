import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPendingRestore, BEFORE_RESTORE_DIR_NAME, cancelPendingRestore, closeDatabase, copyDatabase, initDatabase, readPendingRestore, type Db } from '../db';
import { openReadOnly, quickCheckQuery } from '../query/queryCore';
import { VaultService, type KeyProtector } from '../vault/vaultService';
import { driveSettingsDir } from '../settings/saveToDrive';
import { writeRecoveryFile } from './recoveryFile';
import { restoreFromChosenFile, restoreFromSavedCopy, sniffFile, type RestoreDeps } from './restore';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const FAST = { N: 1024, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const COPY = 'backuphub-db-20261101-100000.db';

function fakeProtector(): KeyProtector {
  const machineKey = randomBytes(32);
  return {
    isAvailable: () => true,
    protect(plain: Buffer): Buffer {
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', machineKey, nonce);
      const body = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([nonce, c.getAuthTag(), body]);
    },
    unprotect(blob: Buffer): Buffer {
      const d = createDecipheriv('aes-256-gcm', machineKey, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
    },
  };
}

let dir: string; // the "old laptop" data folder lives in old/, the "new laptop" in new/
let oldDb: Db;
let drive: string;
let deps: RestoreDeps;
let freeBytes: number | null;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-restore-'));
  fs.mkdirSync(path.join(dir, 'old'));
  fs.mkdirSync(path.join(dir, 'new'));
  drive = path.join(dir, 'T7');
  fs.mkdirSync(driveSettingsDir(drive), { recursive: true });
  const opened = initDatabase(path.join(dir, 'old'), silent);
  if (!opened.ok) throw new Error('db did not open');
  oldDb = opened.db;
  oldDb.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('laptop', 1, 'laptop', 'Old laptop', '{}', 'connected', 1)").run();
  oldDb.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, 'Reunion', 'irreplaceable')").run();
  freeBytes = 500e9;
  deps = {
    dataDir: path.join(dir, 'new'),
    vault: new VaultService({ db: oldDb, dataDir: path.join(dir, 'old'), protector: fakeProtector(), kdf: FAST }),
    drives: () => [{ placeId: 't7', label: 'T7', root: drive }],
    checkInWorker: (file) => {
      const db = openReadOnly(file);
      try {
        return Promise.resolve(quickCheckQuery(db));
      } finally {
        db.close();
      }
    },
    freeBytes: () => freeBytes,
    now: () => 5000,
  };
  // A database copy saved on the T7 the way the settings job does it.
  await copyDatabase(oldDb, path.join(driveSettingsDir(drive), COPY));
});
afterEach(() => {
  closeDatabase(oldDb, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Restore Backup Hub', () => {
  it('stages a saved copy from the drive: checked, summarised, the drive untouched, nothing in use changed', async () => {
    const before = fs.readdirSync(driveSettingsDir(drive));
    const r = await restoreFromSavedCopy(deps, 't7', COPY, true);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 collection/);
    expect(readPendingRestore(deps.dataDir)).toMatchObject({ source: `T7: ${COPY}`, stagedAt: 5000 });
    expect(fs.readdirSync(driveSettingsDir(drive))).toEqual(before);
    expect(fs.existsSync(path.join(deps.dataDir, 'backuphub.db'))).toBe(false); // nothing swapped yet
  });

  it('asks first, and refuses unknown drives, names it does not own and missing copies', async () => {
    expect((await restoreFromSavedCopy(deps, 't7', COPY, false)).ok).toBe(false);
    expect((await restoreFromSavedCopy(deps, 'nope', COPY, true)).ok).toBe(false);
    expect((await restoreFromSavedCopy(deps, 't7', '../../evil.db', true)).ok).toBe(false);
    expect((await restoreFromSavedCopy(deps, 't7', 'backuphub-db-20200101-000000.db', true)).ok).toBe(false);
    expect(readPendingRestore(deps.dataDir)).toBeNull();
  });

  it('refuses a damaged copy, a stranger database and a too-new version, leaving nothing staged', async () => {
    const good = fs.readFileSync(path.join(driveSettingsDir(drive), COPY));
    const bad = path.join(dir, 'bad.db');
    fs.writeFileSync(bad, Buffer.concat([good.subarray(0, 4096), randomBytes(good.length - 4096)]));
    expect((await restoreFromChosenFile(deps, bad, null, true)).ok).toBe(false);
    const other = path.join(dir, 'other.db');
    const o = new Database(other);
    o.exec('CREATE TABLE t (x)');
    o.close();
    expect((await restoreFromChosenFile(deps, other, null, true)).message).toMatch(/not a Backup Hub database/);
    const newer = path.join(dir, 'newer.db');
    fs.copyFileSync(path.join(driveSettingsDir(drive), COPY), newer);
    const n = new Database(newer);
    n.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    n.close();
    expect((await restoreFromChosenFile(deps, newer, null, true)).message).toMatch(/newer Backup Hub/);
    fs.writeFileSync(path.join(dir, 'text.txt'), 'hello');
    expect((await restoreFromChosenFile(deps, path.join(dir, 'text.txt'), null, true)).ok).toBe(false);
    expect(readPendingRestore(deps.dataDir)).toBeNull();
    expect(fs.readdirSync(path.join(deps.dataDir, 'restore'))).toEqual([]);
  });

  it('refuses when there is not enough room', async () => {
    freeBytes = 1000;
    const r = await restoreFromSavedCopy(deps, 't7', COPY, true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/enough free space/);
  });

  it('a recovery file from Google Drive restores on a new laptop with only the passphrase', async () => {
    const vault = new VaultService({ db: oldDb, dataDir: path.join(dir, 'old'), protector: fakeProtector(), kdf: FAST });
    vault.putSecret('google.client', 'secret');
    expect((await vault.setPassphrase(PASS)).ok).toBe(true);
    const kit = vault.recoveryKit()!;
    const copy = path.join(dir, 'copy.db');
    await copyDatabase(oldDb, copy);
    const file = path.join(dir, 'backuphub-recovery-20261102-090000.bhrc');
    await writeRecoveryFile(copy, file, kit.key, { createdAt: 1, appVersion: '0.1.0', vault: kit.record });
    expect(sniffFile(file)).toBe('recovery');

    const newLaptop: RestoreDeps = { ...deps, vault: new VaultService({ db: oldDb, dataDir: path.join(dir, 'new'), protector: fakeProtector(), kdf: FAST }) };
    expect((await restoreFromChosenFile(newLaptop, file, null, true)).needsPassphrase).toBe(true);
    const wrong = await restoreFromChosenFile(newLaptop, file, 'not the right one at all', true);
    expect(wrong).toMatchObject({ ok: false, needsPassphrase: true });
    expect(readPendingRestore(deps.dataDir)).toBeNull();
    const ok = await restoreFromChosenFile(newLaptop, file, PASS, true);
    expect(ok.ok).toBe(true);
    expect(readPendingRestore(deps.dataDir)?.summary).toMatch(/1 collection/);
  });

  it('the next start swaps it in and keeps the old database aside; a cancel drops only the staged files', async () => {
    // The "new laptop" already has a (fresh) database that must not be lost.
    const fresh = initDatabase(deps.dataDir, silent);
    if (!fresh.ok) throw new Error('db did not open');
    fresh.db.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, 'Fresh', 'replaceable')").run();
    closeDatabase(fresh.db, silent);
    expect((await restoreFromSavedCopy(deps, 't7', COPY, true)).ok).toBe(true);

    // Cancel first: staged files go, the database in use stays.
    expect(cancelPendingRestore(deps.dataDir)).toBe(true);
    expect(readPendingRestore(deps.dataDir)).toBeNull();
    expect(fs.existsSync(path.join(deps.dataDir, 'backuphub.db'))).toBe(true);

    expect((await restoreFromSavedCopy(deps, 't7', COPY, true)).ok).toBe(true);
    const reopened = initDatabase(deps.dataDir, silent, () => 1);
    if (!reopened.ok) throw new Error('db did not open after the restore');
    const names = (reopened.db.prepare('SELECT name FROM collections ORDER BY id').all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['Reunion']);
    closeDatabase(reopened.db, silent);
    expect(readPendingRestore(deps.dataDir)).toBeNull();
    // The database that was in use is moved aside, whole.
    const asideRoot = path.join(deps.dataDir, BEFORE_RESTORE_DIR_NAME);
    const stamps = fs.readdirSync(asideRoot);
    expect(stamps).toHaveLength(1);
    const aside = new Database(path.join(asideRoot, stamps[0]!, 'backuphub.db'), { readonly: true });
    expect((aside.prepare('SELECT name FROM collections').all() as { name: string }[]).map((r) => r.name)).toEqual(['Fresh']);
    aside.close();
  });

  it('applyPendingRestore does nothing when nothing is staged', () => {
    expect(applyPendingRestore(deps.dataDir, silent)).toBe(false);
    expect(fs.existsSync(path.join(deps.dataDir, BEFORE_RESTORE_DIR_NAME))).toBe(false);
  });
});
