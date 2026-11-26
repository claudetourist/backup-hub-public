import fs from 'node:fs';
import path from 'node:path';
import { checkIntegrity, openDatabase, probeIntegrity, type Db, type IntegrityResult } from './connection';
import { MIGRATIONS } from './migrations';
import { readSchemaVersion, runMigrations, type MigrationResult } from './migrate';
import { applyPendingRestore } from './restore';
import { decideStartupCheck, markRunning, markStartupCheckPassed, readStartupMeta, type StartupCheckDecision } from './startupCheck';

export * from './connection';
export * from './migrate';
export * from './snapshots';
export * from './startupCheck';
export * from './restore';
export { MIGRATIONS, type Migration } from './migrations';

export const DB_FILE_NAME = 'backuphub.db';

export interface DbLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type InitDatabaseResult =
  | { ok: true; db: Db; file: string; integrity: IntegrityResult | null; startupCheck: StartupCheckDecision | null; migration: MigrationResult }
  | { ok: false; reason: 'integrity' | 'error'; file: string; messages: string[] };

/**
 * Open `<dataDir>\backuphub.db`: integrity check first, then WAL/pragmas, then migrations.
 * An existing file is checked through a read-only connection, so a damaged database is left
 * exactly as found. Failures are returned, not thrown, so the caller can show a plain message.
 */
export function initDatabase(dataDir: string, log: DbLogger, now: () => number = Date.now): InitDatabaseResult {
  applyPendingRestore(dataDir, log);
  const file = path.join(dataDir, DB_FILE_NAME);
  if (!fs.existsSync(file)) return openChecked(file, false, null, null, log);
  // quick_check took 14.5 s on the real database: only when there is a reason to doubt the file.
  const startupCheck = decideStartupCheck(readStartupMeta(file), now());
  const integrity = startupCheck.run ? probeIntegrity(file, 'quick') : null;
  return openChecked(file, true, startupCheck, integrity, log, null, now);
}

/** Runs `quick_check` on another thread through its own read-only connection; null = it could not run there. */
export type QuickCheckRunner = (file: string) => Promise<IntegrityResult | null>;

/** Brings the file up to the latest version on another thread; null = it could not run there. */
export type MigrationRunner = (file: string) => Promise<{ ok: true; result: MigrationResult } | { ok: false; message: string } | null>;

export interface MigrationHooks {
  run: MigrationRunner;
  /** Called just before a migration starts (there is something to migrate), with the version the file is at and the latest. */
  onStart?: (info: { from: number; to: number }) => void;
}

/**
 * Same as `initDatabase`, but the slow parts run on a worker thread, so the window can paint meanwhile:
 * - the startup `quick_check` (when one is needed) runs through `runQuickCheck`. Nothing writes to the database before that
 *   check passes (a file that fails it is never opened for writing). If the runner cannot run it, the check runs here as before.
 *   `onChecking` is called just before a check starts, with the size of the file.
 * - the migrations (when the file is older than this app, or new) run through `migrate.run`, after the check and before the main
 *   connection opens. Without `migrate` they run on the main thread (tests only). If the runner cannot run them, they run here.
 */
