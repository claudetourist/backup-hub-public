/**
 * One colour dot per device, used everywhere the device appears (PLAN section 6). A device keeps the colour it was given;
 * when it has none, one is picked from this fixed set by its name, so the same device always gets the same colour.
 * Every colour here has at least 3:1 contrast on the card colour of both themes (checked in deviceColors.test.ts).
 */
export const DEVICE_COLORS: readonly string[] = ['#2563eb', '#dc2626', '#16a34a', '#c026d3', '#d97706', '#0d9488', '#64748b'];

/** A small stable number from text (FNV-1a), so a name always lands on the same colour. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function deviceColorFor(key: string): string {
  return DEVICE_COLORS[hashText(key.trim().toLowerCase()) % DEVICE_COLORS.length]!;
}
