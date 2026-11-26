/**
 * Reads a file the way a copy check must: through a handle that bypasses the Windows file cache (FILE_FLAG_NO_BUFFERING), so the bytes
 * come from the drive and not from memory. Reading back what was just written without this only proves Windows' memory (PLAN.md
 * section 4 rule 4).
 *
 * Node's `fs.constants.UV_FS_O_DIRECT` is NOT exported on Windows (undefined in Node 25.7 and in Electron 43's Node 24.18), but libuv
 * accepts its value, 0x02000000, which it maps to FILE_FLAG_NO_BUFFERING. So that value is used when the constant is missing. This is
 * the same flag, not a downgrade. After every open the flag is PROVEN to be active: an unbuffered handle refuses a read that is not
 * sector aligned (EINVAL), a cached handle would answer. If the proof fails, this throws: there is no fallback to an ordinary read.
 *
 * Unbuffered reads need an aligned file offset, an aligned length and an aligned memory address. Blocks are 1 MiB at multiples of
 * 4096 bytes (right for 512-byte and 4K sectors); the last block is simply shorter. The memory address of a Buffer cannot be read in
 * JavaScript, so the offset inside one big buffer where an aligned read works is found by trying (at most 256 tries, once).
 */
import type { FileHandle } from 'node:fs/promises';
import { rawFs as fs } from '../rawFs';
import { startDigest } from '../hashing/blockDigest';

/** libuv's UV_FS_O_DIRECT on Windows (FILE_FLAG_NO_BUFFERING). */
export const WINDOWS_DIRECT_FLAG = 0x02000000;
export const DIRECT_BLOCK = 1024 * 1024;
export const SECTOR = 4096;

export class DirectReadUnavailable extends Error {
  constructor(message: string) {
    super(`Reading a copy back from the drive without the cache did not work: ${message}. Nothing was kept. There is no fallback to an ordinary read.`);
    this.name = 'DirectReadUnavailable';
  }
}

/** The flag value used to open a file unbuffered, or null on a system where none is known. */
export function directFlag(): number | null {
  const named = (fs.constants as Record<string, number | undefined>)['UV_FS_O_DIRECT'];
  if (typeof named === 'number' && named !== 0) return named;
  if (process.platform === 'win32') return WINDOWS_DIRECT_FLAG;
  const posix = (fs.constants as Record<string, number | undefined>)['O_DIRECT'];
  return typeof posix === 'number' && posix !== 0 ? posix : null;
}

export interface DirectHashOptions {
  /** Also compute MD5 in the same read. */
  md5?: boolean;
  /** Gives the event loop a turn and throws when the job was cancelled. */
  yieldNow?: () => Promise<void>;
  /** Called after each block with the bytes done so far. */
  onProgress?: (bytesDone: number) => void;
  /** Called with every block as it is read (the copy to a second drive writes it from here: the source is read once). Awaited before the next block; the buffer is reused, so use it at once. */
  onBlock?: (block: Buffer) => Promise<void> | void;
}

export interface DirectHash {
  sha256: string;
  md5: string | null;
  bytes: number;
}

const isEinval = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'EINVAL';

/** Read buffers are reused (a new 1 MiB buffer for every small file was a visible part of the time per file); each remembers where in it an aligned read works. */
interface Slot {
  buffer: Buffer;
  offset: number;
}
const FREE_SLOTS: Slot[] = [];
const MAX_FREE_SLOTS = 8;
const takeSlot = (): Slot => FREE_SLOTS.pop() ?? { buffer: Buffer.allocUnsafeSlow(DIRECT_BLOCK + SECTOR), offset: -1 };
const giveSlot = (slot: Slot): void => {
  if (FREE_SLOTS.length < MAX_FREE_SLOTS) FREE_SLOTS.push(slot);
};

/** Opens `file` unbuffered and proves the flag took effect (see the header). Returns the handle; the caller closes it. */
export async function openUnbuffered(file: string): Promise<FileHandle> {
  return (await openProved(file)).handle;
}

/** The same, and the size the handle reported (one stat for the proof and for the read). */
async function openProved(file: string): Promise<{ handle: FileHandle; size: number }> {
  const flag = directFlag();
  if (flag === null) throw new DirectReadUnavailable('this system has no unbuffered read flag');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | flag);
  try {
    const size = (await handle.stat()).size;
    if (size > 0) {
      // Proof: an unbuffered handle cannot read one byte at an odd address and length.
      const probe = Buffer.allocUnsafeSlow(SECTOR * 2);
      let refused = false;
      try {
        await handle.read(probe, 1, 1, 0);
      } catch (err) {
        if (!isEinval(err)) throw err;
        refused = true;
      }
      if (!refused) throw new DirectReadUnavailable('the system accepted a 1-byte read, so the handle was not unbuffered');
    }
    return { handle, size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** SHA-256 (and MD5 when asked) of a file read from the drive without the cache. */
export async function hashUnbuffered(file: string, opts: DirectHashOptions = {}): Promise<DirectHash> {
  const { handle, size } = await openProved(file);
  const slot = takeSlot();
  // The checksum is made on a worker thread (blockDigest.ts): the main thread only reads and hands the blocks on.
  const digest = startDigest({ md5: opts.md5 === true, size });
  try {
    if (size === 0) return { ...(await digest.finish()), bytes: 0 };
    const buffer = slot.buffer;
    let offset = slot.offset;
    let position = 0;
    let first = true;
    for (;;) {
      await opts.yieldNow?.();
      let n = 0;
      let got = false;
      if (first && offset >= 0) {
        // Where an aligned read worked last time; if this drive wants another place, it is found again below.
        try {
          n = (await handle.read(buffer, offset, DIRECT_BLOCK, 0)).bytesRead;
          got = true;
          first = false;
        } catch (err) {
          if (!isEinval(err)) throw err;
          offset = -1;
        }
      }
      if (got) {
        // (the first block is in)
      } else if (first) {
        for (let at = 0; at < SECTOR; at += 16) {
          try {
            n = (await handle.read(buffer, at, DIRECT_BLOCK, 0)).bytesRead;
            offset = at;
            break;
          } catch (err) {
            if (!isEinval(err)) throw err;
          }
        }
        if (offset < 0) throw new DirectReadUnavailable('no aligned place was found in the read buffer');
        slot.offset = offset;
        first = false;
      } else {
        n = (await handle.read(buffer, offset, DIRECT_BLOCK, position)).bytesRead;
      }
      if (n === 0) break;
      const piece = buffer.subarray(offset, offset + n);
      await digest.update(piece);
      if (opts.onBlock) await opts.onBlock(piece);
      position += n;
      opts.onProgress?.(position);
      if (n < DIRECT_BLOCK) break; // end of file (a short read anywhere else is caught by the size check below)
    }
    if (position !== size) throw Object.assign(new Error('The file read back shorter than it is.'), { code: 'EIO' });
    return { ...(await digest.finish()), bytes: position };
  } finally {
    digest.abort();
    giveSlot(slot);
    await handle.close();
  }
}
