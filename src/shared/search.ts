/**
 * Search types shared by main, the query worker, preload and the screen. Pure data and pure functions only.
 */
import { SEARCH_CATEGORIES, type SearchCategory } from './fileCategories';
import { isFileKind, type FileKind } from './fileKinds';

export const SEARCH_SORTS = ['name', 'size', 'date', 'copies'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** The most contents one search returns. */
export const MAX_SEARCH_RESULTS = 500;
/** The most copies listed under one content (a file with thousands of identical copies shows the first ones and a count). */
export const MAX_COPIES_LISTED = 100;
export const MAX_SEARCH_WORDS = 8;
export const MAX_WORD_LENGTH = 100;
export const MAX_PLACE_FILTERS = 200;
export const MAX_FOLDER_LENGTH = 400;
export const MAX_EXTENSIONS = 20;
/** Contents per "Show next" step is MAX_SEARCH_RESULTS; the screen never holds more than this many. */
export const MAX_SCREEN_RESULTS = 5000;
/** Facet counts (types and places) are worked out only for searches with fewer contents than this when they would be too slow. */
export const FACETS_MAX_CONTENTS = 50_000;

/** The most results the Files screen keeps when the indexed search pages by cursor (the list is virtual: only the rows in view are drawn). */
export const MAX_INDEXED_ON_SCREEN = 20_000;

/** The results the indexed search brings per page (the list is virtual: the next page loads when the list nears its end). */
export const INDEX_PAGE_SIZE = 100;

/** Where the next page of an indexed search starts: the sort value and the file id of the last row of the page before (keyset paging). */
export interface SearchCursor {
  /** The sort value of that row: a name, a size, a date or a number of places; null = a row with no date. */
  v: number | string | null;
  /** Its file id. */
  id: number;
  /** Its name, for the sort by size (equal sizes go by name). */
  n: string | null;
}

export type SortDirection = 'asc' | 'desc';
export const DEFAULT_SORT_DIR: Readonly<Record<SearchSort, SortDirection>> = { name: 'asc', size: 'desc', date: 'desc', copies: 'asc' };

export interface SearchRequest {
  text: string;
  /** Also match the folder names of the path, not only the file name. */
  includeFolders: boolean;
  category: SearchCategory | null;
  /** Only files that sit in one of these places (empty = every place). */
  placeIds: string[];
  /** Only contents held in fewer than 2 OTHER places. */
  fewCopies: boolean;
  /** Only this finer type (camera videos, voice recordings ...); null = every type. */
  kind: FileKind | null;
  /** Only contents that no other place holds (fewer than 2 places in all would be `fewCopies`; this is exactly 1). */
  onlyOnePlace: boolean;
  /**
   * Only this person's files (null = everyone's): the files on their phones and Google accounts, and the files under the folders their
   * backups save to. Worked out in the query worker from the database (prefix ranges on the place + path index).
   */
  person: number | null;
  /** Only files that have no fingerprint yet (new or changed since the last check), so their copies cannot be matched. */
  unfingerprinted: boolean;
  /** Null = the default order (name). Choosing a sort lets an empty text search run. */
  sort: SearchSort | null;
  /** Bytes, inclusive. Files with no size never match a size bound. */
  minSize: number | null;
  maxSize: number | null;
  /** Every word must appear in the folder part of the path (the path without the file name). */
  folder: string;
  /** Lower-case extensions without the dot ("pdf"); a file matches when its name ends with "." + one of them. */
  extensions: string[];
  /** Epoch ms on the file date (mtime), inclusive. */
  fromDate: number | null;
  toDate: number | null;
  /** Null = the default direction of the sort. Rows with no value are always last. */
  sortDir: SortDirection | null;
  /** Only contents that none of these places holds a live copy of ("not on Seagate2TB", "not on Google"). */
  notInPlaceIds: string[];
  /** Only files that are gone (no longer where they were seen), not the ones that are there. */
  gone: boolean;
  /** The indexed search pages by this cursor (the `next` of the page before); null = the first page. The old search pages by `offset`. */
  after: SearchCursor | null;
  /** Where the page starts: 0, 500, 1000 ... below MAX_SCREEN_RESULTS. */
  offset: number;
  /**
   * 'page' = the results. 'counts' = the numbers on the chips and the years for the same search (it ignores offset and
   * sort). Asked second, so the results never wait for them.
   */
  part: 'page' | 'counts';
}

export const EMPTY_SEARCH: SearchRequest = {
  text: '',
  includeFolders: false,
  category: null,
  placeIds: [],
  fewCopies: false,
  kind: null,
  onlyOnePlace: false,
  person: null,
  unfingerprinted: false,
  sort: null,
  minSize: null,
  maxSize: null,
  folder: '',
  extensions: [],
  fromDate: null,
  toDate: null,
  sortDir: null,
  notInPlaceIds: [],
  gone: false,
  after: null,
  offset: 0,
  part: 'page',
};

/** The folder box as words: slashes of either kind are the same, lower case, no repeats. */
export function folderWords(folder: string): string[] {
  return searchWords(folder.replaceAll('\\', '/'));
}

/** "pdf, mp4 .MOV" gives ['pdf', 'mp4', 'mov']. Anything that is not 1 to 10 letters or digits is left out. */
export function parseExtensions(text: string): string[] {
  const found = text
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((e) => e.replace(/^\.+/, ''))
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e));
  return [...new Set(found)].slice(0, MAX_EXTENSIONS);
}

