import type { SearchCategory } from '../../shared/fileCategories';
import { parseExtensions } from '../../shared/search';
import { ANY_DATE, ANY_SIZE, dateSummary, sizeSummary, typeSummary, type DateChoice, type SizeChoice } from './searchModel';
import type { FileKind } from '../../shared/fileKinds';
import type { SearchSeed } from './searchSeed';

/**
 * Every filter of the Files screen in one value (the typed text is not part of it, so Reset never clears the text).
 * The quick chips change it at once; the "More filters" drop-down edits a draft and changes it only on Apply.
 */
export interface FilterState {
  category: SearchCategory | null;
  kind: FileKind | null;
  /** Chosen place chips (ids from placeChips). */
  places: ReadonlySet<string>;
  /** Fewer than 2 other copies. */
  fewCopies: boolean;
  /** No other place holds the file. */
  onlyOnePlace: boolean;
  /** "Not on Seagate", "not on Google": the file has no copy in any of these places (chip ids from placeChips). */
  notIn: ReadonlySet<string>;
  /** Only files that are gone (no longer where they were seen). */
  gone: boolean;
  /** New or changed files that still need a quick check. */
  unfingerprinted: boolean;
  size: SizeChoice;
  folder: string;
  extText: string;
  date: DateChoice;
}

export const NO_FILTERS: FilterState = {
  category: null,
  kind: null,
  places: new Set<string>(),
  fewCopies: false,
  onlyOnePlace: false,
  notIn: new Set<string>(),
  gone: false,
  unfingerprinted: false,
  size: ANY_SIZE,
  folder: '',
  extText: '',
  date: ANY_DATE,
};

/** The filters a "Show in Search" link starts with (nothing without one). */
export function initialFilters(seed: SearchSeed | null): FilterState {
  if (seed === null) return NO_FILTERS;
  return {
    ...NO_FILTERS,
    kind: seed.kind ?? null,
    places: new Set(seed.placeId !== '' ? [seed.placeId] : []),
    // Without "onlyOnePlace" the seed means "fewer than 2 other copies" (the old Collections screen).
    fewCopies: seed.onlyOnePlace !== true,
    onlyOnePlace: seed.onlyOnePlace === true,
    unfingerprinted: seed.unfingerprinted === true,
    folder: seed.folder,
  };
}

// ---- Quick chips ------------------------------------------------------------------------------------------------

export type QuickId = 'photos' | 'videos' | 'documents' | 'over1gb' | 'oneCopy';

export const QUICK_FILTERS: readonly { id: QuickId; label: string }[] = [
  { id: 'photos', label: 'Photos' },
  { id: 'videos', label: 'Videos' },
  { id: 'documents', label: 'Documents' },
  { id: 'over1gb', label: 'Over 1 GB' },
  { id: 'oneCopy', label: 'Only one copy' },
];

const QUICK_CATEGORY: Partial<Record<QuickId, SearchCategory>> = { photos: 'photos', videos: 'videos', documents: 'documents' };

/** A quick chip is on when its filter is exactly what the chip sets (a finer kind of photo is shown by its own tag instead). */
export function isQuickOn(filters: FilterState, id: QuickId): boolean {
  const category = QUICK_CATEGORY[id];
  if (category !== undefined) return filters.category === category && filters.kind === null;
  return id === 'over1gb' ? filters.size.mode === 'over1gb' : filters.onlyOnePlace;
}

/** Press a quick chip: on when it was off, off when it was on. A type chip replaces the other type. */
export function toggleQuick(filters: FilterState, id: QuickId): FilterState {
  const on = isQuickOn(filters, id);
  const category = QUICK_CATEGORY[id];
  if (category !== undefined) return { ...filters, category: on ? null : category, kind: null };
  if (id === 'over1gb') return { ...filters, size: on ? ANY_SIZE : { ...ANY_SIZE, mode: 'over1gb' } };
  return { ...filters, onlyOnePlace: !on };
}

// ---- Active filters as removable tags -----------------------------------------------------------------------------

export interface ActiveFilter {
  /** 'type', 'place:<id>', 'notIn:<id>', 'gone', 'size', 'date', 'folder', 'ext', 'fewCopies', 'unchecked'. */
  key: string;
  label: string;
}

