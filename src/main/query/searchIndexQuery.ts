import {
  effectiveSortDir,
  FACETS_MAX_CONTENTS,
  folderWords,
  INDEX_PAGE_SIZE,
  searchWords,
  type SearchCursor,
  type SearchRequest,
  type SearchResponse,
  type SearchSort,
  type SortDirection,
} from '../../shared/search';
import type { Db } from '../db/connection';
import {
  countsOf,
  KEY_SQL,
  kindsComplete,
  notHeldSql,
  placeLimit,
  placesSql,
  registerFunctions,
  scopeOf,
  toHit,
  whereOf,
  yearsOf,
  type CandidateSet,
  type PageRow,
} from './searchQuery';
import { indexProgress } from './searchIndexFill';

/**
 * Search through the index (R3.1). Same answers as searchQuery.ts (one result per content, the copies listed under it), reached another way:
 *
 * 1. The typed words go to the index (search_names: any 3 letters of a name; search_dirs: the words of the path) and come back as the set of
 *    file ids that can match. Rows the fill has not reached yet (a listing just added them) are read straight from the table.
 * 2. A small set (up to SMALL_SET rows) is grouped and sorted whole, reading only those rows. A big set ("jpg", "2023") is WALKED in the
 *    order of the sort (the name, date or size index), testing each row against the set, so the first page costs a few hundred rows, not all.
 * 3. Paging is by cursor (the sort value and id of the last row), never by offset: page 40 costs what page 1 does.
 *
 * The index may be behind (the first fill still runs, or a move is not applied yet): then `candidatesFor` says 'off' and the old search answers.
 * Order: the sort value, then (for size) the name, then the file id, all in the direction of the sort; rows with no date come last.
 */

/** Up to this many candidate rows the set is grouped whole; above it the walk is used. */
export const SMALL_SET = 20_000;
/** More rows than this above the fill (a big listing just wrote them): the old search answers until the fill has caught up. */
export const TAIL_MAX = 100_000;
/** The most rows a word's folder matches may have to be listed for the walk (a longer list costs more to read than testing the paths does). */
export const PATH_IDS_MAX = 150_000;
/** For the counts, a list of ids is made from the index up to this many rows (reading rows by id is steadier than scanning the whole table). */
export const COUNTS_IDS_MAX = 600_000;

export interface IndexTuning {
  smallSet?: number;
  pageSize?: number;
  facetLimit?: number;
  kinds?: boolean;
}

type Candidates = { kind: 'off' } | { kind: 'none' } | { kind: 'set'; cand: CandidateSet | null };

