import { describe, expect, it } from 'vitest';
import { cleanName, heldReason, knownSha, numberedFile, numberedName, preferredSources, protectedReason, reasonsText, restoreFolderName, safeParts } from './restoreModel';

describe('where a restore may write', () => {
  it('never writes under a drive\'s MyData folder, whatever the letter', () => {
    for (const p of ['F:\\MyData', 'G:\\MyData\\POCO', 'd:/mydata/x', 'D:\\MyData']) expect(protectedReason(p), p).toContain('MyData is protected');
  });
  it('refuses an empty, relative or non-laptop path and accepts a normal folder', () => {
    expect(protectedReason('')).not.toBeNull();
    expect(protectedReason('relative\\folder')).not.toBeNull();
    expect(protectedReason('D:\\Restored')).toBeNull();
    expect(protectedReason('D:\\MyDataOther')).toBeNull();
  });
});

describe('names', () => {
  it('makes a new folder name from the backup and the day, and numbers a taken one', () => {
    expect(restoreFolderName('Poco F4', new Date(2026, 10, 26, 12).getTime())).toBe('Poco F4-2026-11-26');
    expect(restoreFolderName('a<b>:c.', new Date(2026, 0, 5, 12).getTime())).toBe('a-b--c-2026-01-05');
    expect(restoreFolderName('...', new Date(2026, 0, 5, 12).getTime())).toBe('Backup-2026-01-05');
    expect(numberedName('X-2026-11-26', 1)).toBe('X-2026-11-26');
    expect(numberedName('X-2026-11-26', 2)).toBe('X-2026-11-26 (2)');
    expect(numberedFile('a.jpg', 2)).toBe('a (2).jpg');
    expect(numberedFile('README', 3)).toBe('README (3)');
    expect(cleanName('a/b\\c')).toBe('a-b-c');
  });
  it('safeParts refuses anything that could leave the folder', () => {
    expect(safeParts('DCIM/Camera/a.jpg')).toEqual(['DCIM', 'Camera', 'a.jpg']);
    for (const bad of ['', '../a', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a', 'a/b?']) expect(safeParts(bad), bad).toBeNull();
  });
});

describe('which copies may come back', () => {
  it('needs a known checksum and no "found different"', () => {
    expect(heldReason({ size: 1, sha256: 'a', expected: null, verifiedHow: null })).toBeNull();
    expect(heldReason({ size: 1, sha256: null, expected: 'b', verifiedHow: null })).toBeNull();
    expect(heldReason({ size: 1, sha256: null, expected: null, verifiedHow: null })).toBe('no_checksum');
    expect(heldReason({ size: 1, sha256: 'a', expected: null, verifiedHow: 'differs' })).toBe('differs');
    expect(knownSha({ sha256: 'a', expected: 'b' })).toBe('a');
  });
  it('prefers the T7, then the others in the backup\'s own order', () => {
    const list = [{ label: 'Seagate2TB', position: 1 }, { label: 'T7', position: 2 }, { label: 'Other', position: 3 }];
    expect(preferredSources(list).map((s) => s.label)).toEqual(['T7', 'Seagate2TB', 'Other']);
  });
  it('says why files stayed behind in one short line', () => {
    const none = { no_checksum: 0, differs: 0, damaged: 0, missing: 0, protected: 0, failed: 0, no_space: 0 };
    expect(reasonsText(none)).toBe('');
    expect(reasonsText({ ...none, no_checksum: 2, missing: 1 })).toBe('2 never checked, 1 no copy to reach now');
  });
});
