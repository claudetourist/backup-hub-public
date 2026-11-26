import { describe, expect, it } from 'vitest';
import { nextFocusIndex } from './focusTrap';
import { isListKey, moveIndex } from './listNav';
import { scrollTopToShow, visibleWindow } from './virtualWindow';
import { sortRows } from './sortRows';

describe('keyboard movement through a list', () => {
  it('Down starts at the top, Up starts at the bottom', () => {
    expect(moveIndex(-1, 'ArrowDown', 5)).toBe(0);
    expect(moveIndex(-1, 'ArrowUp', 5)).toBe(4);
  });
  it('arrows stop at the ends in a table and go round in a menu', () => {
    expect(moveIndex(4, 'ArrowDown', 5)).toBe(4);
    expect(moveIndex(0, 'ArrowUp', 5)).toBe(0);
    expect(moveIndex(4, 'ArrowDown', 5, 10, true)).toBe(0);
    expect(moveIndex(0, 'ArrowUp', 5, 10, true)).toBe(4);
  });
  it('Home, End, Page Down and Page Up', () => {
    expect(moveIndex(3, 'Home', 100)).toBe(0);
    expect(moveIndex(3, 'End', 100)).toBe(99);
    expect(moveIndex(3, 'PageDown', 100, 10)).toBe(13);
    expect(moveIndex(95, 'PageDown', 100, 10)).toBe(99);
    expect(moveIndex(13, 'PageUp', 100, 10)).toBe(3);
    expect(moveIndex(2, 'PageUp', 100, 10)).toBe(0);
  });
  it('an empty list has nowhere to go', () => {
    expect(moveIndex(-1, 'ArrowDown', 0)).toBe(-1);
  });
  it('knows which keys it handles', () => {
    expect(isListKey('ArrowDown')).toBe(true);
    expect(isListKey('Enter')).toBe(false);
  });
  it('Tab goes round inside a panel', () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });
});

describe('the rows of a long table in view', () => {
  it('draws a few rows plus spare ones, whatever the length', () => {
    for (const count of [50, 100_000]) {
      const win = visibleWindow(0, 400, 40, count);
      expect(win.start).toBe(0);
      expect(win.end - win.start).toBeLessThan(25);
      expect(win.padTop).toBe(0);
      expect(win.padBottom).toBe((count - win.end) * 40);
    }
  });
  it('keeps the total height right (rows drawn plus the empty space above and below)', () => {
    const count = 100_000;
    for (const scrollTop of [0, 400, 1_234_567, 3_999_000]) {
      const win = visibleWindow(scrollTop, 400, 40, count);
      expect(win.padTop + (win.end - win.start) * 40 + win.padBottom).toBe(count * 40);
    }
  });
  it('shows the last rows at the very end', () => {
    const win = visibleWindow(99_990 * 40, 400, 40, 100_000);
    expect(win.end).toBe(100_000);
    expect(win.padBottom).toBe(0);
  });
  it('draws nothing for no rows', () => {
    expect(visibleWindow(0, 400, 40, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
  it('scrolls only as far as needed to bring the highlighted row into view', () => {
    expect(scrollTopToShow(5, 0, 400, 40, 36)).toBe(0);
    expect(scrollTopToShow(20, 0, 400, 40, 36)).toBe(20 * 40 + 40 - (400 - 36));
    expect(scrollTopToShow(2, 400, 400, 40, 36)).toBe(80);
  });
  it('sorting 100,000 rows stays quick', () => {
    const rows = Array.from({ length: 100_000 }, (_unused, i) => ({ name: `file-${(i * 7919) % 100_000}`, size: (i * 31) % 977 }));
    const started = performance.now();
    sortRows(rows, (r) => r.size, 'desc');
    sortRows(rows, (r) => r.name, 'asc');
    expect(performance.now() - started).toBeLessThan(6000);
  });
  it('working out the window is instant even at 100,000 rows', () => {
    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) visibleWindow(i * 400, 400, 44, 100_000);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