/** The direction a request sorts in. */
export function effectiveSortDir(request: Pick<SearchRequest, 'sort' | 'sortDir'>): SortDirection {
  return request.sortDir ?? DEFAULT_SORT_DIR[request.sort ?? 'name'];
}

/** A size or date bound from anything the window sent: a whole number of at least 0, else null. */
function bound(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The same two bounds in order (a minimum above the maximum is swapped). */
function ordered(a: number | null, b: number | null): [number | null, number | null] {
  return a !== null && b !== null && a > b ? [b, a] : [a, b];
}

/** The words of the text: lower case, no empties, no repeats, within the limits. */
export function searchWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w.slice(0, MAX_WORD_LENGTH));
  return [...new Set(words)].slice(0, MAX_SEARCH_WORDS);
}

/** True when the request asks for something: words, a filter or a chosen sort. Otherwise the screen just waits. */
export function hasSearchCriteria(request: SearchRequest): boolean {
  return (
    searchWords(request.text).length > 0 ||
    request.category !== null ||
    request.placeIds.length > 0 ||
    request.fewCopies ||
    request.kind !== null ||
    request.onlyOnePlace ||
    request.unfingerprinted ||
    request.sort !== null ||
    request.minSize !== null ||
    request.maxSize !== null ||
    folderWords(request.folder).length > 0 ||
    request.extensions.length > 0 ||
    request.fromDate !== null ||
    request.toDate !== null ||
    request.notInPlaceIds.length > 0 ||
    request.gone
  );
}

