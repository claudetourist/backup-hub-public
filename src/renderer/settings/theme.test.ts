import { describe, expect, it } from 'vitest';
import { themeAttribute } from './theme';

describe('themeAttribute', () => {
  it('maps system to no attribute and light/dark to themselves', () => {
    expect(themeAttribute('system')).toBeNull();
    expect(themeAttribute('light')).toBe('light');
    expect(themeAttribute('dark')).toBe('dark');
  });
});
