import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  closeDatabase,
  createSnapshot,
  createSnapshotAsync,
  currentSchemaVersion,
  DB_FILE_NAME,
  decideStartupCheck,
  FULL_CHECK_MAX_AGE_MS,
  initDatabase,
  markCleanShutdown,
  markFullCheckPassed,
  listSnapshots,
  MIGRATIONS,
  openDatabase,
  probeIntegrity,
  pruneSnapshots,
  runMigrations,
  snapshotFileName,
  snapshotIfDue,
  snapshotIsDue,
  snapshotsDir,
  type Db,
} from './index';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
const opened: Db[] = [];

function track(db: Db): Db {
  opened.push(db);
  return db;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-db-test-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('builds the full schema from an empty database and seeds the "You" profile', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    const result = runMigrations(db);
    expect(result).toMatchObject({ from: 0, to: MIGRATIONS.length });
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of [
      'meta',
      'profiles',
      'places',
      'files',
      'collections',
      'collection_roots',
      'jobs',
      'job_events',
      'settings',
      'secrets',
    ]) {
      expect(tables).toContain(t);
    }

    const profiles = db.prepare('SELECT name FROM profiles').all() as { name: string }[];
    expect(profiles).toEqual([{ name: 'You' }]);
    const created = db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get() as { value: string };
    expect(Number(created.value)).toBeGreaterThan(1_700_000_000_000);
  });

  it('is idempotent: a second run applies nothing and does not reseed', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    runMigrations(db);
    const again = runMigrations(db);
    expect(again).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length, applied: [] });
    expect(db.prepare('SELECT count(*) AS n FROM profiles').get()).toEqual({ n: 1 });
  });

  it('applies only newer migrations and rolls a failing one back completely', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    const first = MIGRATIONS.slice(0, 1);
    runMigrations(db, first);
    const broken = [
      ...first,
      { version: 2, name: 'broken', sql: 'CREATE TABLE half_done (x); INSERT INTO nope VALUES (1);' },
    ];
    expect(() => runMigrations(db, broken)).toThrow();
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();

    const good = [...first, { version: 2, name: 'extra', sql: 'CREATE TABLE extra (x);' }];
    expect(runMigrations(db, good)).toEqual({ from: 1, to: 2, applied: ['0002_extra'] });
  });

  it('refuses a database newer than the app and a malformed migration list', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    runMigrations(db);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => runMigrations(db)).toThrow(/newer than this app/);
    expect(() => runMigrations(db, [{ version: 2, name: 'gap', sql: '' }])).toThrow(/broken/);
  });

  it('uses WAL, foreign keys and a busy timeout', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});

describe('migration 0003 (files catalog columns)', () => {
  it('keeps existing file rows and ids, allows a NULL size and adds the Drive id columns', () => {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    runMigrations(db, MIGRATIONS.slice(0, 2));
    db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p1', 1, 'laptop', 'L', 1)").run();
    db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, md5, first_seen_at, last_seen_at) VALUES ('p1', 'a/b.txt', 7, 5, 'm', 1, 2)").run();
    expect(() => db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('p1', 'x', NULL, 1, 1)").run()).toThrow(/NOT NULL/);

    expect(runMigrations(db)).toMatchObject({ from: 2, to: MIGRATIONS.length });
    expect(db.prepare('SELECT id, rel_path, name, size, mtime, md5, ext_id, mime, web_link FROM files').all()).toEqual([
      { id: 1, rel_path: 'a/b.txt', name: 'b.txt', size: 7, mtime: 5, md5: 'm', ext_id: null, mime: null, web_link: null },
    ]);
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, ext_id) VALUES ('p1', 'doc', NULL, 1, 1, 'drive-1')").run();
    expect(() => db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, ext_id) VALUES ('p1', 'doc2', 1, 1, 1, 'drive-1')").run()).toThrow(/UNIQUE/);
    // Rows without an ext_id never clash on it, and the old unique path rule still holds.
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('p1', 'n1', 1, 1, 1)").run();
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('p1', 'n2', 1, 1, 1)").run();
    expect(() => db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('p1', 'n1', 1, 1, 1)").run()).toThrow(/UNIQUE/);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_files_sha256', 'idx_files_md5', 'idx_files_size_name', 'idx_files_place_ext']));
  });
});

