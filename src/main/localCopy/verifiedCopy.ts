/**
 * The one verified copy of a single file, shared by the copy to a drive (`copy.toLocal`) and the app data snapshot (PLAN.md section 4
 * rule 4; S1). The sequence, in this order:
 *   1. the bytes go to a temp file in the drive's temp folder (in the app's own files; the same volume, never inside a backup root), are written,
 *      flushed (`fsync` of the handle) and closed;
 *   2. the temp file is read back THROUGH A HANDLE THAT BYPASSES THE WINDOWS CACHE (`directRead.ts`, aligned blocks) and hashed;
 *   3. the checksum is compared with the one of the source (SHA-256; MD5 as well when asked, in the same read);
 *   4. the temp name is linked to the final name (`fs.promises.link`): it fails with EEXIST when anything is there and can never replace;
 *   5. the final file is opened, flushed and closed; only then the temp name is removed (through `danger/ownFiles`).
 * The caller writes the index row only after this returned ok.
 * A crash or an unplug between 4 and 5 leaves a complete, verified file under both names. The next copy of the same final name finds
 * both (same file), checks the checksum against the source, flushes the final and clears the temp name (`settleLeftover`).
 * A failed flush of the final file keeps both names for exactly that reason. Nothing here falls back to an ordinary read.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { assertWritable } from '../fsutil';
import { ownRemoveAsync } from '../danger/ownFiles';
import { isInsideAppOwnFiles, isInsideCardFolder } from '../../shared/appFolders';
import { driveTmpFolder } from '../places/appFolders';
import { hashUnbuffered } from './directRead';
import { startDigest } from '../hashing/blockDigest';

export const COPY_CHUNK = 4 * 1024 * 1024;

/** What reading a file once gave. MD5 is there only when it was asked for (files that go to Google or are compared with Google). */
export interface Hashes {
  sha256: string;
  md5: string | null;
}

/** Test hooks: the real operations are the defaults. A failing flush or link simulates a drive that dropped off. */
export interface CopyIo {
  /** Flush a written handle (default: handle.sync()). */
  syncHandle?: (handle: FileHandle) => Promise<void>;
  /** Flush the final file after the link (default: open, sync, close). */
  syncFinal?: (file: string) => Promise<void>;
  link?: (from: string, to: string) => void | Promise<void>;
  /** Read back without the cache (default: hashUnbuffered). */
  readBack?: (file: string, opts: { md5: boolean; yieldNow: () => Promise<void> }) => Promise<{ sha256: string; md5: string | null }>;
}

export interface VerifiedCopyOptions {
  source: string;
  /** The final name on the drive. */
  final: string;
  /** The size the source must still have (a file that grew or shrank while it was read is refused). */
  size: number;
  chunkBytes?: number;
  /** Compute MD5 as well in the same reads (default: no). */
  md5?: boolean;
  /** Gives the event loop a turn and throws when the job was cancelled. */
  yieldNow: () => Promise<void>;
  /** Called after each chunk with the bytes of this file done so far, and after the read back with `checking` set. */
  onProgress?: (bytesDone: number, checking: boolean) => void;
  /** The caller may reject what was read from the source (for example when it no longer matches the catalog). */
  acceptSource?: (hashes: Hashes) => boolean;
  /** Where the temp file goes (default: the temp folder of the drive the final file is on). */
  tmpDir?: string;
  io?: CopyIo;
}

export type VerifiedCopyResult =
  | { ok: true; hashes: Hashes; /** True when an earlier run had already linked the file and this run finished and checked it. */ recovered?: boolean }
  | { ok: false; reason: 'source_changed' | 'mismatch' | 'exists' | 'protected_name'; hashes?: Hashes };

let tmpDirResolver: ((final: string) => string) | null = null;

/** Tests only: where temp files go when a call gives no `tmpDir` (the real default is on the drive of the final file). */
export function setCopyTmpResolverForTests(fn: ((final: string) => string) | null): void {
  tmpDirResolver = fn;
}

