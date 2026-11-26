import type { Stats } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import { describeReadError } from './hashCore';
import type { FileHasher } from './hasher';

/** The size and modified time the listing stored for a row (mtime is whole milliseconds, truncated). */
export interface ListedStat {
  size: number;
  mtime: number | null;
}

export type FingerprintOutcome =
  | { kind: 'hashed'; sha256: string; md5: string }
  /** The file is not what the listing saw (size or date differ, or it is no longer a plain file). Left for the next listing. */
  | { kind: 'changed' }
  | { kind: 'missing' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'aborted' };

export interface FingerprintOptions {
  capBytesPerSec: number;
  signal: AbortSignal;
  onBytes?: (bytes: number) => void;
  /** A big file that may use the second worker thread. */
  wide?: boolean;
}

const same = (st: Stats, listed: ListedStat): boolean => st.isFile() && st.size === listed.size && Math.trunc(st.mtimeMs) === listed.mtime;

/**
 * Fingerprint one file the listing saw: look at it (lstat) first, read it once, look again. If the
 * size or date differ from the listing before or after the read, the result is thrown away: a file
 * that changed while being read has no trustworthy fingerprint.
 */
export async function fingerprintFile(hasher: FileHasher, absPath: string, listed: ListedStat, options: FingerprintOptions): Promise<FingerprintOutcome> {
  let before: Stats;
  try {
    before = await fs.promises.lstat(absPath);
  } catch (err) {
    const { code, message } = describeReadError(err);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', code, message };
  }
  if (!same(before, listed)) return { kind: 'changed' };

  const result = await hasher.hash({
    path: absPath,
    capBytesPerSec: options.capBytesPerSec,
    size: listed.size,
    signal: options.signal,
    ...(options.wide ? { wide: true } : {}),
    ...(options.onBytes ? { onBytes: options.onBytes } : {}),
  });
  if (!result.ok) return result.code === 'ABORTED' ? { kind: 'aborted' } : { kind: 'error', code: result.code, message: result.message };

  let after: Stats;
  try {
    after = await fs.promises.lstat(absPath);
  } catch {
    return { kind: 'changed' };
  }
  if (!same(after, listed) || result.bytes !== listed.size) return { kind: 'changed' };
  return { kind: 'hashed', sha256: result.sha256, md5: result.md5 };
}
