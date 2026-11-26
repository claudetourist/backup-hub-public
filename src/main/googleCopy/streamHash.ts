/**
 * SHA-256 and MD5 of a file computed WHILE its chunks are read for the upload, so the file is read once, not twice (a check read before the upload used
 * to double the time). The chunks come in order; a chunk read again after a failed try (or after Google says how far it got) is skipped for the part that
 * was already hashed. The hashing itself runs where the rest of the app hashes blocks (hashing/blockDigest.ts: a worker, never a stall of the window).
 * A gap (a chunk that starts beyond what was hashed) makes the answer unusable: `finish` then gives null and the caller reads the file once more.
 */
import { startDigest, type BlockDigest } from '../hashing/blockDigest';
import type { HashResult } from './googleCopyRun';

export class StreamHash {
  private readonly digest: BlockDigest;
  private hashed = 0;
  private gap = false;
  private answer: Promise<HashResult> | null = null;

  constructor(private readonly size: number) {
    this.digest = startDigest({ md5: true, size });
  }

  /** Hands on the bytes of the file that start at `offset`; the part that was hashed before is skipped. */
  async feed(offset: number, bytes: Uint8Array): Promise<void> {
    if (this.gap || this.answer !== null) return;
    if (offset > this.hashed) {
      this.gap = true;
      this.digest.abort();
      return;
    }
    const skip = this.hashed - offset;
    if (skip >= bytes.length) return;
    const part = skip === 0 ? bytes : bytes.subarray(skip);
    this.hashed += part.length;
    await this.digest.update(part);
  }

  /** How many bytes from the start of the file were hashed so far (a resumed upload reads only what is missing before it goes on). */
  get position(): number {
    return this.hashed;
  }

  /** Every byte of the file was seen, in order. */
  get complete(): boolean {
    return !this.gap && this.hashed === this.size;
  }

  /** The checksums of the whole file, or null when it was not seen whole and in order. The same answer however often it is asked. */
  finish(): Promise<HashResult | null> {
    if (!this.complete) return Promise.resolve(null);
    this.answer ??= this.digest.finish().then((d) => ({ sha256: d.sha256, md5: d.md5, bytes: this.hashed }));
    return this.answer;
  }

  /** Drops the digest (the upload failed): safe after `finish`. */
  abort(): void {
    this.digest.abort();
  }
}