describe('schema rules', () => {
  function migrated(): Db {
    const db = track(openDatabase(path.join(dir, 'a.db')));
    runMigrations(db);
    db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p1', 1, 'laptop', 'L', 1)").run();
    return db;
  }
  const insertFile = (db: Db, relPath: string, size = 10) =>
    db
      .prepare('INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES (?, ?, ?, 1, 1)')
      .run('p1', relPath, size);

  it('derives files.name from the last path segment', () => {
    const db = migrated();
    for (const p of ['a.jpg', 'Photos/2026/trip.jpg', 'x/x/x', 'a/a/', 'dir/sub dir/file.tar.gz']) insertFile(db, p);
    const names = db.prepare('SELECT rel_path, name FROM files ORDER BY id').all();
    expect(names).toEqual([
      { rel_path: 'a.jpg', name: 'a.jpg' },
      { rel_path: 'Photos/2026/trip.jpg', name: 'trip.jpg' },
      { rel_path: 'x/x/x', name: 'x' },
      { rel_path: 'a/a/', name: '' },
      { rel_path: 'dir/sub dir/file.tar.gz', name: 'file.tar.gz' },
    ]);
  });

  it('enforces unique (place, path), foreign keys and CHECK constraints', () => {
    const db = migrated();
    insertFile(db, 'dup.txt');
    expect(() => insertFile(db, 'dup.txt')).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare('INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES (?, ?, 1, 1, 1)')
        .run('missing-place', 'a'),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p2', 1, 'floppy', 'x', 1)").run(),
    ).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO jobs (kind, title, state, created_at) VALUES ('k', 't', 'paused', 1)").run()).toThrow(
      /CHECK/,
    );
  });

  it('has the lookup indexes the plan asks for', () => {
    const db = migrated();
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(idx).toEqual(expect.arrayContaining(['idx_files_sha256', 'idx_files_size_name']));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM files WHERE size = 1 AND name = 'a'").all() as {
      detail: string;
    }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_files_size_name');
  });
});

