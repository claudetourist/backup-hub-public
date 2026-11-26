import type { PlaceKind, PlaceStatus } from './places';

/**
 * Drive health, reminders and "What would I lose?": what main answers and the window shows. Plain data only.
 * Everything here is read only: nothing is ever copied, changed or deleted by these.
 */

/** A backup that has had no successful run for this many days asks for attention (per backup; the person can change it). */
export const DEFAULT_REMINDER_DAYS = 7;
export const MIN_REMINDER_DAYS = 1;
export const MAX_REMINDER_DAYS = 365;
/** A named drive not plugged in for this many days is "not seen for 30 days". */
export const DRIVE_NOT_SEEN_DAYS = 30;
/** A plugged-in drive with less than this share free is "almost full". */
export const DRIVE_ALMOST_FULL_FREE_SHARE = 0.1;
/** USB trouble is counted over the jobs that ended in this many days. */
export const USB_TROUBLE_DAYS = 30;

/** What Windows says about the disk's own health. 'unknown' = Windows could not tell (many USB cases do not report it). */
export type SmartState = 'good' | 'warning' | 'bad' | 'unknown';

/** The one plain word per drive. */
export type Verdict = 'healthy' | 'check-soon' | 'problem';
export const VERDICT_WORDS: Readonly<Record<Verdict, string>> = { healthy: 'Healthy', 'check-soon': 'Check soon', problem: 'Problem' };

/** The last "Check old copies" that read this drive (a second drive's check, or a phone's check against the first drive). */
export interface DriveCheckInfo {
  /** When it ended (epoch ms). */
  at: number;
  /** Files proven the same. */
  verified: number;
  /** Files that did not match (never replaced). */
  differs: number;
  /** Files that could not be read. */
  couldNotRead: number;
  /** False when it was stopped part-way. */
  complete: boolean;
}

/** What the verdict is made from. Plain numbers, so it is the same for a drive, the laptop, a phone and a Google account. */
export interface HealthFacts {
  kind: PlaceKind;
  status: PlaceStatus;
  /** Epoch ms; "now" for a place that is connected. */
  lastSeenAt: number | null;
  freeBytes: number | null;
  capacityBytes: number | null;
  /** Null for a place Windows has no disk for (phone, Google account). */
  smart: SmartState | null;
  /** Disk errors Windows logged for it in the last 30 days; null = not read. */
  windowsErrors: number | null;
  usbTroubles: number;
  /** Files the app could not read in its last check of old copies. */
  readErrors: number;
  /** Copies the app found damaged (a copy that no longer matches what was written). */
  damaged: number;
  /** Files whose copy on the second drive differs from the first drive's. */
  differs: number;
}

export interface DriveHealth extends HealthFacts {
  placeId: string;
  label: string;
  /** One plain line about the disk's health ("Windows says the disk is healthy", "Windows could not tell"); empty when there is no disk. */
  smartNote: string;
  lastCheck: DriveCheckInfo | null;
  /** About how many bytes the next backup to this drive needs (the size of its last run); null when not known. */
  nextBackupBytes: number | null;
  verdict: Verdict;
  /** Why, in short plain lines (empty for Healthy). */
  reasons: string[];
}

export type DriveHealthResult = { ok: true; drives: DriveHealth[] } | { ok: false; message: string };

const DAY_MS = 86_400_000;
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/**
 * The verdict and the reasons. Problem: Windows says the disk is failing, Windows cannot read the drive, or a copy on it is damaged.
 * Check soon: a Windows warning, disk errors in the log, USB trouble, files the last check could not read, differing copies, almost full,
 * not seen for 30 days, a Google account to sign in again. Anything else is Healthy. Pure, so a test can pin every rule.
 */
export function verdictOf(f: HealthFacts, now: number): { verdict: Verdict; reasons: string[] } {
  const problem: string[] = [];
  const soon: string[] = [];
  if (f.smart === 'bad') problem.push('Windows says this disk is failing');
  if (f.status === 'problem') problem.push('Windows cannot read it properly');
  if (f.damaged > 0) problem.push(`${plural(f.damaged, 'copy is', 'copies are')} damaged`);
  if (f.smart === 'warning') soon.push('Windows warns about this disk');
  if ((f.windowsErrors ?? 0) > 0) soon.push(`Windows logged ${plural(f.windowsErrors ?? 0, 'disk error', 'disk errors')} in 30 days`);
  if (f.usbTroubles > 0) soon.push(`Paused ${plural(f.usbTroubles, 'time', 'times')} for USB trouble in 30 days`);
  if (f.readErrors > 0) soon.push(`${plural(f.readErrors, 'file', 'files')} could not be read in the last check`);
  if (f.differs > 0) soon.push(`${plural(f.differs, 'copy differs', 'copies differ')} from the first drive`);
  if (f.freeBytes !== null && f.capacityBytes !== null && f.capacityBytes > 0 && f.freeBytes / f.capacityBytes < DRIVE_ALMOST_FULL_FREE_SHARE) soon.push('Almost full');
  if (f.status === 'needs_signin') soon.push('Needs signing in again');
  if ((f.kind === 'drive' || f.kind === 'phone') && f.status !== 'connected' && f.lastSeenAt !== null && now - f.lastSeenAt >= DRIVE_NOT_SEEN_DAYS * DAY_MS) soon.push(`Not seen for ${plural(Math.floor((now - f.lastSeenAt) / DAY_MS), 'day', 'days')}`);
  return { verdict: problem.length > 0 ? 'problem' : soon.length > 0 ? 'check-soon' : 'healthy', reasons: [...problem, ...soon] };
}

