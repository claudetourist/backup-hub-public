import { describe, expect, it } from 'vitest';
import { nextWindow, shownCount, WINDOW_ROWS } from './windowRows';

describe('windowRows', () => {
  it('draws the window, or all rows when there are fewer', () => {
    expect(shownCount(5000, WINDOW_ROWS, -1)).toBe(WINDOW_ROWS);
    expect(shownCount(40, WINDOW_ROWS, -1)).toBe(40);
    expect(shownCount(0, WINDOW_ROWS, -1)).toBe(0);
  });
  it('never hides the selected row', () => {
    expect(shownCount(5000, 300, 1200)).toBe(1201);
    expect(shownCount(5000, 300, 10)).toBe(300);
    expect(shownCount(100, 300, 90)).toBe(100);
  });
  it('shows more in steps and stops at the end', () => {
    expect(nextWindow(1000, 300)).toBe(600);
    expect(nextWindow(1000, 900)).toBe(1000);
    expect(nextWindow(1000, 1000)).toBe(1000);
  });
});
