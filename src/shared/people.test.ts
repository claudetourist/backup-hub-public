import { describe, expect, it } from 'vitest';
import { contrastRatio, ownedText, ownsLine, paletteColor, PERSON_COLORS, PERSON_PALETTE, removeBlockedMessage, textOn } from './people';

describe('person colours', () => {
  it('the palette has distinct colours and the person pink', () => {
    expect(new Set(PERSON_COLORS).size).toBe(PERSON_PALETTE.length);
    expect(PERSON_COLORS).toContain('#e74796');
    expect(paletteColor(' #E74796 ')).toBe('#e74796');
    expect(paletteColor('#123456')).toBeNull();
    expect(paletteColor(5)).toBeNull();
  });

  it('the text on a chip in any palette colour reads at least 4.5 to 1 (AA)', () => {
    for (const color of PERSON_COLORS) expect(contrastRatio(color, textOn(color))).toBeGreaterThanOrEqual(4.5);
    // Any colour at all: white or near black always reaches AA for normal text.
    for (const color of ['#808080', '#777777', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#888888', '#6b6b6b']) {
      expect(contrastRatio(color, textOn(color))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('what a person owns, in words', () => {
  it('joins the parts with commas and "and"', () => {
    expect(ownedText({ backups: 1, phones: 1, accounts: 0 })).toBe('1 backup and 1 phone');
    expect(ownedText({ backups: 2, phones: 1, accounts: 3 })).toBe('2 backups, 1 phone and 3 Google accounts');
    expect(ownedText({ backups: 0, phones: 0, accounts: 1 })).toBe('1 Google account');
    expect(ownedText({ backups: 0, phones: 0, accounts: 0 })).toBe('');
    expect(ownsLine({ backups: 0, phones: 0, accounts: 0 })).toBe('Owns nothing yet');
    expect(ownsLine({ backups: 1, phones: 0, accounts: 0 })).toBe('Owns 1 backup');
  });

  it('refuses to remove a person who still has things, with the plain sentence', () => {
    expect(removeBlockedMessage('Sam', { backups: 1, phones: 1, accounts: 0 })).toBe('Sam still has 1 backup and 1 phone. Give them to someone else first.');
    expect(removeBlockedMessage('Mom', { backups: 0, phones: 1, accounts: 0 })).toBe('Mom still has 1 phone. Give it to someone else first.');
    expect(removeBlockedMessage('Mom', { backups: 0, phones: 0, accounts: 0 })).toBeNull();
  });
});
