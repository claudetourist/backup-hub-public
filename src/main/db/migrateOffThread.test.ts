import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { migrateInWorker } from '../query/queryService';
import {
  closeDatabase,
  currentSchemaVersion,
  DB_FILE_NAME,
  initDatabaseAsync,
  markCleanShutdown,
  markFullCheckPassed,
  migrateFile,
  MIGRATIONS,
  openDatabase,
  readSchemaVersion,
  runMigrations,
  type IntegrityResult,
  type MigrationHooks,
  type MigrationRunner,
} from './index';

/** An older database, as the real one was when the new app first opened it: schema 19 (the runner stopped there). */
const OLD_VERSION = 19;

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const passes = (): Promise<IntegrityResult> => Promise.resolve({ ok: true, messages: ['ok'] });

let dir: string;
let file: string;

/** Builds <dir>/backuphub.db at schema 19 with fake rows, closed cleanly after a full check (so no startup check is needed unless a test says so). */
function makeOldDatabase(rows: number, options: { cleanAndChecked: boolean } = { cleanAndChecked: true }): void {
  const db = openDatabase(file);
  runMigrations(db, MIGRATIONS.slice(0, OLD_VERSION));
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'Laptop', 'connected', 1)").run();
  insertFakeRows(db, 'laptop-1', 'docs', rows, { fingerprinted: true });
  if (options.cleanAndChecked) {
    markFullCheckPassed(db, Date.now());
    markCleanShutdown(db);
  } else {
    db.prepare("INSERT INTO meta (key, value) VALUES ('clean_shutdown', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-migrate-'));
  file = path.join(dir, DB_FILE_NAME);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the test database really is an old one', () => {
  it('stops at schema 19 and has the rows', () => {
    makeOldDatabase(500);
    expect(readSchemaVersion(file)).toBe(OLD_VERSION);
    expect(MIGRATIONS.length).toBeGreaterThan(OLD_VERSION);
    const db = openDatabase(file);
    expect((db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBe(500);
    expect(currentSchemaVersion(db)).toBe(OLD_VERSION);
    db.close();
  });
});

describe('migrations run on a worker thread, before the main connection opens', () => {
  /** A runner that does the real work in-process but records what the file looked like around it (stands in for the worker). */
  function recordingRunner(seen: { before: number | null; after: number | null; calls: number }): MigrationRunner {
    return (target) => {
      seen.calls += 1;
      seen.before = readSchemaVersion(target);
      const result = migrateFile(target);
      seen.after = readSchemaVersion(target);
      return Promise.resolve({ ok: true as const, result });
    };
  }

  it('the app opens an old database: the runner brings it up to date first, the main connection finds nothing left to do', async () => {
    makeOldDatabase(2000);
    const seen = { before: null as number | null, after: null as number | null, calls: 0 };
    const events: string[] = [];
    const logs: string[] = [];
    const hooks: MigrationHooks = { run: recordingRunner(seen), onStart: (info) => events.push(`migrating ${info.from}->${info.to}`) };
    const opened = await initDatabaseAsync(dir, { ...silent, info: (...a: unknown[]) => void logs.push(a.join(' ')) }, passes, () => events.push('checking'), Date.now, hooks);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(seen).toEqual({ before: OLD_VERSION, after: MIGRATIONS.length, calls: 1 });
    expect(events).toEqual([`migrating ${OLD_VERSION}->${MIGRATIONS.length}`]); // clean and recently checked: no safety check
    expect(opened.migration.from).toBe(OLD_VERSION);
    expect(opened.migration.to).toBe(MIGRATIONS.length);
    expect(opened.migration.applied).toEqual(MIGRATIONS.slice(OLD_VERSION).map((m) => `${String(m.version).padStart(4, '0')}_${m.name}`));
    expect(opened.migration.applied.length).toBeGreaterThanOrEqual(2); // 0020_backup_profiles, 0021_danger
    expect(logs.some((l) => l.includes(`db schema version ${MIGRATIONS.length} (migrated from ${OLD_VERSION}`))).toBe(true);
    expect((opened.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBe(2000);
    closeDatabase(opened.db, silent);
  });

  it('an up-to-date database does not start a migration at all (no worker, no "updating" state)', async () => {
    makeOldDatabase(10);
    migrateFile(file);
    let calls = 0;
    const opened = await initDatabaseAsync(dir, silent, passes, undefined, Date.now, { run: () => ((calls += 1), Promise.resolve(null)), onStart: () => (calls += 100) });
    expect(opened.ok).toBe(true);
    expect(calls).toBe(0);
    if (opened.ok) closeDatabase(opened.db, silent);
  });

  it('a new database is created and migrated by the runner too', async () => {
    const seen = { before: null as number | null, after: null as number | null, calls: 0 };
    let started = 0;
    const opened = await initDatabaseAsync(dir, silent, passes, undefined, Date.now, {
      run: (target) => {
        seen.calls += 1;
        expect(fs.existsSync(target)).toBe(false);
        return Promise.resolve({ ok: true as const, result: migrateFile(target) });
      },
      onStart: () => (started += 1),
    });
    expect(opened.ok).toBe(true);
    expect(seen.calls).toBe(1);
    expect(started).toBe(1);
    if (opened.ok) {
      expect(opened.migration).toMatchObject({ from: 0, to: MIGRATIONS.length });
      closeDatabase(opened.db, silent);
    }
  });

  it('when the worker cannot start, the main thread migrates instead and says so', async () => {
    makeOldDatabase(100);
    const warns: string[] = [];
    const opened = await initDatabaseAsync(dir, { ...silent, warn: (...a: unknown[]) => void warns.push(a.join(' ')) }, passes, undefined, Date.now, { run: () => Promise.resolve(null) });
    expect(opened.ok).toBe(true);
    expect(warns.some((w) => w.includes('could not run it'))).toBe(true);
    if (opened.ok) {
      expect(opened.migration).toMatchObject({ from: OLD_VERSION, to: MIGRATIONS.length });
      closeDatabase(opened.db, silent);
    }
  });

  it('a migration that fails on the worker stops the start with a plain reason and leaves the file as it was', async () => {
    makeOldDatabase(100);
    const before = fs.readFileSync(file);
    const opened = await initDatabaseAsync(dir, silent, passes, undefined, Date.now, { run: () => Promise.resolve({ ok: false as const, message: 'disk full' }) });
    expect(opened).toMatchObject({ ok: false, reason: 'error', messages: ['disk full'] });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('the start-up safety check still comes first', () => {
  it('after a crash the check runs, and the migration only starts once it has passed', async () => {
    makeOldDatabase(300, { cleanAndChecked: false });
    const events: string[] = [];
    const opened = await initDatabaseAsync(
      dir,
      silent,
      () => {
        events.push('check ran');
        return passes();
      },
      ({ bytes }) => events.push(`checking ${bytes > 0 ? 'with a size' : 'without a size'}`),
      Date.now,
      { run: (target) => (events.push('migrating'), Promise.resolve({ ok: true as const, result: migrateFile(target) })), onStart: () => events.push('updating') },
    );
    expect(opened.ok).toBe(true);
    expect(events).toEqual(['checking with a size', 'check ran', 'updating', 'migrating']);
    if (opened.ok) closeDatabase(opened.db, silent);
  });

  it('a database that fails the check is never migrated or opened for writing', async () => {
    makeOldDatabase(300, { cleanAndChecked: false });
    const before = fs.readFileSync(file);
    let migrations = 0;
    const opened = await initDatabaseAsync(dir, silent, () => Promise.resolve({ ok: false, messages: ['page 7 is damaged'] }), undefined, Date.now, {
      run: () => ((migrations += 1), Promise.resolve(null)),
      onStart: () => (migrations += 100),
    });
    expect(opened).toMatchObject({ ok: false, reason: 'integrity', messages: ['page 7 is damaged'] });
    expect(migrations).toBe(0);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(readSchemaVersion(file)).toBe(OLD_VERSION);
    const wal = `${file}-wal`;
    expect(fs.existsSync(wal) && fs.statSync(wal).size > 0).toBe(false);
  });

  it('the check does not hold the main loop: it is awaited, so timers keep firing while it runs', async () => {
    makeOldDatabase(300, { cleanAndChecked: false });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const opened = await initDatabaseAsync(dir, silent, () => new Promise<IntegrityResult>((resolve) => setTimeout(() => resolve({ ok: true, messages: ['ok'] }), 120)), undefined, Date.now, {
      run: (target) => Promise.resolve({ ok: true as const, result: migrateFile(target) }),
    });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5);
    if (opened.ok) closeDatabase(opened.db, silent);
  });
});

describe('the built worker (a real worker thread)', () => {
  let outDir: string;
  let workerPath: string;
  beforeAll(async () => {
    // Built the way Forge does it: a CommonJS file with better-sqlite3 left as a real require. Its own folder, so it cannot clash with query.test.ts.
    outDir = path.join(process.cwd(), 'node_modules', '.cache', `migrate-worker-test-${process.pid}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        ssr: path.join(__dirname, '..', 'query', 'queryWorker.ts'),
        rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'queryWorker.js' } },
      },
    });
    workerPath = path.join(outDir, 'queryWorker.js');
  }, 60_000);
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('migrates a schema-19 database on the worker while the main loop keeps turning', async () => {
    makeOldDatabase(5000);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 2);
    const reply = await migrateInWorker(workerPath, file);
    clearInterval(timer);
    expect(reply).toMatchObject({ ok: true, result: { from: OLD_VERSION, to: MIGRATIONS.length } });
    if (reply?.ok) expect(reply.result.applied.length).toBe(MIGRATIONS.length - OLD_VERSION);
    expect(readSchemaVersion(file)).toBe(MIGRATIONS.length);
    expect(ticks).toBeGreaterThan(0);
    const db = openDatabase(file);
    expect((db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBe(5000);
    db.close();
  });

  it('the whole start through the real worker: old database in, current database out, rows kept', async () => {
    makeOldDatabase(3000, { cleanAndChecked: false });
    const phases: string[] = [];
    const opened = await initDatabaseAsync(dir, silent, passes, () => phases.push('checking'), Date.now, {
      run: (target) => migrateInWorker(workerPath, target),
      onStart: () => phases.push('updating'),
    });
    expect(phases).toEqual(['checking', 'updating']);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.migration).toMatchObject({ from: OLD_VERSION, to: MIGRATIONS.length });
    expect(currentSchemaVersion(opened.db)).toBe(MIGRATIONS.length);
    expect((opened.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBe(3000);
    closeDatabase(opened.db, silent);
  });

  it('answers with a plain reason, and leaves the file alone, when the database is newer than the app', async () => {
    makeOldDatabase(10);
    const db = openDatabase(file);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(MIGRATIONS.length + 5));
    db.close();
    const reply = await migrateInWorker(workerPath, file);
    expect(reply?.ok).toBe(false);
    if (reply && !reply.ok) expect(reply.message).toContain('newer than this app');
    expect(await migrateInWorker(path.join(dir, 'missing.js'), file)).toBeNull();
  });
});
