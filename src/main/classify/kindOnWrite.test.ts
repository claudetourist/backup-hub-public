import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf } from '../../shared/fileKinds';
import { closeDatabase, initDatabase, type Db } from '../db';
import { FOLDER_MIME, type DriveFileInfo } from '../google/driveApi';
import { commitChanges, commitFullList } from '../google/driveStore';
import { upsertFiles } from '../listing/fileStore';

/** The code that writes `files` rows sets the kind itself, so normally no row is left without one (the upkeep process only sorts old rows). */

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-kindwrite-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('lap', 1, 'laptop', 'L', 'connected', 1)").run();
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('gd', 1, 'gdrive', 'G', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const kindOfRow = (place: string, rel: string): string | null => (db.prepare('SELECT kind FROM files WHERE place_id = ? AND rel_path = ?').get(place, rel) as { kind: string | null }).kind;
const unsorted = (): number => (db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n;
const noYield = (): Promise<void> => Promise.resolve();
const info = (over: Partial<DriveFileInfo> & { id: string; name: string }): DriveFileInfo => ({ mimeType: 'application/octet-stream', size: 10, md5: 'x', mtime: 1, webLink: null, parent: null, ...over });

describe('the listing sets the kind when it writes a row', () => {
  const list = (rel: string, size: number): void => upsertFiles(db, 'lap', [{ relPath: rel, size, mtimeMs: 5, cloudOnly: false }], 5, false);

  it('a new row has its kind at once, from the path and the size', () => {
    list('D:/Phone/DCIM/Camera/IMG_1.jpg', 100);
    list('D:/Phone/WhatsApp/Media/IMG-1-WA0001.jpg', 100);
    list('D:/x/empty.pdf', 0);
    list('D:/x/notes.pdf', 100);
    expect(kindOfRow('lap', 'D:/Phone/DCIM/Camera/IMG_1.jpg')).toBe('photo-camera');
    expect(kindOfRow('lap', 'D:/Phone/WhatsApp/Media/IMG-1-WA0001.jpg')).toBe('photo-whatsapp');
    expect(kindOfRow('lap', 'D:/x/empty.pdf')).toBe('empty');
    expect(kindOfRow('lap', 'D:/x/notes.pdf')).toBe('documents');
    expect(unsorted()).toBe(0);
  });

  it('a kind you chose for that path wins, for a new row and after the file changes', () => {
    db.prepare("INSERT INTO kind_overrides (place_id, rel_path, kind, set_at) VALUES ('lap', 'D:/x/a.pdf', 'photo-camera', 1)").run();
    list('D:/x/a.pdf', 100);
    expect(kindOfRow('lap', 'D:/x/a.pdf')).toBe('photo-camera');
    list('D:/x/a.pdf', 0); // emptied: the automatic kind would be "empty", your choice still wins
    expect(kindOfRow('lap', 'D:/x/a.pdf')).toBe('photo-camera');
  });

  it('an old row with no kind gets one when it is listed again, and a row keeps its kind when only its date changes', () => {
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('lap', 'D:/x/old.pdf', 5, 1, 1)").run();
    list('D:/x/old.pdf', 5);
    expect(kindOfRow('lap', 'D:/x/old.pdf')).toBe('documents');
    db.prepare("UPDATE files SET kind = 'other' WHERE rel_path = 'D:/x/old.pdf'").run();
    upsertFiles(db, 'lap', [{ relPath: 'D:/x/old.pdf', size: 5, mtimeMs: 99, cloudOnly: false }], 6, false);
    expect(kindOfRow('lap', 'D:/x/old.pdf')).toBe('other');
  });
});

describe('the Google Drive refresh sets the kind when it writes a row', () => {
  it('a full list gives every file its kind, with its mime type', async () => {
    await commitFullList(
      db,
      'gd',
      [
        info({ id: 'd1', name: 'Papers', mimeType: FOLDER_MIME }),
        info({ id: 'f1', name: 'photo.jpg', mimeType: 'image/jpeg', parent: 'd1' }),
        info({ id: 'f2', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', parent: 'd1', size: null, md5: null }),
        info({ id: 'f3', name: 'empty.txt', size: 0, parent: 'd1' }),
      ],
      5,
      noYield,
    );
    const rows = db.prepare('SELECT rel_path, kind, mime, size FROM files WHERE place_id = ? AND ext_id IS NOT NULL').all('gd') as { rel_path: string; kind: string | null; mime: string | null; size: number | null }[];
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.kind, r.rel_path).toBe(kindOf(r.rel_path, r.rel_path.slice(r.rel_path.lastIndexOf('/') + 1), r.mime, r.size));
    expect(unsorted()).toBe(0);
  });

  it('a renamed folder gives the files below it the kind of their new path', async () => {
    await commitFullList(
      db,
      'gd',
      [info({ id: 'd1', name: 'Docs', mimeType: FOLDER_MIME }), info({ id: 'f1', name: 'a.dat', parent: 'd1' }), info({ id: 'f2', name: 'b.dat', parent: 'd1' })],
      5,
      noYield,
    );
    const read = (): { ext_id: string; rel_path: string; kind: string | null }[] => db.prepare("SELECT ext_id, rel_path, kind FROM files WHERE place_id = 'gd' AND ext_id IN ('f1', 'f2') ORDER BY ext_id").all() as { ext_id: string; rel_path: string; kind: string | null }[];
    expect(read().map((r) => r.kind)).toEqual(['other', 'other']);
    // The files are pictures; a folder named WhatsApp Images makes them WhatsApp photos, and the rename gives them that kind at once.
    db.prepare("UPDATE files SET mime = 'image/jpeg', kind = 'photo-other' WHERE place_id = 'gd' AND ext_id IN ('f1', 'f2')").run();
    await commitChanges(db, 'gd', [{ fileId: 'd1', removed: false, file: { ...info({ id: 'd1', name: 'WhatsApp Images', mimeType: FOLDER_MIME }), trashed: false, ownedByMe: true } }], 6, noYield);
    const rows = read();
    expect(rows.every((r) => r.rel_path.includes('WhatsApp Images/'))).toBe(true);
    expect(rows.map((r) => r.kind)).toEqual(['photo-whatsapp', 'photo-whatsapp']);
  });
});

describe('every writer of file rows sets the kind (source check)', () => {
  it('the four places that insert into files pass a kind', () => {
    const root = path.resolve(__dirname, '..');
    for (const f of ['listing/fileStore.ts', 'google/driveStore.ts', 'import/fleetV1/importer.ts', 'backupProfiles/ledgerImport.ts']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(text, f).toContain('makeKindResolver');
      expect(text, f).toMatch(/INSERT INTO files \([^)]*\bkind\b[^)]*\)/);
    }
  });
});
