import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPendingRestore, cancelPendingRestore, closeDatabase, copyDatabase, createSnapshot, createSnapshotAsync, initDatabase, pruneSnapshots, type Db } from './db';
import { assertWritable, configureWriteGuard, DriveWriteProtectedError, protectedDriveFor, resetWriteGuardForTests } from './fsutil';
import { CARD_FILE, CARD_PARTS, LEGACY_CARD_FOLDER, MY_DATA_FOLDER } from '../shared/appFolders';
import { cardFile, cardFolder } from './places/appFolders';
import { writeDriveCard } from './places/driveCard';
import { PlaceService } from './places/placeService';
import type { Volume } from './places/volumes';
import { restoreFromChosenFile } from './recovery/restore';
import { removeOldCopies } from './settings/savedCopyActions';
import { driveSettingsDir, pruneOwnFiles, saveToDriveRoot } from './settings/saveToDrive';
import { applyImport, buildExport, parseExport } from './settings/exportImport';
import { SettingsStore } from './settings/settingsStore';
import { putFakeCard, protectFakeDrive, treeOf, unprotectFakeDrives } from './writeGuard.testutil';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LINE = 'T7 is read-only (protected), so nothing is written to it.';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** What a drive that has only its ID card looks like (every folder down to the card, then the card), as `treeOf` lists it. */
const CARD_ONLY = [...CARD_PARTS.map((_, i) => path.join(...CARD_PARTS.slice(0, i + 1))), path.join(...CARD_PARTS, CARD_FILE)].toSorted();

