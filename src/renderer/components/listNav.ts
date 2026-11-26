/** Keyboard movement through a list of rows or menu items. Pure. */

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp';

export function isListKey(key: string): key is ListKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' || key === 'PageDown' || key === 'PageUp';
}

/**
 * Where the highlight goes after a key. `index` is -1 when nothing is highlighted yet (Down then starts at the top, Up at the
 * bottom). With `wrap` the arrows go round (menus); without it they stop at the ends (tables).
 */
export function moveIndex(index: number, key: ListKey, count: number, pageSize = 10, wrap = false): number {
  if (count <= 0) return -1;
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return Math.min(last, Math.max(0, index) + Math.max(1, pageSize));
    case 'PageUp':
      return Math.max(0, (index < 0 ? 0 : index) - Math.max(1, pageSize));
    case 'ArrowDown':
      if (index < 0) return 0;
      return index >= last ? (wrap ? 0 : last) : index + 1;
    case 'ArrowUp':
      if (index < 0) return last;
      return index <= 0 ? (wrap ? last : 0) : index - 1;
  }
}
