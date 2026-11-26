import Database from 'better-sqlite3';

export type Db = Database.Database;

export const BUSY_TIMEOUT_MS = 5000;

/**
 * Loads the SQLite addon (the DLL load is slow and process-wide) by opening and closing a throwaway in-memory database.
 * A worker thread calls it so that the main thread's own first connection finds the addon already in memory.
 */
export function loadSqliteAddon(): void {
  new Database(':memory:').close();
}

/** Open the database read-write (creating it if absent) with the app's standard pragmas. */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.pragma('foreign_keys = ON');
    // WAL survives in the file; synchronous=NORMAL is the documented safe pairing for WAL.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // 128 MB page cache (default ~2 MB): result writes touch a dozen indexes of ~1.1M rows; with the small cache every row read index pages
    // from disk and a 20-row slice held the window 0.5-0.8 s during a check (CPU profile 25 Nov). Halved per-slice time on a copy of the real db.
    db.pragma('cache_size = -131072');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export interface IntegrityResult {
  ok: boolean;
  /** "ok" or the problems SQLite reported (capped). */
  messages: string[];
}

const MAX_MESSAGES = 20;

/**
 * 'quick' = `PRAGMA quick_check` (page structure, skips index/content cross-checks; fast enough
 * for the startup path). 'full' = `PRAGMA integrity_check` (run later as a background job).
 */
export type IntegrityMode = 'quick' | 'full';

/** Run the integrity pragma for `mode` on an open connection. Never throws. */
export function checkIntegrity(db: Db, mode: IntegrityMode = 'full'): IntegrityResult {
  try {
    const rows = db.pragma(mode === 'quick' ? 'quick_check' : 'integrity_check') as Record<string, string>[];
    const messages = rows.map((row) => Object.values(row)[0] ?? '').slice(0, MAX_MESSAGES);
    return { ok: messages.length === 1 && messages[0] === 'ok', messages };
  } catch (err) {
    return { ok: false, messages: [(err as Error).message] };
  }
}

/**
 * Check an EXISTING database file through a read-only connection, so a damaged file is never
 * written to (no WAL switch, no checkpoint, no migration) before we know it is healthy.
 */
export function probeIntegrity(file: string, mode: IntegrityMode = 'full'): IntegrityResult {
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return checkIntegrity(db, mode);
  } catch (err) {
    return { ok: false, messages: [(err as Error).message] };
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing useful to do; the file was only read.
    }
  }
}