export async function initDatabaseAsync(
  dataDir: string,
  log: DbLogger,
  runQuickCheck: QuickCheckRunner,
  onChecking?: (info: { bytes: number }) => void,
  now: () => number = Date.now,
  migrate?: MigrationHooks,
): Promise<InitDatabaseResult> {
  applyPendingRestore(dataDir, log);
  const file = path.join(dataDir, DB_FILE_NAME);
  if (!fs.existsSync(file)) {
    const outcome = await migrateOffMainThread(file, false, migrate, log);
    if (outcome && !outcome.result) return outcome.refusal;
    return openChecked(file, false, null, null, log, outcome?.result ?? null);
  }
  const startupCheck = decideStartupCheck(readStartupMeta(file), now());
  let integrity: IntegrityResult | null = null;
  if (startupCheck.run) {
    onChecking?.({ bytes: fileBytes(file) });
    const began = Date.now();
    integrity = await runQuickCheck(file);
    if (integrity === null) {
      log.info('db quick_check: the worker thread could not run it; checking in the main process');
      integrity = probeIntegrity(file, 'quick');
    }
    log.info(`db quick_check took ${Date.now() - began} ms`);
  } else {
    // Its own turn: reading the start-up facts above and opening the connection below are two slices, not one long block.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  // A file that failed its check is not touched: openChecked refuses it before anything is opened.
  let migrated: MigrationResult | null = null;
  if (integrity === null || integrity.ok) {
    const outcome = await migrateOffMainThread(file, true, migrate, log);
    if (outcome && !outcome.result) return outcome.refusal;
    migrated = outcome?.result ?? null;
  }
  return openChecked(file, true, startupCheck, integrity, log, migrated, now);
}

function fileBytes(file: string): number {
  return [file, `${file}-wal`].reduce((sum, name) => sum + (fs.statSync(name, { throwIfNoEntry: false })?.size ?? 0), 0);
}

/**
 * Runs the pending migrations of `file` on the worker (creating the file when it is new). Null = nothing was done here (nothing
 * to migrate, no runner, or the runner could not start and the main thread will do it). Otherwise either the result of the
 * worker's migrations, or the refusal to return to the caller when they failed.
 */
async function migrateOffMainThread(
  file: string,
  existed: boolean,
  migrate: MigrationHooks | undefined,
  log: DbLogger,
): Promise<{ result: MigrationResult; refusal?: undefined } | { result: null; refusal: InitDatabaseResult } | null> {
  if (!migrate) return null;
  const from = existed ? readSchemaVersion(file) : 0;
  // Up to date (or newer than this app: the main thread's runMigrations says so in plain words): nothing to do on a worker.
  if (from !== null && from >= MIGRATIONS.length) return null;
  migrate.onStart?.({ from: from ?? 0, to: MIGRATIONS.length });
  const reply = await migrate.run(file);
  if (reply === null) {
    log.warn('db migration: the worker thread could not run it; migrating in the main process (the window may stall for a moment)');
    return null;
  }
  if (!reply.ok) {
    log.error('db init failed (migration):', reply.message);
    return { result: null, refusal: { ok: false, reason: 'error', file, messages: [reply.message] } };
  }
  return { result: reply.result };
}

/** Everything after the (optional) quick_check of an existing file, or the creation of a new one. */
function openChecked(
  file: string,
  existed: boolean,
  startupCheck: StartupCheckDecision | null,
  checked: IntegrityResult | null,
  log: DbLogger,
  migratedElsewhere: MigrationResult | null = null,
  now: () => number = Date.now,
): InitDatabaseResult {
  let db: Db | null = null;
  try {
    let integrity: IntegrityResult | null = checked;
    if (existed) {
      if (startupCheck?.run && integrity) {
        log.info(`db quick_check (${file}; ${startupCheck.reason}): ${integrity.ok ? 'ok' : integrity.messages.join(' | ')}`);
        if (!integrity.ok) return { ok: false, reason: 'integrity', file, messages: integrity.messages };
      } else {
        log.info(`db quick_check skipped (${file}): last shutdown was clean and a full check passed within 7 days`);
      }
      db = openDatabase(file);
    } else {
      db = openDatabase(file);
      integrity = checkIntegrity(db, 'quick');
      log.info(`db created (${file}); quick_check: ${integrity.ok ? 'ok' : integrity.messages.join(' | ')}`);
      if (!integrity.ok) {
        db.close();
        return { ok: false, reason: 'integrity', file, messages: integrity.messages };
      }
    }
    // Normally nothing is left to do here when a worker already migrated the file (initDatabaseAsync).
    const left = runMigrations(db);
    // A migration can write a lot: do not leave a big log file behind.
    if (left.applied.length > 0) db.pragma('wal_checkpoint(TRUNCATE)');
    const migration: MigrationResult = migratedElsewhere
      ? { from: migratedElsewhere.from, to: left.to, applied: [...migratedElsewhere.applied, ...left.applied] }
      : left;
    markRunning(db);
    // A passed start-up check counts as a recent check (so the next launches do not check again for 7 days).
    if (startupCheck?.run && integrity?.ok) markStartupCheckPassed(db, now());
    log.info(
      `db schema version ${migration.to}` +
        (migration.applied.length > 0
          ? ` (migrated from ${migration.from}: ${migration.applied.join(', ')})`
          : ' (up to date)'),
    );
    return { ok: true, db, file, integrity, startupCheck, migration };
  } catch (err) {
    log.error('db init failed:', err);
    try {
      db?.close();
    } catch {
      // Already failing; the original error is what matters.
    }
    return { ok: false, reason: 'error', file, messages: [(err as Error).message] };
  }
}

/** Close cleanly: fold the WAL back into the main file, then release the handle. */
export function closeDatabase(db: Db, log: Pick<DbLogger, 'warn'>): void {
  try {
    if (!db.open) return;
    // TRUNCATE waits (busy timeout) for readers that are still closing, and empties the log file. Asked again if it was still busy.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (!rows[0]?.busy) break;
    }
    db.close();
  } catch (err) {
    log.warn('db close failed:', err);
  }
}
