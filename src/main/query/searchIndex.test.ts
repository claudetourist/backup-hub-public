import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SEARCH, type SearchHit, type SearchRequest } from '../../shared/search';
import { closeDatabase, initDatabase, type Db } from '../db';
import { catchUp, fillSlice, indexProgress, mergeStep, setMergeMode, SliceSizer } from './searchIndexFill';
import { candidatesFor, indexedSearch, type IndexTuning } from './searchIndexQuery';
import { searchQuery } from './searchQuery';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const PLACES = [
  ['laptop-1', 'laptop', 'This laptop'],
  ['drive-t7', 'drive', 'T7'],
  ['drive-sg', 'drive', 'Seagate2TB'],
  ['gdrive-1', 'gdrive', 'Drive one'],
] as const;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-searchindex-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label] of PLACES) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const WORDS = ['holiday', 'report', 'invoice', 'photo', 'budget', 'draft', 'final', 'Résumé', 'Ünïcode', 'scan', 'backup', 'notes'];
const EXTS = ['jpg', 'pdf', 'docx', 'mp4', 'txt'];
const FOLDERS = ['Pictures/2023', 'Pictures/2024/Holiday', 'Documents/Work', 'Documents/Tax Returns', 'Videos', 'Downloads'];

/** Deterministic catalog: contents that sit in several places, names that repeat, a few gone files, a few with no date. */
function fillCatalog(rows: number): void {
  const ins = db.prepare(
    "INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      const content = i % 600;
      const word = WORDS[content % WORDS.length]!;
      const ext = EXTS[content % EXTS.length]!;
      const folder = FOLDERS[(content * 7) % FOLDERS.length]!;
      const copies = 1 + (content % 3);
      for (let c = 0; c < copies; c += 1) {
        const place = PLACES[(content + c) % PLACES.length]![0];
        const name = c === 0 ? `${word}_${content}.${ext}` : c === 1 ? `${word}_${content}.${ext}` : `Copy of ${word}_${content}.${ext}`;
        const rel = place.startsWith('gdrive') ? `${folder}/${name}` : `Users/Test/${folder}/${name}`;
        const size = 1000 + content * 37;
        const md5 = place.startsWith('gdrive') || c % 2 === 0 ? `md5-${content.toString(16).padStart(8, '0')}` : null;
        const sha = place.startsWith('gdrive') ? null : `sha-${content.toString(16).padStart(8, '0')}`;
        const gone = content % 97 === 0 ? 5 : null;
        try {
          ins.run(place, rel, size, content % 53 === 0 ? null : 1_600_000_000_000 + content * 86_400_000, sha, md5, gone);
        } catch {
          // The same path twice: skipped.
        }
      }
      if (i >= rows / 3) break;
    }
  })();
}

function allPages(request: SearchRequest, tuning: IndexTuning): { hits: SearchHit[]; pages: number } {
  const hits: SearchHit[] = [];
  let after: SearchRequest['after'] = null;
  let pages = 0;
  for (;;) {
    const r = indexedSearch(db, { ...request, after }, tuning);
    if (!r || r.status !== 'done') throw new Error('the index did not answer');
    hits.push(...r.hits);
    pages += 1;
    if (!r.next) return { hits, pages };
    after = r.next;
    if (pages > 500) throw new Error('paging does not end');
  }
}

function oldAll(request: SearchRequest): SearchHit[] {
  const hits: SearchHit[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = searchQuery(db, { ...request, offset });
    if (r.status !== 'done') throw new Error('old search failed');
    hits.push(...r.hits);
    if (r.hits.length < 500) return hits;
  }
}

const keysOf = (hits: SearchHit[]): string[] => hits.map((h) => h.key);

describe('the slice size', () => {
  it('starts small, at most doubles, shrinks at once to the time measured, and never passes the limit', () => {
    const sizer = new SliceSizer(400, 30);
    expect(sizer.rows).toBe(25);
    sizer.learn(25, 3);
    expect(sizer.rows).toBe(50);
    sizer.learn(50, 5);
    expect(sizer.rows).toBe(100);
    for (let i = 0; i < 6; i += 1) sizer.learn(sizer.rows, 2);
    expect(sizer.rows).toBe(400);
    // A slice that took 700 ms (an index merge) makes the next one small.
    sizer.learn(400, 700);
    expect(sizer.rows).toBe(17);
    sizer.learn(17, 0);
    expect(sizer.rows).toBeLessThanOrEqual(34);
    sizer.learn(0, 5);
    expect(sizer.rows).toBeGreaterThan(0);
  });
});

