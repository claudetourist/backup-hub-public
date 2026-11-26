import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_KINDS, KIND_LABELS, categoryOfKind, kindOf } from '../shared/fileKinds';
import { classifyChunk } from './classify/sortKinds';
import { computeAllCoverage, copiesFor, placeCoverage } from './copies/copiesIndex';
import { closeDatabase, initDatabase, MIGRATIONS, type Db } from './db';
import { runMigrations } from './db/migrate';
import { emptyFilesSql } from './db/migrations/0016_empty_files';
import { openDatabase } from './db/connection';
import { upsertFiles } from './listing/fileStore';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const KINDS = new Map([
  ['lap', 'laptop'],
  ['t7', 'drive'],
  ['gd', 'gdrive'],
]);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-empty-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind] of KINDS) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, ?, ?, '{}', 'connected', 1)").run(id, kind, id);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

function add(place: string, rel: string, size: number | null, sha: string | null, md5: string | null, extra: { kind?: string; gone?: number } = {}): void {
  db.prepare('INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, kind, gone_at) VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?)').run(place, rel, size, sha, md5, extra.kind ?? null, extra.gone ?? null);
}
const kindOfRow = (place: string, rel: string): string | null => (db.prepare('SELECT kind FROM files WHERE place_id = ? AND rel_path = ?').get(place, rel) as { kind: string | null }).kind;

describe('the "Empty files" kind', () => {
  it('is a kind with the plain label, sits in "everything else", and only size 0 gets it', () => {
    expect(FILE_KINDS).toContain('empty');
    expect(KIND_LABELS.empty).toBe('Empty files');
    expect(categoryOfKind('empty')).toBe('other');
    expect(kindOf('D:/a/photo.jpg', 'photo.jpg', null, 0)).toBe('empty');
    expect(kindOf('D:/a/notes.txt', 'notes.txt', null, 0)).toBe('empty');
    expect(kindOf('D:/a/photo.jpg', 'photo.jpg', null, 5)).toBe('photo-other');
    expect(kindOf('D:/a/photo.jpg', 'photo.jpg', null, null)).toBe('photo-other'); // size not known: the old rules
    expect(kindOf('D:/a/photo.jpg', 'photo.jpg', null)).toBe('photo-other');
  });

  it('sorting the rows that have no kind sets "empty"; a kind the person chose still wins', () => {
    add('lap', 'D:/a/photo.jpg', 0, EMPTY_SHA, EMPTY_MD5);
    add('lap', 'D:/a/notes.txt', 0, null, null);
    add('lap', 'D:/a/chosen.jpg', 0, null, null);
    add('lap', 'D:/a/real.jpg', 12, 'x', 'y');
    db.prepare("INSERT INTO kind_overrides (place_id, rel_path, kind, set_at) VALUES ('lap', 'D:/a/chosen.jpg', 'documents', 1)").run();
    classifyChunk(db, 0);
    expect(kindOfRow('lap', 'D:/a/photo.jpg')).toBe('empty');
    expect(kindOfRow('lap', 'D:/a/notes.txt')).toBe('empty');
    expect(kindOfRow('lap', 'D:/a/chosen.jpg')).toBe('documents');
    expect(kindOfRow('lap', 'D:/a/real.jpg')).toBe('photo-other');
  });

  it('a file whose size changes leaves the bucket on the next listing (and one that becomes empty enters it)', () => {
    const list = (size: number): void => upsertFiles(db, 'lap', [{ relPath: 'D:/a/log.txt', size, mtimeMs: 100 + size, cloudOnly: false }], 5, false);
    list(0); // a new row is given its kind by the listing itself
    expect(kindOfRow('lap', 'D:/a/log.txt')).toBe('empty');
    list(0); // same size again: the kind stays
    expect(kindOfRow('lap', 'D:/a/log.txt')).toBe('empty');
    list(40); // it grew: the listing gives it its new kind at once
    expect(kindOfRow('lap', 'D:/a/log.txt')).toBe('documents');
    list(41); // changed size, still not empty: the kind stays
    expect(kindOfRow('lap', 'D:/a/log.txt')).toBe('documents');
    list(0); // emptied
    expect(kindOfRow('lap', 'D:/a/log.txt')).toBe('empty');
  });

  it('the same for a Google Drive row whose size changes', () => {
    const update = db.prepare("UPDATE files SET size = ? WHERE place_id = 'gd'");
    add('gd', 'My Drive/x.txt', 0, null, EMPTY_MD5);
    classifyChunk(db, 0);
    expect(kindOfRow('gd', 'My Drive/x.txt')).toBe('empty');
    update.run(7);
    // The Drive refresh does this through its own upsert; its kind rule is checked in the source below.
    expect(fs.readFileSync(path.join(__dirname, 'google/driveStore.ts'), 'utf8')).toMatch(/size IS excluded\.size OR \(size IS NOT 0 AND excluded\.size IS NOT 0\)/);
  });

  it('migration 0016 sends empty rows back to be sorted again and leaves every other row alone', () => {
    const raw = openDatabase(path.join(dir, 'm.db'));
    try {
      runMigrations(raw, MIGRATIONS.slice(0, 15));
      raw.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p', 1, 'laptop', 'L', 1)").run();
      const ins = raw.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, kind) VALUES ('p', ?, ?, 1, 2, ?)");
      ins.run('a.jpg', 0, 'photo-other');
      ins.run('b.jpg', 9, 'photo-other');
      ins.run('c.txt', 0, null);
      expect(runMigrations(raw)).toMatchObject({ from: 15, to: MIGRATIONS.length });
      expect(MIGRATIONS[15]?.sql).toBe(emptyFilesSql);
      const rows = Object.fromEntries((raw.prepare('SELECT rel_path, kind FROM files').all() as { rel_path: string; kind: string | null }[]).map((r) => [r.rel_path, r.kind]));
      expect(rows).toEqual({ 'a.jpg': null, 'b.jpg': 'photo-other', 'c.txt': null });
    } finally {
      raw.close();
    }
  });
});