/** The temp folder of the volume the final file is on: the same volume, outside every backup root. */
export function tmpDirFor(final: string, override?: string): string {
  if (override !== undefined) return override;
  if (tmpDirResolver) return tmpDirResolver(final);
  return driveTmpFolder(path.parse(path.resolve(final)).root);
}

/** The temp name of one final name: always the same, so an interrupted copy can be found and settled later. */
export function tempPathFor(final: string, override?: string): string {
  const key = createHash('sha1').update(path.resolve(final).toLowerCase()).digest('hex').slice(0, 24);
  return path.join(tmpDirFor(final, override), `${key}.bhtmp`);
}

/** True when a SOURCE is inside the app's own files folder (or the card folder of an old-layout drive): never copied (a whole-drive copy leaves it out). */
export function touchesBackupHubFolder(p: string): boolean {
  return isInsideAppOwnFiles(path.resolve(p));
}

/** True when a FINAL name would be inside the card folder (card, temp, set-aside): a copy never lands there. The app's other own folders may be copied into. */
function landsInCardFolder(p: string): boolean {
  return isInsideCardFolder(path.resolve(p));
}

/** Reads a whole file once (ordinary read) and returns the hashes. Used to look at a source or at a file that is already at a name. */
export async function hashFileOnce(target: string, opts: Pick<VerifiedCopyOptions, 'chunkBytes' | 'yieldNow'> & { md5?: boolean }): Promise<Hashes> {
  const chunk = opts.chunkBytes ?? COPY_CHUNK;
  const handle = await fs.promises.open(target, 'r');
  // The checksum is made on a worker thread (hashing/blockDigest.ts), not on the window's thread.
  const digest = startDigest({ md5: opts.md5 === true, size: (await handle.stat()).size });
  try {
    const buffer = Buffer.allocUnsafe(chunk);
    for (;;) {
      await opts.yieldNow();
      const { bytesRead } = await handle.read(buffer, 0, chunk, null);
      if (bytesRead === 0) break;
      await digest.update(buffer.subarray(0, bytesRead));
    }
    return await digest.finish();
  } finally {
    digest.abort();
    await handle.close();
  }
}

/** Copies source to `tmp` in chunks, hashing what was read, and flushes the written handle before it closes. */
async function copyToTemp(source: string, tmp: string, size: number, opts: VerifiedCopyOptions): Promise<Hashes> {
  const chunk = opts.chunkBytes ?? COPY_CHUNK;
  const input = await fs.promises.open(source, 'r');
  let output: FileHandle | null = null;
  const digest = startDigest({ md5: opts.md5 === true, size });
  let hashes: Hashes;
  try {
    output = await fs.promises.open(tmp, 'wx');
    const buffer = Buffer.allocUnsafe(chunk);
    let done = 0;
    for (;;) {
      await opts.yieldNow();
      const { bytesRead } = await input.read(buffer, 0, chunk, null);
      if (bytesRead === 0) break;
      const piece = buffer.subarray(0, bytesRead);
      await digest.update(piece);
      await output.write(piece, 0, bytesRead);
      done += bytesRead;
      opts.onProgress?.(done, false);
    }
    if (done !== size) throw Object.assign(new Error('The file changed size while it was being read.'), { code: 'EIO' });
    await (opts.io?.syncHandle ? opts.io.syncHandle(output) : output.sync());
    hashes = await digest.finish();
  } finally {
    digest.abort();
    await input.close();
    if (output) await output.close();
  }
  return hashes;
}

async function syncFile(file: string, io: CopyIo | undefined): Promise<void> {
  if (io?.syncFinal) return io.syncFinal(file);
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** True when a path is there (any error counts as not there, like `existsSync`). Asks the drive on the thread pool, never on the window's thread. */
export async function existsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const x = await fs.promises.stat(a);
    const y = await fs.promises.stat(b);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * Looks at the temp name of `final` before a copy or when a look finds the final file already there. Nothing there: nothing to do.
 * The temp name is the same file as the final (a crash or unplug between the link and the flush): the final is flushed and the temp
 * name cleared, but only when `isExpected` confirms the final's content (the caller's checksum check). Anything else is an old
 * half-written temp file of ours: it is removed. Returns what was found.
 */