/** The filters that are on and are not already shown by a pressed quick chip. */
export function activeFilters(filters: FilterState, placeLabel: (id: string) => string): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const typeOwnedByChip = QUICK_FILTERS.some((q) => QUICK_CATEGORY[q.id] !== undefined && isQuickOn(filters, q.id));
  if ((filters.category !== null || filters.kind !== null) && !typeOwnedByChip) out.push({ key: 'type', label: typeSummary(filters.category, filters.kind) });
  for (const id of filters.places) out.push({ key: `place:${id}`, label: placeLabel(id) });
  if (filters.size.mode !== 'any' && !isQuickOn(filters, 'over1gb')) out.push({ key: 'size', label: sizeSummary(filters.size) });
  if (filters.date.mode !== 'any') out.push({ key: 'date', label: dateSummary(filters.date) });
  if (filters.folder.trim() !== '') out.push({ key: 'folder', label: `Folder: ${filters.folder.trim()}` });
  const extensions = parseExtensions(filters.extText);
  if (extensions.length > 0) out.push({ key: 'ext', label: `Ending: ${extensions.join(', ')}` });
  if (filters.fewCopies) out.push({ key: 'fewCopies', label: 'Fewer than 2 other copies' });
  for (const id of filters.notIn) out.push({ key: `notIn:${id}`, label: `Not on ${placeLabel(id)}` });
  if (filters.gone) out.push({ key: 'gone', label: 'Gone files' });
  if (filters.unfingerprinted) out.push({ key: 'unchecked', label: 'Not checked yet' });
  return out;
}

/** Take one tag away. */
export function removeFilter(filters: FilterState, key: string): FilterState {
  if (key.startsWith('place:')) {
    const places = new Set(filters.places);
    places.delete(key.slice('place:'.length));
    return { ...filters, places };
  }
  if (key.startsWith('notIn:')) {
    const notIn = new Set(filters.notIn);
    notIn.delete(key.slice('notIn:'.length));
    return { ...filters, notIn };
  }
  switch (key) {
    case 'gone':
      return { ...filters, gone: false };
    case 'type':
      return { ...filters, category: null, kind: null };
    case 'size':
      return { ...filters, size: ANY_SIZE };
    case 'date':
      return { ...filters, date: ANY_DATE };
    case 'folder':
      return { ...filters, folder: '' };
    case 'ext':
      return { ...filters, extText: '' };
    case 'fewCopies':
      return { ...filters, fewCopies: false };
    case 'unchecked':
      return { ...filters, unfingerprinted: false };
    default:
      return filters;
  }
}

// ---- The drop-down: edit a draft, apply on Apply ------------------------------------------------------------------

export interface StagedFilters {
  /** What the search uses now. */
  applied: FilterState;
  /** What the drop-down shows; the search does not see it until Apply. */
  draft: FilterState;
}

/** Opening the drop-down: the draft starts as what is applied. */
export function openStaged(applied: FilterState): StagedFilters {
  return { applied, draft: applied };
}

export function editDraft(staged: StagedFilters, patch: Partial<FilterState>): StagedFilters {
  return { ...staged, draft: { ...staged.draft, ...patch } };
}

/** Apply: the draft becomes what the search uses. */
export function applyDraft(staged: StagedFilters): StagedFilters {
  return { applied: staged.draft, draft: staged.draft };
}

/** Reset: every filter off, at once. The typed text is not a filter and is not touched. */
export function resetStaged(): StagedFilters {
  return { applied: NO_FILTERS, draft: NO_FILTERS };
}

export function isDirty(staged: StagedFilters): boolean {
  return !sameFilters(staged.applied, staged.draft);
}

export function sameFilters(a: FilterState, b: FilterState): boolean {
  return (
    a.category === b.category &&
    a.kind === b.kind &&
    a.places.size === b.places.size &&
    [...a.places].every((id) => b.places.has(id)) &&
    a.fewCopies === b.fewCopies &&
    a.onlyOnePlace === b.onlyOnePlace &&
    a.notIn.size === b.notIn.size &&
    [...a.notIn].every((id) => b.notIn.has(id)) &&
    a.gone === b.gone &&
    a.unfingerprinted === b.unfingerprinted &&
    a.size.mode === b.size.mode &&
    a.size.min === b.size.min &&
    a.size.max === b.size.max &&
    a.size.unit === b.size.unit &&
    a.folder === b.folder &&
    a.extText === b.extText &&
    a.date.mode === b.date.mode &&
    a.date.year === b.date.year &&
    a.date.from === b.date.from &&
    a.date.to === b.date.to
  );
}
