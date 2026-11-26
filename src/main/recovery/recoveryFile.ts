/**
 * The recovery file: a copy of the Backup Hub database, compressed and encrypted, small enough to keep in a Google Drive
 * account and useful on a new laptop.
 *
 * Layout: `BHRC1\n`, a 4-byte big-endian header length, a JSON header, then frames (4-byte length, 12-byte nonce,
 * AES-256-GCM ciphertext of one chunk of the gzip stream). The header holds the vault record (the data key wrapped by the
 * recovery passphrase), so the passphrase alone is enough to open the file on another computer; the data key itself is
 * never in the file in the clear. Every frame binds its position and whether it is the last one, so a cut, reordered or
 * altered file fails to open instead of giving a partial database.
 */
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { assertWritable } from '../fsutil';
import { NONCE_BYTES, open as openSealed, seal } from '../vault/vaultCrypto';
import { ownRemove } from '../danger/ownFiles';

export const RECOVERY_MAGIC = Buffer.from('BHRC1\n');
export const RECOVERY_CHUNK_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const TAG_BYTES = 16;

export interface RecoveryHeader {
  v: 1;
  createdAt: number;
  appVersion: string;
  /** The vault record at the time (JSON as stored); the passphrase unwraps the data key from it. */
  vault: unknown;
}

export class RecoveryFileError extends Error {}

const aadOf = (index: number, last: boolean): string => `bhrc1|${index}|${last ? 1 : 0}`;

/** Compress `source` and write it encrypted to `target` (which must not exist yet). The source is only read. Returns bytes written. */
export async function writeRecoveryFile(source: string, target: string, key: Buffer, meta: { createdAt: number; appVersion: string; vault: unknown }): Promise<number> {
  const header: RecoveryHeader = { v: 1, createdAt: meta.createdAt, appVersion: meta.appVersion, vault: meta.vault };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(headerBytes.length);
  assertWritable(target); // T7 write ban
  const out = await fs.promises.open(target, 'wx');
  let written = 0;
  const put = async (buf: Buffer): Promise<void> => {
    await out.write(buf);
    written += buf.length;
  };
  try {
    await put(Buffer.concat([RECOVERY_MAGIC, lengthPrefix, headerBytes]));
    let index = 0;
    const frame = async (plain: Buffer, last: boolean): Promise<void> => {
      const sealed = seal(key, plain, aadOf(index, last));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(NONCE_BYTES + sealed.ciphertext.length);
      await put(Buffer.concat([len, sealed.nonce, sealed.ciphertext]));
      index += 1;
    };
    // One chunk is held back so the final frame can be marked as the last one.
    let pending: Buffer | null = null;
    let carry: Buffer = Buffer.alloc(0);
    const sink = new Writable({
      write(chunk: Buffer, _encoding, finishWrite) {
        void (async () => {
          carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
          while (carry.length >= RECOVERY_CHUNK_BYTES) {
            if (pending) await frame(pending, false);
            pending = Buffer.from(carry.subarray(0, RECOVERY_CHUNK_BYTES));
            carry = carry.subarray(RECOVERY_CHUNK_BYTES);
          }
        })().then(() => finishWrite(), finishWrite);
      },
      final(finishFinal) {
        void (async () => {
          if (pending) await frame(pending, false);
          await frame(Buffer.from(carry), true);
        })().then(() => finishFinal(), finishFinal);
      },
    });
    await pipeline(fs.createReadStream(source), createGzip({ level: 6 }), sink);
    await out.sync();
  } finally {
    await out.close();
  }
  return written;
}

/** The header of a recovery file (the file is only read). Throws RecoveryFileError when it is not one. */
export async function readRecoveryHeader(file: string): Promise<{ header: RecoveryHeader; offset: number }> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(RECOVERY_MAGIC.length + 4);
    const got = await handle.read(head, 0, head.length, 0);
    if (got.bytesRead < head.length || !head.subarray(0, RECOVERY_MAGIC.length).equals(RECOVERY_MAGIC)) throw new RecoveryFileError('This is not a Backup Hub recovery file.');
    const length = head.readUInt32BE(RECOVERY_MAGIC.length);
    if (length === 0 || length > MAX_HEADER_BYTES) throw new RecoveryFileError('This recovery file is damaged.');
    const body = Buffer.alloc(length);
    const read = await handle.read(body, 0, length, head.length);
    if (read.bytesRead < length) throw new RecoveryFileError('This recovery file is damaged.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RecoveryFileError('This recovery file is damaged.');
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || o['v'] !== 1 || typeof o['createdAt'] !== 'number') throw new RecoveryFileError('This recovery file is damaged or from a newer Backup Hub.');
    return { header: { v: 1, createdAt: o['createdAt'], appVersion: typeof o['appVersion'] === 'string' ? o['appVersion'] : '', vault: o['vault'] }, offset: head.length + length };
  } finally {
    await handle.close();
  }
}

/**
 * Decrypt a recovery file into `target` (must not exist). Returns false when the key is wrong or the file was altered or cut
 * (the partial `target` is removed). The source is only read.
 */
export async function openRecoveryFile(file: string, target: string, key: Buffer): Promise<boolean> {
  if (fs.existsSync(target)) throw new RecoveryFileError('The target file already exists.');
  const { offset } = await readRecoveryHeader(file);
  const size = (await fs.promises.stat(file)).size;
  const handle = await fs.promises.open(file, 'r');
  async function* plainChunks(): AsyncGenerator<Buffer> {
    let position = offset;
    let index = 0;
    while (position < size) {
      const len = Buffer.alloc(4);
      if ((await handle.read(len, 0, 4, position)).bytesRead < 4) throw new RecoveryFileError('cut');
      const frameLength = len.readUInt32BE(0);
      if (frameLength < NONCE_BYTES + TAG_BYTES || frameLength > RECOVERY_CHUNK_BYTES + NONCE_BYTES + TAG_BYTES + 1024) throw new RecoveryFileError('bad frame');
      const body = Buffer.alloc(frameLength);
      if ((await handle.read(body, 0, frameLength, position + 4)).bytesRead < frameLength) throw new RecoveryFileError('cut');
      position += 4 + frameLength;
      const plain = openSealed(key, { nonce: body.subarray(0, NONCE_BYTES), ciphertext: body.subarray(NONCE_BYTES) }, aadOf(index, position >= size));
      if (!plain) throw new RecoveryFileError('wrong key or altered');
      index += 1;
      yield plain;
    }
    if (index === 0) throw new RecoveryFileError('empty');
  }
  assertWritable(target); // T7 write ban
  let ok = true;
  try {
    await pipeline(Readable.from(plainChunks()), createGunzip(), fs.createWriteStream(target, { flags: 'wx' }));
  } catch {
    ok = false;
  } finally {
    await handle.close();
  }
  if (!ok) ownRemove(target);
  return ok;
}
