import { describe, expect, it } from 'vitest';
import { effectiveSortDir, EMPTY_SEARCH, folderOf, folderWords, hasSearchCriteria, MAX_SEARCH_WORDS, parseExtensions, resultsSummary, searchWords, toSearchRequest } from './search';

describe('searchWords', () => {
  it('lower-cases, splits on any spaces, drops repeats and caps the number of words', () => {
    expect(searchWords('  Holiday   ROME\tholiday ')).toEqual(['holiday', 'rome']);
    expect(searchWords('')).toEqual([]);
    expect(searchWords(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))).toHaveLength(MAX_SEARCH_WORDS);
  });
});

describe('hasSearchCriteria', () => {
  it('needs words, a filter or a chosen sort', () => {
    expect(hasSearchCriteria(EMPTY_SEARCH)).toBe(false);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, text: '   ' })).toBe(false);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, includeFolders: true })).toBe(false);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, text: 'a' })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, category: 'videos' })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, placeIds: ['p'] })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, fewCopies: true })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, sort: 'size' })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, sortDir: 'desc', offset: 500 })).toBe(false);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, minSize: 0 })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, maxSize: 5 })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, folder: 'reunion' })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, folder: '   ' })).toBe(false);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, extensions: ['pdf'] })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, fromDate: 1 })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, toDate: 1 })).toBe(true);
  });
});

describe('toSearchRequest', () => {
  it('takes a known kind and the only-one-place flag, and drops an unknown kind', () => {
    expect(toSearchRequest({ kind: 'video-camera', onlyOnePlace: true })).toMatchObject({ kind: 'video-camera', onlyOnePlace: true });
    expect(toSearchRequest({ kind: 'nonsense', onlyOnePlace: 'yes' })).toMatchObject({ kind: null, onlyOnePlace: false });
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, kind: 'documents' })).toBe(true);
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, onlyOnePlace: true })).toBe(true);
  });

  it('reads the person (a whole id, else everyone); a person alone is not a reason to search', () => {
    expect(toSearchRequest({ person: 3 }).person).toBe(3);
    for (const bad of [0, -1, 1.5, '3', null, undefined, true]) expect(toSearchRequest({ person: bad }).person).toBeNull();
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, person: 3 })).toBe(false);
  });

  it('keeps good values and drops bad ones', () => {
    expect(toSearchRequest({ text: 'x', includeFolders: true, category: 'videos', placeIds: ['a', 'a', 3, ''], fewCopies: true, sort: 'date' })).toEqual({
      text: 'x',
      includeFolders: true,
      category: 'videos',
      placeIds: ['a'],
      fewCopies: true,
      kind: null,
      onlyOnePlace: false,
      person: null,
      unfingerprinted: false,
      sort: 'date',
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
    });
    expect(toSearchRequest({ review: 'later', part: 'review' })).toMatchObject({ part: 'page' });
    expect(toSearchRequest({ category: 'nope', sort: 'nope', text: 5, includeFolders: 'yes', placeIds: 'a' })).toEqual(EMPTY_SEARCH);
    for (const junk of [null, undefined, 'text', 5, []]) expect(toSearchRequest(junk)).toEqual(EMPTY_SEARCH);
    expect(toSearchRequest({ text: 'a'.repeat(5000) }).text).toHaveLength(400);
  });
});

describe('resultsSummary and folderOf', () => {
  it('says how many are shown', () => {
    expect(resultsSummary(0, 0)).toBe('Nothing found');
    expect(resultsSummary(1, 1)).toBe('1 found');
    expect(resultsSummary(13, 13)).toBe('13 found');
    expect(resultsSummary(500, 12345)).toBe('500 of 12,345 shown; narrow the search to see the rest');
  });
  it('cuts the folder off a stored path', () => {
    expect(folderOf('D:/MyData/a.jpg')).toBe('D:/MyData');
    expect(folderOf('a.jpg')).toBe('');
    expect(folderOf('My Drive/Photos/a.jpg')).toBe('My Drive/Photos');
  });
});

describe('parseExtensions, folderWords and effectiveSortDir', () => {
  it('reads extensions typed any way and drops what cannot be one', () => {
    expect(parseExtensions('pdf, mp4 .MOV;.jpg')).toEqual(['pdf', 'mp4', 'mov', 'jpg']);
    expect(parseExtensions('..pdf pdf *.txt a/b elevenchars1 ünï')).toEqual(['pdf']);
    expect(parseExtensions('')).toEqual([]);
  });
  it('treats both slashes alike in the folder box', () => {
    expect(folderWords('D:\\MyData\\Reunion  final')).toEqual(['d:/mydata/reunion', 'final']);
  });
  it('uses the usual direction of each sort unless one is given', () => {
    expect(effectiveSortDir({ sort: null, sortDir: null })).toBe('asc');
    expect(effectiveSortDir({ sort: 'size', sortDir: null })).toBe('desc');
    expect(effectiveSortDir({ sort: 'date', sortDir: null })).toBe('desc');
    expect(effectiveSortDir({ sort: 'copies', sortDir: null })).toBe('asc');
    expect(effectiveSortDir({ sort: 'size', sortDir: 'asc' })).toBe('asc');
  });
});
