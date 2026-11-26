import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyChunk } from '../classify/sortKinds';
import { closeDatabase, initDatabase, type Db } from '../db';
import { searchQuery } from '../query/searchQuery';
import { EMPTY_SEARCH } from '../../shared/search';
import { KindStore } from './kindStore';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const PLACES = [
  ['laptop-1', 'laptop', 'This laptop'],
  ['drive-t7', 'drive', 'T7'],
] as const;

let dir: string;
let db: Db;
let changes: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-kinds-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label] of PLACES) db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  changes = 0;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

let nextContent = 1;
/** A fingerprinted file with a content of its own, or the content `c` shared with others. */
function addFile(place: string, rel: string, size: number, c: string = `unique${nextContent++}`): number {
  const info = db
    .prepare('INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, cloud_only) VALUES (?, ?, ?, ?, ?, 1, 2, 0)')
    .run(place, rel, size, `S${c}`, `M${c}`);
  return Number(info.lastInsertRowid);
}
const sorted = (): void => void classifyChunk(db, 0);

function store(): KindStore {
  return new KindStore({
    db,
    changed: () => {
      changes += 1;
    },
  });
}

describe('changing the kind of a file', () => {
  it('writes your kind to the file and to the overrides, and it wins when the rows are sorted again', async () => {
    addFile('laptop-1', 'D:/Misc/clip_a.mp4', 10);
    addFile('laptop-1', 'D:/Misc/clip_b.mp4', 10);
    sorted();
    const id = (db.prepare("SELECT id FROM files WHERE name = 'clip_a.mp4'").get() as { id: number }).id;
    expect(db.prepare('SELECT kind FROM files WHERE id = ?').get(id)).toEqual({ kind: 'video-other' });
    const result = await store().changeKind({ kind: 'video-camera', targets: [{ type: 'file', fileId: id }], similar: false });
    expect(result).toMatchObject({ ok: true, files: 1 });
    expect(db.prepare('SELECT kind FROM files WHERE id = ?').get(id)).toEqual({ kind: 'video-camera' });
    expect(changes).toBe(1);
    // Sorting again (kind reset to nothing) keeps your choice and leaves the other file automatic.
    db.prepare('UPDATE files SET kind = NULL').run();
    classifyChunk(db, 0);
    expect(db.prepare("SELECT name, kind FROM files ORDER BY name").all()).toEqual([
      { name: 'clip_a.mp4', kind: 'video-camera' },
      { name: 'clip_b.mp4', kind: 'video-other' },
    ]);
  });

  it('"also for similar files" changes the same ending and name start in the same folder, and says how many', async () => {
    addFile('laptop-1', 'D:/Shots/IMG_001.jpg', 10);
    addFile('laptop-1', 'D:/Shots/IMG_002.jpg', 10);
    addFile('laptop-1', 'D:/Shots/IMG_003.png', 10);
    addFile('laptop-1', 'D:/Shots/holiday.jpg', 10);
    addFile('laptop-1', 'D:/Other/IMG_004.jpg', 10);
    sorted();
    const id = (db.prepare("SELECT id FROM files WHERE name = 'IMG_001.jpg'").get() as { id: number }).id;
    const s = store();
    expect(s.similar(id)).toEqual({ count: 1, description: 'all .jpg files starting with IMG_ in D:\\Shots' });
    const result = await s.changeKind({ kind: 'photo-screenshot', targets: [{ type: 'file', fileId: id }], similar: true });
    expect(result).toMatchObject({ ok: true, files: 2 });
    const kinds = db.prepare('SELECT name, kind FROM files ORDER BY rel_path').all() as { name: string; kind: string }[];
    expect(kinds.filter((k) => k.kind === 'photo-screenshot').map((k) => k.name)).toEqual(['IMG_001.jpg', 'IMG_002.jpg']);
  });

  it('search finds a file by the kind you gave it', async () => {
    addFile('laptop-1', 'D:/Misc/clip_a.mp4', 10);
    sorted();
    const id = (db.prepare('SELECT id FROM files').get() as { id: number }).id;
    await store().changeKind({ kind: 'video-camera', targets: [{ type: 'file', fileId: id }], similar: false });
    const found = searchQuery(db, { ...EMPTY_SEARCH, kind: 'video-camera' });
    expect(found.status === 'done' && found.hits.map((h) => h.kind)).toEqual(['video-camera']);
  });
});