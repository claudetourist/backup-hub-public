import { describe, expect, it } from 'vitest';
import { EMPTY_SEARCH, type SearchRequest } from '../../shared/search';
import { screenStateOf, sizeChoiceOf, dateChoiceOf, indexLine, missingPlaces, savedSummary } from './savedModel';
import { dateBounds, sizeBounds, type PlaceChip } from './searchModel';

const chips: PlaceChip[] = [
  { id: 'laptop', label: 'STUDY-PC', placeIds: ['laptop'], connected: true, offline: false, lastLookedAt: 1 },
  { id: 'seagate', label: 'Seagate2TB', placeIds: ['seagate'], connected: false, offline: true, lastLookedAt: 1 },
  { id: 'gdrive:all', label: 'Google Drive', placeIds: ['g1', 'g2'], connected: true, offline: false, lastLookedAt: 1 },
];

describe('a saved search puts the screen back as it was', () => {
  it('filters, places and the sort', () => {
    const request: SearchRequest = {
      ...EMPTY_SEARCH,
      text: 'holiday',
      includeFolders: true,
      category: 'photos',
      kind: 'photo-camera',
      placeIds: ['laptop', 'g1', 'g2'],
      notInPlaceIds: ['seagate'],
      onlyOnePlace: true,
      gone: false,
      folder: 'Pictures 2023',
      extensions: ['jpg', 'png'],
      sort: 'date',
      sortDir: 'asc',
    };
    const state = screenStateOf(request, chips);
    expect(state.text).toBe('holiday');
    expect(state.includeFolders).toBe(true);
    expect([...state.filters.places].toSorted()).toEqual(['gdrive:all', 'laptop']);
    expect([...state.filters.notIn]).toEqual(['seagate']);
    expect(state.filters.onlyOnePlace).toBe(true);
    expect(state.filters.folder).toBe('Pictures 2023');
    expect(state.filters.extText).toBe('jpg png');
    expect(state.sort).toBe('date');
    expect(state.sortDir).toBe('asc');
  });

  it('a Google chip is on only when every account is in the saved places', () => {
    expect([...screenStateOf({ ...EMPTY_SEARCH, placeIds: ['g1'] }, chips).filters.places]).toEqual([]);
  });

  it('a size range comes back as the same bytes', () => {
    for (const [min, max] of [[null, null], [10_000_000, null], [1_000_000_000, null], [500_000_000, 2_000_000_000], [2_000_000_000, 4_000_000_000], [1_500_000, 9_500_000]] as const) {
      const choice = sizeChoiceOf(min, max);
      expect(sizeBounds(choice)).toEqual({ minSize: min, maxSize: max });
    }
    expect(sizeChoiceOf(10_000_000, null).mode).toBe('over10mb');
  });

  it('a date range comes back as the same days', () => {
    const from = new Date(2022, 9, 14).getTime();
    const to = new Date(2022, 9, 21).getTime() - 1;
    expect(dateBounds(dateChoiceOf(from, to))).toEqual({ fromDate: from, toDate: to });
    expect(dateChoiceOf(null, null).mode).toBe('any');
  });

  it('counts the places that are no longer there', () => {
    expect(missingPlaces({ ...EMPTY_SEARCH, placeIds: ['laptop', 'gone-drive'], notInPlaceIds: ['x'] }, chips)).toBe(2);
  });
});

describe('the "getting ready" line', () => {
  it('shows the percent only while the first fill runs', () => {
    expect(indexLine({ available: true, ready: false, percent: 40, waiting: false })).toContain('40%');
    expect(indexLine({ available: true, ready: false, percent: 40, waiting: true })).toContain('running job');
    expect(indexLine({ available: true, ready: true, percent: 100, waiting: false })).toBeNull();
    expect(indexLine({ available: false, ready: false, percent: 0, waiting: false })).toBeNull();
    expect(indexLine(null)).toBeNull();
  });
  it('the saved menu says how many', () => {
    expect(savedSummary([])).toBe('None yet');
  });
});
