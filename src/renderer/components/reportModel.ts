/** What a finished run tells the person: copied, skipped and why, failed and why, where it went. Pure. */
import { formatBytes, formatCount, plural } from '../lib/format';

export interface ReportReason {
  /** In plain words: "already on the Seagate", "name Windows cannot store". */
  reason: string;
  count: number;
  /** A few example file names. */
  examples?: readonly string[];
}

export interface ReportData {
  copied: { files: number; bytes: number };
  skipped: readonly ReportReason[];
  failed: readonly ReportReason[];
  /** Where the files went: one line per place ("Seagate, folder Poco F4/2026-11-22"). */
  where: readonly string[];
  /** When it finished, as the person reads it ("3 Nov, 14:05"). */
  finished?: string;
}

export function reasonTotal(reasons: readonly ReportReason[]): number {
  return reasons.reduce((sum, r) => sum + r.count, 0);
}

export type ReportOutcome = 'ok' | 'warn' | 'bad';

/** Everything copied and nothing failed is ok; something failed is warn; nothing copied and something failed is bad. */
export function reportOutcome(data: ReportData): ReportOutcome {
  const failed = reasonTotal(data.failed);
  if (failed === 0) return 'ok';
  return data.copied.files === 0 ? 'bad' : 'warn';
}

export function reportHeadline(data: ReportData): string {
  const failed = reasonTotal(data.failed);
  const copied = `Copied ${formatCount(data.copied.files)} ${plural(data.copied.files, 'file', 'files')} (${formatBytes(data.copied.bytes)})`;
  if (failed === 0) return copied;
  return data.copied.files === 0 ? `Nothing was copied, ${formatCount(failed)} failed` : `${copied}, ${formatCount(failed)} failed`;
}
