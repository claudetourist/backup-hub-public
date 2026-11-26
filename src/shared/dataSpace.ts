/** Room on the disk that holds Backup Hub's data folder. Shared by main and the screens. Pure data and pure functions only. */

/** Under this much free space Home warns (the person has time to act). */
export const WARN_FREE_BYTES = 5_000_000_000;
/** Under this much free space heavy jobs and saved copies do not start. */
export const BLOCK_FREE_BYTES = 2_000_000_000;

export type SpaceLevel = 'ok' | 'low' | 'critical' | 'unknown';

export function spaceLevel(freeBytes: number | null): SpaceLevel {
  if (freeBytes === null) return 'unknown';
  if (freeBytes < BLOCK_FREE_BYTES) return 'critical';
  if (freeBytes < WARN_FREE_BYTES) return 'low';
  return 'ok';
}

export interface DataSpaceInfo {
  dataDir: string;
  /** "D:" */
  disk: string;
  /** Null when Windows will not say. */
  freeBytes: number | null;
  /** The database file. */
  dbBytes: number;
  /** The write-ahead log next to it (grows while jobs run, folded back in at the end). */
  walBytes: number;
  /** The daily saved copies in the data folder, and how many there are. */
  snapshotsBytes: number;
  snapshotCount: number;
  level: SpaceLevel;
  /** The plain warning for 'low' and 'critical', else null. */
  message: string | null;
  warnBelowBytes: number;
  blockBelowBytes: number;
}
