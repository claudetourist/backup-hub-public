import fs from 'node:fs';
import path from 'node:path';
import type { DataSpaceInfo, SpaceLevel } from '../shared/dataSpace';
import { DB_FILE_NAME } from './db/index';
import { listSnapshots, snapshotsDir } from './db/snapshots';
import { freeBytesOf } from './localCopy/freeSpace';

export { BLOCK_FREE_BYTES, WARN_FREE_BYTES, spaceLevel } from '../shared/dataSpace';
import { BLOCK_FREE_BYTES, WARN_FREE_BYTES, spaceLevel } from '../shared/dataSpace';

/** Job kinds that must still run when the disk is nearly full (they only read, or only move things inside a drive). */
/** (The recovery copy is made in the temp folder on C: and checks its own room.) */
const EXEMPT_KINDS = new Set<string>(['db.integrityCheck', 'clean.laptop', 'clean.phone', 'clean.putBack', 'recovery.toDrive', 'freeup.check', 'freeup.remove']);

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** "D:" for a path on a lettered drive, else the folder itself. */
export function diskNameOf(dir: string): string {
  const m = /^([A-Za-z]:)/.exec(dir);
  return m ? m[1]!.toUpperCase() : dir;
}

/** The plain sentence under 5 GB (a warning) or under 2 GB (heavy jobs and saved copies do not start). */
export function spaceMessage(level: SpaceLevel, freeBytes: number | null, disk: string): string | null {
  if (freeBytes === null || level === 'ok' || level === 'unknown') return null;
  if (level === 'low') {
    return `The disk that holds Backup Hub's data (${disk}) has only ${gb(freeBytes)} free. Backup Hub grows as it learns about more files. Free some space on ${disk}, or move old saved copies to a backup drive, before it runs short. Nothing is wrong yet.`;
  }
  return `The disk that holds Backup Hub's data (${disk}) has only ${gb(freeBytes)} free, so Backup Hub will not start checking, matching copies or saving copies until there is more room. Nothing was lost. Free some space on ${disk}, or move old saved copies to a backup drive, then try again.`;
}

/**
 * What Backup Hub knows about the disk its data folder is on: free space, how big the database and its log are, and how much
 * the daily saved copies take. Cheap (a few file sizes), read only.
 */
export class DataSpace {
  constructor(
    private readonly dataDir: string,
    private readonly free: (dir: string) => number | null = freeBytesOf,
  ) {}

  freeBytes(): number | null {
    return this.free(this.dataDir);
  }

  level(): SpaceLevel {
    return spaceLevel(this.freeBytes());
  }

  info(): DataSpaceInfo {
    const sizeOf = (file: string): number => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    };
    const file = path.join(this.dataDir, DB_FILE_NAME);
    const dir = snapshotsDir(this.dataDir);
    const snapshots = listSnapshots(dir);
    const freeBytes = this.freeBytes();
    const level = spaceLevel(freeBytes);
    const disk = diskNameOf(this.dataDir);
    return {
      dataDir: this.dataDir,
      disk,
      freeBytes,
      dbBytes: sizeOf(file),
      walBytes: sizeOf(`${file}-wal`),
      snapshotsBytes: snapshots.reduce((sum, name) => sum + sizeOf(path.join(dir, name)), 0),
      snapshotCount: snapshots.length,
      level,
      message: spaceMessage(level, freeBytes, disk),
      warnBelowBytes: WARN_FREE_BYTES,
      blockBelowBytes: BLOCK_FREE_BYTES,
    };
  }

  /** The plain reason a heavy job of this kind may not start now, or null. */
  refusalFor(kind: string): string | null {
    if (EXEMPT_KINDS.has(kind) || kind.startsWith('dev.')) return null;
    const free = this.freeBytes();
    if (spaceLevel(free) !== 'critical') return null;
    return `Did not start: ${spaceMessage('critical', free, diskNameOf(this.dataDir))}`;
  }

  /** The plain reason a saved copy of the database may not be made now (it needs about the size of the database and must leave a safe margin), or null. */
  copyRefusal(): string | null {
    const free = this.freeBytes();
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(path.join(this.dataDir, DB_FILE_NAME)).size;
    } catch {
      // No file yet: nothing to copy.
    }
    if (free === null) return null;
    if (free >= dbBytes + BLOCK_FREE_BYTES) return null;
    const disk = diskNameOf(this.dataDir);
    return `No saved copy was made: the disk that holds Backup Hub's data (${disk}) has ${gb(free)} free, and a copy needs about ${gb(dbBytes)} and must leave ${gb(BLOCK_FREE_BYTES)} free. The database itself is fine. Free some space on ${disk}, or move old saved copies to a backup drive.`;
  }
}
