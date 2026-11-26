import { describe, expect, it } from 'vitest';
import type { PlaceView } from '../../shared/places';
import { EMPTY_SEARCH, type SearchCopy, type SearchFacets, type SearchHit } from '../../shared/search';
import {
  chooseCategory,
  chooseKind,
  KIND_OPTIONS,
  typeSummary,
  appendHits,
  canOpenInDrive,
  canShowMore,
  categoryCount,
  countsKeyOf,
  knownTotal,
  countText,
  dateBounds,
  folderBoxText,
  hasFilters,
  headerSort,
  nextOffset,
  nextSortChoice,
  placeCount,
  showMoreLabel,
  sizeBound,
  summaryText,
  yearOptions,
  canShowInFolder,
  copiesLabel,
  copiesText,
  copiesTotalText,
  copiesTone,
  displayPath,
  formatDate,
  lastLookedLine,
  needsSearch,
  noMatchText,
  placeChips,
  placeGroups,

  listsFrom,
  moreOnCount,
  ANY_SIZE,
  dateSummary,
  driveButtonLabel,
  isOfflinePlace,
  showInFolderState,
  sizeBounds,
  sizeSummary,
  placeIdsFromKey,
  placeIdsKey,
  placeIdsOf,
  resultsHeading,
  searchLabel,
  verdictText,
} from './searchModel';

const place = (id: string, kind: PlaceView['kind'], label: string, files: number, status: PlaceView['status'] = 'connected'): PlaceView =>
  ({ id, kind, label, status, files: files > 0 ? { files, totalBytes: 1, cloudOnly: 0 } : null }) as PlaceView;

const listed = [
  place('lap', 'laptop', 'STUDY-PC', 100),
  place('t7', 'drive', 'T7', 50, 'disconnected'),
  place('g1', 'gdrive', 'a@example.com', 10),
  place('g2', 'gdrive', 'b@example.com', 20),
  place('g3', 'gdrive', 'empty@example.com', 0),
  place('ph', 'phone', 'Phone', 0),
];

describe('places chips', () => {
  it('lists the laptop and drives one by one and all Drive accounts with files as one chip', () => {
    const chips = placeChips(listed);
    expect(chips.map((c) => c.label)).toEqual(['STUDY-PC', 'T7', 'Google Drive']);
    expect(chips[2]?.placeIds).toEqual(['g1', 'g2']);
    expect(placeIdsOf(chips, new Set(['t7', 'gdrive:all']))).toEqual(['t7', 'g1', 'g2']);
    expect(placeIdsOf(chips, new Set())).toEqual([]);
  });

  it('gives the same place key for a fresh copy of the same place list, so the search does not run again', () => {
    const chosen = new Set(['lap', 'gdrive:all']);
    const before = placeIdsKey(placeChips(listed), chosen);
    const fresh = listed.map((p) => ({ ...p, freeBytes: 123 }));
    expect(placeIdsKey(placeChips(fresh), chosen)).toBe(before);
    expect(placeIdsFromKey(before)).toEqual(['lap', 'g1', 'g2']);
    expect(placeIdsFromKey(placeIdsKey(placeChips(listed), new Set()))).toEqual([]);
  });

  it('names what is searched', () => {
    expect(searchLabel(listed)).toBe('Search your files on STUDY-PC, T7 and 2 Drive accounts');
    expect(searchLabel([place('lap', 'laptop', 'STUDY-PC', 100), place('od', 'onedrive', 'OneDrive', 5), place('t7', 'drive', 'T7', 50), place('sg', 'drive', 'Seagate2TB', 50)])).toBe('Search your files on STUDY-PC, OneDrive, T7 and Seagate2TB');
    expect(searchLabel([])).toBe('Search your listed files');
    expect(searchLabel([place('lap', 'laptop', 'STUDY-PC', 3)])).toBe('Search your files on STUDY-PC');
  });
});

