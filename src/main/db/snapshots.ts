import fs from 'node:fs';
import path from 'node:path';
import { assertWritable } from '../fsutil';
import type { Db } from './connection';
import { ownRemove, ownReplace } from '../danger/ownFiles';

export const SNAPSHOT_DIR_NAME = 'snapshots';
export const SNAPSHOTS_KEPT = 7;
export const SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The ONLY file names pruning is allowed to delete: backuphub-YYYYMMDD-HHmmss.db */
const SNAPSHOT_NAME = /^backuphub-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

/** Thrown when a saved copy is not made on purpose (not enough room). The message is plain words for the person. */
export class SnapshotRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotRefused';
  }
}

/** Asked before a copy is written: a plain sentence says no, null says go on. */
export type SnapshotGuard = () => string | null;

export interface SnapshotLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-time file name for a snapshot taken at `at`. */
export function snapshotFileName(at: Date): string {
  return (
    `backuphub-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.db`
  );
}

/** When a snapshot file was taken, read from its name; null if the name is not ours. */
export function snapshotTime(fileName: string): Date | null {
  const m = SNAPSHOT_NAME.exec(fileName);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s);
}

export function snapshotsDir(dataDir: string): string {
  return path.join(dataDir, SNAPSHOT_DIR_NAME);
}

/** Our snapshot files in `dir`, newest first. Anything else in the folder is ignored. */
export function listSnapshots(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && SNAPSHOT_NAME.test(e.name))
    .map((e) => e.name)
    .toSorted()
    .toReversed();
}

export interface SnapshotResult {
  path: string;
  /** False when a snapshot with this exact second-stamped name already existed. */
  created: boolean;
}

/**
 * Consistent copy of the live database via `VACUUM INTO`, never a raw copy of the WAL files.
 * Written under a temporary name first so a crash cannot leave a half-written snapshot that
 * looks real.
 */
export function createSnapshot(db: Db, dataDir: string, now: Date = new Date(), guard?: SnapshotGuard): SnapshotResult {
  const dir = snapshotsDir(dataDir);
  assertWritable(dir);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, snapshotFileName(now));
  if (fs.existsSync(finalPath)) return { path: finalPath, created: false };
  const refusal = guard?.() ?? null;
  if (refusal !== null) throw new SnapshotRefused(refusal);
  const tmpPath = `${finalPath}.tmp`;
  ownRemove(tmpPath); // our own leftover from an interrupted run
  try {
    db.prepare('VACUUM INTO ?').run(tmpPath);
    ownReplace(tmpPath, finalPath);
  } catch (err) {
    ownRemove(tmpPath);
    throw err;
  }
  return { path: finalPath, created: true };
}

/** Pages copied per step of an online backup (4 KB pages: about 1 MB per event-loop turn). */
export const BACKUP_PAGES_PER_STEP = 256;

/**
 * Consistent copy of the live database through SQLite's online backup, done in small steps between
 * event-loop turns so the app stays responsive. `VACUUM INTO` runs in one go on the main thread: a
 * 133 MB copy to the T7 froze the whole app for 29 s (30 Oct). Written under a temporary name and
 * renamed, like `createSnapshot`.
 */
export async function copyDatabase(db: Db, target: string): Promise<void> {
  assertWritable(target); // T7 write ban: also covers the temporary file next to it
  const tmpPath = `${target}.tmp`;
  ownRemove(tmpPath); // our own leftover from an interrupted run
  try {
    await db.backup(tmpPath, { progress: () => BACKUP_PAGES_PER_STEP });
    ownReplace(tmpPath, target);
  } catch (err) {
    ownRemove(tmpPath);
    throw err;
  }
}

/** `createSnapshot` for use while the app is running: same name and rules, without blocking. */
export async function createSnapshotAsync(db: Db, dataDir: string, now: Date = new Date(), guard?: SnapshotGuard): Promise<SnapshotResult> {
  const dir = snapshotsDir(dataDir);
  assertWritable(dir);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, snapshotFileName(now));
  if (fs.existsSync(finalPath)) return { path: finalPath, created: false };
  const refusal = guard?.() ?? null;
  if (refusal !== null) throw new SnapshotRefused(refusal);
  await copyDatabase(db, finalPath);
  return { path: finalPath, created: true };
}

/** Delete all but the newest `keep` snapshot files (exact-name matches only). Returns names removed. */
export function pruneSnapshots(dir: string, keep: number = SNAPSHOTS_KEPT): string[] {
  assertWritable(dir);
  const doomed = listSnapshots(dir).slice(Math.max(0, keep));
  for (const name of doomed) ownRemove(path.join(dir, name));
  return doomed;
}

/** True when there is no snapshot yet or the newest one is at least `minIntervalMs` old. */
export function snapshotIsDue(dir: string, now: Date, minIntervalMs: number = SNAPSHOT_MIN_INTERVAL_MS): boolean {
  const newest = listSnapshots(dir)[0];
  const taken = newest ? snapshotTime(newest) : null;
  if (!taken) return true;
  return now.getTime() - taken.getTime() >= minIntervalMs;
}

/** Take a snapshot if the last one is over 24 h old, then prune. Never throws (used on quit). */
export function snapshotIfDue(
  db: Db,
  dataDir: string,
  log: SnapshotLogger,
  now: Date = new Date(),
  guard?: SnapshotGuard,
): SnapshotResult | null {
  try {
    const dir = snapshotsDir(dataDir);
    if (!snapshotIsDue(dir, now)) {
      log.info('db snapshot: newest is under 24 h old, skipping');
      return null;
    }
    const result = createSnapshot(db, dataDir, now, guard);
    const pruned = pruneSnapshots(dir);
    log.info(`db snapshot: ${result.created ? 'wrote' : 'already had'} ${result.path}; pruned ${pruned.length}`);
    return result;
  } catch (err) {
    if (err instanceof SnapshotRefused) log.warn(`db snapshot skipped: ${err.message}`);
    else log.warn('db snapshot failed:', err);
    return null;
  }
}