/** The days of the reminder per backup (backup id as text); a backup not in the list uses DEFAULT_REMINDER_DAYS. */
export type ReminderDays = Record<string, number>;

export type ReminderDaysResult = { ok: true; days: ReminderDays } | { ok: false; message: string };

export function reminderDaysOf(days: ReminderDays | null | undefined, backupId: number): number {
  const value = days?.[String(backupId)];
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_REMINDER_DAYS && value <= MAX_REMINDER_DAYS ? value : DEFAULT_REMINDER_DAYS;
}

export function isReminderDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_REMINDER_DAYS && value <= MAX_REMINDER_DAYS;
}

// ---- What would I lose? ----------------------------------------------------------------------------------------------------------

/** One folder (the first levels of its path) and what only lives there. */
export interface LoseFolder {
  folder: string;
  files: number;
  bytes: number;
}

export interface LoseKind {
  /** A kind of file (see shared/fileKinds): 'photo-camera', 'documents' ... */
  kind: string;
  files: number;
  bytes: number;
  /** The biggest folders first (at most 6). */
  folders: LoseFolder[];
  /** The folders that did not fit in the list, lumped together. */
  rest: { folders: number; files: number; bytes: number };
}

/** What only lives here, per backup (the backup whose folder the file is in); backupId null = not part of any backup. */
export interface LoseBackup {
  backupId: number | null;
  name: string;
  files: number;
  bytes: number;
}

export interface LoseSection {
  files: number;
  bytes: number;
  /** The biggest kind first. */
  kinds: LoseKind[];
  /** The biggest backup first. */
  byBackup: LoseBackup[];
}

/** Files of one device that have no checked copy anywhere else (same SHA-256 on another device), and the ones that might. */
export interface WouldLoseDetail {
  placeId: string;
  /** No checked copy and nothing with the same name and size anywhere else. */
  onlyHere: LoseSection;
  /** No checked copy, but a file with the same name and size is somewhere else: probably copied, not proven. */
  maybeCopied: LoseSection;
  /** Files above (both parts) that have no fingerprint yet, so a copy may exist that we cannot see. */
  notChecked: { files: number; bytes: number };
  /** Files this device holds now (empty files left out): the whole the numbers above are part of. */
  totalFiles: number;
}

/** The one-line summary of a drive card and Home: "12.3 GB with no checked copy" (only and maybe-copied files together). Named drives only. */
export interface OnlyHereSummary {
  placeId: string;
  files: number;
  bytes: number;
}

export type WouldLoseResult = { ok: true; detail: WouldLoseDetail } | { ok: false; message: string };
export type OnlyHereResult = { ok: true; places: OnlyHereSummary[] } | { ok: false; message: string };

/** Which part of the list: files with nothing like them elsewhere, or files that look copied but are not proven. */
export type LosePart = 'onlyHere' | 'maybeCopied';

/** One page of the files (biggest first), optionally only those whose path holds the words typed. */
export interface WouldLoseFilesRequest {
  placeId: string;
  part: LosePart;
  /** Words of the path to look for (all must be in it); empty = every file. */
  search: string;
  offset: number;
  /** Only filter to one kind ('photo-camera' ...); null = every kind. */
  kind: string | null;
}

export interface LoseFile {
  path: string;
  /** Bytes (0 for a file with no size, such as a Google Doc). */
  size: number;
  kind: string;
  /** No fingerprint yet: a copy may exist that cannot be seen. */
  unchecked: boolean;
}

export interface WouldLoseFilesPage {
  files: LoseFile[];
  /** True when more follow (ask again with the offset advanced by the length). */
  more: boolean;
}

export type WouldLoseFilesResult = { ok: true; page: WouldLoseFilesPage } | { ok: false; message: string };

/** Files per page of the list. */
export const LOSE_PAGE_SIZE = 100;
