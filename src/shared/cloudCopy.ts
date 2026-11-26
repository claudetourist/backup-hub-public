/**
 * What is left of the old Google upload types (R0.1c): the size formatter the clean-up and copy screens use.
 * The verified upload job `copy.toDrive`, the account assignment rules and "Rebalance Google accounts" are gone.
 */

const GB = 1_000_000_000;

/** "46.5 GB" style (decimal, as Google counts). */
export function formatGb(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1_000_000)).toLocaleString('en-US')} MB`;
}
