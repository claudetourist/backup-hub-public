import { describe, expect, it } from 'vitest';
import { categoryOf, extensionOf, SEARCH_CATEGORIES } from './fileCategories';

describe('extensionOf', () => {
  it('takes the text after the last dot, in lower case', () => {
    expect(extensionOf('IMG_0001.JPG')).toBe('jpg');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf('')).toBe('');
  });
});

describe('categoryOf', () => {
  const cases: [string, string | null, string][] = [
    ['a.jpg', null, 'photos'],
    ['a.HEIC', null, 'photos'],
    ['a.mp4', null, 'videos'],
    ['a.MOV', 'video/quicktime', 'videos'],
    ['a.mp3', null, 'audio'],
    ['a.m4a', null, 'audio'],
    ['a.pdf', null, 'documents'],
    ['a.docx', null, 'documents'],
    ['a.xlsx', null, 'documents'],
    ['a.txt', null, 'documents'],
    ['a.zip', null, 'archives'],
    ['a.7z', null, 'archives'],
    ['a.exe', null, 'other'],
    ['noext', null, 'other'],
    ['Budget', 'application/vnd.google-apps.spreadsheet', 'googleDocs'],
    ['Slides', 'application/vnd.google-apps.presentation', 'googleDocs'],
    ['Budget.xlsx', 'application/vnd.google-apps.spreadsheet', 'googleDocs'],
    // no extension on the name: the mime decides
    ['photo', 'image/png', 'photos'],
    ['clip', 'video/mp4', 'videos'],
    ['song', 'audio/mpeg', 'audio'],
    ['paper', 'application/pdf', 'documents'],
    ['notes', 'text/plain', 'documents'],
    ['bundle', 'application/zip', 'archives'],
    ['thing', 'application/octet-stream', 'other'],
    // the extension wins over a vague mime
    ['a.mp4', 'application/octet-stream', 'videos'],
  ];
  for (const [name, mime, expected] of cases) {
    it(`${name} (${mime ?? 'no mime'}) is ${expected}`, () => {
      expect(categoryOf(name, mime)).toBe(expected);
    });
  }

  it('always answers one of the known categories', () => {
    for (const name of ['', '.', '..', 'a.b.c.d', 'ÄÖ.jpg']) expect(SEARCH_CATEGORIES).toContain(categoryOf(name, null));
  });
});
