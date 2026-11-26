import { CATEGORY_LABELS, SEARCH_CATEGORIES, type SearchCategory } from '../../shared/fileCategories';
import { categoryOfKind, FILE_KINDS, KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import type { PlaceView } from '../../shared/places';
import {
  effectiveSortDir,
  folderOf,
  hasSearchCriteria,
  looksLikeEmail,
  MAX_SCREEN_RESULTS,
  MAX_SEARCH_RESULTS,
  resultsSummary,
  type SearchCopy,
  type SearchFacets,
  type SearchHit,
  type SearchRequest,
  type SearchSort,
  type SortDirection,
} from '../../shared/search';
import { copyCountLabel, copyCountTone, type Tone } from '../components/status';
import { formatBytes, plural } from '../lib/format';
import { formatWhen } from '../jobs/jobsModel';
import { checkedWhen } from '../places/placesModel';

export { looksLikeEmail };

/** Pure view-model of the Search screen (no React, no window.backupHub), so it can be tested. */

export const SORT_OPTIONS: readonly { key: SearchSort; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'date', label: 'Date' },
  { key: 'copies', label: 'Copies' },
];

export const CATEGORY_OPTIONS: readonly { key: SearchCategory; label: string }[] = SEARCH_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] }));

/** The finer kinds (camera videos, screenshots ...) the Type menu offers under the types, each with the type it belongs to. */
export const KIND_OPTIONS: readonly { key: FileKind; label: string; category: SearchCategory }[] = FILE_KINDS.map((key) => ({ key, label: KIND_LABELS[key], category: categoryOfKind(key) }));

/** What the Type button says: the kind when one is chosen, else the type, else "All types". */
export function typeSummary(category: SearchCategory | null, kind: FileKind | null): string {
  if (kind !== null) return KIND_LABELS[kind];
  return category === null ? 'All types' : CATEGORY_LABELS[category];
}

/** Choosing a type drops a chosen kind that belongs to another type (it could never match). */
export function chooseCategory(current: { category: SearchCategory | null; kind: FileKind | null }, category: SearchCategory | null): { category: SearchCategory | null; kind: FileKind | null } {
  const keep = current.kind !== null && category !== null && categoryOfKind(current.kind) === category;
  return { category, kind: keep ? current.kind : null };
}

/** Choosing a kind sets its type too, so the Type button and the chips agree. */
export function chooseKind(kind: FileKind | null): { category: SearchCategory | null; kind: FileKind | null } {
  return { category: kind === null ? null : categoryOfKind(kind), kind };
}

/** The screen waits for the person to type or pick something before it asks for anything. */
export const needsSearch = hasSearchCriteria;

/**
 * What the numbers above the results depend on: every part of the request except the order and the page. Clicking a
 * sort changes the order only, so the numbers (and the total) already on screen stay right and are not asked for again.
 */
export function countsKeyOf(request: SearchRequest): string {
  return JSON.stringify({ ...request, sort: null, sortDir: null, offset: 0, part: 'counts' });
}

/** How long the screen waits after the last key before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

/** A place chip: one place, or all Google Drive accounts together (there can be dozens). */
export interface PlaceChip {
  id: string;
  label: string;
  placeIds: string[];
  /** True when the place can be reached now (for Google Drive: at least one account). Drives the dot on the chip. */
  connected: boolean;
  /** A laptop, drive or OneDrive that is not connected: its results show what was there when it was last checked. */
  offline: boolean;
  /** When the place was last checked in full (epoch ms), or null. */
  lastLookedAt: number | null;
}

/** Chips for the places that have listed files: the laptop, drives and OneDrive one by one, and Google Drive as one chip. */
export function placeChips(places: readonly PlaceView[]): PlaceChip[] {
  const listed = places.filter((p) => (p.files?.files ?? 0) > 0);
  const own: PlaceChip[] = listed
    .filter((p) => p.kind === 'laptop' || p.kind === 'drive' || p.kind === 'onedrive')
    .map((p) => ({ id: p.id, label: p.label, placeIds: [p.id], connected: p.status === 'connected', offline: p.status !== 'connected', lastLookedAt: p.lastLookedAt }));
  const google = listed.filter((p) => p.kind === 'gdrive');
  const chips = own.toSorted((a, b) => a.label.localeCompare(b.label));
  if (google.length > 0) {
    const looked = google.map((p) => p.lastLookedAt).filter((t): t is number => t !== null);
    chips.push({
      id: 'gdrive:all',
      label: 'Google Drive',
      placeIds: google.map((p) => p.id),
      connected: google.some((p) => p.status === 'connected'),
      offline: false,
      lastLookedAt: looked.length > 0 ? Math.max(...looked) : null,
    });
  }
  return chips;
}