export async function settleLeftover(final: string, opts: { tmpDir?: string; io?: CopyIo; isExpected: () => Promise<boolean> }): Promise<'none' | 'settled' | 'cleared' | 'unexpected'> {
  const tmp = tempPathFor(final, opts.tmpDir);
  if (!(await existsAsync(tmp))) return 'none';
  assertWritable(final);
  if ((await existsAsync(final)) && (await sameFile(tmp, final))) {
    if (!(await opts.isExpected())) return 'unexpected'; // both names stay; the person decides
    await syncFile(final, opts.io);
    await ownRemoveAsync(tmp);
    return 'settled';
  }
  await ownRemoveAsync(tmp);
  return 'cleared';
}

/** Removes the temp files of copies that never reached their final name (nothing else links to them) in a drive's temp folder. */
export async function sweepStaleTemps(tmpDir: string): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(tmpDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.bhtmp')) continue;
    const abs = path.join(tmpDir, name);
    try {
      if ((await fs.promises.stat(abs)).nlink > 1) continue; // linked to a final name: settled by the next look at that file
      await ownRemoveAsync(abs);
      removed += 1;
    } catch {
      // Gone or busy: leave it.
    }
  }
  return removed;
}

/**
 * Copy one file with the whole check. The folder of `final` must exist. Returns the hashes of the written copy; on any refusal only
 * this copy's own temp file is removed and nothing else on the drive is touched. Read and write problems are thrown (the caller maps
 * their codes); the temp file is removed before they leave, except after the link (see the header).
 */
export async function verifiedCopy(opts: VerifiedCopyOptions): Promise<VerifiedCopyResult> {
  assertWritable(opts.final); // before anything is created, linked or removed on the drive
  if (touchesBackupHubFolder(opts.source) || landsInCardFolder(opts.final)) return { ok: false, reason: 'protected_name' };
  const io = opts.io;
  const tmp = tempPathFor(opts.final, opts.tmpDir);
  assertWritable(tmp);
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true });

  // An earlier run that was cut off: finish it (the final file is there under both names) or clear the old temp file.
  let sourceHash: Hashes | null = null;
  const settled = await settleLeftover(opts.final, {
    ...(opts.tmpDir === undefined ? {} : { tmpDir: opts.tmpDir }),
    ...(io === undefined ? {} : { io }),
    isExpected: async () => {
      sourceHash = await hashFileOnce(opts.source, { ...(opts.chunkBytes === undefined ? {} : { chunkBytes: opts.chunkBytes }), yieldNow: opts.yieldNow, md5: opts.md5 === true });
      const there = await (io?.readBack ?? hashUnbuffered)(opts.final, { md5: opts.md5 === true, yieldNow: opts.yieldNow });
      return there.sha256 === sourceHash.sha256 && (opts.md5 !== true || there.md5 === sourceHash.md5);
    },
  });
  if (settled === 'settled' && sourceHash) return { ok: true, hashes: sourceHash, recovered: true };
  if (settled === 'unexpected') return { ok: false, reason: 'exists' };
  if (await existsAsync(opts.final)) return { ok: false, reason: 'exists' };

  let linked = false;
  try {
    const copied = await copyToTemp(opts.source, tmp, opts.size, opts);
    if (opts.acceptSource && !opts.acceptSource(copied)) {
      await ownRemoveAsync(tmp);
      return { ok: false, reason: 'source_changed', hashes: copied };
    }
    opts.onProgress?.(opts.size, true);
    const back = await (io?.readBack ?? hashUnbuffered)(tmp, { md5: opts.md5 === true, yieldNow: opts.yieldNow });
    if (back.sha256 !== copied.sha256 || (opts.md5 === true && back.md5 !== copied.md5)) {
      await ownRemoveAsync(tmp);
      return { ok: false, reason: 'mismatch' };
    }
    await fs.promises.utimes(tmp, new Date(), (await fs.promises.stat(opts.source)).mtimeMs / 1000);
    try {
      await (io?.link ?? fs.promises.link)(tmp, opts.final);
    } catch (err) {
      await ownRemoveAsync(tmp);
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' };
      throw err;
    }
    linked = true;
    await syncFile(opts.final, io);
    await ownRemoveAsync(tmp);
    return { ok: true, hashes: copied };
  } catch (err) {
    if (!linked) await ownRemoveAsync(tmp);
    throw err;
  }
}

