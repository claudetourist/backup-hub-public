import { describe, expect, it } from 'vitest';
import { endingOf, namePrefix, toKindChange } from './kinds';

describe('similar files', () => {
  it('reads the ending and the start of a name', () => {
    expect(endingOf('IMG_001.JPG')).toBe('jpg');
    expect(endingOf('README')).toBe('');
    expect(namePrefix('IMG_20240101.mp4')).toBe('img_');
    expect(namePrefix('a1.jpg')).toBe('');
  });
});

describe('what the window may ask', () => {
  it('refuses broken input and accepts a good change of kind', () => {
    expect(toKindChange({ kind: 'nope', targets: [{ type: 'file', fileId: 2 }] }).ok).toBe(false);
    for (const bad of [null, 'x', {}, { kind: 'video-camera', targets: [] }, { kind: 'video-camera', targets: [{ type: 'file', fileId: -1 }] }, { kind: 'video-camera', targets: [{ type: 'folder', placeId: 'p', folder: 'A' }] }]) {
      expect(toKindChange(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(toKindChange({ kind: 'video-camera', targets: [{ type: 'file', fileId: 2 }], similar: true })).toMatchObject({ ok: true, value: { similar: true } });
  });
});
