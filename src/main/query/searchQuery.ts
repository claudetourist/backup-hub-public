import { categoryOf, type SearchCategory } from '../../shared/fileCategories';
import { categoryOfKind, FILE_KINDS, isFileKind, kindOf, kindsOfCategory, type FileKind } from '../../shared/fileKinds';
import {
  effectiveSortDir,
  FACETS_MAX_CONTENTS,
  folderOf,
  folderWords,
  MAX_COPIES_LISTED,
  MAX_SEARCH_RESULTS,
  searchWords,
  type SearchCopy,
  type SearchFacets,
  type SearchFingerprint,
  type SearchHit,
  type SearchPlaceCount,
  type SearchRequest,
  type SearchResponse,
  type SearchSort,
  type SortDirection,
} from '../../shared/search';
import type { Db } from '../db/connection';
import { personRanges, personWhere } from './personScope';

/**
 * Search, read only. Runs in the query worker on its own read-only connection (or, for tests and
 * when no worker can start, on any connection).
 *
 * One result per CONTENT. The key of a row is its md5 + size when it has both (every fingerprinted
 * local file has them next to its sha256, and a Google Drive row has nothing else), else its
 * sha256, else the row itself ("not fingerprinted"). For real files md5 + size and sha256 name
 * the same content, so a laptop file, its T7 copy and its Drive copy are ONE result; the md5 key is
 * used first because it joins Drive rows to local rows without a lookup per row (that lookup made
 * a common word over 700k rows take 15 s; this takes about 2 s). Copies = distinct places holding
 * the content, the rules of the copies index (src/main/copies/copiesIndex.ts): two copies in one
 * place count once, rows marked gone never count.
 *
 * The match is a plain substring (instr) on the lower-cased name, so no index can serve it; the
 * scan reads the live rows once.
 *
 * Two ways to the first page, giving the SAME rows in the SAME order:
 * - grouping: every matching row is grouped by content key (the representative of a content is its row with the
 *   smallest id), the groups are ordered, the first page is cut. Reads all matching rows.
 * - walking (sorts by name, date or size): rows are read in index order (idx_files_name_nocase / idx_files_mtime / idx_files_size_name) and the
 *   contents met first are looked up (their representative row, wherever it is). The first page is certain once the
 *   page's last content is strictly ahead of the place the walk reached, because every content not yet met has all
 *   its rows behind that place. When that cannot be shown within a row budget, grouping answers instead.
 *
 * Type filters read the stored `files.kind` (src/shared/fileKinds.ts) while no live row lacks one, else the type is
 * worked out per row as before; both give the same results.
 */

export interface PageRow {
  k: string;
  id: number;
  md5: string | null;
  size: number | null;
  sha256: string | null;
  total: number | null;
}

interface FileRow {
  name: string;
  rel_path: string;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  md5: string | null;
  mime: string | null;
  kind: string | null;
}

interface CopyRow {
  id: number;
  place_id: string;
  label: string;
  kind: string;
  last_looked_at: number | null;
  rel_path: string;
  size: number | null;
  mtime: number | null;
  cloud_only: number;
  has_link: number;
  has_sha: number;
  is_verified: number;
}

/** 1 Jan 2100: a file date past it is a broken clock, not a year to offer. */
const YEAR_2100_MS = 4_102_444_800_000;

/**
 * The walk reads this many rows per row of the page the first time (about 3 rows per content when every row matches),
 * then this many times more, up to WALK_ATTEMPTS times. A walk that finds too few matches gives up at once.
 */
const WALK_ROWS_PER_RESULT = 4;
const WALK_RETRY_FACTOR = 4;
const WALK_ATTEMPTS = 3;

/** Knobs for tests and the benchmark; the app uses the defaults. */
export interface SearchTuning {
  /** The most contents a search may find and still get its counts. */
  facetLimit?: number;
  /** Results per page (the app always uses MAX_SEARCH_RESULTS). */
  pageSize?: number;
  /** False = always group. */
  walk?: boolean;
  /** Rows read by the first walk (default: 4 per result). */
  walkRows?: number;
  /** True/false forces the stored kind / the per-row type; undefined looks at the catalog. */
  kinds?: boolean;
}

