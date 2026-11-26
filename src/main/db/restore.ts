import fs from 'node:fs';
import path from 'node:path';
import { assertWritable } from '../fsutil';
import { ownMoveDb, ownRemove } from '../danger/ownFiles';

/**
 * "Restore Backup Hub" on a new laptop (or after a loss): a checked database copy is STAGED in `<dataDir>\restore` while the app
 * runs and swapped in at the NEXT start, before the database is opened. The database that was in use is moved (never deleted) to
 * `<dataDir>\before-restore\<stamp>\`, so a restore can always be undone by moving it back.
 */
export const RESTORE_DIR_NAME = 'restore';
export const BEFORE_RESTORE_DIR_NAME = 'before-restore';
export const PENDING_DB = 'pending.db';
export const PENDING_INFO = 'pending.json';
const LIVE_DB = 'backuphub.db';

export interface PendingRestore {
  /** What the copy came from, in plain words (a drive name and file, or the chosen file). */
  source: string;
  stagedAt: number;
  /** What it holds, in plain words. */
  summary: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export function restoreStamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

export function restoreDir(dataDir: string): string {
  return path.join(dataDir, RESTORE_DIR_NAME);
}

/** The staged restore, or null when none is waiting (both files must be there and the info must read). */
export function readPendingRestore(dataDir: string): PendingRestore | null {
  const dir = restoreDir(dataDir);
  try {
    if (!fs.statSync(path.join(dir, PENDING_DB)).isFile()) return null;
    const info = JSON.parse(fs.readFileSync(path.join(dir, PENDING_INFO), 'utf8')) as Partial<PendingRestore>;
    if (typeof info.source !== 'string' || typeof info.stagedAt !== 'number' || typeof info.summary !== 'string') return null;
    return { source: info.source, stagedAt: info.stagedAt, summary: info.summary };
  } catch {
    return null;
  }
}

/** Removes the staged restore (only our own two files). The database in use is not touched. */
export function cancelPendingRestore(dataDir: string): boolean {
  const dir = restoreDir(dataDir);
  assertWritable(dir); // T7 write ban (the data folder is normally on the laptop)
  let removed = false;
  for (const name of [PENDING_DB, `${PENDING_DB}.part`, `${PENDING_DB}.part-wal`, `${PENDING_DB}.part-shm`, PENDING_INFO]) {
    if (fs.existsSync(path.join(dir, name))) {
      ownRemove(path.join(dir, name));
      removed = true;
    }
  }
  return removed;
}

export interface RestoreLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * At start, before the database is opened: swap in a staged restore. The current database (and its -wal and -shm files) is moved to
 * `before-restore\<stamp>\`; the staged copy takes its place. If the swap fails half way, the old files are moved back. Returns true
 * when a restore was applied.
 */
export function applyPendingRestore(dataDir: string, log: RestoreLogger, now: Date = new Date()): boolean {
  const pending = readPendingRestore(dataDir);
  if (!pending) return false;
  const dir = restoreDir(dataDir);
  const live = path.join(dataDir, LIVE_DB);
  const aside = path.join(dataDir, BEFORE_RESTORE_DIR_NAME, restoreStamp(now));
  const moved: [string, string][] = [];
  try {
    assertWritable(aside);
    assertWritable(live);
    fs.mkdirSync(aside, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${live}${suffix}`;
      if (!fs.existsSync(from)) continue;
      const to = path.join(aside, `${LIVE_DB}${suffix}`);
      ownMoveDb(from, to);
      moved.push([to, from]);
    }
    ownMoveDb(path.join(dir, PENDING_DB), live);
    ownRemove(path.join(dir, PENDING_INFO));
    log.info(`restore: applied the staged copy from ${pending.source}; the database that was in use is in ${aside}`);
    return true;
  } catch (err) {
    log.warn('restore: could not swap in the staged copy; putting the old database back', err);
    for (const [from, to] of moved.toReversed()) {
      try {
        if (!fs.existsSync(to)) ownMoveDb(from, to);
      } catch (undo) {
        log.warn(`restore: could not move ${from} back`, undo);
      }
    }
    return false;
  }
}
