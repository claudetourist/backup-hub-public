import { describe, expect, it } from 'vitest';
import { mockCases } from '../dev/mockDecisions';
import { afterRunTitle, CASES_SHOWN, foundText, needsYouBadgeLabel, needsYouTotal, showMoreText, similarText, splitCases } from './decisionsModel';

const NOW = new Date(2026, 10, 24, 15, 0, 0).getTime();

describe('the words of "Needs your decision"', () => {
  it('one count for the cases and the other lines of "Needs you", said in words for a screen reader', () => {
    expect(needsYouTotal(3, 4)).toBe(7);
    expect(needsYouBadgeLabel(1)).toBe('1 thing needs you');
    expect(needsYouBadgeLabel(7)).toBe('7 things need you');
    expect(afterRunTitle(2)).toBe('Needs your decision (2)');
  });

  it('says when it was found, in the same way Activity says it', () => {
    expect(foundText(new Date(2026, 10, 24, 14, 5).getTime(), NOW)).toBe('Found: Today 14:05');
    expect(foundText(new Date(2026, 10, 23, 9, 30).getTime(), NOW)).toBe('Found: Yesterday 09:30');
  });

  it('offers "do the same for the others" only where the case says there are others', () => {
    const [drive, look, differs] = mockCases();
    expect(similarText(drive!)).toBeNull();
    expect(similarText(look!)).toBeNull(); // a refused look is never answered for others
    expect(similarText(differs!)).toBe('Do the same for the other 11 copies');
    expect(similarText({ source: 'copy_differs', similar: 1 })).toBe('Do the same for the other 1 copy');
  });

  it('keeps the cases beyond the first five behind "Show N more", and shows them all when asked', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...mockCases()[0]!, key: 'drive:' + (i + 1) }));
    expect(splitCases(many.slice(0, CASES_SHOWN), false)).toMatchObject({ hidden: 0 });
    const cut = splitCases(many, false);
    expect(cut.shown).toHaveLength(5);
    expect(cut.hidden).toBe(3);
    expect(showMoreText(cut.hidden)).toBe('Show 3 more');
    expect(splitCases(many, true)).toMatchObject({ hidden: 0, shown: many });
  });
});
