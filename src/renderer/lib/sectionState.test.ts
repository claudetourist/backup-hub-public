import { describe, expect, it } from 'vitest';
import { readSectionOpen, sectionKey, writeSectionOpen, type TinyStorage } from './sectionState';

function memory(initial: Record<string, string> = {}): TinyStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('section open state', () => {
  it('uses the default until the user chooses, then remembers the choice per section', () => {
    const store = memory();
    expect(readSectionOpen(store, 'google', false)).toBe(false);
    expect(readSectionOpen(store, 'places', true)).toBe(true);
    writeSectionOpen(store, 'google', true);
    writeSectionOpen(store, 'places', false);
    expect(store.data[sectionKey('google')]).toBe('1');
    expect(readSectionOpen(store, 'google', false)).toBe(true);
    expect(readSectionOpen(store, 'places', true)).toBe(false);
  });

  it('falls back to the default for junk values and a store that throws', () => {
    expect(readSectionOpen(memory({ [sectionKey('x')]: 'maybe' }), 'x', true)).toBe(true);
    const broken: TinyStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSectionOpen(broken, 'x', false)).toBe(false);
    expect(() => writeSectionOpen(broken, 'x', true)).not.toThrow();
    expect(readSectionOpen(null, 'x', true)).toBe(true);
  });
});
