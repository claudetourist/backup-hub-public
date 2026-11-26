/** Keyboard shortcuts for the whole window, pure so they can be tested. */

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Ctrl+K (Cmd+K on a Mac): open Files search from anywhere. */
export function isSearchShortcut(event: KeyLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
}

/** Ctrl+Shift+G: the developer gallery (dev builds only). */
export function isGalleryShortcut(event: KeyLike): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g';
}

/** The search box of the Files screen carries this mark (TextField searchBox). */
export const SEARCH_BOX_SELECTOR = 'input[data-search-box]';

/**
 * Puts the cursor in the Files search box. The screen may still be loading, so it tries on the next few frames.
 * Returns a function that stops trying.
 */
export function focusSearchBox(root: ParentNode = document, frames = 30): () => void {
  let stopped = false;
  let left = frames;
  const attempt = (): void => {
    if (stopped) return;
    const box = root.querySelector<HTMLInputElement>(SEARCH_BOX_SELECTOR);
    if (box) {
      box.focus();
      box.select();
      return;
    }
    left -= 1;
    if (left > 0) requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    stopped = true;
  };
}