describe('copies wording', () => {
  const hit = (places: number, fingerprint: 'sha256' | 'md5' | 'none' = 'sha256') => ({ places, fingerprint });
  it('counts backups as the places other than the first', () => {
    expect(copiesLabel(hit(1))).toBe('No backup');
    expect(copiesLabel(hit(2))).toBe('1 backup');
    expect(copiesLabel(hit(4))).toBe('3 backups');
    expect(copiesTone(hit(1))).toBe('crit');
    expect(copiesTone(hit(2))).toBe('warn');
    expect(copiesTone(hit(3))).toBe('ok');
  });
  it('does not claim "no backup" for a file that was never fingerprinted', () => {
    expect(copiesLabel(hit(1, 'none'))).toBe('Not checked yet');
    expect(copiesTone(hit(1, 'none'))).toBe('neutral');
    expect(verdictText(hit(1, 'none'))).toMatch(/not read this file/);
  });
  it('gives a plain sentence per case', () => {
    expect(verdictText(hit(1))).toBe('Only in one place. No backup.');
    expect(verdictText(hit(2))).toBe('In 2 places: 1 other copy.');
    expect(verdictText(hit(3))).toBe('In 3 places: 2 other copies.');
  });
});

describe('paths, dates and sizes', () => {
  it('shows backslashes for this PC and drives, Drive paths as stored', () => {
    expect(displayPath({ relPath: 'D:/MyData/a.jpg', placeKind: 'laptop' })).toBe('D:\\MyData\\a.jpg');
    expect(displayPath({ relPath: 'Backups/a.jpg', placeKind: 'drive' })).toBe('Backups\\a.jpg');
    expect(displayPath({ relPath: 'My Drive/a.jpg', placeKind: 'gdrive' })).toBe('My Drive/a.jpg');
  });
  it('formats a date or nothing', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(new Date(2022, 9, 20, 12).getTime())).toBe('2022-10-20');
  });
  it('says when a place was last checked', () => {
    const now = new Date(2026, 9, 31, 12, 0).getTime();
    expect(lastLookedLine({ lastLookedAt: null }, now)).toBe('Never checked in full');
    expect(lastLookedLine({ lastLookedAt: new Date(2026, 9, 31, 9, 5).getTime() }, now)).toBe('Last checked 09:05');
  });
});

describe('actions offered', () => {
  it('Show in folder only for a local copy on a connected place', () => {
    expect(canShowInFolder({ placeId: 'lap', placeKind: 'laptop' }, listed)).toBe(true);
    expect(canShowInFolder({ placeId: 't7', placeKind: 'drive' }, listed)).toBe(false); // not plugged in
    expect(canShowInFolder({ placeId: 'g1', placeKind: 'gdrive' }, listed)).toBe(false);
    expect(canShowInFolder({ placeId: 'unknown', placeKind: 'laptop' }, listed)).toBe(false);
  });
  it('Open in Drive only for a Drive copy with a link', () => {
    expect(canOpenInDrive({ placeKind: 'gdrive', hasWebLink: true })).toBe(true);
    expect(canOpenInDrive({ placeKind: 'gdrive', hasWebLink: false })).toBe(false);
    expect(canOpenInDrive({ placeKind: 'laptop', hasWebLink: true })).toBe(false);
  });
});

describe('when to search and what to say', () => {
  it('waits for words, a filter or a sort', () => {
    expect(needsSearch(EMPTY_SEARCH)).toBe(false);
    expect(needsSearch({ ...EMPTY_SEARCH, sort: 'size' })).toBe(true);
  });
  it('heading', () => {
    expect(resultsHeading(1)).toBe('1 file');
    expect(resultsHeading(12345)).toBe('12,345 files');
  });
  it('explains an empty answer in plain words', () => {
    expect(noMatchText({ ...EMPTY_SEARCH, text: ' reunion ', category: 'videos' })).toBe(
      'Nothing found for "reunion" in Videos. Try fewer words, a different spelling, or turn on "Also match folder names".',
    );
    expect(noMatchText({ ...EMPTY_SEARCH, placeIds: ['p'], includeFolders: true })).toBe('Nothing found in the places you chose. Try fewer words or a different spelling.');
    expect(noMatchText({ ...EMPTY_SEARCH, text: 'x', includeFolders: true, fewCopies: true })).toBe(
      'Nothing found for "x" with fewer than 2 other copies. Try fewer words or a different spelling.',
    );
  });
});