describe('initDatabase and integrity', () => {
  it('creates a new database file, migrates it and can be reopened', () => {
    const first = initDatabase(dir, silent);
    if (!first.ok) throw new Error('expected ok');
    track(first.db);
    expect(first.file).toBe(path.join(dir, DB_FILE_NAME));
    expect(first.migration.applied).toHaveLength(MIGRATIONS.length);
    closeDatabase(first.db, silent);

    const second = initDatabase(dir, silent);
    if (!second.ok) throw new Error('expected ok');
    track(second.db);
    expect(second.migration).toMatchObject({ from: MIGRATIONS.length, applied: [] });
    expect(second.db.prepare('SELECT count(*) AS n FROM profiles').get()).toEqual({ n: 1 });
  });

  it('logs the integrity result', () => {
    const lines: string[] = [];
    const log = { ...silent, info: (...a: unknown[]) => lines.push(a.join(' ')) };
    const created = initDatabase(dir, log);
    if (created.ok) closeDatabase(created.db, silent);
    const reopened = initDatabase(dir, log);
    if (reopened.ok) closeDatabase(reopened.db, silent);
    expect(lines.some((l) => l.includes('quick_check') && l.endsWith('ok'))).toBe(true);
    expect(lines.some((l) => l.includes(`schema version ${MIGRATIONS.length}`))).toBe(true);
  });

  it('reports a damaged file without modifying it', () => {
    const file = path.join(dir, DB_FILE_NAME);
    const junk = Buffer.concat([Buffer.from('this is not a sqlite database\n'), Buffer.alloc(8192, 7)]);
    fs.writeFileSync(file, junk);
    const before = fs.readFileSync(file);

    const result = initDatabase(dir, silent);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('integrity');
    expect(result.messages.length).toBeGreaterThan(0);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).toSorted()).toEqual([DB_FILE_NAME]); // no -wal / -shm / extras
  });

  it('detects page-level corruption in a real database and leaves the bytes alone', () => {
    const made = initDatabase(dir, silent);
    if (!made.ok) throw new Error('expected ok');
    const db = made.db;
    db.exec('CREATE TABLE bulk (v TEXT); CREATE INDEX bulk_v ON bulk(v);');
    const ins = db.prepare('INSERT INTO bulk VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) ins.run(`row-${i}-${'x'.repeat(40)}`);
    })();
    closeDatabase(db, silent);

    const file = path.join(dir, DB_FILE_NAME);
    const bytes = fs.readFileSync(file);
    // Smash a chunk in the middle of the file (past page 1) so the structure is inconsistent.
    const page = 4096;
    bytes.fill(0xff, page * 3, page * 3 + 2048);
    fs.writeFileSync(file, bytes);
    const before = fs.readFileSync(file);

    const result = initDatabase(dir, silent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('integrity');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('snapshots', () => {
  function liveDb(): { db: Db; dataDir: string } {
    const result = initDatabase(dir, silent);
    if (!result.ok) throw new Error('expected ok');
    track(result.db);
    return { db: result.db, dataDir: dir };
  }

  it('names snapshots backuphub-YYYYMMDD-HHmmss.db in local time', () => {
    expect(snapshotFileName(new Date(2026, 9, 30, 7, 5, 9))).toBe('backuphub-20261030-070509.db');
  });

  it('writes a consistent, openable VACUUM INTO copy under snapshots\\', () => {
    const { db, dataDir } = liveDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    const snap = createSnapshot(db, dataDir, new Date(2026, 9, 30, 12, 0, 0));
    expect(snap.created).toBe(true);
    expect(path.dirname(snap.path)).toBe(snapshotsDir(dataDir));
    expect(path.basename(snap.path)).toBe('backuphub-20261030-120000.db');

    const copy = new Database(snap.path, { readonly: true });
    try {
      expect(copy.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({ value: 'v' });
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
    expect(fs.readdirSync(snapshotsDir(dataDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const again = createSnapshot(db, dataDir, new Date(2026, 9, 30, 12, 0, 0));
    expect(again.created).toBe(false);
  });

  // The copy to the T7 used to be one VACUUM INTO on the main thread (29 s frozen, 30 Oct).
  it('copies the live database in steps, letting the event loop run in between', async () => {
    const { db, dataDir } = liveDb();
    db.exec('CREATE TABLE filler (b BLOB)');
    const insert = db.prepare('INSERT INTO filler (b) VALUES (randomblob(4096))');
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run(); // about 12 MB, many backup steps
    })();
    let turns = 0;
    const tick = setInterval(() => (turns += 1), 0);
    try {
      const snap = await createSnapshotAsync(db, dataDir, new Date(2026, 9, 30, 13, 0, 0));
      expect(snap.created).toBe(true);
      const copy = new Database(snap.path, { readonly: true });
      try {
        expect(copy.prepare('SELECT count(*) AS n FROM filler').get()).toEqual({ n: 3000 });
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        copy.close();
      }
    } finally {
      clearInterval(tick);
    }
    expect(turns).toBeGreaterThan(3);
    expect(fs.readdirSync(snapshotsDir(dataDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the newest 7 and never touches files that do not match the exact pattern', () => {
    const { db, dataDir } = liveDb();
    const snaps = snapshotsDir(dataDir);
    fs.mkdirSync(snaps, { recursive: true });
    const bystanders = [
      'notes.txt',
      'backuphub-20261030-120000.db.bak',
      'backuphub-20261030-12000.db',
      'xbackuphub-20261030-120000.db',
      'backuphub-latest.db',
      'BACKUPHUB-20261030-120000.db',
      'backuphub-20261030-120000.db.tmp',
    ];
    for (const name of bystanders) fs.writeFileSync(path.join(snaps, name), 'keep me');
    fs.mkdirSync(path.join(snaps, 'backuphub-20200101-000000.db')); // a folder with a matching name

    for (let day = 1; day <= 10; day++) createSnapshot(db, dataDir, new Date(2026, 9, day, 3, 0, 0));
    expect(listSnapshots(snaps)).toHaveLength(10);

    const removed = pruneSnapshots(snaps);
    expect(removed).toEqual([
      'backuphub-20261003-030000.db',
      'backuphub-20261002-030000.db',
      'backuphub-20261001-030000.db',
    ]);
    const left = listSnapshots(snaps);
    expect(left).toHaveLength(7);
    expect(left[0]).toBe('backuphub-20261010-030000.db');
    expect(left[6]).toBe('backuphub-20261004-030000.db');

    for (const name of bystanders) expect(fs.readFileSync(path.join(snaps, name), 'utf8')).toBe('keep me');
    expect(fs.statSync(path.join(snaps, 'backuphub-20200101-000000.db')).isDirectory()).toBe(true);
  });

  it('pruning an empty or missing folder is a no-op', () => {
    expect(pruneSnapshots(path.join(dir, 'nope'))).toEqual([]);
  });

  it('snapshotIfDue snapshots at most once per 24 hours and prunes', () => {
    const { db, dataDir } = liveDb();
    const snaps = snapshotsDir(dataDir);
    const t0 = new Date(2026, 9, 30, 8, 0, 0);

    expect(snapshotIsDue(snaps, t0)).toBe(true);
    expect(snapshotIfDue(db, dataDir, silent, t0)?.created).toBe(true);
    expect(snapshotIsDue(snaps, new Date(2026, 9, 30, 20, 0, 0))).toBe(false);
    expect(snapshotIfDue(db, dataDir, silent, new Date(2026, 9, 30, 20, 0, 0))).toBeNull();
    expect(snapshotIfDue(db, dataDir, silent, new Date(2026, 9, 31, 7, 59, 59))).toBeNull();
    expect(snapshotIfDue(db, dataDir, silent, new Date(2026, 9, 31, 8, 0, 0))?.created).toBe(true);
    expect(listSnapshots(snaps)).toHaveLength(2);

    for (let i = 2; i < 12; i++) snapshotIfDue(db, dataDir, silent, new Date(2026, 9, 31 + i, 8, 0, 0));
    expect(listSnapshots(snaps)).toHaveLength(7);
  });

  it('snapshotIfDue never throws (a failure is logged, not fatal)', () => {
    const { db, dataDir } = liveDb();
    db.close();
    const warnings: unknown[][] = [];
    const log = { info: () => {}, warn: (...a: unknown[]) => warnings.push(a) };
    expect(snapshotIfDue(db, dataDir, log, new Date(2026, 9, 30, 8, 0, 0))).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('quick and full integrity checks', () => {
  it('both pass on a healthy database and the probe never writes', () => {
    const made = initDatabase(dir, silent);
    if (!made.ok) throw new Error('expected ok');
    expect(checkIntegrity(made.db, 'quick')).toEqual({ ok: true, messages: ['ok'] });
    expect(checkIntegrity(made.db, 'full')).toEqual({ ok: true, messages: ['ok'] });
    closeDatabase(made.db, silent);
    const file = path.join(dir, DB_FILE_NAME);
    const before = fs.readFileSync(file);
    expect(probeIntegrity(file, 'quick').ok).toBe(true);
    expect(probeIntegrity(file, 'full').ok).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('when the startup quick_check runs', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const meta = (cleanShutdown: string | null, lastIntegrityOkAt: number | null) => ({
    cleanShutdown,
    lastIntegrityOkAt: lastIntegrityOkAt === null ? null : String(lastIntegrityOkAt),
  });

  it('is skipped only after a clean shutdown with a full check from the last 7 days', () => {
    expect(decideStartupCheck(meta('1', NOW - 2 * DAY), NOW)).toEqual({ run: false, reason: 'clean-and-recently-checked' });
    expect(decideStartupCheck(meta('1', NOW - FULL_CHECK_MAX_AGE_MS), NOW).run).toBe(false);
  });

  it('runs after a crash, kill or power cut (flag still 0)', () => {
    expect(decideStartupCheck(meta('0', NOW - DAY), NOW)).toEqual({ run: true, reason: 'unclean-shutdown' });
  });

  it('runs when nothing is on record (first start after this update) or the flag is junk', () => {
    expect(decideStartupCheck(meta(null, NOW - DAY), NOW)).toEqual({ run: true, reason: 'unknown-shutdown' });
    expect(decideStartupCheck(meta('yes', NOW - DAY), NOW).run).toBe(true);
  });

  it('runs when no full check passed, or the last one is older than 7 days or in the future', () => {
    expect(decideStartupCheck(meta('1', null), NOW)).toEqual({ run: true, reason: 'no-full-check-on-record' });
    expect(decideStartupCheck({ cleanShutdown: '1', lastIntegrityOkAt: 'abc' }, NOW).run).toBe(true);
    expect(decideStartupCheck(meta('1', NOW - 8 * DAY), NOW)).toEqual({ run: true, reason: 'full-check-too-old' });
    expect(decideStartupCheck(meta('1', NOW + DAY), NOW).run).toBe(true);
  });

  it('a passed start-up check counts as a recent check too; the newest trusted time decides', () => {
    const both = (full: number | null, startup: number | null) => ({ ...meta('1', full), lastStartupCheckOkAt: startup === null ? null : String(startup) });
    expect(decideStartupCheck(both(null, NOW - 2 * DAY), NOW)).toEqual({ run: false, reason: 'clean-and-recently-checked' });
    expect(decideStartupCheck(both(NOW - 30 * DAY, NOW - DAY), NOW).run).toBe(false);
    expect(decideStartupCheck(both(NOW - 30 * DAY, NOW - 8 * DAY), NOW)).toEqual({ run: true, reason: 'full-check-too-old' });
    // A future time is not trusted, but a good older one still counts.
    expect(decideStartupCheck(both(NOW - DAY, NOW + DAY), NOW).run).toBe(false);
    expect(decideStartupCheck(both(null, NOW + DAY), NOW)).toEqual({ run: true, reason: 'full-check-too-old' });
    // A crash still means a check, however recent the last one.
    expect(decideStartupCheck({ ...both(NOW - DAY, NOW - DAY), cleanShutdown: '0' }, NOW).run).toBe(true);
  });

  it('runs when the meta table cannot be read', () => {
    expect(decideStartupCheck(null, NOW)).toEqual({ run: true, reason: 'meta-unreadable' });
  });

  it('initDatabase: first run checks, clean quit plus a passed full check skips, a crash checks again', () => {
    const lines: string[] = [];
    const log = { ...silent, info: (...a: unknown[]) => lines.push(a.join(' ')) };
    let now = NOW;

    const created = initDatabase(dir, log, () => now);
    if (!created.ok) throw new Error('expected ok');
    // Running: the flag is cleared right after opening.
    expect(created.db.prepare("SELECT value FROM meta WHERE key = 'clean_shutdown'").get()).toEqual({ value: '0' });
    markFullCheckPassed(created.db, now);
    markCleanShutdown(created.db);
    closeDatabase(created.db, silent);

    lines.length = 0;
    now += 2 * DAY;
    const quick = initDatabase(dir, log, () => now);
    if (!quick.ok) throw new Error('expected ok');
    expect(quick.integrity).toBeNull();
    expect(quick.startupCheck).toEqual({ run: false, reason: 'clean-and-recently-checked' });
    expect(lines.some((l) => l.includes('quick_check skipped'))).toBe(true);
    // No clean quit this time (simulated crash): closed without markCleanShutdown.
    closeDatabase(quick.db, silent);

    lines.length = 0;
    const afterCrash = initDatabase(dir, log, () => now);
    if (!afterCrash.ok) throw new Error('expected ok');
    expect(afterCrash.startupCheck).toEqual({ run: true, reason: 'unclean-shutdown' });
    expect(afterCrash.integrity?.ok).toBe(true);
    expect(lines.some((l) => l.includes('unclean-shutdown') && l.endsWith('ok'))).toBe(true);
    markCleanShutdown(afterCrash.db);
    closeDatabase(afterCrash.db, silent);

    // A clean quit, but the last full check is now 9 days old.
    now += 9 * DAY;
    const stale = initDatabase(dir, log, () => now);
    if (!stale.ok) throw new Error('expected ok');
    expect(stale.startupCheck).toEqual({ run: true, reason: 'full-check-too-old' });
    expect(stale.integrity?.ok).toBe(true);
    markCleanShutdown(stale.db);
    closeDatabase(stale.db, silent);

    // That passed check is recorded: the next launch, a day later, does not check again (no full check needed).
    now += DAY;
    const next = initDatabase(dir, log, () => now);
    if (!next.ok) throw new Error('expected ok');
    expect(next.startupCheck).toEqual({ run: false, reason: 'clean-and-recently-checked' });
    closeDatabase(next.db, silent);
  });

  it('a damaged file is still refused when there is doubt, and left untouched', () => {
    const first = initDatabase(dir, silent);
    if (!first.ok) throw new Error('expected ok');
    closeDatabase(first.db, silent); // flag still 0 (no clean quit)
    const file = path.join(dir, DB_FILE_NAME);
    const bytes = fs.readFileSync(file);
    bytes.fill(0xff, 4096, 8192); // wreck the second page
    fs.writeFileSync(file, bytes);
    const before = fs.readFileSync(file);
    const result = initDatabase(dir, silent);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
