/** The plain words of "Why?" that the window's sample screens also use (so a sample and the real answer say the same thing). Pure. */
import type { WhyLine } from './decisions';

/** "23 Nov 2026" (the person's own time zone). */
export const dayWords = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const GONE_WORDS: Record<string, string> = {
  gone_from_source: 'it was no longer on the phone at the next check',
  removed_on_purpose: 'you removed it on purpose',
  merged: 'it was merged with another copy',
  compressed: 'it was put into an archive',
  kept_only_on_other_drive: 'it is kept only on the other drive',
  phone_cleaned: 'Free up phone space took it off the phone',
  missing_on_drive: 'it was not on the drive any more when it was checked',
};

export const goneWords = (reason: string | null): string => (reason !== null && GONE_WORDS[reason] !== undefined ? GONE_WORDS[reason]! : 'it was no longer there at the last check');

export interface CheckedFacts {
  verified_how: string | null;
  verified_at: number | null;
  place_kind: string;
  last_seen_at: number;
}

/** How a copy was checked, in plain words. */
export function checkedWords(row: CheckedFacts, googleMatch = false): { text: string; tone: WhyLine['tone'] } {
  if (row.place_kind === 'gdrive') return googleMatch ? { text: `matched by Google's own checksum (seen ${dayWords(row.last_seen_at)}); Backup Hub has not read it back`, tone: 'ok' } : { text: 'not checked yet', tone: 'warn' };
  switch (row.verified_how) {
    case 'read_both':
      return { text: `read back and compared with the phone's file on ${row.verified_at === null ? 'a day that was not kept' : dayWords(row.verified_at)}`, tone: 'ok' };
    case 'imported':
      return { text: 'brought in from the old tool, not checked yet', tone: 'warn' };
    case 'name_size':
      return { text: 'matched by name and size only, not checked yet', tone: 'warn' };
    case 'differs':
      return { text: `found different from the phone's file on ${row.verified_at === null ? 'a day that was not kept' : dayWords(row.verified_at)}`, tone: 'bad' };
    default:
      return { text: 'not checked yet', tone: 'warn' };
  }
}