describe('size boxes', () => {
  it('turns an amount and a unit into bytes, and a blank or bad amount into no bound', () => {
    expect(sizeBound('10', 'MB')).toBe(10_000_000);
    expect(sizeBound('1.5', 'GB')).toBe(1_500_000_000);
    expect(sizeBound('0,5', 'GB')).toBe(500_000_000);
    expect(sizeBound(' 0 ', 'MB')).toBe(0);
    for (const bad of ['', 'abc', '-1', '1e9', '1.', '9'.repeat(30)]) expect(sizeBound(bad, 'MB')).toBeNull();
  });
});

describe('date choices', () => {
  const none = { mode: 'any' as const, year: '', from: '', to: '' };
  it('makes local-day bounds: a year, or whole days from and to', () => {
    expect(dateBounds(none)).toEqual({ fromDate: null, toDate: null });
    expect(dateBounds({ ...none, mode: 'year', year: '2022' })).toEqual({ fromDate: new Date(2022, 0, 1).getTime(), toDate: new Date(2023, 0, 1).getTime() - 1 });
    expect(dateBounds({ ...none, mode: 'year', year: 'abc' })).toEqual({ fromDate: null, toDate: null });
    const range = dateBounds({ ...none, mode: 'range', from: '2022-10-14', to: '2022-10-20' });
    expect(range.fromDate).toBe(new Date(2022, 9, 14, 0, 0, 0, 0).getTime());
    expect(range.toDate).toBe(new Date(2022, 9, 20, 23, 59, 59, 999).getTime());
    expect(dateBounds({ ...none, mode: 'range', from: '2022-02-30', to: '' })).toEqual({ fromDate: null, toDate: null });
    expect(dateBounds({ ...none, mode: 'range', from: '', to: '2022-10-20' }).fromDate).toBeNull();
    // A year kept in the state while another mode is picked does nothing.
    expect(dateBounds({ ...none, year: '2022' })).toEqual({ fromDate: null, toDate: null });
  });
  it('offers the years that have files, newest first', () => {
    expect(yearOptions([2019, 2022])).toEqual([2022, 2021, 2020, 2019]);
    expect(yearOptions(null)).toEqual([]);
    expect(yearOptions([2022, 2019])).toEqual([]);
    expect(yearOptions([1, 2022])).toEqual([]);
  });
});

describe('sorting from the header', () => {
  it('another column starts in its usual direction; the same column reverses, again and again', () => {
    expect(nextSortChoice(null, null, 'size')).toEqual({ sort: 'size', sortDir: null });
    expect(nextSortChoice('size', null, 'size')).toEqual({ sort: 'size', sortDir: 'asc' });
    expect(nextSortChoice('size', 'asc', 'size')).toEqual({ sort: 'size', sortDir: 'desc' });
    expect(nextSortChoice(null, null, 'name')).toEqual({ sort: 'name', sortDir: 'desc' }); // name is the shown sort, so a click reverses it
    expect(nextSortChoice('date', 'asc', 'copies')).toEqual({ sort: 'copies', sortDir: null });
  });
  it('shows the arrow on the column that sorts', () => {
    expect(headerSort(null, null)).toEqual({ columnKey: 'name', direction: 'asc' });
    expect(headerSort('size', null)).toEqual({ columnKey: 'size', direction: 'desc' });
    expect(headerSort('size', 'asc')).toEqual({ columnKey: 'size', direction: 'asc' });
  });
});

