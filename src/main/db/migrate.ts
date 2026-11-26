import Database from 'better-sqlite3';
import { BUSY_TIMEOUT_MS, openDatabase, type Db } from './connection';
import { MIGRATIONS, type Migration } from './migrations';

export const SCHEMA_VERSION_KEY = 'schema_version';

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function currentSchemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined;
  return row ? Number.parseInt(row.value, 10) : 0;
}

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(`Migration list is broken: expected version ${index + 1} at position ${index}, found ${m.version}`);
    }
  });
}

/**
 * Bring the database up to the latest version. Each migration and its version bump run in ONE
 * transaction, so a failure leaves the database exactly as it was before that migration.
 * A database newer than this app (a downgrade) is refused rather than guessed at.
 */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  validate(migrations);
  const from = currentSchemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    throw new Error(`Database schema version ${from} is newer than this app understands (${latest}). Update Backup Hub.`);
  }
  const applied: string[] = [];
  for (const migration of migrations.slice(from)) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(SCHEMA_VERSION_KEY, String(migration.version));
    });
    apply();
    applied.push(`${String(migration.version).padStart(4, '0')}_${migration.name}`);
  }
  return { from, to: Math.max(from, latest), applied };
}

/** The schema version of an EXISTING file, read through a read-only connection (nothing is changed). Null when it cannot be read. */
export function readSchemaVersion(file: string): number | null {
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return currentSchemaVersion(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read only; nothing to lose.
    }
  }
}

/**
 * Open `file` read-write (creating it if absent), bring it up to the latest version, and let go of it. This is what the query
 * worker thread runs for the `migrate` request (queryWorker.ts), so a migration of a big database never blocks the main loop.
 * Same migrations, same order, one transaction each; a failure leaves the file as it was before that migration.
 */
export function migrateFile(file: string): MigrationResult {
  const db = openDatabase(file);
  try {
    const result = runMigrations(db);
    // A migration can write a lot: do not leave a big log file behind.
    if (result.applied.length > 0) db.pragma('wal_checkpoint(TRUNCATE)');
    return result;
  } finally {
    db.close();
  }
}
