import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_FILE, CARD_PARTS, DB_COPIES_PARTS, LEGACY_CARD_FOLDER, OWN_FILES_PARTS } from '../../shared/appFolders';
import { cardFolder, driveTmpFolder } from '../places/appFolders';
import { DIRECT_BLOCK, directFlag, hashUnbuffered, openUnbuffered, SECTOR } from './directRead';
import { settleLeftover, sweepStaleTemps, tempPathFor, touchesBackupHubFolder, verifiedCopy, type CopyIo, type VerifiedCopyOptions } from './verifiedCopy';

let dir: string;
let drive: string;
let tmpDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-vcopy-test-'));
  drive = path.join(dir, 'drive');
  tmpDir = driveTmpFolder(drive);
  fs.mkdirSync(path.join(drive, 'BackupHub'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer | string): string => createHash('md5').update(b).digest('hex');
const bytes = (n: number): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) % 251;
  return b;
};
const source = (data: Buffer | string, name = 'src.bin'): string => {
  const p = path.join(dir, 'source', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
};
const finalOf = (name = 'a.bin'): string => path.join(drive, 'BackupHub', name);
const tmpFiles = (): string[] => (fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []);

function opts(src: string, final: string, size: number, extra: Partial<VerifiedCopyOptions> = {}): VerifiedCopyOptions {
  return { source: src, final, size, tmpDir, yieldNow: () => Promise.resolve(), ...extra };
}

describe('the cache-free read-back (UV_FS_O_DIRECT)', () => {
  it('has a flag, and an opened handle is proven to be unbuffered', async () => {
    expect(directFlag()).not.toBeNull();
    const f = source(bytes(10000));
    const handle = await openUnbuffered(f);
    try {
      // An unbuffered handle refuses a read that is not sector aligned: a cached handle would answer.
      await expect(handle.read(Buffer.allocUnsafeSlow(SECTOR * 2), 1, 1, 0)).rejects.toMatchObject({ code: 'EINVAL' });
    } finally {
      await handle.close();
    }
  });

  it('hashes the same bytes as an ordinary read for empty, tiny, sector, block and odd sizes', async () => {
    for (const n of [0, 1, 511, 512, 4095, 4096, 4097, DIRECT_BLOCK - 1, DIRECT_BLOCK, DIRECT_BLOCK + 1, 3 * DIRECT_BLOCK + 123]) {
      const data = bytes(n);
      const got = await hashUnbuffered(source(data, `f${n}.bin`), { md5: true });
      expect(got, `size ${n}`).toEqual({ sha256: sha(data), md5: md5(data), bytes: n });
    }
  });

  it('MD5 only when asked', async () => {
    expect((await hashUnbuffered(source('abc'))).md5).toBeNull();
  });
});

describe('verified copy', () => {
  it('writes through the temp folder, reads back without the cache, links into place and clears the temp name', async () => {
    const data = bytes(2 * DIRECT_BLOCK + 321);
    const src = source(data);
    fs.utimesSync(src, new Date(), 1_700_000_000);
    const seen: string[] = [];
    const io: CopyIo = { readBack: async (file, o) => (seen.push(file), hashUnbuffered(file, o)) };
    const result = await verifiedCopy(opts(src, finalOf(), data.length, { io, md5: true, chunkBytes: 64 * 1024 }));
    expect(result).toEqual({ ok: true, hashes: { sha256: sha(data), md5: md5(data) } });
    expect(fs.readFileSync(finalOf()).equals(data)).toBe(true);
    expect(Math.round(fs.statSync(finalOf()).mtimeMs / 1000)).toBe(1_700_000_000);
    expect(tmpFiles()).toEqual([]);
    expect(seen).toEqual([tempPathFor(finalOf(), tmpDir)]); // the read-back looked at the temp file, before the link
    expect(fs.readFileSync(src).equals(data)).toBe(true);
  });

  it('md5 only when asked', async () => {
    const src = source('hello');
    const result = await verifiedCopy(opts(src, finalOf(), 5));
    expect(result).toEqual({ ok: true, hashes: { sha256: sha('hello'), md5: null } });
  });

  it('a file already at the destination is never replaced, and the temp file is removed', async () => {
    fs.writeFileSync(finalOf(), 'precious');
    const result = await verifiedCopy(opts(source('new content'), finalOf(), 11));
    expect(result).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('precious');
    expect(tmpFiles()).toEqual([]);
  });

  it('a file that appears between the check and the link is never replaced either (EEXIST)', async () => {
    const io: CopyIo = {
      link: (from, to) => {
        fs.writeFileSync(to, 'intruder'); // arrives at the last moment
        fs.linkSync(from, to);
      },
    };
    const result = await verifiedCopy(opts(source('new content'), finalOf(), 11, { io }));
    expect(result).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('intruder');
    expect(tmpFiles()).toEqual([]);
  });

  it('unplug before the flush: the flush fails (EIO), nothing reaches the final name, the temp file is removed', async () => {
    const io: CopyIo = { syncHandle: () => Promise.reject(Object.assign(new Error('I/O error'), { code: 'EIO' })) };
    await expect(verifiedCopy(opts(source('abc'), finalOf(), 3, { io }))).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.existsSync(finalOf())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('a read-back that disagrees keeps nothing', async () => {
    const io: CopyIo = { readBack: () => Promise.resolve({ sha256: 'f'.repeat(64), md5: null }) };
    expect(await verifiedCopy(opts(source('abc'), finalOf(), 3, { io }))).toEqual({ ok: false, reason: 'mismatch' });
    expect(fs.existsSync(finalOf())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('a read-back that cannot read without the cache fails loudly: no fallback, nothing kept', async () => {
    const io: CopyIo = { readBack: () => Promise.reject(new Error('Reading a copy back from the drive without the cache did not work')) };
    await expect(verifiedCopy(opts(source('abc'), finalOf(), 3, { io }))).rejects.toThrow(/without the cache/);
    expect(fs.existsSync(finalOf())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('the caller can reject what was read from the source', async () => {
    expect(await verifiedCopy(opts(source('abc'), finalOf(), 3, { acceptSource: () => false }))).toMatchObject({ ok: false, reason: 'source_changed' });
    expect(fs.existsSync(finalOf())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('a file that changed size while it was read is refused', async () => {
    await expect(verifiedCopy(opts(source('abc'), finalOf(), 99))).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.existsSync(finalOf())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it("never copies the app's own files folder or the card folder (a whole-drive copy leaves them out)", async () => {
    const inCard = source('x', `../drive/${CARD_PARTS.join('/')}/${CARD_FILE}`);
    expect(touchesBackupHubFolder(inCard)).toBe(true);
    expect(touchesBackupHubFolder(source('x', `../drive/${OWN_FILES_PARTS.join('/')}/anything.bin`))).toBe(true);
    expect(touchesBackupHubFolder(source('x', `../drive/${LEGACY_CARD_FOLDER}/${CARD_FILE}`))).toBe(true); // an old-layout drive
    expect(touchesBackupHubFolder(source('x', '../drive/MyData/photo.jpg'))).toBe(false);
    expect(await verifiedCopy(opts(inCard, path.join(dir, 'other', 'drive.json'), 1))).toEqual({ ok: false, reason: 'protected_name' });
    expect(await verifiedCopy(opts(source('x'), path.join(cardFolder(drive), 'x.bin'), 1))).toEqual({ ok: false, reason: 'protected_name' });
    expect(fs.existsSync(path.join(dir, 'other'))).toBe(false);
    expect(fs.existsSync(path.join(cardFolder(drive), 'x.bin'))).toBe(false);
  });

  it("copies into the app's other own folders (the database safety copies hold the app data copies) but never into the card folder", async () => {
    const final = path.join(drive, ...DB_COPIES_PARTS, 'Laptop-AppData', 'PC', 'x.bin');
    fs.mkdirSync(path.dirname(final), { recursive: true });
    const data = bytes(1000);
    expect(await verifiedCopy(opts(source(data), final, data.length))).toMatchObject({ ok: true });
    expect(fs.readFileSync(final)).toEqual(data);
  });

  it('an old half-written temp file of ours is cleared and the copy goes on', async () => {
    const tmp = tempPathFor(finalOf(), tmpDir);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, 'half');
    expect((await verifiedCopy(opts(source('whole file'), finalOf(), 10))).ok).toBe(true);
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('whole file');
    expect(tmpFiles()).toEqual([]);
  });
});

describe('crash between the link and the flush', () => {
  const crashAfterLink: CopyIo = { syncFinal: () => Promise.reject(Object.assign(new Error('I/O error'), { code: 'EIO' })) };

  it('leaves the complete file under both names; the next copy finds both, checks the checksum, flushes and clears the temp name', async () => {
    const data = bytes(DIRECT_BLOCK + 5);
    const src = source(data);
    await expect(verifiedCopy(opts(src, finalOf(), data.length, { io: crashAfterLink }))).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(finalOf()).equals(data)).toBe(true);
    expect(tmpFiles()).toHaveLength(1); // both names exist: the temp one is the same file
    expect(fs.statSync(finalOf()).nlink).toBe(2);

    let flushed = 0;
    const io: CopyIo = { syncFinal: () => ((flushed += 1), Promise.resolve()) };
    const again = await verifiedCopy(opts(src, finalOf(), data.length, { io, md5: true }));
    expect(again).toEqual({ ok: true, hashes: { sha256: sha(data), md5: md5(data) }, recovered: true });
    expect(flushed).toBe(1);
    expect(tmpFiles()).toEqual([]);
    expect(fs.readFileSync(finalOf()).equals(data)).toBe(true);
    expect(fs.statSync(finalOf()).nlink).toBe(1);
  });

  it('when a look finds the final file already there it settles the temp name (checksum checked by the caller)', async () => {
    const src = source('some data');
    await expect(verifiedCopy(opts(src, finalOf(), 9, { io: crashAfterLink }))).rejects.toBeDefined();
    expect(tmpFiles()).toHaveLength(1);
    expect(await settleLeftover(finalOf(), { tmpDir, isExpected: () => Promise.resolve(true) })).toBe('settled');
    expect(tmpFiles()).toEqual([]);
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('some data');
    expect(await settleLeftover(finalOf(), { tmpDir, isExpected: () => Promise.resolve(true) })).toBe('none');
  });

  it('a final file that does not match is left alone with both names kept for the person to look at', async () => {
    const src = source('some data');
    await expect(verifiedCopy(opts(src, finalOf(), 9, { io: crashAfterLink }))).rejects.toBeDefined();
    fs.writeFileSync(src, 'other data'); // the source changed since
    expect(await verifiedCopy(opts(src, finalOf(), 10))).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('some data');
    expect(tmpFiles()).toHaveLength(1);
  });

  it('sweeps temp files that never reached a final name, never one that is linked to a final file', async () => {
    const orphan = path.join(tmpDir, 'abc.bhtmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(orphan, 'orphan');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not ours to judge');
    await expect(verifiedCopy(opts(source('some data'), finalOf(), 9, { io: crashAfterLink }))).rejects.toBeDefined();
    expect(await sweepStaleTemps(tmpDir)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'notes.txt'))).toBe(true);
    expect(tmpFiles()).toHaveLength(2); // the linked one and the note
    expect(fs.readFileSync(finalOf(), 'utf8')).toBe('some data');
  });
});