// ---- A file that is already on the drive under its temp name (R1.2a: `adb pull` writes straight to the temp name) -------------------

/**
 * What the safe placement of a pulled file asks of the drive. The real one is `realDriveOps`; tests swap in an unkind fake drive.
 * Every method that changes the drive is one step of the S1 sequence; none of them can replace a final name.
 */
export interface DriveOps {
  /** Refuses (throws) when the final name must not be written (write protection, the card folder). */
  guard(final: string): void;
  exists(file: string): Promise<boolean>;
  sizeOf(file: string): Promise<number | null>;
  /** Flush the file to the drive (fsync). */
  flush(file: string): Promise<void>;
  /** SHA-256 of the file read from the drive itself, bypassing the cache. */
  hash(file: string, yieldNow: () => Promise<void>): Promise<string>;
  /** A second name for the same file; throws with code EEXIST when anything is at `to` (never replaces). */
  link(from: string, to: string): Promise<void>;
  /** Removes this app's own temp name. */
  removeTemp(tmp: string): Promise<void>;
}

export function realDriveOps(io?: CopyIo): DriveOps {
  return {
    guard(final) {
      assertWritable(final);
      if (landsInCardFolder(final)) throw Object.assign(new Error('Not inside the Backup Hub card folder.'), { code: 'EPERM' });
    },
    exists: (file) => existsAsync(file),
    async sizeOf(file) {
      try {
        return (await fs.promises.stat(file)).size;
      } catch {
        return null;
      }
    },
    flush: (file) => syncFile(file, io),
    hash: async (file, yieldNow) => (await (io?.readBack ?? hashUnbuffered)(file, { md5: false, yieldNow })).sha256,
    link: async (from, to) => {
      await (io?.link ?? fs.promises.link)(from, to);
    },
    removeTemp: (tmp) => ownRemoveAsync(tmp),
  };
}

export type AdoptResult = { ok: true } | { ok: false; reason: 'short' | 'mismatch' | 'exists' | 'protected_name' };

/**
 * The S1 sequence for a file that is already complete under its temp name (`tmp`): size check; flush; read back from the drive without
 * the cache and compare with `expectedSha256` (the checksum read on the phone); link to the final name (cannot replace); flush the final;
 * remove the temp name. The caller writes the index row only after this returned ok. On any refusal only this temp name is removed.
 */
export async function adoptVerifiedTemp(opts: { tmp: string; final: string; size: number; expectedSha256: string; yieldNow: () => Promise<void>; ops?: DriveOps }): Promise<AdoptResult> {
  const ops = opts.ops ?? realDriveOps();
  try {
    ops.guard(opts.final);
  } catch (err) {
    await ops.removeTemp(opts.tmp);
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return { ok: false, reason: 'protected_name' };
    throw err;
  }
  if ((await ops.sizeOf(opts.tmp)) !== opts.size) {
    await ops.removeTemp(opts.tmp);
    return { ok: false, reason: 'short' };
  }
  await ops.flush(opts.tmp);
  if ((await ops.hash(opts.tmp, opts.yieldNow)) !== opts.expectedSha256) {
    await ops.removeTemp(opts.tmp);
    return { ok: false, reason: 'mismatch' };
  }
  if (await ops.exists(opts.final)) {
    await ops.removeTemp(opts.tmp);
    return { ok: false, reason: 'exists' };
  }
  try {
    await ops.link(opts.tmp, opts.final);
  } catch (err) {
    await ops.removeTemp(opts.tmp);
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' };
    throw err;
  }
  await ops.flush(opts.final); // a failed flush keeps both names: the next run finds and settles them
  await ops.removeTemp(opts.tmp);
  return { ok: true };
}
