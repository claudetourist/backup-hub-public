import crypto from 'node:crypto';
import { rawFs as fs } from '../rawFs';
import { throttleDelayMs } from './pure';

/** Result of reading one file once. Never throws: a read problem is a value. */
export type HashResult =
  | { ok: true; sha256: string; md5: string; bytes: number }
  | { ok: false; code: string; message: string };

export interface HashOptions {
  /** Most bytes per second to read (0 = no limit). */
  capBytesPerSec: number;
  /** Checked after every chunk; true stops the read. */
  isCancelled: () => boolean;
  /** Called with the size of each chunk read. */
  onBytes?: (bytes: number) => void;
  /** The size the listing saw. At or below SMALL_FILE_BYTES the file is read in one go (no stream). */
  sizeHint?: number;
  /** One budget shared by files read at the same time, so the cap holds for the total. */
  throttle?: SharedThrottle;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const CHUNK = 1024 * 1024;
/** Files up to this size are read with one read call into a buffer instead of a stream. */
export const SMALL_FILE_BYTES = 4 * 1024 * 1024;

/**
 * One reading budget (bytes per second) shared by every file read at the same moment. Each read
 * reserves its share of the time line; the caller waits until its turn. A short idle stretch
 * (half a second) may be banked so a burst of small files is not delayed one by one.
 */
export class SharedThrottle {
  private nextFree = 0;
  private readonly cell: BigInt64Array | null;
  /**
   * With a `shared` buffer (8 bytes) the time line lives in shared memory, so reading threads that
   * get the same buffer share ONE budget: two big files in two workers still read at the cap in total.
   */
  constructor(
    private readonly clock: () => number = Date.now,
    shared?: SharedArrayBuffer,
  ) {
    this.cell = shared ? new BigInt64Array(shared) : null;
  }

  /** Memory two threads can use to share one budget (pass it to `new SharedThrottle(clock, buffer)`). */
  static createShared(): SharedArrayBuffer {
    return new SharedArrayBuffer(8);
  }

  /** Milliseconds to wait after reading  so the total stays at or below the cap. 0 = no limit. */
  take(bytes: number, capBytesPerSec: number): number {
    if (!(capBytesPerSec > 0) || bytes <= 0) return 0;
    const t = this.clock();
    if (this.cell) {
      // The time line is kept in whole microseconds; retry if another thread moved it meanwhile.
      for (;;) {
        const seen = Atomics.load(this.cell, 0);
        const start = Math.max(Number(seen) / 1000, t - 500);
        const next = start + (bytes / capBytesPerSec) * 1000;
        if (Atomics.compareExchange(this.cell, 0, seen, BigInt(Math.round(next * 1000))) === seen) return Math.max(0, Math.ceil(next - t));
      }
    }
    const start = Math.max(this.nextFree, t - 500);
    this.nextFree = start + (bytes / capBytesPerSec) * 1000;
    return Math.max(0, Math.ceil(this.nextFree - t));
  }
}

/** The one budget of this thread (the main process when it reads itself; a worker replaces it with the shared one). */
export const threadThrottle = new SharedThrottle();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain words for the common read errors; the code stays in the text for the log. */
export function describeReadError(err: unknown): { code: string; message: string } {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'UNKNOWN';
  const why: Record<string, string> = {
    EBUSY: 'the file is in use by another program',
    EPERM: 'access was refused; Windows or another program may be blocking this file',
    EACCES: 'access was refused; Windows or another program may be blocking this file',
    ENOENT: 'the file is no longer there',
    EIO: 'the disk could not be read',
    ENODEV: 'the drive is not available',
    ENXIO: 'the drive is not available',
    EISDIR: 'it is a folder, not a file',
  };
  return { code, message: `Could not read it (${why[code] ?? 'unexpected error'}, ${code}).` };
}

/**
 * Read a file once, front to back, and compute its SHA-256 and MD5 together. Runs in the hashing
 * worker (and in tests). It only ever opens the file for reading.
 */
export async function hashFile(filePath: string, options: HashOptions): Promise<HashResult> {
  if (options.sizeHint !== undefined && options.sizeHint <= SMALL_FILE_BYTES) return hashSmallFile(filePath, options.sizeHint, options);
  return hashStreamed(filePath, options);
}

/** One open, one read (plus one that finds the end), one close: the cheap path for the many small files. */
async function hashSmallFile(filePath: string, sizeHint: number, options: HashOptions): Promise<HashResult> {
  const sleep = options.sleep ?? defaultSleep;
  if (options.isCancelled()) return { ok: false, code: 'ABORTED', message: 'Stopped.' };
  // One byte more than the listing saw: a file that has grown shows up as a wrong byte count.
  const buf = Buffer.allocUnsafe(sizeHint + 1);
  let n = 0;
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
  } catch (err) {
    return { ok: false, ...describeReadError(err) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const data = buf.subarray(0, n);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const md5 = crypto.createHash('md5').update(data).digest('hex');
  options.onBytes?.(n);
  const wait = options.throttle ? options.throttle.take(n, options.capBytesPerSec) : 0;
  if (wait > 0) await sleep(wait);
  if (options.isCancelled()) return { ok: false, code: 'ABORTED', message: 'Stopped.' };
  return { ok: true, sha256, md5, bytes: n };
}

async function hashStreamed(filePath: string, options: HashOptions): Promise<HashResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  const startedAt = now();
  let bytes = 0;
  const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK, flags: 'r' });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      sha.update(chunk);
      md5.update(chunk);
      bytes += chunk.length;
      options.onBytes?.(chunk.length);
      if (options.isCancelled()) return { ok: false, code: 'ABORTED', message: 'Stopped.' };
      const wait = options.throttle ? options.throttle.take(chunk.length, options.capBytesPerSec) : throttleDelayMs(bytes, now() - startedAt, options.capBytesPerSec);
      if (wait > 0) await sleep(wait);
    }
  } catch (err) {
    stream.destroy();
    return { ok: false, ...describeReadError(err) };
  }
  return { ok: true, sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes };
}
