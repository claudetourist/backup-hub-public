import Database from 'better-sqlite3';
import type { Db } from './connection';
import { BUSY_TIMEOUT_MS } from './connection';

/**
 * When must the app run `quick_check` before it opens the database? On the real 400 MB database
 * it took 14.5 s, so it is skipped when nothing gives a reason to doubt the file:
 * - the last run ended with a normal quit (`meta.clean_shutdown = 1`; it is cleared right after
 *   opening, so a crash, power cut or kill leaves it at 0), and
 * - a check passed within the last 7 days: the full integrity check (`meta.last_integrity_ok_at`, written by the
 *   "Check the database" job), or the start-up `quick_check` itself (`meta.last_startup_check_ok_at`). Since nothing
 *   starts by itself any more, the full check is rare; without the second key every launch after 7 days would check again.
 * Anything else (flag missing, unreadable meta, no full check on record, one older than 7 days)
 * counts as doubt and the check runs, exactly as before.
 */
export const META_CLEAN_SHUTDOWN = 'clean_shutdown';
export const META_LAST_INTEGRITY_OK_AT = 'last_integrity_ok_at';
export const META_LAST_STARTUP_CHECK_OK_AT = 'last_startup_check_ok_at';
export const FULL_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StartupCheckReason =
  | 'unclean-shutdown'
  | 'unknown-shutdown'
  | 'no-full-check-on-record'
  | 'full-check-too-old'
  | 'meta-unreadable'
  | 'clean-and-recently-checked';

export interface StartupCheckDecision {
  /** True = run quick_check before opening. */
  run: boolean;
  reason: StartupCheckReason;
}

export interface StartupMeta {
  cleanShutdown: string | null;
  lastIntegrityOkAt: string | null;
  /** The start-up quick_check passed at this time (ms). */
  lastStartupCheckOkAt?: string | null;
}

/** Pure decision. `meta` is null when the meta table could not be read at all. */
export function decideStartupCheck(meta: StartupMeta | null, now: number): StartupCheckDecision {
  if (meta === null) return { run: true, reason: 'meta-unreadable' };
  if (meta.cleanShutdown === '0') return { run: true, reason: 'unclean-shutdown' };
  if (meta.cleanShutdown !== '1') return { run: true, reason: 'unknown-shutdown' };
  // The newest usable time of the two checks. A time in the future (clock changed) is not trusted.
  const times = [meta.lastIntegrityOkAt, meta.lastStartupCheckOkAt ?? null]
    .map((v) => (v === null ? Number.NaN : Number(v)))
    .filter((t) => Number.isFinite(t) && t > 0);
  if (times.length === 0) return { run: true, reason: 'no-full-check-on-record' };
  const trusted = times.filter((t) => t <= now);
  const at = trusted.length > 0 ? Math.max(...trusted) : Number.NaN;
  if (!Number.isFinite(at) || now - at > FULL_CHECK_MAX_AGE_MS) return { run: true, reason: 'full-check-too-old' };
  return { run: false, reason: 'clean-and-recently-checked' };
}

/** Read the two flags through a read-only connection (the file is not changed). Null if that fails. */
export function readStartupMeta(file: string): StartupMeta | null {
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const get = (key: string): string | null => {
      const row = db!.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    return { cleanShutdown: get(META_CLEAN_SHUTDOWN), lastIntegrityOkAt: get(META_LAST_INTEGRITY_OK_AT), lastStartupCheckOkAt: get(META_LAST_STARTUP_CHECK_OK_AT) };
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

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Right after opening: the app is running, so a crash from here on must be noticed next time. */
export function markRunning(db: Db): void {
  setMeta(db, META_CLEAN_SHUTDOWN, '0');
}

/** On a normal quit, just before the database is closed. */
export function markCleanShutdown(db: Db): void {
  setMeta(db, META_CLEAN_SHUTDOWN, '1');
}

/** The start-up quick_check passed (the file was checked before it was opened for writing). */
export function markStartupCheckPassed(db: Db, now: number): void {
  setMeta(db, META_LAST_STARTUP_CHECK_OK_AT, String(now));
}

/** The full integrity check passed. */
export function markFullCheckPassed(db: Db, now: number): void {
  setMeta(db, META_LAST_INTEGRITY_OK_AT, String(now));
}
