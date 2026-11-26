/** Keeps the Tab key inside an open panel (the Drawer). The index maths is pure; the DOM part is small. */

/** The next place for the focus when Tab or Shift+Tab is pressed among `count` controls; it goes round. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls inside a panel that Tab can reach, in page order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

/** Handles a Tab key inside `root`: moves the focus round instead of letting it leave. Returns true when it did. */
export function trapTab(event: { key: string; shiftKey: boolean; preventDefault: () => void }, root: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const controls = focusableIn(root);
  if (controls.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const wouldLeave = event.shiftKey ? current <= 0 : current === controls.length - 1;
  if (!wouldLeave) return false;
  event.preventDefault();
  controls[nextFocusIndex(current, controls.length, event.shiftKey)]?.focus();
  return true;
}
