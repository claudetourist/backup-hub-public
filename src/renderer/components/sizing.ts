/**
 * Dynamic widths under the strict CSP (style-src 'self': no inline style attributes).
 * Setting a property through the CSSOM (element.style.width = ...) is allowed; only style
 * *attributes* in markup are blocked. These ref callbacks are the single place that does it.
 */

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Ref callback factory: sets the element's width to the given percentage (0..100). */
export function widthPercentRef(percent: number): (element: HTMLElement | null) => void {
  const width = `${clampPercent(percent)}%`;
  return (element) => {
    if (element) element.style.width = width;
  };
}

/** Ref callback factory: sets the element's height in pixels. */
export function heightPxRef(px: number): (element: HTMLElement | null) => void {
  const height = `${Math.max(0, Math.round(Number.isFinite(px) ? px : 0))}px`;
  return (element) => {
    if (element) element.style.height = height;
  };
}

/** Ref callback factory: sets the element's width in pixels. */
export function widthPxRef(px: number): (element: HTMLElement | null) => void {
  const width = `${Math.max(0, Math.round(Number.isFinite(px) ? px : 0))}px`;
  return (element) => {
    if (element) element.style.width = width;
  };
}

/** Ref callback factory: sets a CSS custom property on the element (for example the row height of a long table). */
export function cssVarRef(name: string, value: string): (element: HTMLElement | null) => void {
  return (element) => {
    if (element) element.style.setProperty(name, value);
  };
}

/** Ref callback factory: a chip filled with a person's colour (#rrggbb) and the text colour that reads on it (set as two custom properties). */
export function chipColorsRef(color: string, ink: string): (element: HTMLElement | null) => void {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#777777';
  const text = /^#[0-9a-fA-F]{6}$/.test(ink) ? ink : '#ffffff';
  return (element) => {
    if (element) {
      element.style.setProperty('--chip-bg', safe);
      element.style.setProperty('--chip-ink', text);
    }
  };
}

/** Ref callback factory: sets the element's background colour (a `#rrggbb` value) through the CSSOM. */
export function backgroundColorRef(color: string): (element: HTMLElement | null) => void {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#777777';
  return (element) => {
    if (element) element.style.backgroundColor = safe;
  };
}
