import { describe, expect, it } from 'vitest';
import { groupFromText, neighbourGroup, SETTINGS_GROUPS } from './settingsMenu';

describe('settings menu', () => {
  it('lists the seven groups, in order', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['Appearance', 'Drives and accounts', 'Performance', 'People', 'Security', 'Tools', 'Advanced']);
  });
  it('picks a group from text, else the first', () => {
    expect(groupFromText('#settings,tools')).toBe('tools');
    expect(groupFromText('#settings,security')).toBe('security');
    expect(groupFromText('#settings')).toBe('appearance');
  });
  it('moves to the neighbours and stops at the ends', () => {
    expect(neighbourGroup('appearance', -1)).toBe('appearance');
    expect(neighbourGroup('appearance', 1)).toBe('drives');
    expect(neighbourGroup('advanced', 1)).toBe('advanced');
  });
});
