import { describe, expect, it } from 'vitest';
import {
  activeFilters,
  applyDraft,
  editDraft,
  initialFilters,
  isDirty,
  isQuickOn,
  NO_FILTERS,
  openStaged,
  removeFilter,
  resetStaged,
  sameFilters,
  toggleQuick,
  type FilterState,
} from './filterModel';
import { ANY_SIZE } from './searchModel';

const label = (id: string): string => (id === 't7' ? 'T7' : id);
const on = (patch: Partial<FilterState>): FilterState => ({ ...NO_FILTERS, ...patch });

describe('quick chips', () => {
  it('apply at once, and press again to clear', () => {
    const photos = toggleQuick(NO_FILTERS, 'photos');
    expect(photos.category).toBe('photos');
    expect(isQuickOn(photos, 'photos')).toBe(true);
    expect(toggleQuick(photos, 'photos')).toEqual(NO_FILTERS);
  });
  it('a type chip replaces the other type and drops a finer kind', () => {
    const videos = toggleQuick(on({ category: 'photos', kind: 'photo-screenshot' }), 'videos');
    expect(videos.category).toBe('videos');
    expect(videos.kind).toBeNull();
    expect(isQuickOn(on({ category: 'photos', kind: 'photo-screenshot' }), 'photos')).toBe(false);
  });
  it('Over 1 GB and Only one copy set the filters that already exist', () => {
    expect(toggleQuick(NO_FILTERS, 'over1gb').size.mode).toBe('over1gb');
    expect(toggleQuick(toggleQuick(NO_FILTERS, 'over1gb'), 'over1gb').size).toEqual(ANY_SIZE);
    expect(toggleQuick(NO_FILTERS, 'oneCopy').onlyOnePlace).toBe(true);
    expect(toggleQuick(on({ onlyOnePlace: true }), 'oneCopy').onlyOnePlace).toBe(false);
  });
  it('keeps the other filters', () => {
    const next = toggleQuick(on({ folder: 'Holiday', fewCopies: true }), 'documents');
    expect(next).toMatchObject({ folder: 'Holiday', fewCopies: true, category: 'documents' });
  });
});

describe('active filters as tags', () => {
  it('shows nothing when no filter is on', () => {
    expect(activeFilters(NO_FILTERS, label)).toEqual([]);
  });
  it('leaves out what a pressed quick chip already shows', () => {
    expect(activeFilters(on({ category: 'photos', onlyOnePlace: true, size: { ...ANY_SIZE, mode: 'over1gb' } }), label)).toEqual([]);
  });
  it('lists every other filter with its words', () => {
    const tags = activeFilters(
      on({
        category: 'photos',
        kind: 'photo-screenshot',
        places: new Set(['t7']),
        size: { ...ANY_SIZE, mode: 'over100mb' },
        folder: ' Holiday ',
        extText: 'PDF, .mp4',
        fewCopies: true,
        unfingerprinted: true,
        date: { mode: 'thisYear', year: '', from: '', to: '' },
      }),
      label,
    );
    expect(tags.map((t) => t.key)).toEqual(['type', 'place:t7', 'size', 'date', 'folder', 'ext', 'fewCopies', 'unchecked']);
    expect(tags.map((t) => t.label)).toEqual(['Screenshots', 'T7', 'Over 100 MB', 'This year', 'Folder: Holiday', 'Ending: pdf, mp4', 'Fewer than 2 other copies', 'Not checked yet']);
  });
  it('removing a tag takes just that filter away', () => {
    const state = on({ category: 'photos', kind: 'photo-screenshot', places: new Set(['t7', 'laptop']), folder: 'x', onlyOnePlace: true });
    expect(removeFilter(state, 'type')).toMatchObject({ category: null, kind: null, folder: 'x' });
    expect([...removeFilter(state, 'place:t7').places]).toEqual(['laptop']);
    expect(removeFilter(state, 'folder').folder).toBe('');
    expect(removeFilter(state, 'nothing')).toBe(state);
  });
});

describe('More filters: Apply and Reset', () => {
  const applied = on({ category: 'documents' });
  it('opens with the draft equal to what is applied', () => {
    const staged = openStaged(applied);
    expect(staged.draft).toBe(applied);
    expect(isDirty(staged)).toBe(false);
  });
  it('editing the draft does not change what is applied', () => {
    const edited = editDraft(openStaged(applied), { folder: 'Tax', fewCopies: true });
    expect(edited.applied).toBe(applied);
    expect(edited.draft).toMatchObject({ folder: 'Tax', fewCopies: true, category: 'documents' });
    expect(isDirty(edited)).toBe(true);
  });
  it('Apply makes the draft the applied filters', () => {
    const applied2 = applyDraft(editDraft(openStaged(applied), { folder: 'Tax' }));
    expect(applied2.applied.folder).toBe('Tax');
    expect(isDirty(applied2)).toBe(false);
  });
  it('Reset clears every filter at once (the typed text is not part of the filters)', () => {
    const reset = resetStaged();
    expect(reset.applied).toEqual(NO_FILTERS);
    expect(reset.draft).toEqual(NO_FILTERS);
    expect(Object.keys(NO_FILTERS)).not.toContain('text');
  });
  it('compares places by content', () => {
    expect(sameFilters(on({ places: new Set(['a', 'b']) }), on({ places: new Set(['b', 'a']) }))).toBe(true);
    expect(sameFilters(on({ places: new Set(['a']) }), on({ places: new Set(['b']) }))).toBe(false);
  });
});

describe('a "Show in Search" link', () => {
  it('starts with nothing without one', () => {
    expect(initialFilters(null)).toEqual(NO_FILTERS);
  });
  it('maps the seed to filters as before', () => {
    expect(initialFilters({ placeId: 'p1', folder: 'Trips' })).toMatchObject({ fewCopies: true, onlyOnePlace: false, folder: 'Trips' });
    expect([...initialFilters({ placeId: 'p1', folder: '' }).places]).toEqual(['p1']);
    expect(initialFilters({ placeId: '', folder: '', kind: 'photo-whatsapp', onlyOnePlace: true, unfingerprinted: true })).toMatchObject({
      kind: 'photo-whatsapp',
      fewCopies: false,
      onlyOnePlace: true,
      unfingerprinted: true,
    });
  });
});

describe('"not on" and "gone" filters', () => {
  it('show as tags, and each tag takes its own filter away', () => {
    const f = on({ notIn: new Set(['t7']), gone: true });
    expect(activeFilters(f, label).map((t) => t.label)).toEqual(['Not on T7', 'Gone files']);
    expect(removeFilter(f, 'notIn:t7').notIn.size).toBe(0);
    expect(removeFilter(f, 'gone').gone).toBe(false);
  });
  it('count as a change in the drop-down', () => {
    expect(sameFilters(NO_FILTERS, on({ notIn: new Set(['t7']) }))).toBe(false);
    expect(sameFilters(NO_FILTERS, on({ gone: true }))).toBe(false);
    expect(sameFilters(on({ notIn: new Set(['a', 'b']) }), on({ notIn: new Set(['b', 'a']) }))).toBe(true);
  });
});
