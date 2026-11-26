import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleAuth } from './auth';
import { DownloadShortError, DriveDownloader } from './driveDownload';
import { GoogleApiError, GoogleHttp, NetworkError } from './googleHttp';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-dl-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const auth = (): GoogleAuth => ({ accessToken: vi.fn(() => Promise.resolve('tok')) }) as unknown as GoogleAuth;
const body = (chunks: Buffer[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const b of chunks) c.enqueue(new Uint8Array(b));
        c.close();
      },
    }),
    { status: 200 },
  );

describe('DriveDownloader', () => {
  it('writes the bytes to the temp name and counts them', async () => {
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(body([Buffer.from('hello '), Buffer.from('world')])) });
    const seen: number[] = [];
    const tmp = path.join(dir, 'a.bhtmp');
    const n = await new DriveDownloader(http, auth()).download('g1', 'fileid123456', tmp, { size: 11, onProgress: (d) => seen.push(d) });
    expect(n).toBe(11);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('hello world');
    expect(seen).toEqual([6, 11]);
  });

  it('refuses a file of the wrong size (the caller removes the temp file)', async () => {
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(body([Buffer.from('abc')])) });
    await expect(new DriveDownloader(http, auth()).download('g1', 'fileid123456', path.join(dir, 'b.bhtmp'), { size: 10 })).rejects.toBeInstanceOf(DownloadShortError);
  });

  it('never overwrites a temp name that exists', async () => {
    const tmp = path.join(dir, 'c.bhtmp');
    fs.writeFileSync(tmp, 'mine');
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(body([Buffer.from('abc')])) });
    await expect(new DriveDownloader(http, auth()).download('g1', 'fileid123456', tmp, { size: 3 })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(tmp, 'utf8')).toBe('mine');
  });

  it('asks for a new token once after a 401', async () => {
    const answers = [new Response('{}', { status: 401 }), body([Buffer.from('ok')])];
    const a = auth();
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(answers.shift()!) });
    await new DriveDownloader(http, a).download('g1', 'fileid123456', path.join(dir, 'd.bhtmp'), { size: 2 });
    expect(a.accessToken).toHaveBeenCalledTimes(2);
  });

  it('passes a 404 and a network failure on as they are', async () => {
    const gone = new GoogleHttp({ fetchFn: () => Promise.resolve(new Response('{}', { status: 404 })) });
    await expect(new DriveDownloader(gone, auth()).download('g1', 'fileid123456', path.join(dir, 'e.bhtmp'), { size: 1 })).rejects.toBeInstanceOf(GoogleApiError);
    const down = new GoogleHttp({ fetchFn: () => Promise.reject(new Error('offline')) });
    await expect(new DriveDownloader(down, auth()).download('g1', 'fileid123456', path.join(dir, 'f.bhtmp'), { size: 1 })).rejects.toBeInstanceOf(NetworkError);
  });

  it('gives up a download that stops sending', async () => {
    const stalled = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
      { status: 200 },
    );
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(stalled) });
    await expect(new DriveDownloader(http, auth()).download('g1', 'fileid123456', path.join(dir, 'g.bhtmp'), { size: 5, idleMs: 50 })).rejects.toBeInstanceOf(NetworkError);
  });
});
