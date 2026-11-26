/**
 * Which rows of a very long table are drawn. Only the rows in view (plus a few spare above and below) exist in the page, so
 * 100,000 rows scroll as smoothly as 100. Rows have one fixed height. Pure.
 */
export interface VirtualWindow {
  /** First row drawn. */
  start: number;
  /** One past the last row drawn. */
  end: number;
  /** Empty height standing in for the rows above and below that are not drawn. */
  padTop: number;
  padBottom: number;
}

export const DEFAULT_ROW_HEIGHT = 44;
export const OVERSCAN_ROWS = 6;

export function visibleWindow(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = OVERSCAN_ROWS): VirtualWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const inView = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.min(Math.max(0, count - 1), Math.max(0, first - overscan));
  const end = Math.min(count, first + inView + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** The scrollTop that brings row `index` fully into view, or the current one when it already is. */
export function scrollTopToShow(index: number, scrollTop: number, viewportHeight: number, rowHeight: number, headerHeight = 0): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  // The sticky header covers the first `headerHeight` pixels of the view.
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight - headerHeight) return bottom - (viewportHeight - headerHeight);
  return scrollTop;
}
