import { KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import { VERDICT_WORDS, type DriveCheckInfo, type DriveHealth, type OnlyHereSummary, type Verdict, type WouldLoseDetail } from '../../shared/insights';
import type { PlaceKind, PlaceView } from '../../shared/places';
import { agoText, shortDate } from '../backups/backupsModel';
import type { Tone } from '../components/status';
import { formatBytes, formatCount, plural } from '../lib/format';

/** Pure helpers behind "Drive health" and "What would I lose?" (the Devices cards, the lose screen, the Home card). */

/** The address of the lose screen: Devices, section "lose:<place id>". */
const LOSE_PREFIX = 'lose:';
export const loseSub = (placeId: string): string => LOSE_PREFIX + placeId;
export function losePlaceOf(sub: string | null): string | null {
  return sub !== null && sub.startsWith(LOSE_PREFIX) && sub.length > LOSE_PREFIX.length ? sub.slice(LOSE_PREFIX.length) : null;
}

export const LOSE_BUTTON = 'What would I lose?';

const VERDICT_TONES: Readonly<Record<Verdict, Tone>> = { healthy: 'ok', 'check-soon': 'amber', problem: 'crit' };
export const verdictTone = (verdict: Verdict): Tone => VERDICT_TONES[verdict];
export const verdictWord = (verdict: Verdict): string => VERDICT_WORDS[verdict];

/** What the window knows of the health answer: not asked yet, could not be read, or the answer. */
export type HealthView = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; byId: ReadonlyMap<string, DriveHealth> };

/** "Connected now", "Last seen 9 Nov, 17 days ago", "Never seen". */
export function seenText(h: Pick<DriveHealth, 'status' | 'lastSeenAt' | 'kind'>, now: number): string {
  if (h.status === 'connected' && h.kind !== 'gdrive') return 'Connected now';
  if (h.lastSeenAt === null) return 'Never seen';
  return `${shortDate(h.lastSeenAt, now)}, ${agoText(h.lastSeenAt, now)}`;
}

/** The last check of old copies in few words: "Never checked", "9 Nov: 1,000 the same, 2 different". */
export function checkText(check: DriveCheckInfo | null, now: number): string {
  if (check === null) return 'Never checked';
  const parts = [`${formatCount(check.verified)} the same`];
  if (check.differs > 0) parts.push(`${formatCount(check.differs)} different`);
  if (check.couldNotRead > 0) parts.push(`${formatCount(check.couldNotRead)} could not be read`);
  return `${shortDate(check.at, now)}: ${parts.join(', ')}${check.complete ? '' : ' (stopped early)'}`;
}

/** The errors line: Windows' disk errors and USB pauses of the last 30 days, files the app could not read or found damaged. "None" when clean. */
export function errorsText(h: Pick<DriveHealth, 'windowsErrors' | 'usbTroubles' | 'readErrors' | 'damaged'>): string {
  const parts: string[] = [];
  if ((h.windowsErrors ?? 0) > 0) parts.push(`${formatCount(h.windowsErrors ?? 0)} ${plural(h.windowsErrors ?? 0, 'disk error', 'disk errors')} in Windows`);
  if (h.usbTroubles > 0) parts.push(`${formatCount(h.usbTroubles)} USB ${plural(h.usbTroubles, 'pause', 'pauses')}`);
  if (h.readErrors > 0) parts.push(`${formatCount(h.readErrors)} ${plural(h.readErrors, 'file', 'files')} not readable`);
  if (h.damaged > 0) parts.push(`${formatCount(h.damaged)} damaged ${plural(h.damaged, 'copy', 'copies')}`);
  return parts.length === 0 ? 'None' : parts.join(' · ');
}

/** Only things that hold files you could lose get the button. */
export const canAskLose = (kind: PlaceKind): boolean => kind === 'drive' || kind === 'laptop' || kind === 'onedrive' || kind === 'phone' || kind === 'gdrive';

// ---- The lose screen ------------------------------------------------------------------------------------------------------------

export interface LoseHeadline {
  tone: Tone;
  title: string;
  sub: string;
}

/** The one sentence on top: what has no other checked copy. */
export function loseHeadline(label: string, d: WouldLoseDetail): LoseHeadline {
  const files = d.onlyHere.files + d.maybeCopied.files;
  const bytes = d.onlyHere.bytes + d.maybeCopied.bytes;
  if (d.totalFiles === 0) return { tone: 'neutral', title: `Backup Hub knows of no files on ${label} yet`, sub: 'Check this one first, then ask again.' };
  if (files === 0) return { tone: 'ok', title: 'Nothing would be lost', sub: `Every file on ${label} has a checked copy somewhere else.` };
  const proven = d.onlyHere.files === 0 ? 'Nothing is surely only here, but these copies are not proven.' : '';
  return {
    tone: d.onlyHere.files > 0 ? 'crit' : 'amber',
    title: `${formatBytes(bytes)} (${formatCount(files)} ${plural(files, 'file', 'files')}) would be lost`,
    sub: proven || `If ${label} died today, these have no other checked copy. ${formatCount(d.totalFiles - files)} of ${formatCount(d.totalFiles)} files are safe.`,
  };
}

export const countLine = (files: number, bytes: number): string => `${formatCount(files)} ${plural(files, 'file', 'files')} · ${formatBytes(bytes)}`;

export const kindLabel = (kind: string): string => (kind in KIND_LABELS ? KIND_LABELS[kind as FileKind] : KIND_LABELS.other);

/** The two parts of the list, in plain words. */
export const PART_WORDS = { onlyHere: 'Only here', maybeCopied: 'Looks copied, not proven' } as const;
export const PART_HELP = {
  onlyHere: 'No other file anywhere has the same checksum, and nothing with the same name and size either.',
  maybeCopied: 'A file with the same name and size is somewhere else, but nothing has proven it is the same. Not counted as safe.',
} as const;

export const folderLine = (f: { folder: string; files: number; bytes: number }): string => `${f.folder}: ${countLine(f.files, f.bytes)}`;

/** The chooser: every place, drives first, then the laptop, OneDrive, phones and accounts, each group by name. */
export function loseChoices(places: readonly PlaceView[]): { id: string; label: string; group: string }[] {
  const order: Record<PlaceKind, number> = { drive: 0, laptop: 1, onedrive: 2, phone: 3, gdrive: 4 };
  const group: Record<PlaceKind, string> = { drive: 'Drives', laptop: 'This laptop', onedrive: 'OneDrive', phone: 'Phones', gdrive: 'Google accounts' };
  return places
    .filter((p) => canAskLose(p.kind))
    .toSorted((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' }))
    .map((p) => ({ id: p.id, label: p.label, group: group[p.kind] }));
}

// ---- Home -----------------------------------------------------------------------------------------------------------------------

export interface HomeLoseItem {
  placeId: string;
  label: string;
  text: string;
}

/** The named drives that hold files with no checked copy anywhere else, the biggest first. Empty = no Home card. */
export function homeLoseItems(places: readonly PlaceView[], summary: readonly OnlyHereSummary[] | null): HomeLoseItem[] {
  if (summary === null) return [];
  const out: (HomeLoseItem & { bytes: number })[] = [];
  for (const s of summary) {
    const drive = places.find((p) => p.id === s.placeId && p.kind === 'drive');
    if (drive && s.files > 0) out.push({ placeId: drive.id, label: drive.label, text: countLine(s.files, s.bytes), bytes: s.bytes });
  }
  return out.toSorted((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label)).map(({ placeId, label, text }) => ({ placeId, label, text }));
}