const registered = new WeakSet<object>();

/** User functions the SQL below calls. Registered once per connection; they only compute, they never touch data. */
export function registerFunctions(db: Db): void {
  if (registered.has(db)) return;
  registered.add(db);
  db.function('bh_kind', { deterministic: true }, (relPath: unknown, name: unknown, mime: unknown, size: unknown) =>
    kindOf(typeof relPath === 'string' ? relPath : '', typeof name === 'string' ? name : '', typeof mime === 'string' ? mime : null, typeof size === 'number' ? size : null),
  );
  db.function('bh_cat', { deterministic: true }, (name: unknown, mime: unknown) =>
    categoryOf(typeof name === 'string' ? name : '', typeof mime === 'string' ? mime : null),
  );
  // SQLite's own lower() only folds ASCII; words with other letters use this one.
  db.function('bh_lower', { deterministic: true }, (text: unknown) => (typeof text === 'string' ? text.toLowerCase() : ''));
}

/**
 * True when every live row has its kind, so the type filter can read `files.kind`. One look at the small index of unsorted
 * rows. INDEXED BY is required: with `gone_at IS NULL` in the query SQLite picked idx_files_mtime and read all 670k index
 * entries to find nothing (0.7 to 0.9 s on EVERY search, page and counts alike, once all rows were sorted).
 */
export const KINDS_COMPLETE_SQL = 'SELECT 1 FROM files INDEXED BY idx_files_unclassified WHERE kind IS NULL AND gone_at IS NULL LIMIT 1';

export function kindsComplete(db: Db): boolean {
  try {
    return db.prepare(KINDS_COMPLETE_SQL).get() === undefined;
  } catch {
    return false;
  }
}

function isAscii(word: string): boolean {
  for (let i = 0; i < word.length; i += 1) if (word.charCodeAt(i) > 127) return false;
  return true;
}

/** The content key of a row: 'm<md5>|<size>', else 's<sha256>', else 'r<file id>'. */
export const KEY_SQL = `CASE
    WHEN f.size = 0 THEN 'r' || f.id
    WHEN f.md5 IS NOT NULL AND f.size IS NOT NULL THEN 'm' || f.md5 || '|' || f.size
    WHEN f.sha256 IS NOT NULL THEN 's' || f.sha256
    ELSE 'r' || f.id
  END`;

/** Number of distinct places holding the content of the row `a` (a representative row: its own key decides which hashes count). */
export function placesSql(a: string): string {
  return `CASE
    WHEN ${a}.size = 0 THEN 1
    WHEN ${a}.md5 IS NOT NULL AND ${a}.size IS NOT NULL THEN (SELECT count(DISTINCT place_id) FROM files WHERE md5 = ${a}.md5 AND size = ${a}.size AND gone_at IS NULL)
    WHEN ${a}.sha256 IS NOT NULL THEN (SELECT count(DISTINCT place_id) FROM files WHERE sha256 = ${a}.sha256 AND gone_at IS NULL)
    ELSE 1
  END`;
}

/** The most places a content may sit in to be listed: 1 = only here, 2 = "few copies", null = no limit. */
export function placeLimit(request: Pick<SearchRequest, 'fewCopies' | 'onlyOnePlace'>): number | null {
  return request.onlyOnePlace ? 1 : request.fewCopies ? 2 : null;
}

/** The type of a row as SQL, from the stored kind (only used while every live row has one). */
const KIND_CATEGORY_SQL = `CASE f.kind ${FILE_KINDS.map((k) => `WHEN '${k}' THEN '${categoryOfKind(k)}'`).join(' ')} END`;

