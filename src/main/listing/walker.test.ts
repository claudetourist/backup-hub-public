import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_ATTRIBUTE_MASK,
  ATTR_OFFLINE,
  ATTR_RECALL_ON_DATA_ACCESS,
  ATTR_RECALL_ON_OPEN,
  isCloudOnlyAttributes,
  LineSplitter,
  streamCloudOnly,
  type SpawnFn,
} from './cloudOnly';
import { APP_FOLDER, BACKUPS_PARTS, DB_COPIES_PARTS, LEGACY_CARD_FOLDER, OWN_FILES_FOLDER, OWN_FILES_PARTS } from '../../shared/appFolders';
import { folderPrefix, isInsideOrSame, isOneDriveMarkerName, isSkippedEntry, isSkippedName, prefixUpperBound, toSlashes } from './skipRules';
import { walkRoot, type WalkedFile } from './walker';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-walk-test-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content = 'x'): string {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

async function collect(options: Partial<Parameters<typeof walkRoot>[0]> = {}) {
  const batches: WalkedFile[][] = [];
  const result = await walkRoot({
    root: dir,
    onBatch: async (files) => {
      batches.push(files);
    },
    ...options,
  });
  const rel = batches.flat().map((f) => toSlashes(path.relative(dir, f.absPath))).toSorted();
  return { result, batches, rel };
}

describe('skip rules and path helpers', () => {
  it('skips the named folders and files whatever the case', () => {
    for (const n of ['$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information', LEGACY_CARD_FOLDER, 'desktop.ini', 'Desktop.INI', 'Thumbs.db']) {
      expect(isSkippedName(n)).toBe(true);
    }
    expect(isSkippedName('photo.jpg')).toBe(false);
  });

  it("skips the app's own files folder by its place (inside the app folder), not a look-alike elsewhere, and never the app's backups folder", () => {
    const own = OWN_FILES_PARTS.at(-1)!;
    expect(own).toBe(OWN_FILES_FOLDER);
    expect(isSkippedEntry(path.join('D:\\', 'MyData', APP_FOLDER), own)).toBe(true);
    expect(isSkippedEntry(path.join('D:\\', 'MyData', APP_FOLDER.toUpperCase()), own.toUpperCase())).toBe(true);
    expect(isSkippedEntry(path.join('D:\\', 'MyData', 'Other'), own)).toBe(false);
    expect(isSkippedEntry(path.join('D:\\', 'MyData', APP_FOLDER), BACKUPS_PARTS.at(-1)!)).toBe(false);
    expect(isSkippedEntry(path.join('D:\\', 'MyData'), APP_FOLDER)).toBe(false);
  });

  it('decides inside / same / outside without being fooled by prefixes', () => {
    const a = path.join(dir, 'a');
    expect(isInsideOrSame(path.join(a, 'b'), a)).toBe(true);
    expect(isInsideOrSame(a, a)).toBe(true);
    expect(isInsideOrSame(a + 'x', a)).toBe(false);
    expect(isInsideOrSame(dir, a)).toBe(false);
  });

  it('builds prefix ranges that cover a folder and nothing else', () => {
    expect(folderPrefix('D:/MyData')).toBe('D:/MyData/');
    expect(folderPrefix('D:/')).toBe('D:/');
    expect(folderPrefix('')).toBe('');
    const prefix = 'D:/MyData/';
    const upper = prefixUpperBound(prefix);
    expect(upper).toBe('D:/MyData0');
    expect('D:/MyData/a.jpg' >= prefix && 'D:/MyData/a.jpg' < upper).toBe(true);
    expect('D:/MyData2/a.jpg' >= prefix && 'D:/MyData2/a.jpg' < upper).toBe(false);
  });
});

describe('walkRoot', () => {
  it('lists plain files with size and mtime, skipping the skip list', async () => {
    write('a.txt', 'hello');
    write('sub/b.txt', 'hi');
    write('sub/deeper/c.txt', '');
    write('$RECYCLE.BIN/x.txt');
    write('System Volume Information/y.txt');
    write(`${LEGACY_CARD_FOLDER}/drive.json`);
    write('sub/desktop.ini');
    write('sub/Thumbs.db');
    const { result, batches, rel } = await collect();
    expect(rel).toEqual(['a.txt', 'sub/b.txt', 'sub/deeper/c.txt']);
    expect(result).toMatchObject({ filesSeen: 3, complete: true, rootMissing: false, deniedFolders: [], deniedFiles: [] });
    const a = batches.flat().find((f) => f.absPath.endsWith('a.txt'))!;
    expect(a.size).toBe(5);
    expect(Math.abs(a.mtimeMs - fs.statSync(a.absPath).mtimeMs)).toBeLessThan(1);
  });

  it("lists the app's backups folder (real backups) but not the app's own files folder, anywhere below the root", async () => {
    write(`${BACKUPS_PARTS.join('/')}/Reunion/a.jpg`);
    write(`${DB_COPIES_PARTS.join('/')}/backuphub-db-1.db`);
    write(`${OWN_FILES_PARTS.join('/')}/Quarantine/2026-11-03/x.jpg`);
    write(`MyData/${OWN_FILES_FOLDER}/mine.txt`); // a user's folder with the same name, outside the app folder, is theirs
    const { rel } = await collect();
    expect(rel).toEqual([`${BACKUPS_PARTS.join('/')}/Reunion/a.jpg`, `MyData/${OWN_FILES_FOLDER}/mine.txt`].toSorted());
  });

  it('does not enter excluded folders (OneDrive, the app data folder)', async () => {
    write('keep/a.txt');
    write('OneDrive/doc.txt');
    write('OneDrive/deep/doc2.txt');
    write('data/db.sqlite');
    const { rel } = await collect({ excludeDirs: [path.join(dir, 'OneDrive'), path.join(dir, 'data')] });
    expect(rel).toEqual(['keep/a.txt']);
  });

  it('sends files in chunks and reports each chunk before the walk ends', async () => {
    for (let i = 0; i < 25; i += 1) write(`f${String(i).padStart(2, '0')}.txt`);
    const { batches, result } = await collect({ chunkSize: 10 });
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(result.filesSeen).toBe(25);
  });

  it('stops when the batch callback throws (cancel) and passes that error on', async () => {
    for (let i = 0; i < 5; i += 1) write(`f${i}.txt`);
    let calls = 0;
    await expect(
      walkRoot({
        root: dir,
        chunkSize: 2,
        onBatch: async () => {
          calls += 1;
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });

  it('never follows directory links (junction or symlink) and does not list them', async () => {
    write('real/a.txt');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-walk-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      let linked = true;
      try {
        // 'junction' works without elevation on Windows and is a plain symlink elsewhere.
        fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
      } catch {
        linked = false;
      }
      const { rel, result } = await collect();
      expect(rel).toEqual(['real/a.txt']);
      if (linked) expect(result.skippedLinks).toBe(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('turns an access-denied folder into a note, keeps going and stays complete', async () => {
    write('ok/a.txt');
    write('locked/b.txt');
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (String(p).endsWith('locked')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return real(p, o);
    });
    const denied: string[] = [];
    const { rel, result } = await collect({ onDenied: (p, kind) => denied.push(`${kind}:${path.basename(p)}`) });
    expect(rel).toEqual(['ok/a.txt']);
    expect(denied).toEqual(['folder:locked']);
    expect(result.deniedFolders.map((p) => path.basename(p))).toEqual(['locked']);
    expect(result.complete).toBe(true);
  });

  it('treats an unreadable file (lstat denied) as a note too', async () => {
    write('a.txt');
    write('b.txt');
    const real = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p, o) => {
      if (String(p).endsWith('b.txt')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real(p, o as never);
    });
    const { rel, result } = await collect();
    expect(rel).toEqual(['a.txt']);
    expect(result.deniedFiles.map((p) => path.basename(p))).toEqual(['b.txt']);
    expect(result.complete).toBe(true);
  });

  it('marks the walk incomplete when something other than access went wrong, and when the root is missing', async () => {
    write('ok/a.txt');
    write('bad/b.txt');
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (String(p).endsWith('bad')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return real(p, o);
    });
    const { result } = await collect();
    expect(result.complete).toBe(false);
    expect(result.firstError).toMatch(/EIO/);
    vi.restoreAllMocks();

    const missing = await walkRoot({ root: path.join(dir, 'nope'), onBatch: async () => undefined });
    expect(missing).toMatchObject({ complete: false, rootMissing: true, filesSeen: 0 });
  });
});

describe('cloud-only helper', () => {
  it('knows the three Windows attribute bits', () => {
    expect(CLOUD_ATTRIBUTE_MASK).toBe(0x1000 | 0x40000 | 0x400000);
    for (const bit of [ATTR_OFFLINE, ATTR_RECALL_ON_OPEN, ATTR_RECALL_ON_DATA_ACCESS]) expect(isCloudOnlyAttributes(bit | 0x20)).toBe(true);
    expect(isCloudOnlyAttributes(0x20)).toBe(false);
    expect(isCloudOnlyAttributes(0x20 | 0x2)).toBe(false);
  });

  it('splits streamed text into lines across chunks, CRLF and a BOM', () => {
    const s = new LineSplitter();
    expect(s.push('\uFEFFC:\\a\\one.txt\r\nC:\\a\\tw')).toEqual(['C:\\a\\one.txt']);
    expect(s.push('o.txt\n\nC:\\a\\three')).toEqual(['C:\\a\\two.txt']);
    expect(s.end()).toEqual(['C:\\a\\three']);
    expect(s.end()).toEqual([]);
  });

  function fakeSpawn(run: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }) => void): SpawnFn {
    return () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => run(child));
      return child as never;
    };
  }

  it('delivers each path the helper prints', async () => {
    const got: string[] = [];
    await streamCloudOnly(
      'C:\\Root',
      (p) => got.push(p),
      {
        spawnFn: fakeSpawn((child) => {
          child.stdout.write('C:\\Root\\a.docx\r\nC:\\Root\\sub\\b');
          child.stdout.write('.jpg\r\n');
          child.stdout.end('C:\\Root\\last.txt');
          child.stdout.on('end', () => child.emit('close', 0));
        }),
      },
    );
    expect(got).toEqual(['C:\\Root\\a.docx', 'C:\\Root\\sub\\b.jpg', 'C:\\Root\\last.txt']);
  });

  it('passes the root in the environment, not on the command line', async () => {
    const seen: { args: string[]; root: string | undefined }[] = [];
    await streamCloudOnly('C:\\My Root', () => undefined, {
      spawnFn: (_cmd, args, o) => {
        seen.push({ args, root: o.env['BACKUPHUB_ROOT'] });
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
        queueMicrotask(() => child.emit('close', 0));
        return child as never;
      },
    });
    expect(seen[0]?.root).toBe('C:\\My Root');
    expect(seen[0]?.args.join(' ')).not.toContain('My Root');
  });

  it('rejects with a plain message when the helper fails or cannot start', async () => {
    await expect(
      streamCloudOnly('C:\\R', () => undefined, { spawnFn: fakeSpawn((child) => child.emit('close', 1)) }),
    ).rejects.toThrow(/ended with an error/);
    await expect(
      streamCloudOnly('C:\\R', () => undefined, { spawnFn: fakeSpawn((child) => child.emit('error', new Error('ENOENT'))) }),
    ).rejects.toThrow(/could not run/);
    await expect(
      streamCloudOnly('C:\\R', () => undefined, {
        spawnFn: () => {
          throw new Error('nope');
        },
      }),
    ).rejects.toThrow(/could not start/);
  });

  it('stops the helper when the job is cancelled', async () => {
    const controller = new AbortController();
    let kill = vi.fn();
    const promise = streamCloudOnly('C:\\R', () => undefined, {
      signal: controller.signal,
      spawnFn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
        kill = child.kill;
        return child as never;
      },
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/stopped/);
    expect(kill).toHaveBeenCalled();
  });

  // The one test that really asks Windows: set Offline with `attrib +O` on a temp file, run the real helper.
  it.runIf(process.platform === 'win32')('finds a temp file marked Offline with attrib +O (and not its neighbours)', async () => {
    const offline = write('sub/offline.txt', 'x');
    write('sub/normal.txt', 'x');
    write('top.txt', 'x');
    const attrib = spawnSync('attrib', ['+O', offline], { windowsHide: true });
    expect(attrib.status).toBe(0);
    const got: string[] = [];
    await streamCloudOnly(dir, (p) => got.push(p), { timeoutMs: 60_000 });
    expect(got.map((p) => p.toLowerCase())).toEqual([offline.toLowerCase()]);
    // The walker lists it like any file: lstat does not open it.
    const { rel } = await collect();
    expect(rel).toContain('sub/offline.txt');
  }, 90_000);

  // The real helper with the apostrophe in the own files folder name: its offline files are not reported, the backups folder's are.
  it.runIf(process.platform === 'win32')("does not look inside the app's own files folder, but does look in the app's backups folder (real helper)", async () => {
    const own = write(`${OWN_FILES_PARTS.join('/')}/Quarantine/x.txt`, 'x');
    const backup = write(`${BACKUPS_PARTS.join('/')}/Reunion/y.txt`, 'x');
    const lookAlike = write(`Elsewhere/${OWN_FILES_FOLDER}/z.txt`, 'x');
    for (const f of [own, backup, lookAlike]) expect(spawnSync('attrib', ['+O', f], { windowsHide: true }).status).toBe(0);
    const got: string[] = [];
    await streamCloudOnly(dir, (p) => got.push(p), { timeoutMs: 60_000 });
    expect(got.map((p) => p.toLowerCase()).toSorted()).toEqual([backup.toLowerCase(), lookAlike.toLowerCase()].toSorted());
  }, 90_000);

  // OneDrive folders are reparse points without cloud bits (pinned); only junctions and symlinks are skipped.
  it.runIf(process.platform === 'win32')('never follows a junction, so a file behind one is reported once, by its real path', async () => {
    const offline = write('real/offline.txt', 'x');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    expect(spawnSync('attrib', ['+O', offline], { windowsHide: true }).status).toBe(0);
    const got: string[] = [];
    await streamCloudOnly(dir, (p) => got.push(p), { timeoutMs: 60_000 });
    expect(got.map((p) => p.toLowerCase())).toEqual([offline.toLowerCase()]);
  }, 90_000);
});

describe('OneDrive marker file', () => {
  const GUID = '.849C9593-D756-4E56-8D6E-42412F2A707B';
  it('is skipped at the OneDrive root only, and only when the walk is told it is a OneDrive root', async () => {
    write(GUID, 'locked');
    write('keep.txt');
    write('sub/' + GUID, 'inner');
    write('.not-a-guid');
    expect((await collect({ oneDriveRoot: dir })).rel).toEqual(['.not-a-guid', 'keep.txt', 'sub/' + GUID]);
    expect((await collect()).rel).toEqual([GUID, '.not-a-guid', 'keep.txt', 'sub/' + GUID]);
  });
  it('names are recognised by the dot-plus-GUID shape', () => {
    expect(isOneDriveMarkerName(GUID)).toBe(true);
    expect(isOneDriveMarkerName(GUID.toLowerCase())).toBe(true);
    expect(isOneDriveMarkerName('849C9593-D756-4E56-8D6E-42412F2A707B')).toBe(false);
    expect(isOneDriveMarkerName('.849C9593-D756')).toBe(false);
  });
});
