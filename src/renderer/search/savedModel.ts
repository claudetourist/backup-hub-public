import type { SavedSearch, SearchCursor, SearchIndexStatus, SearchRequest, SearchResponse, SearchSort, SortDirection } from '../../shared/search';
import { formatDate, type DateChoice, type PlaceChip, type SizeChoice, SIZE_CHOICES } from './searchModel';
import { NO_FILTERS, type FilterState } from './filterModel';

/** Pure parts of the saved searches and of the "Search is getting ready" line of the Files screen. */

/** What a saved search puts back on the screen: the typed text, the filters and the sort. */
export interface SearchScreenState {
  text: string;
  includeFolders: boolean;
  filters: FilterState;
  sort: SearchSort | null;
  sortDir: SortDirection | null;
}

/** The chip ids whose places are all among `placeIds`. */
function chipIdsOf(chips: readonly PlaceChip[], placeIds: readonly string[]): Set<string> {
  const have = new Set(placeIds);
  return new Set(chips.filter((chip) => chip.placeIds.length > 0 && chip.placeIds.every((id) => have.has(id))).map((chip) => chip.id));
}

function trimmed(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** A size range back as the screen's size choice: a ready-made one when it is exactly that, else custom boxes in MB (GB when both are whole GB). */
export function sizeChoiceOf(minSize: number | null, maxSize: number | null): SizeChoice {
  if (minSize === null && maxSize === null) return { mode: 'any', min: '', max: '', unit: 'MB' };
  const preset = SIZE_CHOICES.find((c) => c.min !== null && c.min === minSize && maxSize === null);
  if (preset) return { mode: preset.key, min: '', max: '', unit: 'MB' };
  const gb = [minSize, maxSize].every((v) => v === null || v % 1_000_000_000 === 0);
  const per = gb ? 1_000_000_000 : 1_000_000;
  return { mode: 'custom', min: minSize === null ? '' : trimmed(minSize / per), max: maxSize === null ? '' : trimmed(maxSize / per), unit: gb ? 'GB' : 'MB' };
}

/** A date range back as the screen's date choice (always the from-to boxes, in local days). */
export function dateChoiceOf(fromDate: number | null, toDate: number | null): DateChoice {
  if (fromDate === null && toDate === null) return { mode: 'any', year: '', from: '', to: '' };
  return { mode: 'range', year: '', from: formatDate(fromDate), to: formatDate(toDate) };
}

/** The screen state for a saved search. The person in focus is not saved: it follows the screen's own scope. */
export function screenStateOf(request: SearchRequest, chips: readonly PlaceChip[]): SearchScreenState {
  const filters: FilterState = {
    ...NO_FILTERS,
    category: request.category,
    kind: request.kind,
    places: chipIdsOf(chips, request.placeIds),
    fewCopies: request.fewCopies,
    onlyOnePlace: request.onlyOnePlace,
    notIn: chipIdsOf(chips, request.notInPlaceIds),
    gone: request.gone,
    unfingerprinted: request.unfingerprinted,
    size: sizeChoiceOf(request.minSize, request.maxSize),
    folder: request.folder,
    extText: request.extensions.join(' '),
    date: dateChoiceOf(request.fromDate, request.toDate),
  };
  return { text: request.text, includeFolders: request.includeFolders, filters, sort: request.sort, sortDir: request.sortDir };
}

/** Saved searches that name a place this computer has no chip for (a drive that was removed) still open; the place is just not a filter. */
export function missingPlaces(request: SearchRequest, chips: readonly PlaceChip[]): number {
  const known = new Set(chips.flatMap((chip) => chip.placeIds));
  return [...request.placeIds, ...request.notInPlaceIds].filter((id) => !known.has(id)).length;
}

/** The line shown while the first fill of the index runs. Null when nothing needs saying. */
export function indexLine(status: SearchIndexStatus | null): string | null {
  if (status === null || !status.available || status.ready) return null;
  const wait = status.waiting ? ' It goes on when the running job is done.' : '';
  return `Search is getting ready: ${status.percent}%.${wait} Searching works meanwhile, only slower.`;
}

/** The cursor to ask for the next page with, or null when this is the last page or the answer pages by offset (the old search). */
export function nextCursorOf(response: Extract<SearchResponse, { status: 'done' }>): SearchCursor | null {
  return response.next ?? null;
}

/** "3 saved searches" for the menu button. */
export function savedSummary(saved: readonly SavedSearch[]): string {
  return saved.length === 0 ? 'None yet' : `${saved.length}`;
}