describe('merging in steps of its own', () => {
  it('a fill with automerge off and a merge step after every slice gives the same index, and the steps end', () => {
    fillCatalog(1800);
    setMergeMode(db, 'fill');
    let steps = 0;
    while (fillSlice(db, 20) > 0) {
      mergeStep(db, 8);
      steps += 1;
    }
    expect(steps).toBeGreaterThan(10);
    let more = 0;
    while (mergeStep(db, 8)) more += 1;
    expect(more).toBeLessThan(500);
    // Nothing left to merge: the next step says so.
    expect(mergeStep(db, 8)).toBe(false);
    setMergeMode(db, 'normal');
    expect(indexProgress(db)).toMatchObject({ ready: true, dirty: 0 });
    // The index is whole (this throws if it differs from the table) and finds what the plain search finds.
    db.prepare("INSERT INTO search_names (search_names) VALUES ('integrity-check')").run();
    db.prepare("INSERT INTO search_dirs (search_dirs) VALUES ('integrity-check')").run();
    const request: SearchRequest = { ...EMPTY_SEARCH, text: 'holiday' };
    expect(keysOf(allPages(request, { pageSize: 9 }).hits)).toEqual(keysOf(oldAll(request)));
  });

  it('the settings go back to the defaults', () => {
    setMergeMode(db, 'fill');
    const read = (key: string): number => db.prepare('SELECT v FROM search_names_config WHERE k = ?').pluck().get(key) as number;
    expect(read('automerge')).toBe(0);
    expect(read('crisismerge')).toBeGreaterThan(1000);
    setMergeMode(db, 'normal');
    expect(read('automerge')).toBe(4);
    expect(read('crisismerge')).toBe(16);
  });
});

describe('the index fill', () => {
  it('starts empty, fills in slices, is ready only at the end, and can be stopped between slices', () => {
    fillCatalog(900);
    expect(indexProgress(db)).toMatchObject({ ready: false, filledTo: 0 });
    expect(indexedSearch(db, { ...EMPTY_SEARCH, text: 'holiday' })).toBeNull();
    expect(fillSlice(db, 100)).toBe(100);
    const half = indexProgress(db)!;
    expect(half.ready).toBe(false);
    expect(half.percent).toBeGreaterThan(0);
    expect(half.percent).toBeLessThan(100);
    // A new row while the fill runs is simply above filled_to: nothing to do for it now.
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', 'late/arrival.txt', 5, 1, 1)").run();
    expect(db.prepare('SELECT count(*) FROM search_dirty').pluck().get()).toBe(0);
    catchUp(db, 100);
    const done = indexProgress(db)!;
    expect(done).toMatchObject({ ready: true, percent: 100, dirty: 0 });
    expect(done.filledTo).toBe(done.maxId);
    expect(db.prepare("SELECT count(*) FROM search_names WHERE search_names MATCH '\"arrival\"'").pluck().get()).toBe(1);
  });

  it('an empty catalog is ready after one slice', () => {
    expect(indexProgress(db)!.ready).toBe(false);
    fillSlice(db);
    expect(indexProgress(db)!.ready).toBe(true);
  });

  it('forgets a moved, renamed or deleted file by its old name and finds it by the new one', () => {
    fillCatalog(300);
    catchUp(db);
    const id = db.prepare("SELECT id FROM files WHERE name LIKE 'holiday_%' AND gone_at IS NULL ORDER BY id LIMIT 1").pluck().get() as number;
    const old = db.prepare('SELECT name, rel_path FROM files WHERE id = ?').get(id) as { name: string; rel_path: string };
    db.prepare("UPDATE files SET rel_path = 'Elsewhere/renamed_zebra.txt' WHERE id = ?").run(id);
    // A second move before the fill looks: the index still holds the FIRST name, and that is what must be forgotten.
    db.prepare("UPDATE files SET rel_path = 'Elsewhere/again_giraffe.txt' WHERE id = ?").run(id);
    expect(db.prepare('SELECT old_name FROM search_dirty WHERE id = ?').pluck().get(id)).toBe(old.name);
    // The index is behind: the old search answers (null here), and still finds it.
    expect(indexedSearch(db, { ...EMPTY_SEARCH, text: 'giraffe' })).toBeNull();
    expect(searchQuery(db, { ...EMPTY_SEARCH, text: 'giraffe' })).toMatchObject({ status: 'done' });
    catchUp(db);
    expect(db.prepare('SELECT count(*) FROM search_dirty').pluck().get()).toBe(0);
    const found = indexedSearch(db, { ...EMPTY_SEARCH, text: 'giraffe' });
    expect(found?.status === 'done' && found.hits.map((h) => h.name)).toEqual(['again_giraffe.txt']);
    const gone = indexedSearch(db, { ...EMPTY_SEARCH, text: old.name });
    expect(gone?.status === 'done' && gone.hits.every((h) => h.name === old.name)).toBe(true);
    expect(gone?.status === 'done' && gone.hits.some((h) => h.copies.some((c) => c.fileId === id))).toBe(false);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    catchUp(db);
    expect(db.prepare("SELECT count(*) FROM search_names WHERE search_names MATCH '\"giraffe\"'").pluck().get()).toBe(0);
    expect(db.prepare("INSERT INTO search_names (search_names) VALUES ('integrity-check')").run()).toBeDefined();
  });

  it('finds a file the fill has not reached yet (the rows above filled_to are read from the table)', () => {
    fillCatalog(300);
    catchUp(db);
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', 'New/just_added_walrus.txt', 5, 1, 1)").run();
    const r = indexedSearch(db, { ...EMPTY_SEARCH, text: 'walrus' });
    expect(r?.status === 'done' && r.hits.map((h) => h.name)).toEqual(['just_added_walrus.txt']);
    const c = indexedSearch(db, { ...EMPTY_SEARCH, text: 'walrus', part: 'counts' });
    expect(c).toMatchObject({ status: 'counts', total: 1 });
  });
});