/** The ORDER BY of the page. Rows with no value (size, date) are last in both directions; the tail makes the order total, so pages never overlap. */
export function orderSql(sort: SearchSort, dir: SortDirection): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const orders: Record<SearchSort, string> = {
    name: `name COLLATE NOCASE ${d}, id`,
    size: `size IS NULL, size ${d}, name COLLATE NOCASE, id`,
    date: `mtime IS NULL, mtime ${d}, name COLLATE NOCASE, id`,
    copies: `places ${d}, size IS NULL, size DESC, name COLLATE NOCASE, id`,
  };
  return orders[sort];
}

/** Which filter a facet leaves out, so its chips can show what the other choice would give. */
export type Skip = 'category' | 'place' | null;

/**
 * What the search index settled before the query runs (searchIndexQuery.ts): the ids of the rows that can match the typed words and the
 * folder (never fewer than the real matches). The condition tests one row against the list; every typed word is still tested on the row.
 */
export type CandidateSet =
  | {
      kind: 'ids';
      /** The JSON array of file ids (one parameter). */
      json: string;
      count: number;
    }
  | {
      /**
       * No list of rows (a common word), but for some typed words the (few) rows whose folders hold the word: a row matches such a word when
       * its NAME has it (read from the name index, no row fetch) or its id is in that word's list. Folder words are matched by whole path
       * words, the first letters of the last one ("pict" finds Pictures).
       */
      kind: 'words';
      pathIds: ReadonlyMap<string, string>;
    };

/** A list of place ids as SQL text: quotes doubled, so a value can never end the text. Ids come from the window (checked) and the database. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',');
}

/**
 * The WHERE of a search over `files <alias>` (default f), with its parameters. Every value goes in as a parameter, never into the text.
 * With a candidate set the typed words are not tested row by row (the index did it), except words it could not settle.
 */
export function whereOf(
  request: SearchRequest,
  skip: Skip,
  useKinds: boolean,
  scope?: { sql: string; params: string[] },
  cand?: CandidateSet,
  a: string = 'f',
): { where: string; params: (string | number)[] } {
  const where: string[] = [request.gone ? `${a}.gone_at IS NOT NULL` : `${a}.gone_at IS NULL`];
  const params: (string | number)[] = [];
  const word = (column: string, w: string): void => {
    where.push(isAscii(w) ? `instr(lower(${column}), ?) > 0` : `instr(bh_lower(${column}), ?) > 0`);
    params.push(w);
  };
  if (cand?.kind === 'ids') {
    where.push(`${a}.id IN (SELECT value FROM json_each(?))`);
    params.push(cand.json);
  }
  const column = request.includeFolders ? `${a}.rel_path` : `${a}.name`;
  for (const w of searchWords(request.text)) {
    const inFolders = cand?.kind === 'words' ? cand.pathIds.get(w) : undefined;
    if (inFolders !== undefined && request.includeFolders) {
      where.push(`(${isAscii(w) ? `instr(lower(${a}.name), ?)` : `instr(bh_lower(${a}.name), ?)`} > 0 OR ${a}.id IN (SELECT value FROM json_each(?)))`);
      params.push(w, inFolders);
    } else word(column, w);
  }
  // The folder part is the path without the name (the name is its last segment, always).
  for (const w of folderWords(request.folder)) word(`substr(${a}.rel_path, 1, length(${a}.rel_path) - length(${a}.name))`, w);
  // Unary plus: a scan is steadier than walking the place index and fetching every row (6 times slower for big places).
  if (skip !== 'place' && request.placeIds.length > 0) {
    where.push(`+${a}.place_id IN (${request.placeIds.map(() => '?').join(',')})`);
    params.push(...request.placeIds);
  }
  // One person's files: ranges of (place, path prefix), see personScope.ts.
  if (scope) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  if (skip !== 'category' && request.category !== null) {
    if (useKinds) {
      // The kinds are our own fixed words, never text from the window.
      where.push(`${a}.kind IN (${kindsOfCategory(request.category).map((k) => `'${k}'`).join(',')})`);
    } else {
      where.push(`bh_cat(${a}.name, ${a}.mime) = ?`);
      params.push(request.category);
    }
  }
  if (request.kind !== null) {
    if (useKinds) {
      where.push(`${a}.kind = ?`);
      params.push(request.kind);
    } else {
      where.push(`coalesce(${a}.kind, bh_kind(${a}.rel_path, ${a}.name, ${a}.mime, ${a}.size)) = ?`);
      params.push(request.kind);
    }
  }
  if (request.unfingerprinted) {
    // The same files the fingerprint job still has to read (no fingerprint of either kind, on this PC).
    where.push(`${a}.sha256 IS NULL AND ${a}.md5 IS NULL AND ${a}.cloud_only = 0`);
  }
  if (request.minSize !== null) {
    where.push(`${a}.size >= ?`);
    params.push(request.minSize);
  }
  if (request.maxSize !== null) {
    where.push(`${a}.size <= ?`);
    params.push(request.maxSize);
  }
  if (request.fromDate !== null) {
    where.push(`${a}.mtime >= ?`);
    params.push(request.fromDate);
  }
  if (request.toDate !== null) {
    where.push(`${a}.mtime <= ?`);
    params.push(request.toDate);
  }
  if (request.extensions.length > 0) {
    // Extensions are 1 to 10 letters or digits, so "." + extension is a plain suffix of the lower-cased name.
    const tests = request.extensions.map((e) => {
      params.push(`.${e}`);
      return `substr(lower(${a}.name), -${e.length + 1}) = ?`;
    });
    where.push(`(${tests.join(' OR ')})`);
  }
  return { where: where.join(' AND '), params };
}

