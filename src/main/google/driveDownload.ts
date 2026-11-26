/**
 * The one READ of a file's bytes from Google Drive: "Get files back" uses it when no drive copy can be used. It only reads; nothing in Google is changed.
 * The bytes go into a temp file the caller made the name of; the caller checks them (size, flush, SHA-256 read back from the disk) before the file gets its name.
 * Everything goes through GoogleHttp (the allowlist): `openDownload` is the only way to ask for a file's bytes.
 */
import { assertWritable } from '../fsutil';
import { rawFs as fs } from '../rawFs';
import type { GoogleAuth } from './auth';
import { GoogleApiError, NetworkError, type GoogleHttp } from './googleHttp';

/** No bytes for this long: the download is given up (the next copy is tried). */
export const DOWNLOAD_IDLE_MS = 60_000;

export class DownloadShortError extends Error {
  constructor(
    readonly got: number,
    readonly expected: number,
  ) {
    super(`Google gave ${got} bytes, not ${expected}.`);
    this.name = 'DownloadShortError';
  }
}

export interface DownloadOptions {
  /** The size the file must have (from the index); a different number of bytes is refused. */
  size: number;
  signal?: AbortSignal | undefined;
  /** Gives the event loop a turn and throws when the job was cancelled. */
  yieldNow?: () => Promise<void>;
  /** Bytes of this file written so far. */
  onProgress?: (bytesDone: number) => void;
  idleMs?: number;
}

export class DriveDownloader {
  constructor(
    private readonly http: GoogleHttp,
    private readonly auth: GoogleAuth,
  ) {}

  /** Writes the file to `tmpFile` (a name that must not exist yet) and returns the bytes written. The caller removes `tmpFile` when this throws. */
  async download(placeId: string, fileId: string, tmpFile: string, o: DownloadOptions): Promise<number> {
    const idle = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, idle.signal]) : idle.signal;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarm = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = (): void => {
      disarm();
      timer = setTimeout(() => idle.abort(), o.idleMs ?? DOWNLOAD_IDLE_MS);
    };
    try {
      let response: Response | null = null;
      for (let attempt = 1; response === null; attempt += 1) {
        const bearer = await this.auth.accessToken(placeId, signal, attempt > 1);
        try {
          response = await this.http.openDownload({ fileId, bearer, signal });
        } catch (err) {
          if (attempt === 1 && err instanceof GoogleApiError && err.status === 401) continue; // one new token, one more try
          throw err;
        }
      }
      if (response.body === null) throw new GoogleApiError(response.status, null, 'Google sent no file.');
      const reader = response.body.getReader();
      // A read that never answers ends when the job is stopped or the download stalls.
      const stopped = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new Error('The download was stopped or stalled.'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
      stopped.catch(() => undefined);
      assertWritable(tmpFile); // the same guard every writer asks: never into a protected drive
      const out = await fs.promises.open(tmpFile, 'wx');
      let done = 0;
      try {
        arm();
        for (;;) {
          const { value, done: finished } = await Promise.race([reader.read(), stopped]).catch((err: unknown) => {
            throw new NetworkError(err instanceof Error ? err.message : 'The download broke off.');
          });
          if (finished) break;
          disarm(); // a pause may wait for a long time: that is not a stalled download
          await o.yieldNow?.();
          await out.write(value, 0, value.byteLength);
          done += value.byteLength;
          o.onProgress?.(done);
          arm();
        }
        if (done !== o.size) throw new DownloadShortError(done, o.size);
        await out.sync();
      } finally {
        await reader.cancel().catch(() => undefined);
        await out.close();
      }
      return done;
    } finally {
      disarm();
    }
  }
}
