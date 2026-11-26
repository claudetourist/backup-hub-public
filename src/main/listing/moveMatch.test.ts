import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRig, type Rig } from '../look/harness/world.testutil';
import { finishWalk, fullWalk } from './fullWalker';
import { quickWalk } from './quickWalker';
import { normalizeRoot } from './roots';
import { folderPrefix, toSlashes } from './skipRules';
import { relOfMode } from './relPaths';
import { matchMoves } from './moveMatch';

/**
 * R1.6 on REAL folders (NTFS gives real file ids): a file or folder renamed or moved is the same row with a new path, never a second live row; nothing that is
 * not clear-cut is merged; a look that did not finish matches nothing; an id saved for the first time is not a change. The folder is walked by the listing's own
 * full walk and the quick look, the same code the app runs.
 */
const PLACE = 'laptop-r16';
let rig: Rig;
let root: string;
let clock = 1_000_000;
const rel = (p: string): string => toSlashes(path.join(root, ...p.split('/')));
const abs = (p: string): string => path.join(root, ...p.split('/'));

beforeEach(() => {
  rig = makeRig();
  rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'laptop', 'Laptop', '{}', 1)").run(PLACE);
  rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('drive-x', 1, 'drive', 'T7', '{}', 1)").run();
  root = normalizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-r16-')));
  clock = 1_000_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  rig.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const put = (p: string, content: string, mtimeSec = 1_700_000_000): void => {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), content);
  fs.utimesSync(abs(p), mtimeSec, mtimeSec);
};

/** A complete full look of the folder, then its finish (what the listing job and the folder backup do). */
async function look(o: { trust?: boolean } = {}): Promise<{ moved: number; gone: number }> {
  clock += 10_000;
  const runStart = clock;
  const trust = o.trust ?? true;
  const result = await fullWalk({
    db: rig.db,
    request: { placeId: PLACE, root, rel: { kind: 'absolute' }, excludeDirs: [], oneDriveRoot: null, cloudRels: null, chunkSize: 300, ...(trust ? { trustFsId: true } : {}) },
    now: () => clock + 1,
  });
  expect(result.complete).toBe(true);
  return finishWalk(rig.db, { placeId: PLACE, scopePrefix: folderPrefix(toSlashes(root)), keepPrefixes: [], keepPaths: [], runStart, folderRoot: toSlashes(root), ...(trust ? { trustFsId: true } : {}) }, () => clock + 1);
}

const row = (p: string): { id: number; sha256: string | null; gone_at: number | null; fs_id: string | null } | undefined =>
  rig.db.prepare('SELECT id, sha256, gone_at, fs_id FROM files WHERE place_id = ? AND rel_path = ?').get(PLACE, rel(p)) as never;
const live = (): string[] => (rig.db.prepare('SELECT rel_path FROM files WHERE place_id = ? AND gone_at IS NULL ORDER BY rel_path').all(PLACE) as { rel_path: string }[]).map((r) => r.rel_path.slice(rel('').length + 1));
const total = (): number => rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get(PLACE) as number;
const history = (id: number): { rel_path: string; to_at: number | null }[] => rig.db.prepare('SELECT rel_path, to_at FROM file_paths WHERE file_id = ? ORDER BY from_at, rowid').all(id) as never;