describe('showing more', () => {
  it('offers the next page until everything or 5,000 rows are on screen', () => {
    expect(canShowMore(500, 1300)).toBe(true);
    expect(canShowMore(1300, 1300)).toBe(false);
    expect(canShowMore(5000, 12345)).toBe(false);
    expect(canShowMore(4500, 12345)).toBe(true);
  });
  it('keeps offering pages while the total is not known, and says it is counting', () => {
    expect(canShowMore(500, null)).toBe(true);
    expect(canShowMore(1000, null)).toBe(true);
    expect(canShowMore(5000, null)).toBe(false);
    expect(canShowMore(13, null)).toBe(false);
    expect(showMoreLabel(500, null)).toBe('Show next 500');
    expect(summaryText(500, null)).toBe('500 shown, counting the rest');
    expect(knownTotal(null, 12345)).toBe(12345);
    expect(knownTotal(700, 12345)).toBe(700);
    expect(knownTotal(null, null)).toBeNull();
  });
  it('asks for the numbers again only when something but the order changed', () => {
    const base = { ...EMPTY_SEARCH, category: 'photos' as const };
    expect(countsKeyOf({ ...base, sort: 'date', sortDir: 'asc', offset: 500 })).toBe(countsKeyOf(base));
    expect(countsKeyOf({ ...base, text: 'reunion' })).not.toBe(countsKeyOf(base));
    expect(countsKeyOf({ ...base, category: 'videos' })).not.toBe(countsKeyOf(base));
    expect(countsKeyOf({ ...base, placeIds: ['a'] })).not.toBe(countsKeyOf(base));
  });
  it('words the button and the heading', () => {
    expect(showMoreLabel(500, 12345)).toBe('Show next 500');
    expect(showMoreLabel(1000, 1300)).toBe('Show next 300');
    expect(showMoreLabel(4500, 12345)).toBe('Show next 500');
    expect(summaryText(500, 12345)).toBe('500 of 12,345 shown');
    expect(summaryText(5000, 12345)).toBe('5,000 of 12,345 shown; narrow the search to see the rest');
    expect(summaryText(13, 13)).toBe('13 found');
  });
  it('asks for whole pages and adds rows without repeats', () => {
    expect(nextOffset(500)).toBe(500);
    expect(nextOffset(1000)).toBe(1000);
    expect(nextOffset(0)).toBe(0);
    const h = (key: string): SearchHit => ({ key }) as SearchHit;
    expect(appendHits([h('a'), h('b')], [h('b'), h('c')]).map((x) => x.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('counts on the chips', () => {
  const facets: SearchFacets = { categories: { videos: 88, photos: 1203 }, places: { lap: 5, g1: 3, g2: 4 } };
  it('reads a type and a place chip, and nothing when there are no counts', () => {
    expect(categoryCount(facets, 'videos')).toBe(88);
    expect(categoryCount(facets, 'audio')).toBe(0);
    expect(categoryCount(null, 'videos')).toBeNull();
    expect(placeCount(facets, { placeIds: ['lap'] })).toBe(5);
    expect(placeCount(facets, { placeIds: ['g1', 'g2', 'g3'] })).toBe(7);
    expect(placeCount(null, { placeIds: ['lap'] })).toBeNull();
    expect(countText(1203)).toBe('1,203');
    expect(countText(null)).toBe('');
  });
});

describe('in this folder and clear filters', () => {
  it('shows the folder of a copy as the person knows paths', () => {
    expect(folderBoxText({ relPath: 'D:/MyData/Reunion/final/a.mp4', placeKind: 'laptop' })).toBe('D:\\MyData\\Reunion\\final');
    expect(folderBoxText({ relPath: 'My Drive/Reunion/a.mp4', placeKind: 'gdrive' })).toBe('My Drive/Reunion');
    expect(folderBoxText({ relPath: 'a.mp4', placeKind: 'drive' })).toBe('');
  });
  it('knows when filters are set (the text and the sort do not count)', () => {
    expect(hasFilters({ ...EMPTY_SEARCH, text: 'a', sort: 'size' })).toBe(false);
    expect(hasFilters({ ...EMPTY_SEARCH, folder: 'x' })).toBe(true);
    expect(hasFilters({ ...EMPTY_SEARCH, extensions: ['pdf'] })).toBe(true);
  });
  it('mentions the new filters when nothing is found', () => {
    expect(noMatchText({ ...EMPTY_SEARCH, text: 'x', minSize: 5, folder: 'f', extensions: ['pdf', 'mp4'], fromDate: 1 })).toContain('of that size in that folder ending in .pdf, .mp4 in those dates');
  });
});

describe('copies per place in the details panel', () => {
  const copy = (fileId: number, placeId: string, relPath: string, lastLookedAt: number | null = 5): SearchCopy => ({
    fileId,
    placeId,
    placeLabel: placeId.toUpperCase(),
    placeKind: 'drive',
    lastLookedAt,
    relPath,
    size: 1,
    mtime: 1,
    cloudOnly: false,
    hasWebLink: false,
    checked: true,
    verified: false,
  });

  it('groups the listed copies under their place with the exact count, even when not all are listed', () => {
    const hit = {
      perPlace: [
        { placeId: 'lap', placeLabel: 'STUDY-PC', placeKind: 'laptop', files: 2 },
        { placeId: 't7', placeLabel: 'T7', placeKind: 'drive', files: 130 },
      ],
      copies: [copy(1, 'lap', 'D:/a/x.jpg', 9), copy(2, 't7', 'a/x.jpg'), copy(3, 'lap', 'D:/b/x.jpg', 9), copy(4, 't7', 'b/x.jpg')],
    };
    const groups = placeGroups(hit);
    expect(groups.map((g) => [g.label, g.files, g.copies.map((c) => c.fileId), g.notListed, g.lastLookedAt])).toEqual([
      ['STUDY-PC', 2, [1, 3], 0, 9],
      ['T7', 130, [2, 4], 128, 5],
    ]);
    expect(copiesTotalText(hit)).toBe('132 copies in 2 places');
    expect(copiesTotalText({ perPlace: [{ placeId: 'lap', placeLabel: 'L', placeKind: 'laptop', files: 1 }] })).toBe('1 copy in 1 place');
    expect(copiesText(1_234)).toBe('1,234 copies');
  });
});

describe('the More button', () => {
  it('counts the extension and the few-copies switch', () => {
    expect(moreOnCount(EMPTY_SEARCH)).toBe(0);
    expect(moreOnCount({ ...EMPTY_SEARCH, extensions: ['pdf'] })).toBe(1);
    expect(moreOnCount({ ...EMPTY_SEARCH, extensions: ['pdf'], fewCopies: true })).toBe(2);
    expect(moreOnCount({ ...EMPTY_SEARCH, unfingerprinted: true })).toBe(1);
  });
});

describe('the one line "Lists from"', () => {
  const NOW = new Date(2026, 10, 24, 12, 0).getTime();
  const checked = (p: PlaceView, lastLookedAt: number | null): PlaceView => ({ ...p, lastLookedAt });
  const at = (m: number, d: number, h = 8, min = 0): number => new Date(2026, m, d, h, min).getTime();

  it('says when each place was checked: today with the time, else the day', () => {
    const items = listsFrom(
      [checked(place('lap', 'laptop', 'STUDY-PC', 100), at(10, 24, 9, 39)), checked(place('t7', 'drive', 'T7', 50), at(10, 9)), checked(place('sg', 'drive', 'Seagate2TB', 50, 'disconnected'), at(10, 9))],
      new Set(),
      NOW,
    );
    expect(items.map((i) => i.text)).toEqual(['STUDY-PC today 09:39', 'T7 9 Nov', 'Seagate2TB 9 Nov (not plugged in)']);
  });

  it('draws a place amber when it was checked more than 14 days ago, or never', () => {
    const items = listsFrom(
      [checked(place('lap', 'laptop', 'STUDY-PC', 100), NOW - 14 * 86_400_000), checked(place('t7', 'drive', 'T7', 50), NOW - 14 * 86_400_000 - 1000), checked(place('sg', 'drive', 'Seagate2TB', 50), null)],
      new Set(),
      NOW,
    );
    // The laptop, then the drives by name: Seagate2TB (never checked) before T7.
    expect(items.map((i) => [i.placeId, i.old])).toEqual([['lap', false], ['sg', true], ['t7', true]]);
    expect(items[1]?.text).toBe('Seagate2TB not checked yet');
  });

  it('puts the laptop first, then OneDrive, then drives that are plugged in before the others', () => {
    const items = listsFrom(
      [checked(place('a', 'drive', 'Aaa', 5, 'disconnected'), 1), checked(place('t7', 'drive', 'T7', 5), 1), checked(place('od', 'onedrive', 'OneDrive', 5, 'disconnected'), 1), checked(place('lap', 'laptop', 'STUDY-PC', 5), 1)],
      new Set(),
      NOW,
    );
    expect(items.map((i) => i.placeId)).toEqual(['lap', 'od', 't7', 'a']);
    expect(items[1]?.text).toContain('(not connected)');
  });

  it('covers only the places being searched, and only those with files listed', () => {
    const all = [checked(place('lap', 'laptop', 'STUDY-PC', 100), 1), checked(place('t7', 'drive', 'T7', 50), 1), checked(place('g1', 'gdrive', 'a', 10), 1), checked(place('e', 'drive', 'Empty', 0), 1)];
    expect(listsFrom(all, new Set(), NOW).map((r) => r.placeId)).toEqual(['lap', 't7']);
    expect(listsFrom(all, new Set(['t7']), NOW).map((r) => r.placeId)).toEqual(['t7']);
    expect(listsFrom([], new Set(), NOW)).toEqual([]);
  });
});

describe('size choices', () => {
  it('reads a unit typed in the box, which wins over the shared unit', () => {
    expect(sizeBound('500 MB', 'GB')).toBe(500_000_000);
    expect(sizeBound('2 GB', 'MB')).toBe(2_000_000_000);
    expect(sizeBound('2gb', 'MB')).toBe(2_000_000_000);
    expect(sizeBound('1,5 Gb', 'MB')).toBe(1_500_000_000);
    expect(sizeBound('500', 'GB')).toBe(500_000_000_000);
    for (const bad of ['500 KB', 'MB', '2 GB extra', '2 G B']) expect(sizeBound(bad, 'MB'), bad).toBeNull();
  });
  it('turns the ready-made sizes and the custom boxes (one shared unit) into bounds', () => {
    expect(sizeBounds(ANY_SIZE)).toEqual({ minSize: null, maxSize: null });
    expect(sizeBounds({ ...ANY_SIZE, mode: 'over10mb' })).toEqual({ minSize: 10_000_000, maxSize: null });
    expect(sizeBounds({ ...ANY_SIZE, mode: 'over100mb' }).minSize).toBe(100_000_000);
    expect(sizeBounds({ ...ANY_SIZE, mode: 'over1gb' }).minSize).toBe(1_000_000_000);
    expect(sizeBounds({ mode: 'custom', min: '500', max: '2000', unit: 'MB' })).toEqual({ minSize: 500_000_000, maxSize: 2_000_000_000 });
    expect(sizeBounds({ mode: 'custom', min: '1', max: '2', unit: 'GB' })).toEqual({ minSize: 1_000_000_000, maxSize: 2_000_000_000 });
    expect(sizeBounds({ mode: 'custom', min: '500 MB', max: '2 GB', unit: 'GB' })).toEqual({ minSize: 500_000_000, maxSize: 2_000_000_000 });
    expect(sizeBounds({ mode: 'custom', min: '', max: '', unit: 'GB' })).toEqual({ minSize: null, maxSize: null });
    // A reversed pair is put the right way round.
    expect(sizeBounds({ mode: 'custom', min: '2', max: '1', unit: 'GB' })).toEqual({ minSize: 1_000_000_000, maxSize: 2_000_000_000 });
    // Typed values stay while a ready-made size is picked, but do nothing.
    expect(sizeBounds({ mode: 'over10mb', min: '5', max: '6', unit: 'GB' })).toEqual({ minSize: 10_000_000, maxSize: null });
  });
  it('words the Size button', () => {
    expect(sizeSummary(ANY_SIZE)).toBe('Any size');
    expect(sizeSummary({ ...ANY_SIZE, mode: 'over1gb' })).toBe('Over 1 GB');
    expect(sizeSummary({ mode: 'custom', min: '500', max: '2 GB', unit: 'MB' })).toBe('500 MB to 2 GB');
    expect(sizeSummary({ mode: 'custom', min: '1.5', max: '', unit: 'GB' })).toBe('Over 1.5 GB');
    expect(sizeSummary({ mode: 'custom', min: '', max: '300', unit: 'MB' })).toBe('Up to 300 MB');
    expect(sizeSummary({ mode: 'custom', min: '', max: '', unit: 'MB' })).toBe('Custom...');
  });
});

describe('when choices', () => {
  const none = { mode: 'any' as const, year: '', from: '', to: '' };
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  it('this year and last year follow the clock', () => {
    expect(dateBounds({ ...none, mode: 'thisYear' }, now)).toEqual({ fromDate: new Date(2026, 0, 1).getTime(), toDate: new Date(2027, 0, 1).getTime() - 1 });
    expect(dateBounds({ ...none, mode: 'lastYear' }, now)).toEqual({ fromDate: new Date(2025, 0, 1).getTime(), toDate: new Date(2026, 0, 1).getTime() - 1 });
  });
  it('words the When button', () => {
    expect(dateSummary(none)).toBe('Any time');
    expect(dateSummary({ ...none, mode: 'thisYear' })).toBe('This year');
    expect(dateSummary({ ...none, mode: 'lastYear' })).toBe('Last year');
    expect(dateSummary({ ...none, mode: 'year', year: '2022' })).toBe('2022');
    expect(dateSummary({ ...none, mode: 'range', from: '2022-10-14', to: '' })).toBe('2022-10-14 to now');
    expect(dateSummary({ ...none, mode: 'range' })).toBe('From - to...');
  });
});

describe('offline places', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  const t7Looked = new Date(2026, 9, 30, 9, 0).getTime();
  const odLooked = new Date(2026, 9, 31, 8, 0).getTime();
  const withDates = [
    { ...place('lap', 'laptop', 'STUDY-PC', 100), lastLookedAt: now },
    { ...place('t7', 'drive', 'T7', 50, 'disconnected'), lastLookedAt: t7Looked },
    { ...place('od', 'onedrive', 'OneDrive', 40, 'disconnected'), lastLookedAt: odLooked },
    place('g1', 'gdrive', 'a@example.com', 10),
  ];
  it('marks each chip connected or not; Google Drive counts as connected when any account is', () => {
    const chips = placeChips(withDates);
    expect(chips.map((c) => [c.label, c.connected, c.offline])).toEqual([
      ['OneDrive', false, true],
      ['STUDY-PC', true, false],
      ['T7', false, true],
      ['Google Drive', true, false],
    ]);
  });
  it('marks a copy on an unplugged drive, and disables Show in folder with the reason', () => {
    expect(isOfflinePlace('t7', 'drive', withDates)).toBe(true);
    expect(isOfflinePlace('lap', 'laptop', withDates)).toBe(false);
    expect(isOfflinePlace('g1', 'gdrive', withDates)).toBe(false);
    expect(isOfflinePlace('gone', 'drive', withDates)).toBe(false);
    expect(showInFolderState({ placeId: 'lap', placeKind: 'laptop', placeLabel: 'STUDY-PC' }, withDates)).toEqual({ state: 'enabled' });
    expect(showInFolderState({ placeId: 't7', placeKind: 'drive', placeLabel: 'T7' }, withDates)).toEqual({ state: 'disabled', reason: 'T7 is not connected. Connect it to open this folder.' });
    expect(showInFolderState({ placeId: 'g1', placeKind: 'gdrive', placeLabel: 'a@example.com' }, withDates)).toEqual({ state: 'hidden' });
  });
  it('labels Open in Drive with the account', () => {
    expect(driveButtonLabel({ placeLabel: 'sam@example.com' })).toBe('Open in Drive as sam@example.com');
    expect(driveButtonLabel({ placeLabel: 'Family photos' })).toBe('Open in Drive');
  });
});

describe('the Type menu offers kinds too', () => {
  it('lists every kind with the type it belongs to and names the button after the kind', () => {
    expect(KIND_OPTIONS.find((o) => o.key === 'video-camera')).toEqual({ key: 'video-camera', label: 'Camera videos', category: 'videos' });
    expect(typeSummary(null, null)).toBe('All types');
    expect(typeSummary('videos', null)).toBe('Videos');
    expect(typeSummary('videos', 'video-camera')).toBe('Camera videos');
  });
  it('keeps the type and the kind from contradicting each other', () => {
    expect(chooseKind('video-camera')).toEqual({ category: 'videos', kind: 'video-camera' });
    expect(chooseKind(null)).toEqual({ category: null, kind: null });
    expect(chooseCategory({ category: 'videos', kind: 'video-camera' }, 'videos')).toEqual({ category: 'videos', kind: 'video-camera' });
    expect(chooseCategory({ category: 'videos', kind: 'video-camera' }, 'photos')).toEqual({ category: 'photos', kind: null });
    expect(chooseCategory({ category: 'videos', kind: 'video-camera' }, null)).toEqual({ category: null, kind: null });
  });
  it('counts "only in one place" and "not checked yet" in More', () => {
    expect(hasFilters({ ...EMPTY_SEARCH, onlyOnePlace: true })).toBe(true);
    expect(moreOnCount({ ...EMPTY_SEARCH, onlyOnePlace: true, unfingerprinted: true })).toBe(2);
  });
});
