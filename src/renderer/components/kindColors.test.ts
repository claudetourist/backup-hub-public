import { describe, expect, it } from 'vitest';
import { SEARCH_CATEGORIES } from '../../shared/fileCategories';
import { FILE_KINDS } from '../../shared/fileKinds';
import { familyOfCategory, familyOfKind, KIND_FAMILIES } from './kindColors';

describe('kind colour families', () => {
  it('every category and every kind has a family, and every family is used', () => {
    const used = new Set(SEARCH_CATEGORIES.map((c) => familyOfCategory(c)));
    expect([...used].toSorted()).toEqual([...KIND_FAMILIES].toSorted());
    for (const kind of FILE_KINDS) expect(KIND_FAMILIES).toContain(familyOfKind(kind));
  });

  it('photo kinds share the photos colour, Google Docs has its own', () => {
    expect(familyOfKind('photo-screenshot')).toBe('photos');
    expect(familyOfKind('video-whatsapp')).toBe('videos');
    expect(familyOfKind('audio-recording')).toBe('audio');
    expect(familyOfKind('google-docs')).toBe('google-docs');
  });
});
