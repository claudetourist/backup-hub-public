import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../jobs/jobService';
import { closeDatabase, initDatabase, type Db } from '../db';
import { FolderIndex } from './folderIndex';
import { listPlaceHandler, type ListJobEnv } from './listJob';
import { quickWalk } from './quickWalker';
import { BACKUPS_PARTS, DB_COPIES_PARTS, LEGACY_CARD_FOLDER, OWN_FILES_PARTS } from '../../shared/appFolders';
import { toSlashes } from './skipRules';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const LAPTOP = '00000000-0000-4000-8000-00000000000a';
const DRIVE = '00000000-0000-4000-8000-00000000000b';

let dir: string;
let tree: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-quick-db-'));
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-quick-tree-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label] of [
    [LAPTOP, 'laptop', 'STUDY-PC'],
    [DRIVE, 'drive', 'T7'],
  ] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
});

/** Writes a file and keeps the folder's modified time moving forward, so a change is always visible on any file system. */
let clock = Date.UTC(2026, 0, 1);
function bump(abs: string): void {
  clock += 10_000;
  const t = new Date(clock);
  fs.utimesSync(abs, t, t);
}
function write(rel: string, content = 'x'): string {
  const abs = path.join(tree, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  bump(path.dirname(abs));
  return abs;
}
function remove(rel: string): void {
  const abs = path.join(tree, ...rel.split('/'));
  fs.rmSync(abs, { recursive: true, force: true });
  bump(path.dirname(abs));
}

const rel = (p: string): string => toSlashes(path.join(tree, p));
const allRows = (placeId: string) => db.prepare('SELECT rel_path, size, gone_at, hashed_at FROM files WHERE place_id = ? ORDER BY rel_path').all(placeId) as { rel_path: string; size: number; gone_at: number | null; hashed_at: number | null }[];
const live = (placeId: string): string[] => allRows(placeId).filter((r) => r.gone_at === null).map((r) => r.rel_path);
const gone = (placeId: string): string[] => allRows(placeId).filter((r) => r.gone_at !== null).map((r) => r.rel_path);

interface Run {
  message: string;
  changedCalls: number;
  warns: string[];
}

async function runJob(placeId: string, quick: boolean, roots: string[], base = ''): Promise<Run> {
  const run: Run = { message: '', changedCalls: 0, warns: [] };
  const env: ListJobEnv = {
    locate: async () => ({ ok: true, base }),
    excludeDirs: () => [],
    roots: async () => roots,
    dataChanged: () => {
      run.changedCalls += 1;
    },
  };
  const ctx: JobContext = {
    jobId: 1,
    params: { placeId, quick },
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: (text) => run.warns.push(text),
    needsYou: () => Promise.reject(new Error('not used')),
    checkpoint: () => {},
    yield: async () => {},
  };
  const result = await listPlaceHandler({ db, env, log: silent }).run(ctx);
  run.message = typeof result === 'string' ? result : '';
  return run;
}

const laptopWalk = (root: string) =>
  quickWalk({ db, placeId: LAPTOP, root, relOf: (abs) => toSlashes(abs) });

describe('a full listing remembers its folders', () => {
  it('saves every folder it read with the modified time, in step with the files', async () => {
    write('Docs/a.txt');
    write('Docs/sub/deeper/b.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    const folders = new FolderIndex(db);
    expect(folders.count(LAPTOP)).toBe(3);
    expect(folders.get(LAPTOP, rel('Docs/sub'))?.mtime).toBe(Math.trunc(fs.lstatSync(path.join(tree, 'Docs', 'sub')).mtimeMs));
    expect(folders.children(LAPTOP, rel('Docs')).map((f) => f.relPath)).toEqual([rel('Docs/sub')]);
  });

  it('forgets a folder that is no longer there after the next complete listing', async () => {
    write('Docs/a.txt');
    write('Docs/old/b.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    remove('Docs/old');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    expect(new FolderIndex(db).get(LAPTOP, rel('Docs/old'))).toBeUndefined();
    expect(gone(LAPTOP)).toEqual([rel('Docs/old/b.txt')]);
  });
});

describe('check it again (quick pass)', () => {
  it('reads nothing and reports no change when nothing moved', async () => {
    write('Docs/a.txt');
    write('Docs/sub/b.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    const run = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(run.message).toMatch(/0 new files, 0 changed files, 0 files no longer there \(0 folders read, 2 folders unchanged\)/);
    expect(run.changedCalls).toBe(0);
  });

  it('marks a deleted file as gone, never deletes its row, and reads only the folder that changed', async () => {
    write('Docs/a.txt');
    write('Docs/sub/b.txt');
    write('Docs/other/c.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    const before = allRows(LAPTOP).length;
    remove('Docs/sub/b.txt');
    const run = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(run.message).toMatch(/1 file no longer there \(1 folder read, 2 folders unchanged\)/);
    expect(gone(LAPTOP)).toEqual([rel('Docs/sub/b.txt')]);
    expect(allRows(LAPTOP)).toHaveLength(before);
    expect(run.changedCalls).toBeGreaterThan(0);
  });

  it('finds new files and files whose size changed, and a changed file loses its fingerprint', async () => {
    const a = write('Docs/a.txt', 'one');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    db.prepare("UPDATE files SET sha256 = 'abc', md5 = 'def', hashed_at = 5 WHERE rel_path = ?").run(rel('Docs/a.txt'));
    fs.writeFileSync(a, 'one and more');
    write('Docs/new.txt', 'n');
    const run = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(run.message).toMatch(/1 new file, 1 changed file, 0 files no longer there/);
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt'), rel('Docs/new.txt')]);
    const row = db.prepare('SELECT sha256, size FROM files WHERE rel_path = ?').get(rel('Docs/a.txt')) as { sha256: string | null; size: number };
    expect(row).toEqual({ sha256: null, size: 12 });
  });

  it('marks everything below a removed folder as gone and forgets the folder', async () => {
    write('Docs/a.txt');
    write('Docs/old/x.txt');
    write('Docs/old/deep/y.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    remove('Docs/old');
    const run = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(gone(LAPTOP)).toEqual([rel('Docs/old/deep/y.txt'), rel('Docs/old/x.txt')]);
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt')]);
    expect(new FolderIndex(db).get(LAPTOP, rel('Docs/old'))).toBeUndefined();
    expect(run.message).toMatch(/2 files no longer there/);
  });

  it('brings back a file that was gone and is there again', async () => {
    const abs = write('Docs/a.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    fs.rmSync(abs);
    bump(path.dirname(abs));
    await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(live(LAPTOP)).toEqual([]);
    write('Docs/a.txt');
    await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt')]);
  });

  it('with nothing remembered yet it reads every folder (and remembers them for next time)', async () => {
    write('Docs/a.txt');
    write('Docs/sub/b.txt');
    const first = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(first.message).toMatch(/2 new files.*\(2 folders read, 0 folders unchanged\)/);
    const second = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(second.message).toMatch(/\(0 folders read, 2 folders unchanged\)/);
  });

  it('does not mark anything gone when the folder is missing (a drive that is not there), and says the pass was not full', async () => {
    write('Docs/a.txt');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    const lookedBefore = (db.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(LAPTOP) as { t: number }).t;
    fs.rmSync(path.join(tree, 'Docs'), { recursive: true });
    const run = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt')]);
    expect(run.warns.join(' ')).toMatch(/does not count as a full check/);
    expect((db.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(LAPTOP) as { t: number }).t).toBe(lookedBefore);
  });

  it('sets last looked after a complete pass', async () => {
    write('Docs/a.txt');
    await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect((db.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(LAPTOP) as { t: number | null }).t).not.toBeNull();
  });

  it('works on a named drive with paths relative to its root', async () => {
    write('Photos/a.jpg');
    write('Photos/trip/b.jpg');
    await runJob(DRIVE, false, [''], tree);
    expect(live(DRIVE)).toEqual(['Photos/a.jpg', 'Photos/trip/b.jpg']);
    remove('Photos/trip/b.jpg');
    const run = await runJob(DRIVE, true, [''], tree);
    expect(gone(DRIVE)).toEqual(['Photos/trip/b.jpg']);
    expect(run.message).toMatch(/1 file no longer there/);
    expect(new FolderIndex(db).get(DRIVE, '')).toBeDefined();
  });

  it("lists the app's backups folder but never the app's own files folder or an old-layout card folder, in a full and a quick pass", async () => {
    const backup = `${BACKUPS_PARTS.join('/')}/Reunion/a.jpg`;
    write(backup);
    write(`MyData/Photos/p.jpg`);
    write(`${DB_COPIES_PARTS.join('/')}/backuphub-db-1.db`);
    write(`${OWN_FILES_PARTS.join('/')}/Quarantine/2026-11-03/q.jpg`);
    write(`${LEGACY_CARD_FOLDER}/drive.json`);
    await runJob(DRIVE, false, [''], tree);
    expect(live(DRIVE)).toEqual([backup, 'MyData/Photos/p.jpg'].toSorted());
    // A new file in the own files folder is not found by the quick pass either; a new backup is.
    write(`${OWN_FILES_PARTS.join('/')}/Quarantine/2026-11-03/q2.jpg`);
    const added = `${BACKUPS_PARTS.join('/')}/Reunion/b.jpg`;
    write(added);
    await runJob(DRIVE, true, [''], tree);
    expect(live(DRIVE)).toEqual([backup, added, 'MyData/Photos/p.jpg'].toSorted());
  });

  it('does not see an edit made in place (the folder time does not move): the full listing does', async () => {
    const abs = write('Docs/a.txt', 'one');
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    const folderTime = fs.statSync(path.dirname(abs));
    fs.writeFileSync(abs, 'changed in place');
    fs.utimesSync(path.dirname(abs), folderTime.atime, folderTime.mtime);
    const quick = await runJob(LAPTOP, true, [path.join(tree, 'Docs')]);
    expect(quick.message).toMatch(/0 changed files/);
    await runJob(LAPTOP, false, [path.join(tree, 'Docs')]);
    expect(allRows(LAPTOP)[0]!.size).toBe('changed in place'.length);
  });
});

describe('quickWalk directly', () => {
  it('skips the excluded folders and the skip list and does not follow links', async () => {
    write('Docs/a.txt');
    write('Docs/skipme/z.txt');
    write('Docs/$RECYCLE.BIN/q.txt');
    write('Docs/desktop.ini');
    const result = await quickWalk({ db, placeId: LAPTOP, root: path.join(tree, 'Docs'), relOf: (abs) => toSlashes(abs), excludeDirs: [path.join(tree, 'Docs', 'skipme')] });
    expect(result.complete).toBe(true);
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt')]);
  });

  it('reports a missing root without touching the ledger', async () => {
    write('Docs/a.txt');
    await laptopWalk(path.join(tree, 'Docs'));
    const result = await laptopWalk(path.join(tree, 'Nope'));
    expect(result).toMatchObject({ complete: false, rootMissing: true });
    expect(live(LAPTOP)).toEqual([rel('Docs/a.txt')]);
  });

  it('stops when asked to', async () => {
    write('Docs/a.txt');
    const controller = new AbortController();
    controller.abort();
    await expect(quickWalk({ db, placeId: LAPTOP, root: path.join(tree, 'Docs'), relOf: (abs) => toSlashes(abs), signal: controller.signal })).rejects.toThrow(/stopped/);
  });
});

describe('the folder index stays quick with many folders', () => {
  it('finds the sub-folders of a folder without walking the whole place', () => {
    const folders = new FolderIndex(db);
    const many = Array.from({ length: 30_000 }, (_, i) => ({ relPath: `D:/Big/f${i % 3000}/s${i}`, parent: `D:/Big/f${i % 3000}`, mtime: i }));
    folders.record(LAPTOP, many, 1);
    const started = Date.now();
    let found = 0;
    for (let i = 0; i < 3000; i += 1) found += folders.children(LAPTOP, `D:/Big/f${i}`).length;
    expect(found).toBe(30_000);
    // Measured at about 0.1 ms a lookup; without the index hint it was 5 ms a lookup on the real catalog.
    expect(Date.now() - started).toBeLessThan(3000);
  }, 60_000);
});