describe('empty files in coverage: never unprotected, never copies of each other', () => {
  beforeEach(() => {
    // Empty files in three places with the same (empty) content, plus a normal file held by two places.
    add('lap', 'D:/e/one.txt', 0, EMPTY_SHA, EMPTY_MD5);
    add('lap', 'D:/e/two.txt', 0, EMPTY_SHA, EMPTY_MD5);
    add('t7', 'e/one.txt', 0, EMPTY_SHA, EMPTY_MD5);
    add('gd', 'My Drive/one.txt', 0, null, EMPTY_MD5);
    add('lap', 'D:/e/never-read.txt', 0, null, null);
    add('lap', 'D:/n/a.bin', 10, 'S1', 'M1');
    add('t7', 'n/a.bin', 10, 'S1', 'M1');
    add('lap', 'D:/n/solo.bin', 10, 'S2', 'M2');
    add('lap', 'D:/e/gone.txt', 0, EMPTY_SHA, EMPTY_MD5, { gone: 5 });
  });

  it('puts them in their own bucket and leaves the other buckets exactly as if they were not there', () => {
    const all = computeAllCoverage(db);
    const lap = all.get('lap')!;
    expect(lap.empty).toEqual({ files: 3, bytes: 0 }); // two read, one never read; the gone row does not count
    expect(lap.none).toEqual({ files: 1, bytes: 10 });
    expect(lap.one).toEqual({ files: 1, bytes: 10 });
    expect(lap.twoPlus).toEqual({ files: 0, bytes: 0 });
    expect(lap.notFingerprinted).toEqual({ files: 0, bytes: 0 });
    expect(all.get('t7')?.empty.files).toBe(1);
    expect(all.get('gd')?.empty.files).toBe(1);
    expect(all.get('gd')?.none.files).toBe(0);
  });

  it('the one-place reference agrees with the all-places pass', () => {
    const all = computeAllCoverage(db);
    for (const id of ['lap', 't7', 'gd']) expect(placeCoverage(db, id)).toEqual(all.get(id));
  });

  it('an empty file has no copies', () => {
    const id = (db.prepare("SELECT id FROM files WHERE rel_path = 'D:/e/one.txt'").get() as { id: number }).id;
    expect(copiesFor(db, id)).toEqual([]);
    const normal = (db.prepare("SELECT id FROM files WHERE rel_path = 'D:/n/a.bin'").get() as { id: number }).id;
    expect(copiesFor(db, normal)).toHaveLength(1);
  });

});