const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** A typed word as a query on the path words: its letters and digits as words, the last one a prefix ("pictu" finds Pictures). Null: no letters or digits. */
export function dirsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${quote(t)} *` : quote(t))).join(' AND ');
}

const NAMES_SQL = 'SELECT rowid FROM search_names WHERE search_names MATCH ?';
const DIRS_SQL = 'SELECT rowid FROM search_dirs WHERE search_dirs MATCH ?';
const COUNT_NAMES_SQL = 'SELECT count(*) FROM (SELECT 1 FROM search_names WHERE search_names MATCH ? LIMIT ?)';
const COUNT_DIRS_SQL = 'SELECT count(*) FROM (SELECT 1 FROM search_dirs WHERE search_dirs MATCH ? LIMIT ?)';

function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** One thing to look up in the index: a typed word in the names (and, when folders count too, in the path words), or a folder word. */
interface Term {
  /** The word as typed (for the plain test on the rows the index has not seen). */
  word: string;
  /** Where the word is looked up, as [sql, query] pairs. */
  lookups: { sql: string; countSql: string; query: string }[];
  /** True for a folder word: the plain test is on the folder part of the path. */
  folder: boolean;
}

function termsOf(request: SearchRequest): Term[] {
  const terms: Term[] = [];
  for (const word of searchWords(request.text)) {
    if (codePoints(word) < 3) continue;
    const lookups = [{ sql: NAMES_SQL, countSql: COUNT_NAMES_SQL, query: quote(word) }];
    const dq = request.includeFolders ? dirsQuery(word) : null;
    if (dq) lookups.push({ sql: DIRS_SQL, countSql: COUNT_DIRS_SQL, query: dq });
    terms.push({ word, lookups, folder: false });
  }
  for (const word of folderWords(request.folder)) {
    const dq = dirsQuery(word);
    if (dq) terms.push({ word, lookups: [{ sql: DIRS_SQL, countSql: COUNT_DIRS_SQL, query: dq }], folder: true });
  }
  return terms;
}

/** The ids of a term, or null when it has more than `cap` (a common word: not worth listing). */
function idsOf(db: Db, term: Term, cap: number): Set<number> | null {
  const ids = new Set<number>();
  for (const look of term.lookups) {
    let n = 0;
    for (const id of db.prepare(look.sql).pluck().iterate(look.query) as IterableIterator<number>) {
      ids.add(id);
      n += 1;
      if (n > cap) return null;
    }
  }
  return ids;
}

/** The number of ids of a term, counted up to `cap` (the count stops there, so a common word costs no more than a rare one). */
function countOf(db: Db, term: Term, cap: number): number {
  return term.lookups.reduce((sum, look) => sum + (db.prepare(look.countSql).pluck().get(look.query, cap) as number), 0);
}

/**
 * What the index says about the typed words and the folder, as ids that can match (the rows are still tested by the typed words).
 * - 'off': this request cannot use the index (no word of 3 letters or more and no folder word, or the first fill is not over).
 * - 'none': the index says nothing matches.
 * - 'set' with a candidate set: the rarest term has few ids (up to `smallSet`), and only those rows are read.
 * - 'set' with no candidate set: every term is common ("jpg", "2023"); the rows are walked in the order of the sort and tested (a page needs
 *   a few hundred rows). For the counts (`purpose` 'counts') the rarest term is listed when it has up to COUNTS_IDS_MAX ids.
 */
export function candidatesFor(db: Db, request: SearchRequest, smallSet: number = SMALL_SET, purpose: 'page' | 'counts' = 'page'): Candidates {
  const progress = indexProgress(db);
  if (!progress || !progress.ready) return { kind: 'off' };
  const terms = termsOf(request);
  if (terms.length === 0) return { kind: 'off' };

  let best: { term: Term; ids: Set<number> } | null = null;
  for (const term of terms) {
    const ids = idsOf(db, term, Math.min(smallSet, best ? best.ids.size : smallSet));
    if (ids && (!best || ids.size < best.ids.size)) best = { term, ids };
  }
  if (!best && purpose === 'counts') {
    // Every term is common: list the rarest one in full when that is not too many (counts read rows by id).
    const sized = terms.map((term) => ({ term, n: countOf(db, term, COUNTS_IDS_MAX + 1) })).toSorted((a, b) => a.n - b.n)[0]!;
    if (sized.n <= COUNTS_IDS_MAX) {
      const ids = idsOf(db, sized.term, COUNTS_IDS_MAX);
      if (ids) best = { term: sized.term, ids };
    }
  }
  if (!best) {
    // No short list. Words that are also looked up in the folders get their (short) list of folder matches, so the rows walked are tested on the name.
    const pathIds = new Map<string, string>();
    if (request.includeFolders && purpose === 'page') {
      for (const term of terms) {
        const look = term.lookups[1];
        if (term.folder || !look) continue;
        const ids = idsOf(db, { ...term, lookups: [look] }, Math.max(smallSet, PATH_IDS_MAX));
        if (ids) pathIds.set(term.word, JSON.stringify([...ids]));
      }
    }
    return { kind: 'set', cand: pathIds.size > 0 ? { kind: 'words', pathIds } : null };
  }
  // A list made from the index is only right while the index is up to date with the rows it was made from.
  if (progress.dirty > 0 || progress.maxId - progress.filledTo > TAIL_MAX) return { kind: 'off' };
  const ids = best.ids;
  if (progress.maxId > progress.filledTo) {
    // The rows the fill has not reached: read from the table, by the plain test of the word the list is made from.
    const column = best.term.folder ? 'substr(rel_path, 1, length(rel_path) - length(name))' : request.includeFolders ? 'rel_path' : 'name';
    const rows = db.prepare(`SELECT id FROM files WHERE id > ? AND instr(bh_lower(${column}), ?) > 0`).pluck().iterate(progress.filledTo, best.term.word) as IterableIterator<number>;
    for (const id of rows) ids.add(id);
  }
  if (ids.size === 0) return { kind: 'none' };
  return { kind: 'set', cand: { kind: 'ids', json: JSON.stringify([...ids]), count: ids.size } };
}

type PageSort = 'name' | 'size' | 'date' | 'copies';

/** The ORDER BY of the indexed search: every part runs the way the sort does, the file id last; rows with no date are last. */
function orderOf(sort: PageSort, dir: SortDirection, c: { name: string; size: string; mtime: string; places: string; id: string }, datedOnly = false): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  switch (sort) {
    case 'name':
      return `${c.name} COLLATE NOCASE ${d}, ${c.id} ${d}`;
    case 'size':
      return `${c.size} ${d}, ${c.name} ${d}, ${c.id} ${d}`;
    case 'date':
      // (The walk reads only dated rows; a leading `IS NULL` would stop SQLite from using the date index for the order.)
      return datedOnly ? `${c.mtime} ${d}, ${c.id} ${d}` : `${c.mtime} IS NULL, ${c.mtime} ${d}, ${c.id} ${d}`;
    case 'copies':
    default:
      return `${c.places} ${d}, ${c.id} ${d}`;
  }
}

/** "Rows after the cursor" in the order of orderOf, as SQL over the same columns, with its parameters. */
function afterSql(sort: PageSort, dir: SortDirection, cursor: SearchCursor, c: { name: string; size: string; mtime: string; places: string; id: string }): { sql: string; params: (string | number)[] } {
  const op = dir === 'asc' ? '>' : '<';
  const v = cursor.v;
  switch (sort) {
    case 'name':
      return { sql: `(${c.name} COLLATE NOCASE ${op} ? OR (${c.name} COLLATE NOCASE = ? AND ${c.id} ${op} ?))`, params: [String(v ?? ''), String(v ?? ''), cursor.id] };
    case 'size': {
      const n = cursor.n ?? '';
      return {
        sql: `(${c.size} ${op} ? OR (${c.size} = ? AND (${c.name} ${op} ? OR (${c.name} = ? AND ${c.id} ${op} ?))))`,
        params: [Number(v ?? 0), Number(v ?? 0), n, n, cursor.id],
      };
    }
    case 'date':
      // Rows with no date come after every dated row, ordered by id.
      if (v === null) return { sql: `(${c.mtime} IS NULL AND ${c.id} ${op} ?)`, params: [cursor.id] };
      return { sql: `(${c.mtime} IS NULL OR ${c.mtime} ${op} ? OR (${c.mtime} = ? AND ${c.id} ${op} ?))`, params: [Number(v), Number(v), cursor.id] };
    case 'copies':
    default:
      return { sql: `(${c.places} ${op} ? OR (${c.places} = ? AND ${c.id} ${op} ?))`, params: [Number(v ?? 0), Number(v ?? 0), cursor.id] };
  }
}

interface CursorRow extends PageRow {
  name: string;
  mtime: number | null;
  places?: number;
}

function cursorOf(sort: PageSort, row: CursorRow): SearchCursor {
  const v = sort === 'name' ? row.name : sort === 'size' ? row.size : sort === 'date' ? row.mtime : (row.places ?? 0);
  return { v, id: row.id, n: row.name };
}

interface Found {
  rows: CursorRow[];
  total: number | null;
  next: SearchCursor | null;
}

/** A small candidate set (or any set when the walk cannot serve the sort): group every matching row by content, then cut the page after the cursor. */
function groupPage(db: Db, request: SearchRequest, cand: CandidateSet | undefined, useKinds: boolean, pageSize: number): Found {
  const { where, params } = whereOf(request, null, useKinds, scopeOf(db, request), cand);
  const sort: PageSort = request.sort ?? 'name';
  const dir = effectiveSortDir(request);
  const limit = placeLimit(request);
  const notIn = request.notInPlaceIds;
  const needPlaces = limit !== null || sort === 'copies';
  const needHeld = notIn.length > 0;
  const from = needPlaces || needHeld ? 'h' : 'g';
  const conds = [...(limit !== null ? [`places <= ${limit}`] : []), ...(needHeld ? ['not_held = 1'] : [])];
  const columns = { name: 'name', size: 'size', mtime: 'mtime', places: 'places', id: 'id' };
  const after = request.after ? afterSql(sort, dir, request.after, columns) : null;
  const rowConds = [...conds, ...(after ? [after.sql] : [])];
  const sql = `
    WITH g AS MATERIALIZED (
      SELECT ${KEY_SQL} AS k, min(f.id) AS id, f.name AS name, f.size AS size, f.mtime AS mtime, f.md5 AS md5, f.sha256 AS sha256, f.place_id AS place_id
        FROM files f WHERE ${where} GROUP BY k
    )${needPlaces || needHeld ? `, h AS MATERIALIZED (SELECT g.*${needPlaces ? `, ${placesSql('g')} AS places` : ''}${needHeld ? `, ${notHeldSql('g', notIn)} AS not_held` : ''} FROM g)` : ''}
    SELECT k, id, md5, size, sha256, name, mtime${needPlaces ? ', places' : ''}, (SELECT count(*) FROM ${from} ${conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''}) AS total
      FROM ${from} ${rowConds.length > 0 ? `WHERE ${rowConds.join(' AND ')}` : ''}
     ORDER BY ${orderOf(sort, dir, columns)}
     LIMIT ${pageSize + 1}`;
  const rows = db.prepare(sql).all(...params, ...(after?.params ?? [])) as CursorRow[];
  const more = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  return { rows: page, total: rows[0]?.total ?? null, next: more ? cursorOf(sort, page[page.length - 1]!) : null };
}

const KEY_O = KEY_SQL.replaceAll('f.', 'o.');

/**
 * The row shown for a content is its matching row with the smallest id: a row is skipped when another matching row of the same content has a
 * smaller id. `where` is the search's condition on the rows `f`; the row tested is `o`. The condition appears twice (its parameters twice).
 */
function representativeSql(where: string): string {
  return `CASE
      WHEN o.size = 0 THEN 1
      WHEN o.md5 IS NOT NULL AND o.size IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM files f INDEXED BY idx_files_md5_size WHERE ${where} AND f.md5 = o.md5 AND f.size = o.size AND f.id < o.id)
      WHEN o.sha256 IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM files f INDEXED BY idx_files_sha256_live WHERE ${where} AND f.sha256 = o.sha256 AND NOT (f.md5 IS NOT NULL AND f.size IS NOT NULL) AND f.id < o.id)
      ELSE 1
    END`;
}

/**
 * The sort by copies, fewest first, without grouping everything: the contents held in ONE place come first (every content is held in at
 * least one), in the order of their file ids, so the page is the first rows (by id) that are the shown row of their content and sit in one
 * place. Null when this cannot give the page (the other direction, a page that is past the one-place contents, or too few of them to fill
 * it): the caller groups instead, which gives the same order.
 */
function copiesPage(db: Db, request: SearchRequest, cand: CandidateSet | undefined, useKinds: boolean, pageSize: number): Found | null {
  if (effectiveSortDir(request) !== 'asc' || request.gone) return null;
  const cursor = request.after;
  if (cursor !== null && Number(cursor.v) !== 1) return null;
  const notIn = request.notInPlaceIds;
  const wo = whereOf(request, null, useKinds, scopeOf(db, request, 'o'), cand, 'o');
  const wf = whereOf(request, null, useKinds, scopeOf(db, request, 'f'), cand, 'f');
  const rows = db
    .prepare(
      `SELECT ${KEY_O} AS k, o.id AS id, o.md5 AS md5, o.size AS size, o.sha256 AS sha256, o.name AS name, o.mtime AS mtime
         FROM files o
        WHERE ${cursor ? 'o.id > ? AND ' : ''}${wo.where} ${notIn.length > 0 ? `AND (${notHeldSql('o', notIn)})` : ''}
          AND (${placesSql('o')}) = 1 AND ${representativeSql(wf.where)}
        ORDER BY o.id LIMIT ${pageSize + 1}`,
    )
    .all(...(cursor ? [cursor.id] : []), ...wo.params, ...wf.params, ...wf.params) as CursorRow[];
  const more = rows.length > pageSize;
  // Fewer than a page: with the one-place limit that is everything, else the rest is in the contents held in more places.
  if (!more && placeLimit(request) !== 1) return null;
  const page = rows.slice(0, pageSize);
  for (const row of page) row.places = 1;
  return { rows: page, total: null, next: more ? cursorOf('copies', page[page.length - 1]!) : null };
}

/** No list of ids (a common word) sorted by name, size or date: read the rows in the order of the sort and keep the ones that match. */
function walkPage(db: Db, request: SearchRequest, cand: CandidateSet | undefined, useKinds: boolean, pageSize: number): Found {
  const sort = (request.sort ?? 'name') as 'name' | 'size' | 'date';
  const dir = effectiveSortDir(request);
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const col = sort === 'date' ? 'mtime' : sort === 'size' ? 'size' : 'name';
  const index = sort === 'date' ? 'idx_files_mtime' : sort === 'size' ? 'idx_files_size_name' : 'idx_files_name_nocase';
  const limit = placeLimit(request);
  const notIn = request.notInPlaceIds;
  const wo = whereOf(request, null, useKinds, scopeOf(db, request, 'o'), cand, 'o');
  const wf = whereOf(request, null, useKinds, scopeOf(db, request, 'f'), cand, 'f');
  const representative = representativeSql(wf.where);
  const columns = { name: 'o.name', size: 'o.size', mtime: 'o.mtime', places: 'places', id: 'o.id' };
  const content = [...(limit !== null ? [`(${placesSql('o')}) <= ${limit}`] : []), ...(notIn.length > 0 ? [`(${notHeldSql('o', notIn)})`] : [])];

  const run = (extra: { sql: string; params: (string | number)[] }, order: string, room: number): CursorRow[] =>
    db
      .prepare(
        `SELECT ${KEY_O} AS k, o.id AS id, o.md5 AS md5, o.size AS size, o.sha256 AS sha256, o.name AS name, o.mtime AS mtime
           FROM files o INDEXED BY ${index}
          WHERE ${extra.sql} AND ${wo.where} ${content.map((c) => `AND ${c}`).join(' ')} AND ${representative}
          ORDER BY ${order} LIMIT ${room}`,
      )
      .all(...extra.params, ...wo.params, ...wf.params, ...wf.params) as CursorRow[];

  const cursor = request.after;
  const rows: CursorRow[] = [];
  const room = pageSize + 1;
  // Dated rows first. A cursor with no date means the dated rows are already shown.
  if (!(sort === 'date' && cursor !== null && cursor.v === null)) {
    const after = cursor ? afterSql(sort, dir, cursor, columns) : null;
    const guard = `o.${col} IS NOT NULL`;
    // The first condition lets SQLite start at the cursor in the index instead of at the top.
    const seek = cursor && cursor.v !== null ? ` AND o.${col}${sort === 'name' ? ' COLLATE NOCASE' : ''} ${dir === 'asc' ? '>=' : '<='} ?` : '';
    rows.push(
      ...run(
        { sql: `${guard}${seek}${after ? ` AND ${after.sql}` : ''}`, params: [...(seek ? [cursor!.v as string | number] : []), ...(after?.params ?? [])] },
        orderOf(sort, dir, columns, true),
        room,
      ),
    );
  }
  // Then, for the date sort, the files with no date (ordered by id).
  if (sort === 'date' && rows.length < room) {
    const afterId = cursor !== null && cursor.v === null ? cursor.id : null;
    rows.push(
      ...run(
        { sql: `o.mtime IS NULL${afterId !== null ? ` AND o.id ${dir === 'asc' ? '>' : '<'} ?` : ''}`, params: afterId !== null ? [afterId] : [] },
        `o.id ${d}`,
        room - rows.length,
      ),
    );
  }
  const more = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  return { rows: page, total: null, next: more ? cursorOf(sort, page[page.length - 1]!) : null };
}

/**
 * The answer through the index, or null when the index cannot answer this request now (the caller then asks the old search).
 */
export function indexedSearch(db: Db, request: SearchRequest, tuning: IndexTuning = {}): SearchResponse | null {
  const started = Date.now();
  try {
    registerFunctions(db);
    // The counts, the sort by copies and the files that are gone are not walked in index order: they read a list of rows, so they list a common word's rows in full.
    const listed = request.part === 'counts' || request.sort === 'copies' || request.gone;
    const found = candidatesFor(db, request, tuning.smallSet, listed ? 'counts' : 'page');
    if (found.kind === 'off') return null;
    if (found.kind === 'none') {
      return request.part === 'counts'
        ? { status: 'counts', facets: { categories: {}, places: {} }, years: yearsOf(db), total: 0, ms: Date.now() - started }
        : { status: 'done', hits: [], total: 0, ms: Date.now() - started, offset: 0, next: null, indexed: true };
    }
    const useKinds = tuning.kinds ?? kindsComplete(db);
    if (request.part === 'counts') {
      const counted = countsOf(db, request, tuning.facetLimit ?? FACETS_MAX_CONTENTS, useKinds, found.cand ?? undefined);
      return { status: 'counts', facets: counted.facets, years: yearsOf(db), total: counted.total, ms: Date.now() - started };
    }
    const pageSize = tuning.pageSize ?? INDEX_PAGE_SIZE;
    const sort: SearchSort = request.sort ?? 'name';
    // A short list is grouped whole; with no list (a common word) the rows are walked in the order of the sort.
    const walk = (found.cand === null || found.cand.kind === 'words') && sort !== 'copies' && !request.gone;
    const page = walk
      ? walkPage(db, request, found.cand ?? undefined, useKinds, pageSize)
      : ((sort === 'copies' ? copiesPage(db, request, found.cand ?? undefined, useKinds, pageSize) : null) ?? groupPage(db, request, found.cand ?? undefined, useKinds, pageSize));
    const hits = page.rows.map((row) => toHit(db, row));
    return { status: 'done', hits, total: page.total, ms: Date.now() - started, offset: 0, next: page.next, indexed: true };
  } catch {
    // Anything unexpected (a word the index cannot parse): the old search answers; it never depends on the index.
    return null;
  }
}
