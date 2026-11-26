/** Backup-coverage maths for the Collections bars: how much of a collection has 0, 1 or 2+ backups. */

export interface CoverageBytes {
  none: number;
  one: number;
  many: number;
}

export interface CoveragePercents {
  none: number;
  one: number;
  many: number;
}

/**
 * Whole-number percentages that always add up to 100 (largest-remainder method), so the three bar
 * segments never leave a gap or overflow. An empty collection returns all zeros.
 */
export function coveragePercents(bytes: CoverageBytes): CoveragePercents {
  const parts = [Math.max(0, bytes.none), Math.max(0, bytes.one), Math.max(0, bytes.many)];
  const total = parts.reduce((sum, part) => sum + part, 0);
  if (total <= 0) return { none: 0, one: 0, many: 0 };
  const exact = parts.map((part) => (part / total) * 100);
  const floors = exact.map((value) => Math.floor(value));
  let leftover = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .toSorted((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (leftover <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    leftover -= 1;
  }
  return { none: floors[0] ?? 0, one: floors[1] ?? 0, many: floors[2] ?? 0 };
}

export function totalBytes(bytes: CoverageBytes): number {
  return bytes.none + bytes.one + bytes.many;
}

/** Share of the collection that has 2+ backups (0..1); used for sorting by protection. */
export function safeFraction(bytes: CoverageBytes): number {
  const total = totalBytes(bytes);
  return total > 0 ? bytes.many / total : 0;
}

/** Screen-reader summary, e.g. "8% has no backup, 88% has 1 backup, 4% has 2 or more backups". */
export function coverageSummary(percents: CoveragePercents): string {
  const parts: string[] = [];
  if (percents.none > 0) parts.push(`${percents.none}% has no backup`);
  if (percents.one > 0) parts.push(`${percents.one}% has 1 backup`);
  if (percents.many > 0) parts.push(`${percents.many}% has 2 or more backups`);
  return parts.length > 0 ? parts.join(', ') : 'Empty';
}
