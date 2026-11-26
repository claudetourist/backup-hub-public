/** Small formatting helpers shared by screens. Decimal units (1 GB = 1e9 bytes) to match the design. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 46_500_000_000 -> "46.5 GB"; 322e9 -> "322 GB"; values >= 100 of a unit drop the decimal. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const text = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${UNITS[unit]}`;
}

/** 403410 -> "403,410" (fixed locale so output is stable in tests). */
export function formatCount(count: number): string {
  return Math.round(count).toLocaleString('en-US');
}

/** Choose singular only for exactly one: plural(1, 'thing', 'things'). */
export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
