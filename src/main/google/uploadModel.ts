/**
 * Pure rules for Google's resumable uploads: chunk sizes, Content-Range and Range headers, and whether an upload address is the exact shape that is allowed. No network and no files here.
 */
import { parseSessionUri } from './googleHttp';

/** Google wants every chunk but the last to be a multiple of this. */
export const CHUNK_UNIT = 256 * 1024;
/** Default chunk: 16 MiB (a multiple of 256 KiB). */
export const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
/** Every try of one file (after a lost connection) waits like this: 1 s, 2 s, 4 s ... up to 5 failures in a row, then the person is asked. */
export const MAX_FAILURES_IN_A_ROW = 5;

/** A chunk size that Google accepts: a positive multiple of 256 KiB. */
export function isValidChunkSize(bytes: number): boolean {
  return Number.isInteger(bytes) && bytes > 0 && bytes % CHUNK_UNIT === 0;
}

/**
 * The length of the next chunk starting at `offset`: `chunk` bytes, or what is left for the last one.
 * Returns 0 when the whole file has been sent.
 */
export function nextChunkLength(total: number, offset: number, chunk: number = DEFAULT_CHUNK_BYTES): number {
  if (!isValidChunkSize(chunk)) throw new Error('The chunk size must be a multiple of 256 KiB.');
  return Math.max(0, Math.min(chunk, total - offset));
}

/** Content-Range for a chunk of `length` bytes at `offset` of a file of `total` bytes. */
export function chunkRange(offset: number, length: number, total: number): string {
  if (length <= 0) throw new Error('A chunk has at least one byte.');
  return `bytes ${offset}-${offset + length - 1}/${total}`;
}

/** Content-Range that asks "how much do you have?". */
export function statusRange(total: number): string {
  return `bytes */${total}`;
}

/**
 * How many bytes Google holds, from the Range header of a 308 ("bytes=0-262143" means 262,144 bytes). No Range header
 * means none. Returns null for a header that cannot be understood (the upload is then asked again, not guessed).
 */
export function confirmedBytes(range: string | null): number | null {
  if (range === null || range.trim() === '') return 0;
  const m = /^bytes=0-(\d+)$/.exec(range.trim());
  return m ? Number(m[1]) + 1 : null;
}

/**
 * The address from the Location header of a started upload, or null if it is not exactly https on
 * the Google API host, path /upload/drive/v3/files, with an upload_id (no other host, no user name, no port, nothing else).
 */
export function validateSessionUri(location: string | null): string | null {
  return parseSessionUri(location);
}

/** Query text for a folder in a Drive list: backslash and quote escaped. */
export function quoteDriveString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