describe('the indexed search gives the old search\'s answers', () => {
  const requests: [string, Partial<SearchRequest>][] = [
    ['one word', { text: 'holiday' }],
    ['a part of a name', { text: 'olida' }],
    ['two words', { text: 'report jpg' }],
    ['upper case', { text: 'HOLIDAY' }],
    ['letters with accents', { text: 'résu' }],
    ['unicode name', { text: 'ünï' }],
    ['a word of two letters and one of four', { text: 'jp draft' }],
    ['names and folders', { text: 'holiday', includeFolders: true }],
    ['a folder word', { text: 'invoice', folder: 'documents' }],
    ['a folder path', { text: 'photo', folder: 'Pictures/2024' }],
    ['in one place', { text: 'scan', placeIds: ['drive-t7'] }],
    ['only one place holds it', { text: 'notes', onlyOnePlace: true }],
    ['at most two places', { text: 'notes', fewCopies: true }],
    ['a size range', { text: 'report', minSize: 5000, maxSize: 15000 }],
    ['a date range', { text: 'final', fromDate: 1_600_000_000_000 + 100 * 86_400_000, toDate: 1_600_000_000_000 + 400 * 86_400_000 }],
    ['an extension', { text: 'budget', extensions: ['pdf'] }],
    ['not on Seagate', { text: 'holiday', notInPlaceIds: ['drive-sg'] }],
    ['not on Google or Seagate', { text: 'draft', notInPlaceIds: ['gdrive-1', 'drive-sg'] }],
    ['a folder only', { folder: 'tax returns' }],
  ];

  for (const [label, partial] of requests) {
    it(label, () => {
      fillCatalog(1800);
      catchUp(db);
      const request: SearchRequest = { ...EMPTY_SEARCH, ...partial };
      const expected = oldAll(request);
      // Small set grouped whole, and the same set walked (smallSet 0 forces the bit set), in pages of 7.
      for (const tuning of [{ pageSize: 7, smallSet: 1_000_000 }, { pageSize: 7, smallSet: 0 }]) {
        const got = allPages(request, tuning);
        expect(keysOf(got.hits).toSorted()).toEqual(keysOf(expected).toSorted());
        // Name order is the same order; for the other sorts the ties are broken differently, so the SET is compared above and the ORDER below.
        expect(keysOf(got.hits)).toEqual(keysOf(expected));
        expect(new Set(keysOf(got.hits)).size).toBe(got.hits.length);
      }
    });
  }

  it('counts agree', () => {
    fillCatalog(1800);
    catchUp(db);
    for (const partial of [{ text: 'holiday' }, { text: 'report', notInPlaceIds: ['drive-sg'] }, { text: 'photo', folder: 'pictures' }]) {
      const request: SearchRequest = { ...EMPTY_SEARCH, ...partial, part: 'counts' };
      const a = indexedSearch(db, request, { smallSet: 0 });
      const b = searchQuery(db, request);
      expect(a).toMatchObject({ status: 'counts' });
      expect(a?.status === 'counts' && a.total).toBe(b.status === 'counts' && b.total);
      expect(a?.status === 'counts' && a.facets).toEqual(b.status === 'counts' && b.facets);
    }
  });

  for (const sort of ['size', 'date', 'copies'] as const) {
    for (const sortDir of ['asc', 'desc'] as const) {
      it(`pages by cursor in the order of the sort: ${sort} ${sortDir}, small and big sets`, () => {
        fillCatalog(1800);
        catchUp(db);
        const request: SearchRequest = { ...EMPTY_SEARCH, text: 'report', sort, sortDir };
        const expected = oldAll(request);
        for (const smallSet of [1_000_000, 0]) {
          const got = allPages(request, { pageSize: 5, smallSet });
          expect(keysOf(got.hits).toSorted()).toEqual(keysOf(expected).toSorted());
          expect(new Set(keysOf(got.hits)).size).toBe(got.hits.length);
          const value = (h: SearchHit): number | null => (sort === 'size' ? h.size : sort === 'date' ? h.mtime : h.places);
          const values = got.hits.map(value);
          const dated = values.filter((v): v is number => v !== null);
          const sorted = dated.toSorted((x, y) => (sortDir === 'asc' ? x - y : y - x));
          expect(dated).toEqual(sorted);
          // Files with no date are last, whatever the direction.
          if (sort === 'date') expect(values.findIndex((v) => v === null)).toBeGreaterThanOrEqual(values.length - values.filter((v) => v === null).length);
        }
      });
    }
  }

  it('the sort by copies puts the contents held in one place first, whatever else is set', () => {
    fillCatalog(1800);
    catchUp(db);
    for (const partial of [{}, { onlyOnePlace: true }, { notInPlaceIds: ['drive-sg'] }, { placeIds: ['laptop-1'] }]) {
      const request: SearchRequest = { ...EMPTY_SEARCH, text: 'report', sort: 'copies', ...partial };
      const expected = oldAll(request);
      for (const smallSet of [1_000_000, 0]) {
        const got = allPages(request, { pageSize: 4, smallSet });
        expect(keysOf(got.hits).toSorted()).toEqual(keysOf(expected).toSorted());
        const places = got.hits.map((h) => h.places);
        expect(places).toEqual(places.toSorted((a, b) => a - b));
      }
    }
  });

  it('shows files that are gone, and only them, when asked', () => {
    fillCatalog(1800);
    catchUp(db);
    const request: SearchRequest = { ...EMPTY_SEARCH, text: 'holiday', gone: true };
    const got = allPages(request, { pageSize: 4 });
    expect(got.hits.length).toBeGreaterThan(0);
    expect(keysOf(got.hits).toSorted()).toEqual(keysOf(oldAll(request)).toSorted());
    const live = allPages({ ...request, gone: false }, { pageSize: 50 });
    expect(live.hits.some((h) => got.hits.some((g) => g.key === h.key && g.copies[0]?.fileId === h.copies[0]?.fileId))).toBe(false);
  });

  it('leaves what the index cannot do to the old search', () => {
    fillCatalog(300);
    catchUp(db);
    // No word of three letters and no folder: nothing for the index to look up.
    expect(candidatesFor(db, { ...EMPTY_SEARCH, text: 'ab' }).kind).toBe('off');
    expect(candidatesFor(db, { ...EMPTY_SEARCH }).kind).toBe('off');
    // Characters that mean something in the index's own query language are plain letters here.
    expect(indexedSearch(db, { ...EMPTY_SEARCH, text: 'AND OR "' })?.status ?? 'null').not.toBe('failed');
    expect(indexedSearch(db, { ...EMPTY_SEARCH, text: 'zzzznothing' })).toMatchObject({ status: 'done', hits: [], total: 0, next: null });
  });
});
