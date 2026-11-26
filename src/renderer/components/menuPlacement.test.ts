import { describe, expect, it } from 'vitest';
import { chooseMenuPlacement, estimateMenuHeight } from './menuPlacement';

const base = { menuHeight: 130, boundsTop: 100, boundsBottom: 560 };

describe('which way a popup menu opens', () => {
  it('opens below when it fits below', () => {
    expect(chooseMenuPlacement({ ...base, buttonTop: 200, buttonBottom: 230 })).toBe('below');
  });
  it('opens above on one of the last rows of a scrolling list, where below would be cut off', () => {
    // The button is 20 px above the bottom edge of the list: only 20 px below, plenty above.
    expect(chooseMenuPlacement({ ...base, buttonTop: 510, buttonBottom: 540 })).toBe('above');
  });
  it('a menu that fits exactly below stays below', () => {
    expect(chooseMenuPlacement({ ...base, buttonTop: 400, buttonBottom: 430 })).toBe('below');
  });
  it('when it fits on neither side, it opens to the side with more room', () => {
    expect(chooseMenuPlacement({ menuHeight: 300, boundsTop: 0, boundsBottom: 200, buttonTop: 120, buttonBottom: 150 })).toBe('above');
    expect(chooseMenuPlacement({ menuHeight: 300, boundsTop: 0, boundsBottom: 200, buttonTop: 20, buttonBottom: 50 })).toBe('below');
  });
  it('the height of a menu is worked out from its items before it is drawn', () => {
    expect(estimateMenuHeight([])).toBe(10);
    expect(estimateMenuHeight([{}, {}])).toBe(82);
    expect(estimateMenuHeight([{ hint: 'x' }, { hint: 'y' }, {}])).toBe(158);
    // The three entries of a row's "Your choices" menu, with a line of help each, do not fit in the 20 px under the last row of the list.
    const menu = estimateMenuHeight([{ hint: 'a' }, { hint: 'b' }, { hint: 'c' }]);
    expect(chooseMenuPlacement({ buttonTop: 540, buttonBottom: 570, menuHeight: menu, boundsTop: 0, boundsBottom: 600 })).toBe('above');
    expect(chooseMenuPlacement({ buttonTop: 100, buttonBottom: 130, menuHeight: menu, boundsTop: 0, boundsBottom: 600 })).toBe('below');
  });
  it('the first row of the list opens below even though the bounds begin right above it', () => {
    expect(chooseMenuPlacement({ ...base, buttonTop: 101, buttonBottom: 131 })).toBe('below');
  });
});