/** Makes a request out of anything the window sent; unknown or bad parts fall back to "no filter". */
export function toSearchRequest(value: unknown): SearchRequest {
  if (value === null || typeof value !== 'object') return { ...EMPTY_SEARCH };
  const o = value as Record<string, unknown>;
  const category = SEARCH_CATEGORIES.find((c) => c === o['category']) ?? null;
  const sort = SEARCH_SORTS.find((s) => s === o['sort']) ?? null;
  const placeIds = Array.isArray(o['placeIds'])
    ? [...new Set(o['placeIds'].filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 80))].slice(0, MAX_PLACE_FILTERS)
    : [];
  const [minSize, maxSize] = ordered(bound(o['minSize']), bound(o['maxSize']));
  const [fromDate, toDate] = ordered(bound(o['fromDate']), bound(o['toDate']));
  const part = o['part'] === 'counts' ? 'counts' : 'page';
  const offset = part === 'page' ? bound(o['offset']) : 0;
  return {
    text: typeof o['text'] === 'string' ? o['text'].slice(0, 400) : '',
    includeFolders: o['includeFolders'] === true,
    category,
    placeIds,
    fewCopies: o['fewCopies'] === true,
    kind: isFileKind(o['kind']) ? o['kind'] : null,
    onlyOnePlace: o['onlyOnePlace'] === true,
    person: typeof o['person'] === 'number' && Number.isSafeInteger(o['person']) && o['person'] >= 1 ? o['person'] : null,
    unfingerprinted: o['unfingerprinted'] === true,
    sort,
    minSize,
    maxSize,
    folder: typeof o['folder'] === 'string' ? o['folder'].slice(0, MAX_FOLDER_LENGTH) : '',
    extensions: Array.isArray(o['extensions']) ? parseExtensions(o['extensions'].filter((e): e is string => typeof e === 'string').join(' ')) : [],
    fromDate,
    toDate,
    sortDir: o['sortDir'] === 'asc' || o['sortDir'] === 'desc' ? o['sortDir'] : null,
    notInPlaceIds: Array.isArray(o['notInPlaceIds'])
      ? [...new Set(o['notInPlaceIds'].filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 80))].slice(0, MAX_PLACE_FILTERS)
      : [],
    gone: o['gone'] === true,
    after: part === 'page' ? toCursor(o['after']) : null,
    // Whole pages only: 0, 500, 1000 ... and never past the 5,000 the screen holds.
    offset: offset === null || offset >= MAX_SCREEN_RESULTS ? 0 : Math.floor(offset / MAX_SEARCH_RESULTS) * MAX_SEARCH_RESULTS,
    part,
  };
}