/**
 * True when the content of the representative row `a` has NO live copy in the places: "not on Seagate", "not on Google". The same content
 * rule as the copies (md5 + size, else sha256, else the row alone).
 */
export function notHeldSql(a: string, placeIds: readonly string[]): string {
  const list = sqlList(placeIds);
  return `CASE
    WHEN ${a}.size = 0 THEN ${a}.place_id NOT IN (${list})
    WHEN ${a}.md5 IS NOT NULL AND ${a}.size IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM files x INDEXED BY idx_files_md5_size WHERE x.md5 = ${a}.md5 AND x.size = ${a}.size AND x.gone_at IS NULL AND x.place_id IN (${list}))
    WHEN ${a}.sha256 IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM files x INDEXED BY idx_files_sha256_live WHERE x.sha256 = ${a}.sha256 AND x.gone_at IS NULL AND x.place_id IN (${list}))
    ELSE ${a}.place_id NOT IN (${list})
  END`;
}

interface Page {
  rows: PageRow[];
  /** The number of contents found; null when the walk did not count them (the counts request does). */
  total: number | null;
}

/** The condition for the person the request is scoped to (null = everyone: no condition). Read from the database, in the worker. */
export function scopeOf(db: Db, request: SearchRequest, a: string = 'f'): { sql: string; params: string[] } | undefined {
  return request.person === null ? undefined : personWhere(personRanges(db, request.person), a);
}

