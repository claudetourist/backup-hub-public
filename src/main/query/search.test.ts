import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { categoryOf, SEARCH_CATEGORIES } from '../../shared/fileCategories';
import { EMPTY_SEARCH, MAX_COPIES_LISTED, MAX_SEARCH_RESULTS, type SearchHit, type SearchRequest, type SearchResponse, toSearchRequest } from '../../shared/search';
import { kindOf } from '../../shared/fileKinds';
import { compareNoCase } from './searchQuery';
import { classifyChunk } from '../classify/sortKinds';
import { copiesFor } from '../copies/copiesIndex';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import { openReadOnly } from './queryCore';
import { kindsComplete, searchQuery } from './searchQuery';
import { SearchService } from './searchService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const PLACES = [
  ['laptop-1', 'laptop', 'This laptop', 1000],
  ['drive-t7', 'drive', 'T7', 2000],
  ['onedrive-1', 'onedrive', 'OneDrive', null],
  ['gdrive-1', 'gdrive', 'Drive one', 3000],
  ['gdrive-2', 'gdrive', 'Drive two', null],
] as const;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-search-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label, looked] of PLACES) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at, last_looked_at) VALUES (?, 1, ?, ?, 'connected', 1, ?)").run(id, kind, label, looked);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Row {
  place: string;
  rel: string;
  size?: number | null;
  mtime?: number | null;
  sha?: string | null;
  md5?: string | null;
  mime?: string | null;
  link?: string | null;
  gone?: boolean;
  cloud?: boolean;
}
let insertStmt: ReturnType<Db['prepare']> | null = null;
function add(rows: Row[]): void {
  insertStmt = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, mime, web_link, first_seen_at, last_seen_at, gone_at, cloud_only)
     VALUES (@place, @rel, @size, @mtime, @sha, @md5, @mime, @link, 1, 2, @gone, @cloud)`,
  );
  const stmt = insertStmt;
  db.transaction(() => {
    for (const r of rows) {
      stmt.run({
        place: r.place,
        rel: r.rel,
        size: r.size === undefined ? 10 : r.size,
        mtime: r.mtime === undefined ? null : r.mtime,
        sha: r.sha ?? null,
        md5: r.md5 ?? null,
        mime: r.mime ?? null,
        link: r.link ?? null,
        gone: r.gone ? 9 : null,
        cloud: r.cloud ? 1 : 0,
      });
    }
  })();
}

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ ...EMPTY_SEARCH, ...over });
// No time gate on the counts here: a busy test machine must not change what the assertions see.
function run(over: Partial<SearchRequest> = {}): Extract<SearchResponse, { status: 'done' }> {
  const res = searchQuery(db, req(over));
  if (res.status !== 'done') throw new Error(`search did not finish: ${JSON.stringify(res)}`);
  return res;
}
function counts(over: Partial<SearchRequest> = {}, limit?: number): Extract<SearchResponse, { status: 'counts' }> {
  const res = searchQuery(db, req({ ...over, part: 'counts' }), limit);
  if (res.status !== 'counts') throw new Error(`counts did not finish: ${JSON.stringify(res)}`);
  return res;
}
const names = (hits: SearchHit[]): string[] => hits.map((h) => h.name);

describe('matching', () => {
  beforeEach(() => {
    add([
      { place: 'laptop-1', rel: 'D:/MyData/Reunion/final/Math Thread.mp4', size: 500 },
      { place: 'laptop-1', rel: 'D:/MyData/Reunion/photos/IMG_0001.JPG', size: 5 },
      { place: 'laptop-1', rel: 'D:/MyData/Taxes/reunion-budget.xlsx', size: 7 },
      { place: 'drive-t7', rel: 'Backups/thread notes.txt', size: 3 },
      { place: 'laptop-1', rel: 'D:/MyData/Reunion/old/Gone thread.mp4', size: 9, gone: true },
    ]);
  });

  it('needs every word in the file name, in any case and any order, as a part of a word', () => {
    expect(names(run({ text: 'thread' }).hits)).toEqual(['Math Thread.mp4', 'thread notes.txt']);
    expect(names(run({ text: 'THREAD math' }).hits)).toEqual(['Math Thread.mp4']);
    expect(names(run({ text: 'hrea ath' }).hits)).toEqual(['Math Thread.mp4']);
    expect(run({ text: 'thread zzz' }).hits).toEqual([]);
    expect(run({ text: 'thread zzz' }).total).toBe(0);
  });

  it('matches folder names only when asked, and never rows marked gone', () => {
    expect(names(run({ text: 'reunion' }).hits)).toEqual(['reunion-budget.xlsx']);
    expect(names(run({ text: 'reunion', includeFolders: true }).hits)).toEqual(['IMG_0001.JPG', 'Math Thread.mp4', 'reunion-budget.xlsx']);
    expect(names(run({ text: 'reunion final', includeFolders: true }).hits)).toEqual(['Math Thread.mp4']);
    expect(names(run({ text: 'gone' }).hits)).toEqual([]);
  });

  it('is safe with quotes, percent signs and other odd characters', () => {
    add([{ place: 'laptop-1', rel: "D:/x/50% o'brien \"q\" _a.txt" }]);
    expect(names(run({ text: "50% o'brien" }).hits)).toEqual(["50% o'brien \"q\" _a.txt"]);
    expect(names(run({ text: "'; drop table files; --" }).hits)).toEqual([]);
    expect(names(run({ text: '_' }).hits)).toEqual(["50% o'brien \"q\" _a.txt", 'IMG_0001.JPG']); // a literal underscore, not a wildcard
  });

  it('matches letters outside ASCII without regard to case', () => {
    add([{ place: 'laptop-1', rel: 'D:/x/ÉCOLE photo.jpg' }]);
    expect(names(run({ text: 'école' }).hits)).toEqual(['ÉCOLE photo.jpg']);
  });

  it('runs with empty text when a filter or a sort is chosen', () => {
    expect(run({ category: 'videos' }).total).toBe(1);
    expect(run({ sort: 'size' }).hits[0]?.name).toBe('Math Thread.mp4');
    expect(run({ placeIds: ['drive-t7'] }).total).toBe(1);
  });
});

describe('one result per content', () => {
  it('groups by sha256 across places, merges a Drive row with the same md5 and size, and lists every copy', () => {
    add([
      { place: 'laptop-1', rel: 'D:/MyData/a/video.mp4', size: 100, sha: 'S1', md5: 'M1', mtime: 5 },
      { place: 'drive-t7', rel: 'Backup/video-copy.mp4', size: 100, sha: 'S1', md5: 'M1' },
      { place: 'drive-t7', rel: 'Backup2/video.mp4', size: 100, sha: 'S1', md5: 'M1' }, // second copy in the same place
      { place: 'gdrive-1', rel: 'My Drive/video renamed.mp4', size: 100, md5: 'M1', link: 'https://drive.google.com/file/d/1/view' },
      { place: 'gdrive-2', rel: 'My Drive/video.mp4', size: 100, md5: 'M1' },
      { place: 'laptop-1', rel: 'D:/MyData/other/video.mp4', size: 100, sha: 'S2', md5: 'M2' },
    ]);
    const { hits, total } = run({ text: 'video' });
    expect(total).toBe(2);
    const one = hits.find((h) => h.key === 'mM1|100')!;
    expect(one.places).toBe(4); // laptop, T7 (counted once), two Drive accounts
    expect(one.copies).toHaveLength(5);
    expect(one.copies.map((c) => c.placeLabel)).toContain('Drive two');
    expect(one.copies.find((c) => c.placeId === 'gdrive-1')?.hasWebLink).toBe(true);
    expect(one.copies.find((c) => c.placeId === 'drive-t7')?.lastLookedAt).toBe(2000);
    expect(one.fingerprint).toBe('sha256');
    expect(hits.find((h) => h.key === 'mM2|100')?.places).toBe(1);
  });

  it('a Drive-only content groups by md5 and size; different sizes do not group', () => {
    add([
      { place: 'gdrive-1', rel: 'My Drive/x.pdf', size: 5, md5: 'MM' },
      { place: 'gdrive-2', rel: 'My Drive/y.pdf', size: 5, md5: 'MM' },
      { place: 'gdrive-2', rel: 'My Drive/z.pdf', size: 6, md5: 'MM' },
    ]);
    const { hits } = run({ text: 'pdf', sort: 'name' });
    expect(hits.map((h) => [h.name, h.places, h.fingerprint])).toEqual([
      ['x.pdf', 2, 'md5'],
      ['z.pdf', 1, 'md5'],
    ]);
  });

  it('rows with no checksum stand alone and say so; cloud-only rows too', () => {
    add([
      { place: 'laptop-1', rel: 'D:/a/same.txt', size: 4 },
      { place: 'drive-t7', rel: 'b/same.txt', size: 4 },
      { place: 'onedrive-1', rel: 'c/same.txt', size: 4, cloud: true },
    ]);
    const { hits } = run({ text: 'same' });
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.places === 1 && h.fingerprint === 'none' && h.copies.length === 1)).toBe(true);
  });

  it('shows a copy that does not match the words when the content matches', () => {
    add([
      { place: 'laptop-1', rel: 'D:/a/holiday.jpg', size: 4, sha: 'H', md5: 'MH' },
      { place: 'drive-t7', rel: 'z/IMG_9999.jpg', size: 4, sha: 'H', md5: 'MH' },
    ]);
    const { hits } = run({ text: 'holiday' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.copies.map((c) => c.relPath).toSorted()).toEqual(['D:/a/holiday.jpg', 'z/IMG_9999.jpg']);
  });

  it('empty files are never merged as copies of each other: one row each, one place each', () => {
    add([
      { place: 'laptop-1', rel: 'D:/e/blank1.txt', size: 0, sha: 'E', md5: 'ME' },
      { place: 'drive-t7', rel: 'e/blank2.txt', size: 0, sha: 'E', md5: 'ME' },
      { place: 'laptop-1', rel: 'D:/e/blank3.txt', size: 0, sha: 'E', md5: 'ME' },
    ]);
    const { hits } = run({ text: 'blank' });
    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(h.places).toBe(1);
      expect(h.copies).toHaveLength(1);
    }
    expect(run({ text: 'blank', onlyOnePlace: true }).hits).toHaveLength(3);
  });

  it('caps the copies listed for one content and says how many more there are', () => {
    add(Array.from({ length: MAX_COPIES_LISTED + 25 }, (_, i) => ({ place: 'laptop-1', rel: `D:/e/empty${i}.txt`, size: 5, sha: 'E', md5: 'ME' })));
    const { hits } = run({ text: 'empty' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.copies).toHaveLength(MAX_COPIES_LISTED);
    expect(hits[0]?.moreCopies).toBe(25);
    expect(hits[0]?.places).toBe(1);
    // The count per place is exact even when not every copy is listed.
    expect(hits[0]?.perPlace).toEqual([{ placeId: 'laptop-1', placeLabel: expect.any(String), placeKind: 'laptop', files: MAX_COPIES_LISTED + 25 }]);
  });
});

describe('filters and sorts', () => {
  beforeEach(() => {
    add([
      { place: 'laptop-1', rel: 'D:/m/b.jpg', size: 30, mtime: 300, sha: 'A', md5: 'MA' },
      { place: 'drive-t7', rel: 'm/b.jpg', size: 30, mtime: 300, sha: 'A', md5: 'MA' },
      { place: 'gdrive-1', rel: 'My Drive/b.jpg', size: 30, mtime: 300, md5: 'MA' },
      { place: 'laptop-1', rel: 'D:/m/a.mp4', size: 90, mtime: 100, sha: 'B', md5: 'MB' },
      { place: 'drive-t7', rel: 'm/a.mp4', size: 90, mtime: 100, sha: 'B', md5: 'MB' },
      { place: 'laptop-1', rel: 'D:/m/C.pdf', size: 10, mtime: 200, sha: 'C', md5: 'MC' },
      { place: 'gdrive-2', rel: 'My Drive/Notes', size: null, mtime: null, mime: 'application/vnd.google-apps.document' },
      { place: 'laptop-1', rel: 'D:/m/blob.xyz', size: 1, mtime: 50 },
    ]);
  });

  it('filters by category (extension, then mime)', () => {
    expect(names(run({ category: 'photos' }).hits)).toEqual(['b.jpg']);
    expect(names(run({ category: 'videos' }).hits)).toEqual(['a.mp4']);
    expect(names(run({ category: 'documents' }).hits)).toEqual(['C.pdf']);
    expect(names(run({ category: 'googleDocs' }).hits)).toEqual(['Notes']);
    expect(names(run({ category: 'other' }).hits)).toEqual(['blob.xyz']);
    expect(run({ category: 'audio' }).hits).toEqual([]);
    expect(run({ category: 'photos' }).hits[0]?.category).toBe('photos');
  });

  it('place chips keep only files that sit in a chosen place; copies still count every place', () => {
    const only = run({ placeIds: ['gdrive-1'] });
    expect(names(only.hits)).toEqual(['b.jpg']);
    expect(only.hits[0]?.places).toBe(3);
    expect(names(run({ placeIds: ['drive-t7', 'gdrive-2'] }).hits)).toEqual(['a.mp4', 'b.jpg', 'Notes']);
  });

  it('"fewer than 2 other copies" keeps contents held in at most 2 places', () => {
    expect(names(run({ fewCopies: true }).hits)).toEqual(['a.mp4', 'blob.xyz', 'C.pdf', 'Notes']);
    expect(run({ fewCopies: true }).total).toBe(4);
  });

  it('filters by one kind, and by "no other copy at all", with the stored kind or the per-row one', () => {
    classifyChunk(db, 0);
    for (const kinds of [true, false]) {
      const go = (over: Partial<SearchRequest>) => {
        const res = searchQuery(db, req(over), undefined, { kinds });
        if (res.status !== 'done') throw new Error('not done');
        return res;
      };
      expect(names(go({ kind: 'photo-other' }).hits)).toEqual(['b.jpg']);
      expect(names(go({ kind: 'video-other' }).hits)).toEqual(['a.mp4']);
      expect(go({ kind: 'audio-music' }).hits).toEqual([]);
      const one = go({ onlyOnePlace: true });
      expect(one.hits.length).toBeGreaterThan(0);
      expect(one.hits.every((h) => h.places === 1)).toBe(true);
      expect(names(one.hits)).toEqual(names(go({ fewCopies: true }).hits.filter((h) => h.places === 1)));
      expect(one.total).toBe(one.hits.length);
      // Sorts that walk an index give the same contents.
      expect(names(go({ onlyOnePlace: true, sort: 'size' }).hits).toSorted()).toEqual(names(one.hits).toSorted());
      expect(names(go({ onlyOnePlace: true, sort: 'copies' }).hits).toSorted()).toEqual(names(one.hits).toSorted());
    }
    const c = counts({ onlyOnePlace: true, kind: 'documents' });
    expect(c.total).toBe(names(run({ onlyOnePlace: true, kind: 'documents' }).hits).length);
  });

  it('sorts by name, size, date and copies', () => {
    expect(names(run({ sort: 'name' }).hits)).toEqual(['a.mp4', 'b.jpg', 'blob.xyz', 'C.pdf', 'Notes']);
    expect(names(run({ sort: 'size' }).hits)).toEqual(['a.mp4', 'b.jpg', 'C.pdf', 'blob.xyz', 'Notes']);
    expect(names(run({ sort: 'date' }).hits)).toEqual(['b.jpg', 'C.pdf', 'a.mp4', 'blob.xyz', 'Notes']);
    expect(names(run({ sort: 'copies' }).hits)).toEqual(['C.pdf', 'blob.xyz', 'Notes', 'a.mp4', 'b.jpg']);
  });

  it('returns the top 500 contents and the full count', () => {
    add(Array.from({ length: 620 }, (_, i) => ({ place: 'laptop-1', rel: `D:/bulk/file${String(i).padStart(4, '0')}.txt`, size: i })));
    const res = run({ text: 'file' });
    expect(res.hits).toHaveLength(MAX_SEARCH_RESULTS);
    // Name order walks the name index: found without counting; the counts request gives the number.
    expect(res.total ?? counts({ text: 'file' }).total).toBe(620);
    expect(res.hits[0]?.name).toBe('file0000.txt');
    const big = run({ text: 'file', sort: 'size' });
    expect(big.hits[0]?.size).toBe(619);
    // A sort by size on a big catalog is found without counting; the counts request gives the number.
    expect(big.total ?? counts({ text: 'file', sort: 'size' }).total).toBe(620);
  });
});

describe('more filters', () => {
  beforeEach(() => {
    add([
      { place: 'laptop-1', rel: 'D:/Photos/2019/Rome/trip.JPG', size: 5_000_000, mtime: Date.UTC(2019, 5, 1) },
      { place: 'laptop-1', rel: 'D:/Photos/2021/Paris/trip.png', size: 20_000, mtime: Date.UTC(2021, 5, 1) },
      { place: 'drive-t7', rel: 'Backups/Docs/report.pdf', size: 300_000_000, mtime: Date.UTC(2021, 11, 31, 23) },
      { place: 'drive-t7', rel: 'Backups/Docs/report.pdf.bak', size: 1, mtime: Date.UTC(2022, 0, 1) },
      { place: 'gdrive-1', rel: 'My Drive/Rome notes/plan', size: null, mtime: null },
      { place: 'gdrive-1', rel: 'My Drive/Ünï/Écoles.Mp4', size: 1_500_000_000, mtime: Date.UTC(2023, 0, 5) },
    ]);
  });

  it('size bounds are inclusive, a swapped pair is put right by toSearchRequest, and files with no size never match', () => {
    expect(names(run({ minSize: 5_000_000 }).hits)).toEqual(['report.pdf', 'trip.JPG', 'Écoles.Mp4']); // NOCASE folds ASCII only
    expect(names(run({ maxSize: 20_000 }).hits)).toEqual(['report.pdf.bak', 'trip.png']);
    expect(names(run({ minSize: 20_000, maxSize: 5_000_000 }).hits)).toEqual(['trip.JPG', 'trip.png']);
    expect(run({ minSize: 0 }).total).toBe(5); // the file with no size is not a match
    expect(toSearchRequest({ minSize: 10, maxSize: 2 })).toMatchObject({ minSize: 2, maxSize: 10 });
  });

  it('folder: every word in the folder part only, either slash, any case, letters outside ASCII too', () => {
    expect(names(run({ folder: 'photos' }).hits)).toEqual(['trip.JPG', 'trip.png']);
    expect(names(run({ folder: 'D:\\Photos\\2019' }).hits)).toEqual(['trip.JPG']);
    expect(names(run({ folder: 'rome' }).hits)).toEqual(['plan', 'trip.JPG']);
    expect(names(run({ folder: 'rome notes' }).hits)).toEqual(['plan']);
    expect(run({ folder: 'trip' }).hits).toEqual([]); // "trip" is only in names, not in folders
    expect(names(run({ folder: 'ünï' }).hits)).toEqual(['Écoles.Mp4']);
    expect(names(run({ folder: 'docs', text: 'bak' }).hits)).toEqual(['report.pdf.bak']);
  });

  it('extensions: the name must end with a dot and one of them; "pdf" does not match "pdf.bak"', () => {
    expect(names(run({ extensions: ['pdf'] }).hits)).toEqual(['report.pdf']);
    expect(names(run({ extensions: ['jpg', 'mp4'] }).hits)).toEqual(['trip.JPG', 'Écoles.Mp4']);
    expect(names(run({ extensions: ['bak'] }).hits)).toEqual(['report.pdf.bak']);
    expect(run({ extensions: ['df'] }).hits).toEqual([]);
    expect(run({ extensions: ['plan'] }).hits).toEqual([]); // no dot in "plan"
    expect(toSearchRequest({ extensions: ['.PDF', 'pdf', 'mp4;mov', '../x', 5, 'a b'] }).extensions).toEqual(['pdf', 'mp4', 'mov', 'a', 'b']);
  });

  it('dates are inclusive on the file date; files with no date never match', () => {
    expect(names(run({ fromDate: Date.UTC(2021, 0, 1), toDate: Date.UTC(2021, 11, 31, 23) }).hits)).toEqual(['report.pdf', 'trip.png']);
    expect(names(run({ fromDate: Date.UTC(2023, 0, 5) }).hits)).toEqual(['Écoles.Mp4']);
    expect(names(run({ toDate: Date.UTC(2019, 5, 1) }).hits)).toEqual(['trip.JPG']);
    expect(run({ fromDate: 0 }).total).toBe(5);
  });

  it('every filter together, and with text', () => {
    const all = run({
      text: 'trip',
      folder: 'photos',
      extensions: ['png', 'jpg'],
      minSize: 1000,
      maxSize: 6_000_000,
      fromDate: Date.UTC(2019, 0, 1),
      toDate: Date.UTC(2021, 11, 31),
      category: 'photos',
      placeIds: ['laptop-1'],
    });
    expect(names(all.hits)).toEqual(['trip.JPG', 'trip.png']);
    expect(run({ text: 'trip', folder: 'photos', extensions: ['png'], minSize: 1000, maxSize: 6_000_000 }).total).toBe(1);
    expect(run({ text: 'trip', folder: 'photos', extensions: ['png'], minSize: 1_000_000 }).total).toBe(0);
  });

  it('hostile input stays text', () => {
    expect(run({ folder: "x'; DROP TABLE files; --" }).total).toBe(0);
    expect(run({ extensions: ["x'; DROP TABLE files; --"] }).total).toBe(0);
    const bad = toSearchRequest({ minSize: -5, maxSize: 1.5, fromDate: '7', toDate: Number.NaN, offset: -500, sortDir: 'sideways', folder: 5, extensions: 'pdf' });
    expect(bad).toEqual(EMPTY_SEARCH);
    expect(toSearchRequest({ offset: 5000 }).offset).toBe(0);
    expect(toSearchRequest({ offset: 1234 }).offset).toBe(1000);
    expect(toSearchRequest({ extensions: Array.from({ length: 50 }, (_, i) => `e${i}`) }).extensions).toHaveLength(20);
    expect(toSearchRequest({ folder: 'f'.repeat(900) }).folder).toHaveLength(400);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 6 });
  });
});

describe('sort direction', () => {
  beforeEach(() => {
    add([
      { place: 'laptop-1', rel: 'D:/m/b.jpg', size: 30, mtime: 300, sha: 'A', md5: 'MA' },
      { place: 'drive-t7', rel: 'm/b.jpg', size: 30, mtime: 300, sha: 'A', md5: 'MA' },
      { place: 'laptop-1', rel: 'D:/m/a.mp4', size: 90, mtime: 100, sha: 'B', md5: 'MB' },
      { place: 'laptop-1', rel: 'D:/m/C.pdf', size: 10, mtime: 200, sha: 'C', md5: 'MC' },
      { place: 'gdrive-2', rel: 'My Drive/Notes', size: null, mtime: null },
    ]);
  });

  it('flips each sort and keeps rows with no value last both ways', () => {
    expect(names(run({ sort: 'name', sortDir: 'desc' }).hits)).toEqual(['Notes', 'C.pdf', 'b.jpg', 'a.mp4']);
    expect(names(run({ sort: 'size', sortDir: 'asc' }).hits)).toEqual(['C.pdf', 'b.jpg', 'a.mp4', 'Notes']);
    expect(names(run({ sort: 'size', sortDir: 'desc' }).hits)).toEqual(['a.mp4', 'b.jpg', 'C.pdf', 'Notes']);
    expect(names(run({ sort: 'date', sortDir: 'asc' }).hits)).toEqual(['a.mp4', 'C.pdf', 'b.jpg', 'Notes']);
    expect(names(run({ sort: 'date' }).hits)).toEqual(['b.jpg', 'C.pdf', 'a.mp4', 'Notes']);
    expect(names(run({ sort: 'copies', sortDir: 'desc' }).hits)[0]).toBe('b.jpg');
    expect(names(run({ sort: 'copies' }).hits)[3]).toBe('b.jpg');
  });
});

describe('pages', () => {
  it('give disjoint pages in order, the same total, and nothing past the end', () => {
    // 1,300 files; a third share a size and a date so only the tie-break keeps the order total.
    add(
      Array.from({ length: 1300 }, (_, i) => ({
        place: 'laptop-1',
        rel: `D:/bulk/f${String(i).padStart(4, '0')}.txt`,
        size: i % 3 === 0 ? 7 : i,
        mtime: i % 3 === 0 ? 7 : null,
      })),
    );
    for (const [sort, sortDir] of [
      ['name', 'asc'],
      ['name', 'desc'],
      ['size', 'desc'],
      ['date', 'asc'],
      ['copies', 'asc'],
    ] as const) {
      const pages = [0, 500, 1000, 1500].map((offset) => run({ text: 'f', sort, sortDir, offset }));
      expect(pages.map((p) => p.hits.length)).toEqual([500, 500, 300, 0]);
      expect(pages.slice(0, 3).map((p) => p.total ?? counts({ text: 'f' }).total)).toEqual([1300, 1300, 1300]);
      const joined = pages.flatMap((p) => p.hits.map((h) => h.key));
      expect(new Set(joined).size).toBe(1300);
      const whole = run({ text: 'f', sort, sortDir });
      expect(whole.hits.map((h) => h.key)).toEqual(joined.slice(0, 500));
    }
    // A page answer carries no counts or years; those are a second request.
    expect('facets' in run({ text: 'f' })).toBe(false);
    expect('years' in run({ text: 'f' })).toBe(false);
    expect(counts({ text: 'f' }).facets?.places['laptop-1']).toBe(1300);
    // A counts request ignores the page (offset, sort) and the 50,000 rule leaves the chips without numbers.
    expect(toSearchRequest({ text: 'f', part: 'counts', offset: 1000 })).toMatchObject({ part: 'counts', offset: 0 });
    expect(toSearchRequest({ text: 'f', part: 'nope', offset: 1000 })).toMatchObject({ part: 'page', offset: 1000 });
    expect(counts({ text: 'f', offset: 1000, sort: 'size' })).toEqual({ ...counts({ text: 'f' }), ms: expect.any(Number) });
    expect(counts({ text: 'f' }, 1000).facets).toBeNull();
    expect(counts({ text: 'f' }, 1000).years).not.toBeNull(); // the year picker does not depend on the numbers
  }, 30_000);
});

describe('counts above the results', () => {
  interface Live {
    id: number;
    place_id: string;
    name: string;
    size: number | null;
    mtime: number | null;
    sha256: string | null;
    md5: string | null;
    mime: string | null;
  }

  it('equal what a direct count gives, for random catalogs and filters', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      db.prepare('DELETE FROM files').run();
      const next = rng(seed + 1000);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const exts = ['jpg', 'mp4', 'pdf', 'txt', 'zip', 'mp3', 'xyz'];
      const rows: Row[] = [];
      const count = 80 + Math.floor(next() * 80);
      for (let i = 0; i < count; i += 1) {
        const [place, kind] = pick(PLACES);
        const c = Math.floor(next() * 15);
        const fingerprinted = kind === 'gdrive' ? next() < 0.9 : next() < 0.8;
        rows.push({
          place,
          rel: `${kind === 'laptop' ? 'D:/' : ''}dir${i % 4}/${pick(['trip', 'doc', 'img'])}${i}.${pick(exts)}`,
          size: next() < 0.1 ? null : 10 + c * 1000,
          mtime: next() < 0.1 ? null : Date.UTC(2018 + Math.floor(next() * 6), 3, 1),
          sha: kind !== 'gdrive' && fingerprinted ? `s${c}` : null,
          md5: fingerprinted ? `m${c}` : null,
          gone: next() < 0.1,
        });
      }
      add(rows);
      const live = db.prepare('SELECT id, place_id, name, size, mtime, sha256, md5, mime FROM files WHERE gone_at IS NULL').all() as Live[];
      const keyOf = (r: Live): string => (r.md5 !== null && r.size !== null ? `m${r.md5}|${r.size}` : r.sha256 !== null ? `s${r.sha256}` : `r${r.id}`);
      // Places holding the content, by the rules of the page: md5 + size for an 'm' key, sha256 for an 's' key.
      const placesOf = (r: Live): number => {
        const same = (o: Live): boolean => (keyOf(r)[0] === 'm' ? o.md5 === r.md5 && o.size === r.size : keyOf(r)[0] === 's' ? o.sha256 === r.sha256 : o.id === r.id);
        return new Set(live.filter(same).map((o) => o.place_id)).size;
      };

      const filters = req({
        text: pick(['', 'trip', 'i']),
        minSize: pick([null, 5000]),
        extensions: pick([[], ['jpg', 'mp4', 'pdf']]),
        fromDate: pick([null, Date.UTC(2019, 0, 1)]),
        category: pick([null, 'photos', 'videos'] as const),
        placeIds: pick([[], ['laptop-1', 'gdrive-1']]),
        fewCopies: pick([false, true]),
      });
      const matches = (r: Live, skip: 'category' | 'place' | null): boolean =>
        (filters.text === '' || r.name.toLowerCase().includes(filters.text)) &&
        (filters.minSize === null || (r.size !== null && r.size >= filters.minSize)) &&
        (filters.extensions.length === 0 || filters.extensions.some((e) => r.name.toLowerCase().endsWith(`.${e}`))) &&
        (filters.fromDate === null || (r.mtime !== null && r.mtime >= filters.fromDate)) &&
        (skip === 'category' || filters.category === null || categoryOf(r.name, r.mime) === filters.category) &&
        (skip === 'place' || filters.placeIds.length === 0 || filters.placeIds.includes(r.place_id)) &&
        (!filters.fewCopies || placesOf(r) <= 2);

      const res = run(filters);
      expect(res.total, `seed ${seed}`).toBe(new Set(live.filter((r) => matches(r, null)).map(keyOf)).size);
      expect(counts(filters).total, `seed ${seed} counts total`).toBe(res.total);
      const facets = counts(filters).facets!;
      for (const category of SEARCH_CATEGORIES) {
        const expected = new Set(live.filter((r) => categoryOf(r.name, r.mime) === category && matches(r, 'category')).map(keyOf)).size;
        expect(facets.categories[category] ?? 0, `seed ${seed} ${category}`).toBe(expected);
        // And a direct search with that type chosen finds that many contents.
        expect(run({ ...filters, category }).total, `seed ${seed} ${category} direct`).toBe(expected);
      }
      for (const [place] of PLACES) {
        const expected = live.filter((r) => r.place_id === place && matches(r, 'place')).length;
        expect(facets.places[place] ?? 0, `seed ${seed} ${place}`).toBe(expected);
      }
    }
  }, 60_000);

  it('give the years that have files, and none when no file has a date', () => {
    expect(counts({ text: 'x' }).years).toBeNull();
    add([
      { place: 'laptop-1', rel: 'D:/x/old.txt', mtime: Date.UTC(2004, 5, 1) },
      { place: 'laptop-1', rel: 'D:/x/new.txt', mtime: Date.UTC(2023, 5, 1) },
      { place: 'laptop-1', rel: 'D:/x/broken clock.txt', mtime: 99_999_999_999_999 },
    ]);
    expect(counts({ text: 'x' }).years).toEqual([2004, 2023]);
  });
});

// A small deterministic random generator (mulberry32) so a failing seed can be replayed.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('copies equal the copies index', () => {
  it('on 60 random catalogs: every listed copy sees places - 1 other places in copiesFor, and the filter and sort use the same count', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      db.prepare('DELETE FROM files').run();
      const next = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const rows: Row[] = [];
      const count = 30 + Math.floor(next() * 120);
      for (let i = 0; i < count; i += 1) {
        const [place, kind] = pick(PLACES);
        const c = Math.floor(next() * 12); // content c has sha s<c>, md5 m<c>, size 10 + c
        const roll = next();
        const row: Row = { place, rel: `${kind === 'laptop' ? 'D:/' : ''}dir${i % 3}/f${i}.txt`, size: 10 + c, gone: next() < 0.1, cloud: false };
        if (kind === 'gdrive') {
          row.md5 = `m${c}`; // Drive rows: md5 + size, never a sha256
          if (roll > 0.9) row.md5 = null;
        } else if (roll < 0.15) {
          // not fingerprinted yet
        } else {
          row.sha = `s${c}`; // every fingerprinted local row has both hashes
          row.md5 = `m${c}`;
        }
        rows.push(row);
      }
      add(rows);

      const all = run({ sort: 'copies' });
      expect(all.total, `seed ${seed}`).toBe(all.hits.length); // fewer than 500 contents here
      for (const hit of all.hits) {
        for (const copy of hit.copies) {
          const others = new Set(copiesFor(db, copy.fileId).map((c) => c.placeId));
          others.add(copy.placeId);
          expect(others.size, `seed ${seed}, ${hit.key}, file ${copy.fileId}`).toBe(hit.places);
        }
        // The list holds exactly the rows the copies index sees.
        const first = hit.copies[0]!;
        const expected = new Set([first.fileId, ...copiesFor(db, first.fileId).map((c) => c.fileId)]);
        expect(new Set(hit.copies.map((c) => c.fileId)), `seed ${seed}, ${hit.key}`).toEqual(expected);
      }
      // Sorting and filtering by copies (done in SQL) agree with the counts reported for each result.
      const places = all.hits.map((h) => h.places);
      expect(places, `seed ${seed}`).toEqual(places.toSorted((a, b) => a - b));
      const few = run({ fewCopies: true });
      expect(new Set(few.hits.map((h) => h.key)), `seed ${seed}`).toEqual(new Set(all.hits.filter((h) => h.places <= 2).map((h) => h.key)));
      // One result per content: no two results share a row.
      const seen = new Set<number>();
      for (const hit of all.hits) for (const c of hit.copies) {
        expect(seen.has(c.fileId), `seed ${seed}: file ${c.fileId} is in two results`).toBe(false);
        seen.add(c.fileId);
      }
    }
  }, 60_000);
});

describe('SearchService', () => {
  const service = (over: Partial<ConstructorParameters<typeof SearchService>[0]> = {}): SearchService =>
    new SearchService({ dbFile: null, db, workerPath: null, log: silent, ...over });

  it('answers on the main thread when there is no worker (in-memory database, tests)', async () => {
    add([{ place: 'laptop-1', rel: 'D:/a/hello.txt' }]);
    const s = service();
    const res = await s.run(req({ text: 'hello' }));
    expect(res.status).toBe('done');
    s.close();
  });

  it('a newer search replaces the one in flight: the older answers superseded', async () => {
    add([{ place: 'laptop-1', rel: 'D:/a/hello.txt' }]);
    const s = service();
    const first = s.run(req({ text: 'hello' }));
    const second = s.run(req({ text: 'hel' }));
    expect(await first).toEqual({ status: 'superseded' });
    const done = (await second) as Extract<SearchResponse, { status: 'done' }>;
    expect(done.status).toBe('done');
    expect(done.hits).toHaveLength(1);
    s.close();
  });

  it('counts have their own lane: a next page and counts both answer; a new search replaces both', async () => {
    add(Array.from({ length: 700 }, (_, i) => ({ place: 'laptop-1', rel: `D:/a/hello${i}.txt` })));
    const s = service();
    // Counts in flight, then the next page: neither kills the other.
    const c1 = s.run(req({ text: 'hello', part: 'counts' }));
    const next = s.run(req({ text: 'hello', offset: 500 }));
    expect((await c1).status).toBe('counts');
    expect(((await next) as Extract<SearchResponse, { status: 'done' }>).hits).toHaveLength(200);
    // A page in flight, then counts: the page still answers.
    const p = s.run(req({ text: 'hello' }));
    const c2 = s.run(req({ text: 'hello', part: 'counts' }));
    expect((await p).status).toBe('done');
    expect((await c2).status).toBe('counts');
    // Counts and a next page in flight, then a new search: both are replaced.
    const c3 = s.run(req({ text: 'hello', part: 'counts' }));
    const n3 = s.run(req({ text: 'hello', offset: 500 }));
    const fresh = s.run(req({ text: 'hel' }));
    expect(await c3).toEqual({ status: 'superseded' });
    expect(await n3).toEqual({ status: 'superseded' });
    expect((await fresh).status).toBe('done');
    // A newer counts request replaces an older one.
    const c4 = s.run(req({ text: 'hello', part: 'counts' }));
    const c5 = s.run(req({ text: 'hel', part: 'counts' }));
    expect(await c4).toEqual({ status: 'superseded' });
    expect((await c5).status).toBe('counts');
    s.close();
  });

  it('reports a failure as a plain answer, not a thrown error', async () => {
    const s = service({ db: { prepare: () => { throw new Error('boom'); }, function: () => undefined } as unknown as Db });
    const res = await s.run(req({ text: 'x' }));
    expect(res).toEqual({ status: 'failed', message: 'boom' });
    s.close();
  });
});

describe('the built query worker answers searches (real worker thread, read-only connection)', () => {
  let outDir: string;
  let workerPath: string;
  beforeAll(async () => {
    outDir = path.join(process.cwd(), 'node_modules', '.cache', 'search-worker-test');
    fs.rmSync(outDir, { recursive: true, force: true });
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        ssr: path.join(__dirname, 'queryWorker.ts'),
        rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'queryWorker.js' } },
      },
    });
    workerPath = path.join(outDir, 'queryWorker.js');
  }, 60_000);
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('runs a search, replaces a search in flight, and cannot write', async () => {
    add([
      { place: 'laptop-1', rel: 'D:/a/hello.txt', size: 3, sha: 'H', md5: 'MH' },
      { place: 'drive-t7', rel: 'x/hello.txt', size: 3, sha: 'H', md5: 'MH' },
    ]);
    const s = new SearchService({ dbFile: path.join(dir, DB_FILE_NAME), db, workerPath, log: silent });
    const first = s.run(req({ text: 'hello' }));
    const second = s.run(req({ text: 'hello', sort: 'copies' }));
    expect(await first).toEqual({ status: 'superseded' });
    const done = (await second) as Extract<SearchResponse, { status: 'done' }>;
    expect(done.status).toBe('done');
    expect(done.hits[0]?.places).toBe(2);
    const third = (await s.run(req({ text: 'nothing like it' }))) as Extract<SearchResponse, { status: 'done' }>;
    expect(third.hits).toEqual([]);
    // Two lanes, two worker threads: counts and a page in flight together both answer; a new search replaces both.
    const counts1 = s.run(req({ text: 'hello', part: 'counts' }));
    const page = s.run(req({ text: 'hello', offset: 500 }));
    const c = await counts1;
    expect(c.status === 'counts' && c.facets?.places['laptop-1']).toBe(1);
    expect((await page).status).toBe('done');
    const counts2 = s.run(req({ text: 'hello', part: 'counts' }));
    const fresh = s.run(req({ text: 'hello' }));
    expect(await counts2).toEqual({ status: 'superseded' });
    expect((await fresh).status).toBe('done');
    s.close();
    const reader = openReadOnly(path.join(dir, DB_FILE_NAME));
    expect(() => reader.prepare("DELETE FROM files WHERE place_id = 'laptop-1'").run()).toThrow(/readonly/i);
    reader.close();
  });
});

// The 100k one is always on (a loose bound that only catches a return to per-row lookups); the 700k one is opt-in:
// BACKUPHUB_BENCH=1 npm test -- search
const sha = (k: number): string => crypto.createHash('sha256').update(`s${k}`).digest('hex');
const md5 = (k: number): string => crypto.createHash('md5').update(`s${k}`).digest('hex');

/** Fill the catalog in chunks, yielding between them (one long synchronous block starves vitest's worker RPC). */
async function fill(total: number, scale: number): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, mime, first_seen_at, last_seen_at, cloud_only)
     VALUES (@place, @rel, @size, @mtime, @sha, @md5, @mime, 1, 2, 0)`,
  );
  const words = ['holiday', 'reunion', 'report', 'invoice', 'IMG', 'video', 'backup', 'photo', 'scan', 'notes', 'trip', 'family'];
  const exts = ['jpg', 'mp4', 'pdf', 'docx', 'zip', 'mp3', 'txt', 'png'];
  const contents = Math.floor((total * 0.45) / scale) || 1;
  const hashes = new Map<number, [string, string]>();
  const hashOf = (k: number): [string, string] => {
    let h = hashes.get(k);
    if (!h) {
      h = [sha(k), md5(k)];
      hashes.set(k, h);
    }
    return h;
  };
  const chunk = db.transaction((from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      const place = i % 20 < 6 ? 'laptop-1' : i % 20 < 16 ? 'drive-t7' : i % 20 < 18 ? 'onedrive-1' : 'gdrive-1';
      const k = (i * 7) % contents;
      const w1 = words[i % words.length]!;
      const w2 = words[(i * 5) % words.length]!;
      const rel = `Users/someone/Documents/Pictures/2019/${w1}/Italy/Rome/${w1} ${w2} ${i}.${exts[i % exts.length]}`;
      const [s, m] = hashOf(k);
      const driveRow = place === 'gdrive-1';
      insert.run({
        place,
        rel,
        size: (k % 5000) + 1,
        mtime: 1_600_000_000_000 + i * 1000,
        sha: driveRow || i % 10 === 0 ? null : s,
        md5: driveRow ? m : i % 10 === 0 ? null : m,
        mime: driveRow ? 'application/octet-stream' : null,
      });
    }
  });
  for (let at = 0; at < total; at += 50_000) {
    chunk(at, Math.min(total, at + 50_000));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function bench(total: number, scale: number, limitMs: number): Promise<void> {
  await fill(total, scale);
  const rows = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
  expect(rows).toBe(total);
  // The sorting job's work, so the type filters read the stored kind like the app does once the catalog is sorted.
  const t = Date.now();
  for (let after = 0; ; ) {
    const chunk = classifyChunk(db, after, 50_000);
    if (chunk.lastId === null) break;
    after = chunk.lastId;
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(kindsComplete(db)).toBe(true);
  console.log(`BENCHMARK sorting ${total} files by kind: ${Date.now() - t} ms`);
  const reader = openReadOnly(path.join(dir, DB_FILE_NAME)); // like the worker: its own read-only connection
  // Each case is timed as the page (what the person waits for) and then as the counts (a second request).
  const cases: [string, SearchRequest, number?][] = [
    ['typical: two words', req({ text: 'holiday 12' })],
    ['a rare word', req({ text: 'invoice docx 9999' })],
    ['worst: one common word (53k contents, counts skipped)', req({ text: 'a' })],
    ['same, counts forced', req({ text: 'a' }), Infinity],
    ['common word: video', req({ text: 'video' })],
    ['common word + folders', req({ text: 'photo', includeFolders: true })],
    ['common word, sort by copies', req({ text: 'video', sort: 'copies' })],
    ['common word, fewer than 2 other copies', req({ text: 'reunion', fewCopies: true })],
    ['common word, page 2', req({ text: 'a', offset: 500 })],
    ['common word with type and 2 places chosen', req({ text: 'a', category: 'photos', placeIds: ['laptop-1', 'drive-t7'] })],
    ['no text, category videos, biggest first', req({ category: 'videos', sort: 'size' })],
    ['no text, newest first', req({ sort: 'date' })],
    ['no text, biggest first', req({ sort: 'size' })],
    ['no text, oldest first', req({ sort: 'date', sortDir: 'asc' })],
    ['photos filter (name order)', req({ category: 'photos' })],
    ['photos, biggest first', req({ category: 'photos', sort: 'size' })],
    ['photos, newest first', req({ category: 'photos', sort: 'date' })],
    ['photos, newest first, page 2', req({ category: 'photos', sort: 'date', offset: 500 })],
    ['size + extension, no text', req({ minSize: 1000, maxSize: 4000, extensions: ['jpg', 'pdf'] })],
    ['folder + date range + sort by size, smallest first', req({ folder: 'italy rome', fromDate: 1_600_000_000_000, toDate: 1_600_400_000_000, sort: 'size', sortDir: 'asc' })],
  ];
  const lines: string[] = [];
  let worst = 0;
  for (const [label, request, limit] of cases) {
    const t0 = Date.now();
    const res = searchQuery(reader, request);
    const pageMs = Date.now() - t0;
    if (res.status !== 'done') throw new Error(`${label}: ${JSON.stringify(res)}`);
    let countsText = 'counts: none (a later page has none)';
    if (request.offset === 0) {
      const t1 = Date.now();
      const c = searchQuery(reader, { ...request, part: 'counts' }, limit);
      const countsMs = Date.now() - t1;
      if (c.status !== 'counts') throw new Error(`${label}: ${JSON.stringify(c)}`);
      worst = Math.max(worst, countsMs);
      countsText = `counts: ${countsMs} ms (${c.facets ? 'shown' : 'skipped'})`;
    }
    worst = Math.max(worst, pageMs);
    lines.push(`  ${label}: page ${pageMs} ms (${res.total ?? "not counted"} contents); ${countsText}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  reader.close();
  console.log(`BENCHMARK search, ${total} rows:\n${lines.join('\n')}`);
  expect(worst).toBeLessThan(limitMs);
}

describe('search speed: 100,000 rows (quick)', () => {
  it('every kind of search finishes well inside the bound', async () => {
    await bench(100_000, 3, 8_000);
  }, 120_000);
});

describe.runIf(process.env['BACKUPHUB_BENCH'] === '1')('search speed: 700,000 rows', () => {
  it('typical under 1 s, a common word under 5 s', async () => {
    await bench(700_000, 3, 30_000);
  }, 600_000);
});

// ---- Stored kinds and the walk (A2) -----------------------------------------------------------------------------------

/** A random catalog with the names that matter for kinds, shared contents across places, odd dates and sizes, and gone rows. */
function randomCatalog(seed: number, count: number): void {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const patterns = ['IMG_{i}.jpg', 'PXL_{i}.jpg', 'IMG-{i}-WA0001.jpg', 'Screenshot {i}.png', 'VID_{i}.mp4', 'holiday {i}.mkv', 'Recording {i}.m4a', 'song {i}.mp3', 'doc {i}.pdf', 'pack {i}.zip', 'blob {i}.xyz', 'photo {i}.JPG', 'clip {i}.mov'];
  const folders = ['DCIM/Camera', 'WhatsApp/Media', 'Pictures/Screenshots', 'Music', 'Recordings', 'Documents', 'misc'];
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const [place, kind] = pick(PLACES);
    const c = Math.floor(next() * (count / 2.5));
    const name = pick(patterns).replace('{i}', String(c));
    const folder = folders[c % folders.length]!;
    const fingerprinted = kind === 'gdrive' ? next() < 0.9 : next() < 0.8;
    rows.push({
      place,
      // the row number keeps two rows of one place from sharing a path
      rel: `${kind === 'laptop' ? 'D:/' : ''}${folder}/${i % 5 === 0 ? 'Copy of ' : ''}${name.replace(/(\.[A-Za-z0-9]+)$/, `~${i}$1`)}`,
      size: next() < 0.08 ? null : 10 + (c % 9) * 100,
      // copies of one content mostly share a date, but some do not (the representative row decides the place in the list)
      mtime: next() < 0.1 ? null : Date.UTC(2015 + (c % 6), 3, 1) + (next() < 0.25 ? Math.floor(next() * 5) * 86_400_000 : 0),
      sha: kind !== 'gdrive' && fingerprinted ? `s${c}` : null,
      md5: fingerprinted ? `m${c}` : null,
      mime: kind === 'gdrive' && next() < 0.1 ? 'application/vnd.google-apps.document' : null,
      gone: next() < 0.08,
      cloud: false,
    });
  }
  add(rows);
}

describe('stored kinds', () => {
  it('kindsComplete is false while a live row has no kind, ignores rows marked gone, and true once everything is sorted', () => {
    expect(kindsComplete(db)).toBe(true); // an empty catalog
    add([
      { place: 'laptop-1', rel: 'D:/a/IMG_0001.jpg' },
      { place: 'laptop-1', rel: 'D:/a/old.jpg', gone: true },
    ]);
    expect(kindsComplete(db)).toBe(false);
    classifyChunk(db, 0);
    expect(kindsComplete(db)).toBe(true);
    db.prepare("UPDATE files SET kind = NULL WHERE rel_path = 'D:/a/old.jpg'").run();
    expect(kindsComplete(db)).toBe(true); // the gone row does not count
    add([{ place: 'laptop-1', rel: 'D:/a/new.pdf' }]);
    expect(kindsComplete(db)).toBe(false);
  });

  it('every hit carries its kind, the same one kindOf gives, stored or not', () => {
    add([
      { place: 'laptop-1', rel: 'D:/Phone/DCIM/Camera/a.jpg', size: 5, mtime: 1 },
      { place: 'laptop-1', rel: 'D:/Phone/WhatsApp/b.mp4', size: 6, mtime: 2 },
      { place: 'laptop-1', rel: 'D:/Phone/Recordings/c.m4a', size: 7, mtime: 3 },
      { place: 'gdrive-1', rel: 'My Drive/Notes', size: null, mime: 'application/vnd.google-apps.document' },
    ]);
    const before = run({ sort: 'name' }).hits.map((h) => [h.name, h.kind]);
    classifyChunk(db, 0);
    const after = run({ sort: 'name' }).hits.map((h) => [h.name, h.kind]);
    expect(after).toEqual(before);
    expect(Object.fromEntries(after)).toEqual({ 'a.jpg': 'photo-camera', 'b.mp4': 'video-whatsapp', 'c.m4a': 'audio-recording', Notes: 'google-docs' });
    expect(kindOf('D:/Phone/DCIM/Camera/a.jpg', 'a.jpg', null)).toBe('photo-camera');
  });

  it('type filters and type counts give the same answer from the stored kind and from the per-row type, on random catalogs', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      db.prepare('DELETE FROM files').run();
      randomCatalog(seed + 500, 150 + (seed % 5) * 40);
      classifyChunk(db, 0, 100_000);
      expect(kindsComplete(db)).toBe(true);
      const next = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      for (let q = 0; q < 12; q += 1) {
        const request = req({
          category: pick([null, ...SEARCH_CATEGORIES]),
          text: pick(['', 'img', 'a']),
          placeIds: pick([[], ['laptop-1', 'gdrive-1']]),
          fewCopies: pick([false, true]),
          sort: pick([null, 'name', 'size', 'date', 'copies'] as const),
          minSize: pick([null, 150]),
        });
        const stored = searchQuery(db, request, undefined, { kinds: true });
        const perRow = searchQuery(db, request, undefined, { kinds: false });
        expect(stored, `seed ${seed} query ${q}`).toEqual({ ...perRow, ms: expect.any(Number) });
        const countsStored = searchQuery(db, { ...request, part: 'counts' }, undefined, { kinds: true });
        const countsPerRow = searchQuery(db, { ...request, part: 'counts' }, undefined, { kinds: false });
        expect(countsStored, `seed ${seed} query ${q} counts`).toEqual({ ...countsPerRow, ms: expect.any(Number) });
      }
    }
  }, 120_000);

  it('uses the per-row type while a live row has no kind, so Search is right during the sorting', () => {
    add([
      { place: 'laptop-1', rel: 'D:/a/one.jpg' },
      { place: 'laptop-1', rel: 'D:/a/two.jpg' },
      { place: 'laptop-1', rel: 'D:/a/three.pdf' },
    ]);
    classifyChunk(db, 0);
    add([{ place: 'laptop-1', rel: 'D:/a/four.jpg' }]); // new, not sorted yet
    expect(names(run({ category: 'photos' }).hits)).toEqual(['four.jpg', 'one.jpg', 'two.jpg']);
    expect(counts({ category: 'photos' }).facets?.categories).toEqual({ photos: 3, documents: 1 });
  });
});

describe('the walk by date or size gives the page grouping gives', () => {
  it('for the same rows, in the same order, on random catalogs (page of 10, walks of 30 rows)', () => {
    let walked = 0;
    let fellBack = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      db.prepare('DELETE FROM files').run();
      randomCatalog(seed + 900, 200 + (seed % 4) * 60);
      if (seed % 2 === 0) classifyChunk(db, 0, 100_000);
      const next = rng(seed + 77);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      for (let q = 0; q < 14; q += 1) {
        const request = req({
          sort: pick(['date', 'size', 'name', null] as const),
          sortDir: pick([null, 'asc', 'desc'] as const),
          category: pick([null, null, 'photos', 'videos', 'documents'] as const),
          text: pick(['', '', 'img', 'holiday', 'x']),
          placeIds: pick([[], [], ['laptop-1', 'drive-t7']]),
          fewCopies: pick([false, false, true]),
          minSize: pick([null, null, 250]),
          fromDate: pick([null, null, Date.UTC(2017, 0, 1)]),
          offset: pick([0, 0, 10, 20]),
        });
        const grouped = searchQuery(db, request, undefined, { walk: false, pageSize: 10 });
        const walk = searchQuery(db, request, undefined, { walk: true, pageSize: 10, walkRows: pick([12, 30, 100]) });
        if (grouped.status !== 'done' || walk.status !== 'done') throw new Error(`seed ${seed} query ${q}: ${JSON.stringify([grouped, walk])}`);
        const label = `seed ${seed} query ${q} ${JSON.stringify(request)}`;
        expect(walk.hits.map((h) => h.key), label).toEqual(grouped.hits.map((h) => h.key));
        expect(walk.hits.map((h) => [h.name, h.size, h.mtime, h.places]), label).toEqual(grouped.hits.map((h) => [h.name, h.size, h.mtime, h.places]));
        if (walk.total === null) walked += 1;
        else {
          fellBack += 1;
          expect(walk.total, label).toBe(grouped.total);
        }
      }
    }
    // Both ways were exercised, or the test proves nothing.
    expect(walked).toBeGreaterThan(40);
    expect(fellBack).toBeGreaterThan(40);
  }, 120_000);

  it('a walk page and the next page join without gaps or repeats, as grouping does', () => {
    randomCatalog(4242, 400);
    const keysOf = (walk: boolean): string[] => {
      const all: string[] = [];
      for (const offset of [0, 10, 20, 30, 40, 50]) {
        const res = searchQuery(db, req({ sort: 'date', offset }), undefined, { walk, pageSize: 10, walkRows: 30 });
        if (res.status !== 'done') throw new Error('did not finish');
        all.push(...res.hits.map((h) => h.key));
      }
      return all;
    };
    const joined = keysOf(true);
    expect(joined).toEqual(keysOf(false));
    expect(new Set(joined).size).toBe(joined.length);
  });

  it('name order: pages walked by the name index join like grouped pages, and the index is used', () => {
    randomCatalog(777, 400);
    const keysOf = (walk: boolean): string[] => {
      const all: string[] = [];
      for (const offset of [0, 10, 20, 30, 40, 50]) {
        const res = searchQuery(db, req({ sort: 'name', offset }), undefined, { walk, pageSize: 10, walkRows: 30 });
        if (res.status !== 'done') throw new Error('did not finish');
        all.push(...res.hits.map((h) => h.key));
      }
      return all;
    };
    expect(keysOf(true)).toEqual(keysOf(false));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT f.name FROM files f INDEXED BY idx_files_name_nocase WHERE f.gone_at IS NULL ORDER BY f.name COLLATE NOCASE LIMIT 5").all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_files_name_nocase');
    expect(plan.map((p) => p.detail).join(' ')).not.toContain('TEMP B-TREE');
  });

  it('compareNoCase agrees with SQLite NOCASE on mixed names', () => {
    const sample = ['b.jpg', 'B.jpg', 'a.jpg', 'Z', 'z1', '_x', '[x', '\u00e9.jpg', 'e.jpg', '\u00c4', 'IMG 1', 'img 10', 'img 2', 'file~', 'File'];
    const viaSql = (db.prepare("SELECT value AS n FROM json_each(?) ORDER BY n COLLATE NOCASE").all(JSON.stringify(sample)) as { n: string }[]).map((r) => r.n);
    const viaJs = sample.toSorted((a, b) => compareNoCase(a, b));
    expect(viaJs.map((n) => n.toLowerCase())).toEqual(viaSql.map((n) => n.toLowerCase()));
  });
});