export function placeIdsOf(chips: readonly PlaceChip[], selected: ReadonlySet<string>): string[] {
  return chips.filter((c) => selected.has(c.id)).flatMap((c) => c.placeIds);
}

/**
 * The chosen place ids as one string. The place list arrives anew every 10 seconds (free space changes), and a
 * request built from a new array would search again and reset the results; a string stays equal when nothing changed.
 */
export function placeIdsKey(chips: readonly PlaceChip[], selected: ReadonlySet<string>): string {
  return placeIdsOf(chips, selected).join('\n');
}

export function placeIdsFromKey(key: string): string[] {
  return key === '' ? [] : key.split('\n');
}

/** "Search your files on STUDY-PC, T7 and 27 Drive accounts" for the label above the box. */
export function searchLabel(places: readonly PlaceView[]): string {
  const listed = places.filter((p) => (p.files?.files ?? 0) > 0);
  const google = listed.filter((p) => p.kind === 'gdrive').length;
  const others = listed.filter((p) => p.kind !== 'gdrive' && p.kind !== 'phone').map((p) => p.label);
  const parts = [...others];
  if (google > 0) parts.push(`${google} Drive ${plural(google, 'account', 'accounts')}`);
  if (parts.length === 0) return 'Search your listed files';
  if (parts.length === 1) return `Search your files on ${parts[0]}`;
  return `Search your files on ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** True when this copy sits on a laptop, drive or OneDrive that is not connected right now. */
export function isOfflinePlace(placeId: string, placeKind: string, places: readonly PlaceView[]): boolean {
  if (placeKind !== 'laptop' && placeKind !== 'drive' && placeKind !== 'onedrive') return false;
  const found = places.find((p) => p.id === placeId);
  return found !== undefined && found.status !== 'connected';
}

/** What "Show in folder" does for one copy: absent (not on a drive of this PC), disabled with the reason, or ready. */
export function showInFolderState(
  copy: Pick<SearchCopy, 'placeId' | 'placeKind' | 'placeLabel'>,
  places: readonly PlaceView[],
): { state: 'hidden' } | { state: 'enabled' } | { state: 'disabled'; reason: string } {
  if (copy.placeKind !== 'laptop' && copy.placeKind !== 'drive' && copy.placeKind !== 'onedrive') return { state: 'hidden' };
  if (canShowInFolder(copy, places)) return { state: 'enabled' };
  return { state: 'disabled', reason: `${copy.placeLabel} is not connected. Connect it to open this folder.` };
}

/** The text of the Open in Drive button: "Open in Drive as sam@example.com" when the place is named by its email. */
export function driveButtonLabel(copy: Pick<SearchCopy, 'placeLabel'>): string {
  return looksLikeEmail(copy.placeLabel) ? `Open in Drive as ${copy.placeLabel}` : 'Open in Drive';
}

/** The label of the Copies column: how many backups (places other than the one you are looking at). */
export function copiesLabel(hit: Pick<SearchHit, 'places' | 'fingerprint'>): string {
  if (hit.fingerprint === 'none') return 'Not checked yet';
  return copyCountLabel(hit.places - 1);
}

export function copiesTone(hit: Pick<SearchHit, 'places' | 'fingerprint'>): Tone {
  if (hit.fingerprint === 'none') return 'neutral';
  return copyCountTone(hit.places - 1);
}

/** One plain sentence for the details panel. */
export function verdictText(hit: Pick<SearchHit, 'places' | 'fingerprint'>): string {
  if (hit.fingerprint === 'none') return 'Not checked yet. Backup Hub has not read this file, so it cannot say if another copy exists.';
  if (hit.places <= 1) return 'Only in one place. No backup.';
  const other = hit.places - 1;
  return `In ${hit.places} places: ${other} ${plural(other, 'other copy', 'other copies')}.`;
}

/** A place in the details panel: its exact number of copies, the ones listed, and how many are not listed. */
export interface PlaceGroup {
  placeId: string;
  label: string;
  files: number;
  copies: SearchCopy[];
  notListed: number;
  lastLookedAt: number | null;
}

/** The copies grouped by place, in the order of `perPlace` (by place name), with exact counts. */
export function placeGroups(hit: Pick<SearchHit, 'perPlace' | 'copies'>): PlaceGroup[] {
  return hit.perPlace.map((p) => {
    const copies = hit.copies.filter((c) => c.placeId === p.placeId);
    return {
      placeId: p.placeId,
      label: p.placeLabel,
      files: p.files,
      copies,
      notListed: Math.max(0, p.files - copies.length),
      lastLookedAt: copies[0]?.lastLookedAt ?? null,
    };
  });
}

/** "1 copy" / "3 copies". */
export function copiesText(n: number): string {
  return `${n.toLocaleString('en-US')} ${plural(n, 'copy', 'copies')}`;
}

/** "5 copies in 3 places" above the list in the details panel. */
export function copiesTotalText(hit: Pick<SearchHit, 'perPlace'>): string {
  const files = hit.perPlace.reduce((sum, p) => sum + p.files, 0);
  const places = hit.perPlace.length;
  return `${copiesText(files)} in ${places} ${plural(places, 'place', 'places')}`;
}

/** A line under the matching method, in plain words. */
export function fingerprintNote(hit: Pick<SearchHit, 'fingerprint'>): string {
  if (hit.fingerprint === 'sha256') return 'Copies are matched by checksum.';
  if (hit.fingerprint === 'md5') return 'Copies are matched by Google’s checksum and size.';
  return 'Matched by name only until the checksum has been read.';
}

/** Path as the person knows it: backslashes for this computer and drives, Drive paths as they are. */
export function displayPath(copy: Pick<SearchCopy, 'relPath' | 'placeKind'>): string {
  return copy.placeKind === 'gdrive' ? copy.relPath : copy.relPath.split('/').join('\\');
}

export function displayFolder(folder: string, placeKind: string): string {
  return displayPath({ relPath: folder, placeKind });
}

/** "2022-10-20" in the local time zone; '' when there is no date. */
export function formatDate(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sizeText(size: number | null): string {
  return size === null ? '' : formatBytes(size);
}

/** "Last checked: yesterday 14:05" or "Never checked in full". */
export function lastLookedLine(copy: Pick<SearchCopy, 'lastLookedAt'>, now: number): string {
  return copy.lastLookedAt === null ? 'Never checked in full' : `Last checked ${formatWhen(copy.lastLookedAt, now)}`;
}

/** True when "Show in folder" can be offered: a local copy on a place that is connected. Main checks everything again. */
export function canShowInFolder(copy: Pick<SearchCopy, 'placeId' | 'placeKind'>, places: readonly PlaceView[]): boolean {
  if (copy.placeKind !== 'laptop' && copy.placeKind !== 'drive' && copy.placeKind !== 'onedrive') return false;
  return places.some((p) => p.id === copy.placeId && p.status === 'connected');
}

/** True when "Open in Drive" can be offered. Main checks the address again. */
export function canOpenInDrive(copy: Pick<SearchCopy, 'placeKind' | 'hasWebLink'>): boolean {
  return copy.placeKind === 'gdrive' && copy.hasWebLink;
}

/** "13 files" / "1 file" for the results heading. */
export function resultsHeading(total: number): string {
  return `${total.toLocaleString('en-US')} ${plural(total, 'file', 'files')}`;
}

/** Plain explanation shown when a search finds nothing. */
export function noMatchText(request: SearchRequest): string {
  const bits: string[] = [];
  if (request.text.trim() !== '') bits.push(`"${request.text.trim()}"`);
  if (request.category !== null) bits.push(`in ${CATEGORY_LABELS[request.category]}`);
  if (request.placeIds.length > 0) bits.push('in the places you chose');
  if (request.kind !== null) bits.push(`of the kind ${KIND_LABELS[request.kind].toLowerCase()}`);
  if (request.onlyOnePlace) bits.push('with no other copy');
  if (request.unfingerprinted) bits.push('that still need a quick check');
  if (request.fewCopies) bits.push('with fewer than 2 other copies');
  if (request.minSize !== null || request.maxSize !== null) bits.push('of that size');
  if (request.folder.trim() !== '') bits.push('in that folder');
  if (request.extensions.length > 0) bits.push(`ending in ${request.extensions.map((e) => `.${e}`).join(', ')}`);
  if (request.fromDate !== null || request.toDate !== null) bits.push('in those dates');
  // "for" only goes before the typed words: 'Nothing found for "x" in Videos', but 'Nothing found in the places you chose'.
  const what = bits.length === 0 ? '' : request.text.trim() !== '' ? ` for ${bits.join(' ')}` : ` ${bits.join(' ')}`;
  const hint = request.includeFolders ? 'Try fewer words or a different spelling.' : 'Try fewer words, a different spelling, or turn on "Also match folder names".';
  return `Nothing found${what}. ${hint}`;
}

/**
 * How many contents the search finds: the number the page came with, else the one the counts request brought, else null
 * (a page found without counting; the counts are still on their way).
 */
export function knownTotal(pageTotal: number | null, countsTotal: number | null): number | null {
  return pageTotal ?? countsTotal;
}

/**
 * True when "Show next 500" is offered: the answer has more, and the screen has room. While the total is not known a
 * full page means there may be more (a page without a total is always a full page).
 */
export function canShowMore(shown: number, total: number | null): boolean {
  if (shown >= MAX_SCREEN_RESULTS) return false;
  return total === null ? shown > 0 && shown % MAX_SEARCH_RESULTS === 0 : shown < total;
}

/** The line above the results. While "Show next 500" is offered it does not say to narrow the search. */
export function summaryText(shown: number, total: number | null): string {
  if (total === null) return `${shown.toLocaleString('en-US')} shown, counting the rest`;
  if (canShowMore(shown, total)) return `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} shown`;
  return resultsSummary(shown, total);
}

/** The label of the button that loads the next page. */
export function showMoreLabel(shown: number, total: number | null): string {
  const next = Math.min(MAX_SEARCH_RESULTS, total === null ? MAX_SEARCH_RESULTS : total - shown, MAX_SCREEN_RESULTS - shown);
  return `Show next ${next.toLocaleString('en-US')}`;
}

/** Where the next page starts. Only whole pages are asked for, so an uneven number of rows means the end. */
export function nextOffset(shown: number): number {
  return Math.floor(shown / MAX_SEARCH_RESULTS) * MAX_SEARCH_RESULTS;
}

/** Joins a new page to the rows already on screen; a row seen before is not added twice. */
export function appendHits(current: readonly SearchHit[], page: readonly SearchHit[]): SearchHit[] {
  const seen = new Set(current.map((h) => h.key));
  return [...current, ...page.filter((h) => !seen.has(h.key))];
}

/** Size units of the custom size boxes (one unit for both). Decimal, like the sizes shown (1 GB = 1,000,000,000 bytes). */
export const SIZE_UNITS = [
  { key: 'MB', bytes: 1_000_000 },
  { key: 'GB', bytes: 1_000_000_000 },
] as const;
export type SizeUnit = (typeof SIZE_UNITS)[number]['key'];

const BYTES_OF_UNIT: Record<string, number> = { mb: 1_000_000, gb: 1_000_000_000 };

/**
 * "1.5" with the unit of the selector gives 1,500,000,000 for GB. A unit typed in the box wins: "500 MB", "2gb".
 * Empty or not a number gives null (no bound).
 */
export function sizeBound(text: string, unit: SizeUnit): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(mb|gb)?$/i.exec(text.trim());
  if (!m) return null;
  const perUnit = BYTES_OF_UNIT[(m[2] ?? unit).toLowerCase()] ?? 1;
  const bytes = Math.round(Number(m[1]!.replace(',', '.')) * perUnit);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** The ready-made sizes of the Size menu, and a custom one. */
export type SizeMode = 'any' | 'over10mb' | 'over100mb' | 'over1gb' | 'custom';

export const SIZE_CHOICES: readonly { key: SizeMode; label: string; min: number | null }[] = [
  { key: 'any', label: 'Any size', min: null },
  { key: 'over10mb', label: 'Over 10 MB', min: 10_000_000 },
  { key: 'over100mb', label: 'Over 100 MB', min: 100_000_000 },
  { key: 'over1gb', label: 'Over 1 GB', min: 1_000_000_000 },
  { key: 'custom', label: 'Custom...', min: null },
];

/** The size choice of the screen: a ready-made one, or custom boxes that share ONE unit. */
export interface SizeChoice {
  mode: SizeMode;
  min: string;
  max: string;
  unit: SizeUnit;
}

export const ANY_SIZE: SizeChoice = { mode: 'any', min: '', max: '', unit: 'MB' };

/** The bounds in bytes. In custom mode a reversed pair is swapped (the main process does the same). */
export function sizeBounds(choice: SizeChoice): { minSize: number | null; maxSize: number | null } {
  if (choice.mode === 'custom') {
    let minSize = sizeBound(choice.min, choice.unit);
    let maxSize = sizeBound(choice.max, choice.unit);
    if (minSize !== null && maxSize !== null && minSize > maxSize) [minSize, maxSize] = [maxSize, minSize];
    return { minSize, maxSize };
  }
  return { minSize: SIZE_CHOICES.find((c) => c.key === choice.mode)?.min ?? null, maxSize: null };
}

/** "500 MB" / "1.5 GB" for a bound in bytes. */
function boundText(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${Number((bytes / 1_000_000_000).toFixed(2))} GB` : `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

/** The words on the Size button: "Any size", "Over 10 MB", "500 MB to 2 GB", "Up to 2 GB". */
export function sizeSummary(choice: SizeChoice): string {
  if (choice.mode !== 'custom') return SIZE_CHOICES.find((c) => c.key === choice.mode)?.label ?? 'Any size';
  const { minSize, maxSize } = sizeBounds(choice);
  if (minSize !== null && maxSize !== null) return `${boundText(minSize)} to ${boundText(maxSize)}`;
  if (minSize !== null) return `Over ${boundText(minSize)}`;
  if (maxSize !== null) return `Up to ${boundText(maxSize)}`;
  return 'Custom...';
}

/** The date choice of the screen: nothing, this year, last year, one year, or from-to days. */
export interface DateChoice {
  mode: 'any' | 'thisYear' | 'lastYear' | 'year' | 'range';
  year: string;
  /** "2022-10-20", as a date box gives it. */
  from: string;
  to: string;
}

export const ANY_DATE: DateChoice = { mode: 'any', year: '', from: '', to: '' };

function localDay(text: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(y, mo - 1, d);
  return check.getFullYear() === y && check.getMonth() === mo - 1 && check.getDate() === d ? [y, mo, d] : null;
}

/** Local-day bounds (inclusive): a year is 1 Jan 00:00 to 31 Dec 23:59:59.999, a day is the whole day. */
export function dateBounds(choice: DateChoice, now: number = Date.now()): { fromDate: number | null; toDate: number | null } {
  if (choice.mode === 'year' || choice.mode === 'thisYear' || choice.mode === 'lastYear') {
    const thisYear = new Date(now).getFullYear();
    const y = choice.mode === 'thisYear' ? thisYear : choice.mode === 'lastYear' ? thisYear - 1 : Number(choice.year);
    if (!Number.isInteger(y) || y < 1 || y > 9999) return { fromDate: null, toDate: null };
    return { fromDate: new Date(y, 0, 1).getTime(), toDate: new Date(y + 1, 0, 1).getTime() - 1 };
  }
  if (choice.mode === 'range') {
    const from = localDay(choice.from);
    const to = localDay(choice.to);
    return {
      fromDate: from ? new Date(from[0], from[1] - 1, from[2]).getTime() : null,
      toDate: to ? new Date(to[0], to[1] - 1, to[2] + 1).getTime() - 1 : null,
    };
  }
  return { fromDate: null, toDate: null };
}

/** The words on the When button: "Any time", "This year", "Last year", "2022", "2022-10-14 to 2022-10-20". */
export function dateSummary(choice: DateChoice): string {
  switch (choice.mode) {
    case 'any':
      return 'Any time';
    case 'thisYear':
      return 'This year';
    case 'lastYear':
      return 'Last year';
    case 'year':
      return choice.year === '' ? 'One year...' : choice.year;
    case 'range':
    default:
      return choice.from === '' && choice.to === '' ? 'From - to...' : `${choice.from || 'the start'} to ${choice.to || 'now'}`;
  }
}

/** Years for the picker, newest first, from the first and last year that have files. */
export function yearOptions(years: readonly [number, number] | null | undefined): number[] {
  if (!years) return [];
  const [lo, hi] = years;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo || hi - lo > 200) return [];
  return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
}

/** What a header click on column `key` asks for: the same column reverses, another column starts in its usual direction. */
export function nextSortChoice(sort: SearchSort | null, sortDir: SortDirection | null, key: SearchSort): { sort: SearchSort; sortDir: SortDirection | null } {
  if (key !== (sort ?? 'name')) return { sort: key, sortDir: null };
  return { sort: key, sortDir: effectiveSortDir({ sort, sortDir }) === 'asc' ? 'desc' : 'asc' };
}

/** The sort the table header shows (an arrow on the column). */
export function headerSort(sort: SearchSort | null, sortDir: SortDirection | null): { columnKey: SearchSort; direction: SortDirection } {
  return { columnKey: sort ?? 'name', direction: effectiveSortDir({ sort, sortDir }) };
}

/** The count to print on a type chip, or null when the counts are not available. */
export function categoryCount(facets: SearchFacets | null, category: SearchCategory): number | null {
  return facets ? (facets.categories[category] ?? 0) : null;
}

/** Matched files on a place chip (all Drive accounts together on the Google Drive chip). */
export function placeCount(facets: SearchFacets | null, chip: Pick<PlaceChip, 'placeIds'>): number | null {
  return facets ? chip.placeIds.reduce((sum, id) => sum + (facets.places[id] ?? 0), 0) : null;
}

/** "1,203" for a chip, '' when there is no count. */
export function countText(count: number | null): string {
  return count === null ? '' : count.toLocaleString('en-US');
}

/** The text for the In folder box from one copy: the folder of that copy, as the person sees paths. */
export function folderBoxText(copy: Pick<SearchCopy, 'relPath' | 'placeKind'>): string {
  return displayFolder(folderOf(copy.relPath), copy.placeKind);
}

/** How many of the "More" filters are set (extension, fewer than 2 other copies), for the button. */
export function moreOnCount(request: Pick<SearchRequest, 'extensions' | 'fewCopies' | 'onlyOnePlace' | 'unfingerprinted'>): number {
  return (request.extensions.length > 0 ? 1 : 0) + (request.fewCopies ? 1 : 0) + (request.onlyOnePlace ? 1 : 0) + (request.unfingerprinted ? 1 : 0);
}

/** A file list older than this many days is shown in amber (the same rule as "Behind" for a backup). */
export const OLD_LIST_DAYS = 14;

/** One place in the line "Lists from: ...". */
export interface ListsFromItem {
  placeId: string;
  /** "STUDY-PC today 09:39", "T7 9 Nov", "Seagate2TB 9 Nov (not plugged in)", "OneDrive not checked yet". */
  text: string;
  /** Older than 14 days, or never checked: drawn in amber. */
  old: boolean;
  offline: boolean;
}

const LISTS_FROM_RANK: Readonly<Record<string, number>> = { laptop: 0, onedrive: 1, drive: 2 };

/**
 * The ONE line above the results about how fresh each file list is: the laptop, OneDrive and the named drives that are searched
 * (the ones chosen, or all of them when none is chosen) and have files listed. The laptop first, then OneDrive, then the drives,
 * plugged-in ones before the others.
 */
export function listsFrom(places: readonly PlaceView[], chosen: ReadonlySet<string>, now: number): ListsFromItem[] {
  const rank = (p: PlaceView): number => (LISTS_FROM_RANK[p.kind] ?? 3) * 2 + Number(p.status !== 'connected');
  return places
    .filter((p) => (p.kind === 'laptop' || p.kind === 'drive' || p.kind === 'onedrive') && (p.files?.files ?? 0) > 0 && (chosen.size === 0 || chosen.has(p.id)))
    .toSorted((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'en', { numeric: true }))
    .map((p) => {
      const offline = p.status !== 'connected';
      const when = p.lastLookedAt === null ? 'not checked yet' : checkedWhen(p.lastLookedAt, now);
      const away = offline ? (p.kind === 'drive' ? ' (not plugged in)' : ' (not connected)') : '';
      return { placeId: p.id, text: `${p.label} ${when}${away}`, old: p.lastLookedAt === null || now - p.lastLookedAt > OLD_LIST_DAYS * 86_400_000, offline };
    });
}

/** True when anything but the text and the sort is set, so "Clear filters" has something to do. */
export function hasFilters(request: SearchRequest): boolean {
  return hasSearchCriteria({ ...request, text: '', sort: null });
}
