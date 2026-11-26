/** How many rows a long table draws at first, and how many more each "Show more" adds. */
export const WINDOW_ROWS = 300;

/**
 * How many rows to draw: the window asked for, but never fewer than needed to include the selected row (so a row the
 * person picked is never hidden), and never more than there are.
 */
export function shownCount(total: number, wanted: number, selectedIndex: number): number {
  const base = Math.max(1, wanted);
  const needed = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  return Math.min(total, Math.max(base, needed));
}

/** The step "Show more" takes, never past the end. */
export function nextWindow(total: number, shown: number, step: number = WINDOW_ROWS): number {
  return Math.min(total, shown + Math.max(1, step));
}