describe('a file renamed or moved is the same row', () => {
  it('a rename keeps the row, its checksum and its copy link; the old path goes to the history; no second row is ever left', async () => {
    put('Docs/trip.jpg', 'photo-bytes');
    await look();
    const before = row('Docs/trip.jpg')!;
    expect(before.fs_id).not.toBeNull();
    rig.db.prepare('UPDATE files SET sha256 = ? WHERE id = ?').run('abc123', before.id);
    // A copy on a drive points at the file's row.
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, origin_file_id) VALUES ('drive-x', 'MyData/b/trip.jpg', 11, 1, 1, ?)").run(before.id);

    fs.renameSync(abs('Docs/trip.jpg'), abs('Docs/goa.jpg'));
    const result = await look();
    expect(result).toEqual({ moved: 1, gone: 0 });
    expect(row('Docs/trip.jpg')).toBeUndefined();
    expect(row('Docs/goa.jpg')).toMatchObject({ id: before.id, sha256: 'abc123', gone_at: null });
    expect(live()).toEqual(['Docs/goa.jpg']);
    expect(total()).toBe(1);
    expect(rig.db.prepare('SELECT origin_file_id FROM files WHERE place_id = ?').pluck().get('drive-x')).toBe(before.id);
    expect(history(before.id)).toEqual([
      { rel_path: rel('Docs/trip.jpg'), to_at: clock + 1 },
      { rel_path: rel('Docs/goa.jpg'), to_at: null },
    ]);
    // Nothing changes on a second look.
    expect(await look()).toEqual({ moved: 0, gone: 0 });
    expect(history(before.id)).toHaveLength(2);
  });

  it('a move to another folder, then another: the history keeps every path, the row is the same', async () => {
    put('A/f.txt', 'same');
    await look();
    const id = row('A/f.txt')!.id;
    fs.mkdirSync(abs('B'));
    fs.renameSync(abs('A/f.txt'), abs('B/f.txt'));
    expect((await look()).moved).toBe(1);
    fs.renameSync(abs('B/f.txt'), abs('C.txt'));
    expect((await look()).moved).toBe(1);
    expect(row('C.txt')!.id).toBe(id);
    expect(history(id).map((h) => [h.rel_path.slice(rel('').length + 1), h.to_at === null])).toEqual([['A/f.txt', false], ['B/f.txt', false], ['C.txt', true]]);
    expect(total()).toBe(1);
  });

  it('a folder renamed with 1,000 files in it: every file keeps its row; no new rows', async () => {
    for (let i = 0; i < 1000; i += 1) put(`Trip/d${i % 20}/f${i}.txt`, `content ${i}`, 1_700_000_000 + i);
    await look();
    const ids = new Map((rig.db.prepare('SELECT id, rel_path FROM files WHERE place_id = ?').all(PLACE) as { id: number; rel_path: string }[]).map((r) => [r.rel_path.slice(rel('').length + 1).replace('Trip/', 'Goa 2026/'), r.id]));
    fs.renameSync(abs('Trip'), abs('Goa 2026'));
    const result = await look();
    expect(result).toEqual({ moved: 1000, gone: 0 });
    expect(total()).toBe(1000);
    for (const [p, id] of ids) expect(row(p)?.id, p).toBe(id);
    expect(live().every((p) => p.startsWith('Goa 2026/'))).toBe(true);
  }, 120_000);

  it('moved AND edited (another size) is not matched: it is a new file and the old row is gone', async () => {
    put('A/doc.txt', 'first version');
    await look();
    const old = row('A/doc.txt')!;
    fs.mkdirSync(abs('B'));
    fs.renameSync(abs('A/doc.txt'), abs('B/doc.txt'));
    fs.writeFileSync(abs('B/doc.txt'), 'first version, edited and longer');
    fs.utimesSync(abs('B/doc.txt'), 1_700_000_500, 1_700_000_500);
    expect(await look()).toEqual({ moved: 0, gone: 1 });
    expect(row('B/doc.txt')!.id).not.toBe(old.id);
    expect(row('A/doc.txt')!.gone_at).not.toBeNull();
  });

  it('the same name, size and date in another folder with another file id (a copy, then the old one deleted) is only a candidate: nothing is merged', async () => {
    put('A/same.bin', 'twelve bytes');
    await look();
    const old = row('A/same.bin')!;
    fs.mkdirSync(abs('B'));
    fs.copyFileSync(abs('A/same.bin'), abs('B/same.bin'));
    fs.utimesSync(abs('B/same.bin'), 1_700_000_000, 1_700_000_000);
    fs.rmSync(abs('A/same.bin'));
    expect(await look()).toEqual({ moved: 0, gone: 1 });
    expect(row('B/same.bin')!.id).not.toBe(old.id);
    expect(history(old.id)).toEqual([]);
  });

  it('two new names with one file id (hard links) are a guess: nothing is merged', async () => {
    put('A/one.txt', 'linked');
    await look();
    fs.mkdirSync(abs('B'));
    fs.linkSync(abs('A/one.txt'), abs('B/two.txt'));
    fs.linkSync(abs('A/one.txt'), abs('B/three.txt'));
    fs.rmSync(abs('A/one.txt'));
    expect(await look()).toEqual({ moved: 0, gone: 1 });
    expect(live()).toEqual(['B/three.txt', 'B/two.txt']);
  });

  it('a row something already points at is never dropped (the new row is kept, the old one stays gone)', async () => {
    put('A/f.txt', 'content');
    await look();
    fs.renameSync(abs('A/f.txt'), abs('A/g.txt'));
    // The new path got its row and a copy (an earlier incomplete look) before the matching ran.
    const result = await fullWalk({ db: rig.db, request: { placeId: PLACE, root, rel: { kind: 'absolute' }, excludeDirs: [], oneDriveRoot: null, cloudRels: null, chunkSize: 300, trustFsId: true }, now: () => clock + 20_001 });
    expect(result.complete).toBe(true);
    const fresh = row('A/g.txt')!;
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, origin_file_id) VALUES ('drive-x', 'MyData/b/g.txt', 7, 1, 1, ?)").run(fresh.id);
    rig.db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND rel_path = ?').run(clock + 20_001, PLACE, rel('A/f.txt'));
    expect((await matchMoves(rig.db, { placeId: PLACE, runStart: clock + 10_000, now: clock + 20_002, pause: async () => undefined })).moved).toBe(0);
    expect(row('A/g.txt')!.id).toBe(fresh.id);
  });
});