/** A cursor from anything the window sent; anything that is not a whole cursor gives null (the first page). */
export function toCursor(value: unknown): SearchCursor | null {
  if (value === null || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const v = o['v'];
  const okV = v === null || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 1000);
  const id = o['id'];
  const n = o['n'];
  if (!okV || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
  return { v: v as SearchCursor['v'], id, n: typeof n === 'string' && n.length <= 1000 ? n : null };
}

/** One place holding a copy. */
export interface SearchCopy {
  fileId: number;
  placeId: string;
  placeLabel: string;
  placeKind: string;
  /** When the place was last fully looked at (epoch ms), or null. */
  lastLookedAt: number | null;
  /** The path as stored for the place (laptop paths are absolute). Forward slashes. */
  relPath: string;
  size: number | null;
  mtime: number | null;
  cloudOnly: boolean;
  /** True when the copy has a link to open in Google Drive (the address itself stays in main). */
  hasWebLink: boolean;
  /** Its checksum has been read (so it can be matched with its other copies). */
  checked: boolean;
  /** A backup copy proven equal to its source by reading both. */
  verified: boolean;
}

export type SearchFingerprint = 'sha256' | 'md5' | 'none';

/** One place holding the content, and how many copies it holds there (all of them, listed or not). */
export interface SearchPlaceCount {
  placeId: string;
  placeLabel: string;
  placeKind: string;
  files: number;
}

/** One content (one result row). */
export interface SearchHit {
  /** Stable within one answer; "s<sha256>", "m<md5>|<size>" or "r<file id>". */
  key: string;
  name: string;
  /** The folder part of the path of the copy that matched. */
  folder: string;
  size: number | null;
  mtime: number | null;
  category: SearchCategory;
  /** The finer type (camera photo, screenshot, voice recording ...). */
  kind: FileKind;
  fingerprint: SearchFingerprint;
  /** In how many different places this content sits (two copies in one place count once). */
  places: number;
  copies: SearchCopy[];
  /** Copies that exist but are not in the list. */
  moreCopies: number;
  /** Every place holding the content with its exact number of copies, by place name. */
  perPlace: SearchPlaceCount[];
}

/**
 * Counts for the chips above the results, for the search with every filter except the one the chip sets
 * (so the other types and places can be compared). Worked out on the first page only.
 */
export interface SearchFacets {
  /** Contents per type. */
  categories: Partial<Record<SearchCategory, number>>;
  /** Matched files per place id. */
  places: Record<string, number>;
}

export type SearchResponse =
  | {
      status: 'done';
      hits: SearchHit[];
      /**
       * How many contents the search finds. Null when the page was found without counting them (a sort by date or size
       * on a big catalog); the answer to the 'counts' request carries the number then.
       */
      total: number | null;
      ms: number;
      /** Where this page starts. */
      offset: number;
      /**
       * Indexed search only: the cursor of the next page (null = this is the last page). Absent = the old search answered; it pages by
       * `offset` and a full page means there may be more.
       */
      next?: SearchCursor | null;
      /** Indexed search only: true when the answer came from the search index. */
      indexed?: boolean;
    }
  | {
      /** The answer to a request with part 'counts'. */
      status: 'counts';
      /** Null for big searches (see FACETS_MAX_CONTENTS). */
      facets: SearchFacets | null;
      /** The first and last year any live file is dated, for the year picker; null when no file has a date. */
      years: [number, number] | null;
      /** How many contents the whole search finds (the page's total when it has one). */
      total: number;
      ms: number;
    }
  | { status: 'superseded' }
  | { status: 'failed'; message: string };

export type ShowInFolderResult = { ok: true } | { ok: false; message: string };
export type OpenInDriveResult = { ok: true } | { ok: false; message: string };

/** "500 of 12,345 shown; narrow the search" / "13 found". */
export function resultsSummary(shown: number, total: number): string {
  const n = (v: number): string => v.toLocaleString('en-US');
  if (total === 0) return 'Nothing found';
  if (shown < total) return `${n(shown)} of ${n(total)} shown; narrow the search to see the rest`;
  return total === 1 ? '1 found' : `${n(total)} found`;
}

/** The folder part of a stored path ("D:/MyData/a.jpg" gives "D:/MyData"). */
export function folderOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

/** True when a place label looks like an email address (Google Drive places are labelled with the account's email). */
export function looksLikeEmail(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 254 && /^[^\s@/?#&=]+@[^\s@/?#&=]+\.[^\s@/?#&=.]+$/.test(text);
}

/** How ready the search index is (the "Search is getting ready" line of the Files screen). */
export interface SearchIndexStatus {
  /** False on a database that has no index tables (never in the app; tests). */
  available: boolean;
  /** The first fill is over: searches use the index. */
  ready: boolean;
  /** 0 to 100 while the first fill runs. */
  percent: number;
  /** The fill waits for a running job to finish (jobs write to the same file). */
  waiting: boolean;
}

export const MAX_SAVED_SEARCHES = 50;
export const MAX_SAVED_NAME = 80;

/** A search the person saved: a name and the request (without paging). */
export interface SavedSearch {
  id: number;
  name: string;
  request: SearchRequest;
  createdAt: number;
}

export type SavedSearchResult = { ok: true; saved: SavedSearch[] } | { ok: false; message: string };

/** What a saved search keeps of a request: everything but the page. */
export function savedRequestOf(request: SearchRequest): SearchRequest {
  return { ...request, after: null, offset: 0, part: 'page' };
}

/** The name a saved search gets when the person gives none: the words, else the first thing set. */
export function defaultSavedName(request: SearchRequest): string {
  const words = request.text.trim();
  if (words !== '') return words.slice(0, MAX_SAVED_NAME);
  if (request.folder.trim() !== '') return request.folder.trim().slice(0, MAX_SAVED_NAME);
  return 'My search';
}