export function searchQuery(db: Db, request: SearchRequest, facetLimit: number = FACETS_MAX_CONTENTS, tuning: SearchTuning = {}): SearchResponse {
  const started = Date.now();
  registerFunctions(db);
  const useKinds = tuning.kinds ?? kindsComplete(db);
  if (request.part === 'counts') {
    try {
      const counted = countsOf(db, request, tuning.facetLimit ?? facetLimit, useKinds);
      return { status: 'counts', facets: counted.facets, years: yearsOf(db), total: counted.total, ms: Date.now() - started };
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }
  const pageSize = tuning.pageSize ?? MAX_SEARCH_RESULTS;
  let page: Page;
  try {
    page = (tuning.walk !== false && request.sort !== 'copies' ? walkPage(db, request, useKinds, pageSize, tuning.walkRows) : null) ?? groupPage(db, request, useKinds, pageSize);
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  const hits = page.rows.map((row) => toHit(db, row));
  return { status: 'done', hits, total: page.total, ms: Date.now() - started, offset: request.offset };
}

/** Group every matching row by content and cut the page. The representative of a content is its row with the smallest id. */
function groupPage(db: Db, request: SearchRequest, useKinds: boolean, pageSize: number): Page {
  const { where, params } = whereOf(request, null, useKinds, scopeOf(db, request));
  const sort = request.sort ?? 'name';
  const limit = placeLimit(request);
  const notIn = request.notInPlaceIds;
  const needPlaces = limit !== null || sort === 'copies';
  const needHeld = notIn.length > 0;
  const from = needPlaces || needHeld ? 'h' : 'g';
  const conds = [...(limit !== null ? [`places <= ${limit}`] : []), ...(needHeld ? ['not_held = 1'] : [])];
  const filter = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  // Narrow first. SQLite gives the columns that are not grouped (name, size ...) the values of the row with the smallest
  // id (the only aggregate is min(id)), so the representative needs no lookup per content.
  // "Fewer than 2 OTHER places holding it" = at most 2 places in all.
  const sql = `
    WITH g AS MATERIALIZED (
      SELECT ${KEY_SQL} AS k, min(f.id) AS id, f.name AS name, f.size AS size, f.mtime AS mtime, f.md5 AS md5, f.sha256 AS sha256, f.place_id AS place_id
        FROM files f WHERE ${where} GROUP BY k
    )${needPlaces || needHeld ? `, h AS MATERIALIZED (SELECT g.*${needPlaces ? `, ${placesSql('g')} AS places` : ''}${needHeld ? `, ${notHeldSql('g', notIn)} AS not_held` : ''} FROM g)` : ''}
    SELECT k, id, md5, size, sha256, (SELECT count(*) FROM ${from} ${filter}) AS total FROM ${from} ${filter}
    ORDER BY ${orderSql(sort, effectiveSortDir(request))}
    LIMIT ${pageSize} OFFSET ${request.offset}`;
  const rows = db.prepare(sql).all(...params) as PageRow[];
  return { rows, total: rows[0]?.total ?? 0 };
}

/** A walk position: a date or size, or a name (for the walk in name order). */
type Pos = number | string;

/**
 * SQLite's NOCASE order: ASCII letters folded to lower case, then the UTF-8 bytes compared. Used to tell whether a name is
 * strictly ahead of another in the walk; it must agree with `ORDER BY name COLLATE NOCASE`.
 */
export function compareNoCase(a: string, b: string): number {
  const fold = (t: string): Buffer => Buffer.from(t.replace(/[A-Z]+/g, (m) => m.toLowerCase()), 'utf8');
  return Buffer.compare(fold(a), fold(b));
}

interface Scanned {
  s: Pos;
  k: string;
  id: number;
  md5: string | null;
  size: number | null;
  sha256: string | null;
  ok: number | null;
}

interface Ranked {
  id: number;
  s: Pos | null;
}

/**
 * The first page of a sort by date or size without grouping everything, or null when it cannot be shown to be the
 * same page grouping would give within the row budget (see the comment at the top of the file).
 */
function walkPage(db: Db, request: SearchRequest, useKinds: boolean, pageSize: number, firstRows: number | undefined): Page | null {
  // "Not held in these places" is judged per content: grouping does that.
  if (request.notInPlaceIds.length > 0 || request.gone) return null;
  const sort: 'name' | 'date' | 'size' = request.sort === 'date' ? 'date' : request.sort === 'size' ? 'size' : 'name';
  const col = sort === 'date' ? 'mtime' : sort === 'size' ? 'size' : 'name';
  const index = sort === 'date' ? 'idx_files_mtime' : sort === 'size' ? 'idx_files_size_name' : 'idx_files_name_nocase';
  const collate = sort === 'name' ? ' COLLATE NOCASE' : '';
  const dir = effectiveSortDir(request);
  const desc = dir === 'desc';
  const need = request.offset + pageSize;
  const { where, params } = whereOf(request, null, useKinds, scopeOf(db, request));
  const scan = (limit: number): Scanned[] =>
    db
      .prepare(
        `SELECT f.${col} AS s, ${KEY_SQL} AS k, f.id AS id, f.md5 AS md5, f.size AS size, f.sha256 AS sha256, (${where}) AS ok
           FROM files f INDEXED BY ${index}
          WHERE f.gone_at IS NULL AND f.${col} IS NOT NULL ORDER BY f.${col}${collate} ${desc ? 'DESC' : 'ASC'} LIMIT ${limit}`,
      )
      .all(...params) as Scanned[];

  // The row with the smallest id among the matching rows of one content.
  const repM = db.prepare(`SELECT min(f.id) FROM files f INDEXED BY idx_files_md5_size WHERE ${where} AND f.md5 = ? AND f.size = ?`).pluck();
  const repS = db
    .prepare(`SELECT min(f.id) FROM files f INDEXED BY idx_files_sha256_live WHERE ${where} AND f.sha256 = ? AND NOT (f.md5 IS NOT NULL AND f.size IS NOT NULL)`)
    .pluck();
  const reps = new Map<string, number>();
  const repOf = (row: Scanned): number => {
    let id = reps.get(row.k);
    if (id === undefined) {
      id = row.k[0] === 'm' ? (repM.get(...params, row.md5, row.size) as number) : row.k[0] === 's' ? (repS.get(...params, row.sha256) as number) : row.id;
      reps.set(row.k, id);
    }
    return id;
  };
  const rankStmt = db.prepare(
    `SELECT id, ${col} AS s FROM (
       SELECT x.id AS id, x.name AS name, x.size AS size, x.mtime AS mtime${placeLimit(request) !== null ? `, ${placesSql('x')} AS places` : ''}
         FROM files x WHERE x.id IN (SELECT value FROM json_each(?))
     ) ${placeLimit(request) !== null ? `WHERE places <= ${placeLimit(request)}` : ''} ORDER BY ${orderSql(sort, dir)}`,
  );
  const cmp = (a: Pos, b: Pos): number => (typeof a === 'string' && typeof b === 'string' ? compareNoCase(a, b) : Number(a) - Number(b));
  const ahead = (a: Pos, b: Pos): boolean => (desc ? cmp(a, b) > 0 : cmp(a, b) < 0);

  let limit = firstRows ?? WALK_ROWS_PER_RESULT * need;
  for (let attempt = 0; attempt < WALK_ATTEMPTS; attempt += 1, limit *= WALK_RETRY_FACTOR) {
    const rows = scan(limit);
    const exhausted = rows.length < limit;
    // The contents in the order they are first met, and the walk position at which each was met.
    const met = new Map<string, Scanned>();
    const metAt: Pos[] = [];
    for (const row of rows) {
      if (row.ok === 1 && !met.has(row.k)) {
        met.set(row.k, row);
        metAt.push(row.s);
      }
    }
    const metRows = [...met.values()];
    for (let take = Math.max(2 * need, 64); ; take *= 2) {
      const all = take >= metRows.length;
      const cut = all ? metRows.length : take;
      // Every content not looked at has all its matching rows at or behind this value (null = there is nothing behind).
      const boundary = all ? (exhausted ? null : rows[rows.length - 1]!.s) : metAt[cut - 1]!;
      const ids = metRows.slice(0, cut).map(repOf);
      const ranked = rankStmt.all(JSON.stringify(ids)) as Ranked[];
      const last = ranked[need - 1];
      if (last && last.s !== null && (boundary === null || ahead(last.s, boundary))) {
        const kOf = new Map<number, Scanned>();
        for (const row of metRows.slice(0, cut)) kOf.set(repOf(row), row);
        const page = ranked.slice(request.offset, need).map((r): PageRow => {
          const row = kOf.get(r.id)!;
          return { k: row.k, id: r.id, md5: row.md5, size: row.size, sha256: row.sha256, total: null };
        });
        return { rows: page, total: null };
      }
      if (all) break;
    }
    // Too few matches in this stretch to ever finish within the budget (a rare word, a small type): grouping is cheaper.
    if (exhausted || metRows.length < need / 4) return null;
  }
  return null;
}

/** Counts for the type and place chips, and the number of contents the whole search finds. Read only, like everything here. */
export function countsOf(db: Db, request: SearchRequest, facetLimit: number, useKinds: boolean, cand?: CandidateSet): { facets: SearchFacets | null; total: number } {
  const cats = whereOf(request, 'category', useKinds, scopeOf(db, request), cand);
  const limit = placeLimit(request);
  const notIn = request.notInPlaceIds;
  // The conditions on the content (judged on its representative row x): at most so many places hold it, none of the places listed does.
  const repCond = [...(limit !== null ? [`(${placesSql('x')}) <= ${limit}`] : []), ...(notIn.length > 0 ? [`(${notHeldSql('x', notIn)})`] : [])].join(' AND ');
  const filtered = repCond !== '';
  // One row per content and type; "fewer than 2 other copies" is judged on the content, as in the page. The same
  // groups give the number of contents (one count over the groups, one per type).
  const catExpr = useKinds ? KIND_CATEGORY_SQL : 'bh_cat(f.name, f.mime)';
  const catRows = db
    .prepare(
      `WITH g AS MATERIALIZED (SELECT ${KEY_SQL} AS k, ${catExpr} AS c, min(f.id) AS id FROM files f WHERE ${cats.where} GROUP BY k, c)
              ${filtered ? `, j AS MATERIALIZED (SELECT g.k AS k, g.c AS c FROM g JOIN files x ON x.id = g.id WHERE ${repCond})` : ''}
       SELECT c, count(*) AS n FROM ${filtered ? 'j' : 'g'} GROUP BY c
       UNION ALL
       SELECT NULL, count(DISTINCT k) FROM ${filtered ? 'j' : 'g'}`,
    )
    .all(...cats.params) as { c: SearchCategory | null; n: number }[];
  const categories: SearchFacets['categories'] = {};
  let distinct = 0;
  for (const row of catRows) {
    if (row.c === null) distinct = row.n;
    else categories[row.c] = row.n;
  }
  const total = request.category !== null ? (categories[request.category] ?? 0) : distinct;
  // Too many contents: the place counts would be slow too, and the chips say so instead.
  if (Object.values(categories).reduce((sum, n) => sum + n, 0) >= facetLimit) return { facets: null, total };

  // The unary plus keeps SQLite off the place index: walking it and fetching every row's name is 6 times slower than one scan.
  const pl = whereOf(request, 'place', useKinds, scopeOf(db, request), cand);
  const placeRows = db
    .prepare(
      filtered
        ? `WITH g AS (SELECT ${KEY_SQL} AS k, +f.place_id AS p, min(f.id) AS id, count(*) AS n FROM files f WHERE ${pl.where} GROUP BY k, p)
           SELECT g.p AS p, sum(g.n) AS n FROM g JOIN files x ON x.id = g.id WHERE ${repCond} GROUP BY g.p`
        : `SELECT +f.place_id AS p, count(*) AS n FROM files f WHERE ${pl.where} GROUP BY +f.place_id`,
    )
    .all(...pl.params) as { p: string; n: number }[];
  const places: SearchFacets['places'] = {};
  for (const row of placeRows) places[row.p] = row.n;
  return { facets: { categories, places }, total };
}

/** The first and last year any live file is dated, for the year picker. */
export function yearsOf(db: Db): [number, number] | null {
  const span = db.prepare('SELECT min(mtime) AS lo, max(mtime) AS hi FROM files WHERE gone_at IS NULL AND mtime BETWEEN 0 AND ?').get(YEAR_2100_MS) as {
    lo: number | null;
    hi: number | null;
  };
  return span.lo === null || span.hi === null ? null : [new Date(span.lo).getFullYear(), new Date(span.hi).getFullYear()];
}

const COPY_SELECT = `SELECT f.id, f.place_id, p.label, p.kind, p.last_looked_at, f.rel_path, f.size, f.mtime, f.cloud_only,
                            f.web_link IS NOT NULL AS has_link, f.sha256 IS NOT NULL AS has_sha, f.verified_at IS NOT NULL AS is_verified
                       FROM files f JOIN places p ON p.id = f.place_id`;

interface PlaceCountRow {
  place_id: string;
  label: string;
  kind: string;
  files: number;
  withSha: number;
}

/** Every live row holding the content of the representative `row`: the rows listed (capped), and per place how many rows there are. */
function copyRows(db: Db, row: PageRow, file: FileRow): { rows: CopyRow[]; perPlace: SearchPlaceCount[]; files: number; withSha: number } {
  const kind = row.k[0];
  if (kind === 'r') {
    const rows = db.prepare(`${COPY_SELECT} WHERE f.id = ?`).all(row.id) as CopyRow[];
    const perPlace = rows.map((c) => ({ placeId: c.place_id, placeLabel: c.label, placeKind: c.kind, files: 1 }));
    return { rows, perPlace, files: rows.length, withSha: file.sha256 === null ? 0 : 1 };
  }
  const cond = kind === 'm' ? 'f.md5 = @md5 AND f.size = @size' : 'f.sha256 = @sha';
  const args = kind === 'm' ? { md5: row.md5, size: row.size } : { sha: row.sha256 };
  const rows = db
    .prepare(`${COPY_SELECT} WHERE ${cond} AND f.gone_at IS NULL ORDER BY p.label COLLATE NOCASE, f.rel_path LIMIT ${MAX_COPIES_LISTED}`)
    .all(args) as CopyRow[];
  const counted = db
    .prepare(
      `SELECT f.place_id, p.label, p.kind, count(*) AS files, count(f.sha256) AS withSha
         FROM files f JOIN places p ON p.id = f.place_id
        WHERE ${cond} AND f.gone_at IS NULL
        GROUP BY f.place_id ORDER BY p.label COLLATE NOCASE`,
    )
    .all(args) as PlaceCountRow[];
  return {
    rows,
    perPlace: counted.map((c) => ({ placeId: c.place_id, placeLabel: c.label, placeKind: c.kind, files: c.files })),
    files: counted.reduce((sum, c) => sum + c.files, 0),
    withSha: counted.reduce((sum, c) => sum + c.withSha, 0),
  };
}

export function toHit(db: Db, row: PageRow): SearchHit {
  const file = db.prepare('SELECT name, rel_path, size, mtime, sha256, md5, mime, kind FROM files WHERE id = ?').get(row.id) as FileRow;
  const found = copyRows(db, row, file);
  const copies: SearchCopy[] = found.rows.map((c) => ({
    fileId: c.id,
    placeId: c.place_id,
    placeLabel: c.label,
    placeKind: c.kind,
    lastLookedAt: c.last_looked_at,
    relPath: c.rel_path,
    size: c.size,
    mtime: c.mtime,
    cloudOnly: c.cloud_only === 1,
    hasWebLink: c.has_link === 1,
    checked: c.has_sha === 1,
    verified: c.is_verified === 1,
  }));
  const fingerprint: SearchFingerprint = found.withSha > 0 ? 'sha256' : row.k[0] === 'm' ? 'md5' : 'none';
  const kind: FileKind = isFileKind(file.kind) ? file.kind : kindOf(file.rel_path, file.name, file.mime);
  return {
    key: row.k,
    name: file.name,
    folder: folderOf(file.rel_path),
    size: file.size,
    mtime: file.mtime,
    category: categoryOf(file.name, file.mime),
    kind,
    fingerprint,
    places: found.perPlace.length,
    copies,
    moreCopies: found.files - copies.length,
    perPlace: found.perPlace,
  };
}
