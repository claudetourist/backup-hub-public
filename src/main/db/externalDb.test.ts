import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openImmutable, withTempCopy } from './externalDb';
import { treeOf } from '../writeGuard.testutil';

let dir: string;
let drive: string;

const sideFiles = (folder: string): string[] => treeOf(folder).filter((f) => /-(wal|shm|journal)$/.test(f));

/** A WAL-mode database with a row, checkpointed and closed: what an old ledger on a drive looks like. */
function makeLedger(file: string): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE ledger (name TEXT, size INTEGER)');
  db.prepare('INSERT INTO ledger VALUES (?, ?)').run('a.jpg', 10);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  for (const s of ['-wal', '-shm']) fs.rmSync(`${file}${s}`, { force: true });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-extdb-test-'));
  drive = path.join(dir, 'T7', 'MyData');
  fs.mkdirSync(drive, { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SQLite files on a drive are opened without any write', () => {
  it('openImmutable reads the rows, refuses writes, leaves no -wal, -shm or -journal and the same bytes', () => {
    const file = path.join(drive, 'ledger.db');
    makeLedger(file);
    const before = treeOf(drive);
    const bytes = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    const db = openImmutable(file);
    expect(db.prepare('SELECT name, size FROM ledger').all()).toEqual([{ name: 'a.jpg', size: 10 }]);
    expect(() => db.exec("INSERT INTO ledger VALUES ('x', 1)")).toThrow();
    db.close();
    expect(treeOf(drive)).toEqual(before);
    expect(sideFiles(drive)).toEqual([]);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('openImmutable does not roll back a leftover journal (that would be a write)', () => {
    const file = path.join(drive, 'ledger.db');
    makeLedger(file);
    const journal = `${file}-journal`;
    fs.writeFileSync(journal, Buffer.alloc(512, 1));
    const before = treeOf(drive);
    const bytes = fs.readFileSync(file);
    const db = openImmutable(file);
    db.prepare('SELECT * FROM ledger').all();
    db.close();
    expect(treeOf(drive)).toEqual(before);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it('withTempCopy sees rows still in the -wal file, leaves the drive untouched and removes its copy', () => {
    const live = path.join(dir, 'live.db');
    const db = new Database(live);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE ledger (name TEXT)');
    db.prepare('INSERT INTO ledger VALUES (?)').run('only-in-wal.jpg');
    // The connection stays open so the row is only in the -wal; copy the three files as a snapshot of a drive.
    const snap = path.join(dir, 'T7', 'snap');
    fs.mkdirSync(snap);
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${live}${s}`)) fs.copyFileSync(`${live}${s}`, path.join(snap, `phone-ledger.db${s}`));
    db.close();
    expect(fs.existsSync(path.join(snap, 'phone-ledger.db-wal'))).toBe(true);
    const target = path.join(snap, 'phone-ledger.db');
    const before = treeOf(snap);
    const bytes = fs.readFileSync(target);
    const scratchRoot = path.join(dir, 'tmp');
    fs.mkdirSync(scratchRoot);
    const rows = withTempCopy(target, (c) => c.prepare('SELECT name FROM ledger').all(), scratchRoot);
    expect(rows).toEqual([{ name: 'only-in-wal.jpg' }]);
    expect(treeOf(snap)).toEqual(before);
    expect(fs.readFileSync(target).equals(bytes)).toBe(true);
    expect(fs.readdirSync(scratchRoot)).toEqual([]);
  });

  it('works for a path with spaces, % and # in it', () => {
    const odd = path.join(drive, 'My Ledger #1 100%.db');
    makeLedger(odd);
    const db = openImmutable(odd);
    expect(db.prepare('SELECT count(*) AS n FROM ledger').get()).toEqual({ n: 1 });
    db.close();
    expect(sideFiles(drive)).toEqual([]);
  });
});

describe('static: every SQLite open in src/main is on the reviewed list', () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith('.ts') && !/\.(test|testutil)\.ts$/.test(e.name) ? [full] : [];
    });
  const root = path.resolve(__dirname, '..');
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
  const read = (f: string): string => fs.readFileSync(path.join(root, f), 'utf8');

  /** Opens of Backup Hub's OWN database in the data folder, or of a temp copy. A new opener must be added here on purpose. */
  const REVIEWED = new Set([
    'db/connection.ts', // the app database (read-write) and the integrity probe (read only)
    'db/startupCheck.ts', // the app database, read only
    'db/migrate.ts', // the app database, read only (its schema version before a migration on the worker)
    'upkeep/upkeepProcess.ts', // the app database (own connection, in the upkeep utility process)
    'listing/quickWalkWorker.ts', // the app database (own connection)
    'query/queryCore.ts', // the app database, read only
    'import/fleetV1/source.ts', // opens ONLY the temporary copy made by copySource
    'db/externalDb.ts', // the helper for files on a drive
    'phoneBackup/previewTool.ts', // the proof helper: Backup Hub's own database (or a copy), opened read only, nothing written
    'mirror/mirrorPreviewTool.ts', // the second-copy proof helper: Backup Hub's own database (or a copy), read only
    'folderBackup/previewTool.ts', // the folder-backup proof helper: Backup Hub's own database (or a copy), read only
  ]);

  it('finds the openers and none is outside the reviewed list (a new one must use externalDb.ts or be reviewed)', () => {
    const openers = walk(root).filter((f) => /new Database\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(openers).toContain('db/connection.ts');
    expect(openers.filter((f) => !REVIEWED.has(f))).toEqual([]);
  });

  it('the opener of a file it is handed is read only', () => {
    for (const f of ['db/startupCheck.ts', 'db/migrate.ts', 'query/queryCore.ts', 'import/fleetV1/source.ts', 'phoneBackup/previewTool.ts', 'mirror/mirrorPreviewTool.ts', 'folderBackup/previewTool.ts']) {
      for (const m of read(f).matchAll(/new Database\([^)]*\)/g)) expect(m[0], f).toContain('readonly: true');
    }
  });

  it('callers that take a database from a drive copy it to temp first and open the copy', () => {
    expect(read('settings/savedCopyActions.ts')).toMatch(/copyFile\(file, copy\)[\s\S]*openReadOnly\(copy\)/);
    expect(read('import/fleetV1/importer.ts')).toMatch(/copySource\([\s\S]*new FleetV1Source\(copy\.dbFile\)/);
    expect(read('recovery/restore.ts')).toMatch(/copyFile\(source, part/);
  });
});
