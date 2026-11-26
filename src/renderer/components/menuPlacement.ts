/**
 * Which way a popup menu opens. Pure. A menu inside a scrolling list (the "Your choices" menu on a row of the file list) is cut off by the
 * list's own edge when it opens downwards on one of the last rows; it opens upwards then. The numbers are screen coordinates in pixels.
 */
export interface PlacementInput {
  /** Top and bottom edge of the button that opens the menu. */
  buttonTop: number;
  buttonBottom: number;
  /** How tall the open menu is. */
  menuHeight: number;
  /** The visible box the menu must stay inside: the nearest scrolling or clipping parent, else the window. */
  boundsTop: number;
  boundsBottom: number;
}

/** Below when it fits there; else above when it fits there; else the side with more room. */
export function chooseMenuPlacement(input: PlacementInput): 'below' | 'above' {
  const below = input.boundsBottom - input.buttonBottom;
  const above = input.buttonTop - input.boundsTop;
  if (below >= input.menuHeight) return 'below';
  if (above >= input.menuHeight) return 'above';
  return above > below ? 'above' : 'below';
}

/** About how tall a menu of these items is, before it is drawn: 36 px an item (56 with a line of help under it), the padding and the border. */
export function estimateMenuHeight(items: readonly { hint?: string | undefined }[]): number {
  return items.reduce((sum, item) => sum + (item.hint ? 56 : 36), 10);
}