let dir: string;
let t7: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-guard-'));
  t7 = path.join(dir, 'T7');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(t7);
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
});
afterEach(() => {
  unprotectFakeDrives();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const underT7 = (p: string): string | null => (p.startsWith(t7) ? t7 : null);

describe('assertWritable', () => {
  it('refuses a drive whose card carries a protected name or id, in any case, and says so plainly', () => {
    protectFakeDrive(t7, 'T7');
    expect(() => assertWritable(path.join(t7, 'BackupHub', 'x.bin'))).toThrow(DriveWriteProtectedError);
    expect(() => assertWritable(path.join(t7, 'BackupHub', 'x.bin'))).toThrow(LINE);
    configureWriteGuard({ protectedDrives: () => ['t7'], rootOf: underT7, systemRoot: 'ZZ:\\' });
    expect(protectedDriveFor(path.join(t7, 'a'))).toBe('T7');
    putFakeCard(t7, 'Renamed', ID);
    configureWriteGuard({ protectedDrives: () => [ID], rootOf: underT7, systemRoot: 'ZZ:\\' });
    expect(protectedDriveFor(path.join(t7, 'a'))).toBe('Renamed');
  });

  it('allows a drive with another name, a drive with no card, and anything once protection is switched off', () => {
    protectFakeDrive(t7, 'Backup', ['T7']);
    expect(() => assertWritable(path.join(t7, 'a'))).not.toThrow();
    const bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: (p) => (p.startsWith(bare) ? bare : null), systemRoot: 'ZZ:\\' });
    expect(() => assertWritable(path.join(bare, 'a'))).not.toThrow();
    protectFakeDrive(t7, 'T7', []);
    expect(() => assertWritable(path.join(t7, 'a'))).not.toThrow();
  });

  it('never lets anything be written at the old place of the ID card (the drive root), whatever the drive', () => {
    const old = path.join(dir, 'oldlayout');
    fs.mkdirSync(old);
    configureWriteGuard({ protectedDrives: () => [], rootOf: (p) => (p.startsWith(old) ? old : null), systemRoot: 'ZZ:\\' });
    expect(() => assertWritable(path.join(old, LEGACY_CARD_FOLDER, 'tmp', 'x.bhtmp'))).toThrow(/never writes there/);
    expect(() => assertWritable(path.join(old, LEGACY_CARD_FOLDER.toUpperCase(), CARD_FILE))).toThrow(DriveWriteProtectedError);
    expect(() => assertWritable(path.join(old, 'MyData', 'x.bin'))).not.toThrow();
    expect(() => assertWritable(cardFile(old))).not.toThrow(); // the new place is fine
  });

  it('allows an unknown drive letter and paths that are not on a lettered drive', () => {
    resetWriteGuardForTests();
    expect(() => assertWritable('Q:\\nothing\\here.txt')).not.toThrow();
    expect(() => assertWritable('\\\\server\\share\\x.txt')).not.toThrow();
  });

  it('fails closed when a card cannot be read, except on the system disk and on a fixed disk', () => {
    const odd = path.join(dir, 'odd');
    fs.mkdirSync(cardFolder(odd), { recursive: true });
    fs.writeFileSync(cardFile(odd), '{ not json');
    const map = (volume: { label: string | null; removable: boolean } | null, systemRoot = 'ZZ:\\') =>
      configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: (p) => (p.startsWith(odd) ? odd : null), systemRoot, volumeOf: () => volume });
    map(null);
    expect(() => assertWritable(path.join(odd, 'a'))).toThrow(/could not be identified/);
    map({ label: 'X', removable: true });
    expect(() => assertWritable(path.join(odd, 'a'))).toThrow(DriveWriteProtectedError);
    map({ label: 'X', removable: false });
    expect(() => assertWritable(path.join(odd, 'a'))).not.toThrow();
    map(null, odd.toUpperCase());
    expect(() => assertWritable(path.join(odd, 'a'))).not.toThrow();
  });

  it('recognises the drive by its volume label when its card is gone or unreadable', () => {
    putFakeCard(t7, 'T7');
    fs.rmSync(path.join(t7, MY_DATA_FOLDER), { recursive: true }); // the card and the folders around it
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: underT7, systemRoot: 'ZZ:\\' });
    expect(() => assertWritable(path.join(t7, 'a'))).not.toThrow(); // nothing says it is the T7
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: underT7, systemRoot: 'ZZ:\\', volumeOf: () => ({ label: 't7', removable: true }) });
    expect(() => assertWritable(path.join(t7, 'a'))).toThrow(DriveWriteProtectedError);
  });

  it('stays protected for the run when a protected drive card later cannot be read', () => {
    protectFakeDrive(t7, 'T7');
    expect(() => assertWritable(path.join(t7, 'a'))).toThrow(DriveWriteProtectedError);
    fs.rmSync(path.join(t7, MY_DATA_FOLDER), { recursive: true }); // the card and the folders around it
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: underT7, systemRoot: 'ZZ:\\', now: () => 99_999 });
    expect(() => assertWritable(path.join(t7, 'a'))).toThrow(LINE); // no card any more, but it was seen protected in this run
    configureWriteGuard({ protectedDrives: () => [], rootOf: underT7, systemRoot: 'ZZ:\\' });
    expect(() => assertWritable(path.join(t7, 'a'))).not.toThrow(); // switched off in Settings
  });

  it('keeps the last list it read when the setting later cannot be read', () => {
    putFakeCard(t7, 'T7');
    let clock = 0;
    let broken = false;
    configureWriteGuard({
      protectedDrives: () => {
        if (broken) throw new Error('db closed');
        return ['T7'];
      },
      rootOf: underT7,
      systemRoot: 'ZZ:\\',
      now: () => clock,
    });
    expect(() => assertWritable(path.join(t7, 'a'))).toThrow(DriveWriteProtectedError);
    broken = true;
    clock = 60_000;
    expect(() => assertWritable(path.join(t7, 'a'))).toThrow(DriveWriteProtectedError);
  });
});

