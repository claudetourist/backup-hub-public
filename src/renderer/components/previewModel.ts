/** The list shown before anything runs (PLAN section 4 rule 5): largest first, untick what you do not want. Pure. */
import { formatBytes, formatCount, plural } from '../lib/format';
import { compareText } from './sortRows';

export interface PreviewItem {
  id: string;
  /** The file name or path as the person reads it. */
  name: string;
  bytes: number;
  /** A stored file kind (photo-camera ...), shown as a chip. */
  kind?: string;
  /** Where it goes or why it is in the list, in plain words. */
  note?: string;
}

export interface SkipReason {
  reason: string;
  count: number;
}

/** Files left out of the list, and why. */
export interface SkippedInfo {
  count: number;
  reasons: readonly SkipReason[];
}

/** Largest first; files of the same size by name, so the order never jumps. */
export function sortLargestFirst<T extends { name: string; bytes: number }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.bytes - a.bytes || compareText(a.name, b.name));
}

export interface PreviewTotals {
  files: number;
  bytes: number;
  tickedFiles: number;
  tickedBytes: number;
}

export function previewTotals(items: readonly PreviewItem[], unticked: ReadonlySet<string>): PreviewTotals {
  let bytes = 0;
  let tickedFiles = 0;
  let tickedBytes = 0;
  for (const item of items) {
    bytes += item.bytes;
    if (!unticked.has(item.id)) {
      tickedFiles += 1;
      tickedBytes += item.bytes;
    }
  }
  return { files: items.length, bytes, tickedFiles, tickedBytes };
}

/** A new set with the file ticked or unticked. */
export function toggleUnticked(unticked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(unticked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "312 of 350 files ticked, 4.2 GB". */
export function tickedText(totals: PreviewTotals): string {
  return `${formatCount(totals.tickedFiles)} of ${formatCount(totals.files)} ${plural(totals.files, 'file', 'files')} ticked, ${formatBytes(totals.tickedBytes)}`;
}

/** "3 of 5 ticked": the line above a short list of ticks (folders, groups) that has Tick all and Untick all. */
export function tickedOfText(ticked: number, total: number): string {
  return `${formatCount(ticked)} of ${formatCount(total)} ticked`;
}

/** "Skipped: 12 files", or null when nothing was skipped. */
export function skippedHeadline(skipped: SkippedInfo | undefined): string | null {
  if (!skipped || skipped.count <= 0) return null;
  return `Skipped: ${formatCount(skipped.count)} ${plural(skipped.count, 'file', 'files')}`;
}

/** "8 already there, 4 name too long": the reasons, biggest first. */
export function skippedReasonsText(skipped: SkippedInfo | undefined): string {
  if (!skipped) return '';
  return skipped.reasons
    .filter((r) => r.count > 0)
    .toSorted((a, b) => b.count - a.count)
    .map((r) => `${formatCount(r.count)} ${r.reason}`)
    .join(', ');
}