describe('the file system id is trusted only where it is proven', () => {
  it('a look without trust (a backup drive) saves no id and merges nothing', async () => {
    put('A/f.txt', 'content');
    await look({ trust: false });
    expect(row('A/f.txt')!.fs_id).toBeNull();
    fs.renameSync(abs('A/f.txt'), abs('A/g.txt'));
    expect(await look({ trust: false })).toEqual({ moved: 0, gone: 1 });
    expect(live()).toEqual(['A/g.txt']);
  });

  it('rows listed before ids existed get their id at the next look without any change being counted (full look and quick look)', async () => {
    put('A/f.txt', 'content');
    put('B/g.txt', 'more content');
    await look({ trust: false });
    expect(row('A/f.txt')!.fs_id).toBeNull();
    // The quick look reads the folders it has no time for (an unchanged folder is skipped): nothing is added, changed or gone; the ids are filled in.
    rig.db.prepare('DELETE FROM scan_folders WHERE place_id = ?').run(PLACE);
    const quick = await quickWalk({ db: rig.db, placeId: PLACE, root, relOf: relOfMode({ kind: 'absolute' }), trustFsId: true, now: () => clock + 5 });
    expect(quick).toMatchObject({ added: 0, changed: 0, gone: 0, moved: 0, complete: true });
    expect(row('A/f.txt')!.fs_id).not.toBeNull();
    expect(row('B/g.txt')!.fs_id).not.toBeNull();
    const idA = row('A/f.txt')!.fs_id;
    // A full look after the fill-in counts nothing either.
    expect(await look()).toEqual({ moved: 0, gone: 0 });
    expect(row('A/f.txt')!.fs_id).toBe(idA);
  });

  it('a full look fills the ids of old rows the same way (nothing moves, nothing is gone)', async () => {
    put('A/f.txt', 'content');
    await look({ trust: false });
    expect(await look()).toEqual({ moved: 0, gone: 0 });
    expect(row('A/f.txt')!.fs_id).not.toBeNull();
    expect(total()).toBe(1);
  });
});

describe('the quick look recognises the same moves', () => {
  it('a renamed folder and a moved file: counted as moved, not as added or gone', async () => {
    put('Photos/a.jpg', 'aaaa');
    put('Photos/b.jpg', 'bbbbb');
    put('Docs/c.txt', 'cccccc');
    await look();
    const ids = [row('Photos/a.jpg')!.id, row('Photos/b.jpg')!.id, row('Docs/c.txt')!.id];
    fs.renameSync(abs('Photos'), abs('Pictures 2026'));
    fs.renameSync(abs('Docs/c.txt'), abs('c.txt'));
    const quick = await quickWalk({ db: rig.db, placeId: PLACE, root, relOf: relOfMode({ kind: 'absolute' }), trustFsId: true, now: () => (clock += 10_000) });
    expect(quick).toMatchObject({ complete: true, moved: 3, added: 0, gone: 0 });
    expect([row('Pictures 2026/a.jpg')!.id, row('Pictures 2026/b.jpg')!.id, row('c.txt')!.id]).toEqual(ids);
    expect(total()).toBe(3);
  });

  it('a quick look that did not finish matches nothing', async () => {
    put('A/f.txt', 'content');
    put('Bad/x.txt', 'x');
    await look();
    fs.renameSync(abs('A/f.txt'), abs('A/g.txt'));
    const real = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      if (String(p).endsWith('Bad')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return real(p, o);
    });
    // The folder times of the last look are forgotten so Bad is read (and fails).
    rig.db.prepare('DELETE FROM scan_folders WHERE place_id = ?').run(PLACE);
    const quick = await quickWalk({ db: rig.db, placeId: PLACE, root, relOf: relOfMode({ kind: 'absolute' }), trustFsId: true, now: () => (clock += 10_000) });
    expect(quick.complete).toBe(false);
    expect(quick.moved).toBe(0);
    expect(row('A/f.txt')!.gone_at).not.toBeNull();
    expect(history(row('A/f.txt')!.id)).toEqual([]);
  });
});