describe('every write path refuses a protected drive and changes nothing', () => {
  beforeEach(() => {
    protectFakeDrive(t7, 'T7');
  });

  it('the ID card (driveCard.ts)', () => {
    fs.rmSync(path.join(t7, MY_DATA_FOLDER), { recursive: true }); // the card and the folders around it
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: underT7, systemRoot: 'ZZ:\\', volumeOf: () => ({ label: 'T7', removable: true }) });
    expect(() => writeDriveCard(t7, { id: ID, name: 'Other', createdAt: '', appVersion: '1' })).toThrow(LINE);
    expect(treeOf(t7)).toEqual([]);
  });

  it('naming a drive whose volume label is a protected name (placeService.ts)', async () => {
    const root = path.join(dir, 'named');
    fs.mkdirSync(root);
    const volume: Volume = { letter: 'E:', label: 'T7', fileSystem: 'exFAT', capacity: 1e12, free: 5e11, driveType: 2, serial: 'AAAA0001' };
    const places = new PlaceService({ db, dataDir: dir, hostname: 'PC', appVersion: '1', systemDrive: 'C:', listVolumes: () => Promise.resolve([volume]), rootOf: () => root, log: silent });
    places.init();
    await places.refresh();
    configureWriteGuard({ protectedDrives: () => ['T7'], rootOf: (p) => (p.startsWith(root) ? 'E:\\' : null), systemRoot: 'ZZ:\\', volumeOf: (r) => places.volumeFact(r) });
    const result = await places.nameDrive({ letter: 'E:', name: 'Backup', confirmed: true });
    expect(result.ok).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('saved copies: settings file, database copy and pruning (saveToDrive.ts)', async () => {
    await expect(saveToDriveRoot(db, new SettingsStore(db), '1', t7, new Date())).rejects.toThrow(LINE);
    expect(() => pruneOwnFiles(driveSettingsDir(t7))).toThrow(LINE);
    expect(treeOf(t7)).toEqual(CARD_ONLY);
  });

  it('removing old saved copies (savedCopyActions.ts)', () => {
    const result = removeOldCopies({ drives: () => [{ placeId: 'p', label: 'T7', root: t7 }], keep: () => 3, checkInWorker: () => Promise.resolve(null), freeBytes: () => null }, 'p', true);
    expect(result).toEqual({ ok: false, message: `${LINE} Nothing was removed.` });
  });

  it('database copies and snapshots (snapshots.ts)', async () => {
    await expect(copyDatabase(db, path.join(t7, 'x.db'))).rejects.toThrow(LINE);
    expect(() => createSnapshot(db, t7)).toThrow(LINE);
    await expect(createSnapshotAsync(db, t7)).rejects.toThrow(LINE);
    expect(() => pruneSnapshots(path.join(t7, 'snapshots'))).toThrow(LINE);
    expect(treeOf(t7)).toEqual(CARD_ONLY);
  });

  it('a restore cancelled, applied or staged in a protected folder (db/restore.ts, recovery/restore.ts)', async () => {
    expect(() => cancelPendingRestore(t7)).toThrow(LINE);
    expect(applyPendingRestore(t7, { info: () => {}, warn: () => {} })).toBe(false);
    unprotectFakeDrives();
    const file = path.join(dir, 'copy.db');
    await copyDatabase(db, file);
    protectFakeDrive(t7, 'T7');
    const result = await restoreFromChosenFile(
      { dataDir: t7, vault: null as never, drives: () => [], checkInWorker: () => Promise.resolve({ ok: true, messages: [] }), freeBytes: () => 1e12 },
      file,
      null,
      true,
    );
    expect(result.ok).toBe(false);
    expect(treeOf(t7)).toEqual(CARD_ONLY);
  });
});

describe('the writeProtectedDrives setting', () => {
  it('is empty for a database that never had it, can be changed by hand, and a settings file cannot change it', () => {
    const store = new SettingsStore(db);
    expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'writeProtectedDrives'").get()).toEqual({ n: 0 });
    expect(store.get().writeProtectedDrives).toEqual([]);
    store.get().writeProtectedDrives.push('Other');
    expect(store.get().writeProtectedDrives).toEqual([]); // a caller cannot change the default by accident
    expect(store.set('writeProtectedDrives', 'T7')).toMatchObject({ ok: false });
    expect(store.set('writeProtectedDrives', [''])).toMatchObject({ ok: false });
    const file = JSON.parse(JSON.stringify(buildExport(db, store, '1'))) as { settings: Record<string, unknown> };
    file.settings['writeProtectedDrives'] = [];
    const parsed = parseExport(JSON.stringify(file));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(store.set('writeProtectedDrives', ['T7'])).toMatchObject({ ok: true });
    applyImport(db, store, parsed.data);
    expect(store.get().writeProtectedDrives).toEqual(['T7']);
    expect(store.set('writeProtectedDrives', ['T7', ' Seagate '])).toMatchObject({ ok: true });
    expect(store.get().writeProtectedDrives).toEqual(['T7', 'Seagate']);
    expect(store.set('writeProtectedDrives', [])).toMatchObject({ ok: true });
    expect(store.get().writeProtectedDrives).toEqual([]);
  });
});
