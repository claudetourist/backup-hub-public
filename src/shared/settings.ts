/**
 * Settings and profile types shared by main, preload and renderer. Pure data and pure functions.
 */

import { defaultAppDataSources, toAppDataSources, type AppDataSource } from './plans';
import { DEFAULT_HASH_MB_PER_SEC, MAX_HASH_MB_PER_SEC, MIN_HASH_MB_PER_SEC } from './fingerprint';
import { DEFAULT_KEEP_FREE_PERCENT, MAX_KEEP_FREE_PERCENT, MIN_KEEP_FREE_PERCENT } from './start';

export type ThemeSetting = 'system' | 'light' | 'dark';
export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];

/** How many saved copies of each kind (settings file, database copy) are kept on a backup drive, when old ones may be removed. */
export const DEFAULT_SAVED_COPIES_KEEP = 7;
export const MIN_SAVED_COPIES_KEEP = 3;
export const MAX_SAVED_COPIES_KEEP = 30;

/**
 * Folder names that are never backed up, versioned or indexed on a SOURCE (laptop, OneDrive): matched against EVERY folder of a
 * path, without regard to case. `.git` is deliberately not in the list. Never applied to the backup drives (T7, Seagate2TB):
 * old archives there stay indexed exactly as they are.
 */
export const DEFAULT_SKIP_FOLDERS: readonly string[] = ['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '$RECYCLE.BIN', 'System Volume Information'];
export const MAX_SKIP_FOLDERS = 200;

/** A clean skip list: trimmed names, no slashes, no duplicates (case-insensitive), or null when it cannot be used. */
export function toSkipFolders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SKIP_FOLDERS) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    if (name === '' || name.length > 200 || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return null;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Home reminds you when a named drive has not been plugged in for this many days (1 to 365, default 14). */
export const DEFAULT_DRIVE_REMINDER_DAYS = 14;
export const MIN_DRIVE_REMINDER_DAYS = 1;
export const MAX_DRIVE_REMINDER_DAYS = 365;

export interface AppSettings {
  theme: ThemeSetting;
  notificationsEnabled: boolean;
  /** Save settings and a database copy to a named backup drive when it is connected. */
  snapshotToDrive: boolean;
  /** Folder names never backed up or indexed on a source (see DEFAULT_SKIP_FOLDERS). Editable; the backup drives are never filtered by it. */
  skipFolders: string[];
  /** Most MB per second the fingerprint job reads, so the laptop stays usable. 0 = no limit. */
  hashMegabytesPerSecond: number;
  /** Saved copies kept per kind on each backup drive (3 to 30). Only matters when `autoRemoveOldCopies` is on. */
  savedCopiesKeep: number;
  /** Remove the older saved copies on a backup drive by itself after each save. Off: nothing is ever removed without asking. */
  autoRemoveOldCopies: boolean;
  /** Every Google account always keeps at least this share of its space free (20 to 50, default 25). Replaces the GB caps in Send to Google. */
  googleKeepFreePercent: number;
  /** Keep an encrypted recovery copy of the database in one Google Drive account. OFF until the person picks the account. */
  recoveryToGoogle: boolean;
  /** The Google Drive place that gets the recovery copy (null = none chosen yet). */
  recoveryGoogleAccount: string | null;
  /**
   * Drives (by name or id) that Backup Hub must never write to: no backups, saved copies, ID card, deletes or renames. Reading,
   * listing and hashing still work. Default [] (the 3 Nov 2026 T7 ban was lifted by the user on 5 Nov 2026); a missing value means the default.
   */
  writeProtectedDrives: string[];
  /**
   * "Also look for duplicates in my C: folders": offer duplicates inside the Windows user profile (Documents, Desktop, Pictures,
   * Downloads and everything else under C:\Users\<you>) for the quarantine. OFF by default: those are the files the person works with.
   */
  duplicatesInUserFolders: boolean;
  /** The laptop app data list of the "Laptop app data" plan: folders with %APPDATA% style tokens, a priority and an on/off switch. */
  appDataSources: AppDataSource[];
  /** Home says "T7 not plugged in for N days" for a named drive last seen more than this many days ago. Only a reminder: nothing runs because of it. */
  driveReminderDays: number;
  /** The person the screens show: a person's id, or null for Everyone. Remembered between launches. Default 1 (the first person, "You"). */
  activePerson: number | null;
}

/** Recovery copies kept in Google Drive. Backup Hub never deletes in Drive, so it stops at this many until some are removed by hand. */
export const RECOVERY_DRIVE_KEEP = 7;
/** Days between recovery copies to Google Drive. */
export const RECOVERY_DRIVE_DAYS = 7;

export type SettingKey = keyof AppSettings;

/** True when the drive (matched by name or id, ignoring case) is on the write-protected list. */
export function isDriveProtected(settings: Pick<AppSettings, 'writeProtectedDrives'>, drive: { id: string; label: string }): boolean {
  const names = new Set(settings.writeProtectedDrives.map((n) => n.trim().toLowerCase()));
  return names.has(drive.label.trim().toLowerCase()) || names.has(drive.id.toLowerCase());
}

/** The plain line shown wherever a protected drive blocks a button. */
export function readOnlyLine(name: string): string {
  return `${name} is read-only (protected), so nothing is written to it.`;
}

/** The list after switching one drive's protection on or off (off removes both its name and its id). */
export function withProtection(settings: Pick<AppSettings, 'writeProtectedDrives'>, drive: { id: string; label: string }, on: boolean): string[] {
  const drop = new Set([drive.label.trim().toLowerCase(), drive.id.toLowerCase()]);
  const rest = settings.writeProtectedDrives.filter((n) => !drop.has(n.trim().toLowerCase()));
  return on ? [...rest, drive.label] : rest;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  notificationsEnabled: true,
  snapshotToDrive: true,
  skipFolders: [...DEFAULT_SKIP_FOLDERS],
  hashMegabytesPerSecond: DEFAULT_HASH_MB_PER_SEC,
  savedCopiesKeep: DEFAULT_SAVED_COPIES_KEEP,
  autoRemoveOldCopies: false,
  googleKeepFreePercent: DEFAULT_KEEP_FREE_PERCENT,
  recoveryToGoogle: false,
  recoveryGoogleAccount: null,
  writeProtectedDrives: [],
  duplicatesInUserFolders: false,
  appDataSources: defaultAppDataSources(),
  driveReminderDays: DEFAULT_DRIVE_REMINDER_DAYS,
  activePerson: 1,
};

export const SETTING_KEYS: readonly SettingKey[] = ['theme', 'notificationsEnabled', 'snapshotToDrive', 'skipFolders', 'hashMegabytesPerSecond', 'savedCopiesKeep', 'autoRemoveOldCopies', 'googleKeepFreePercent', 'recoveryToGoogle', 'recoveryGoogleAccount', 'writeProtectedDrives', 'duplicatesInUserFolders', 'appDataSources', 'driveReminderDays', 'activePerson'];

/** Returns the value when it is valid for `key`, otherwise undefined. */
export function validSettingValue<K extends SettingKey>(key: K, value: unknown): AppSettings[K] | undefined {
  if (key === 'theme') return (THEME_SETTINGS.includes(value as ThemeSetting) ? value : undefined) as AppSettings[K] | undefined;
  if (key === 'notificationsEnabled' || key === 'snapshotToDrive' || key === 'autoRemoveOldCopies' || key === 'recoveryToGoogle' || key === 'duplicatesInUserFolders') {
    return (typeof value === 'boolean' ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'hashMegabytesPerSecond') {
    const ok = typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= MIN_HASH_MB_PER_SEC && value <= MAX_HASH_MB_PER_SEC));
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'skipFolders') return (toSkipFolders(value) ?? undefined) as AppSettings[K] | undefined;
  if (key === 'savedCopiesKeep') {
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= MIN_SAVED_COPIES_KEEP && value <= MAX_SAVED_COPIES_KEEP;
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'googleKeepFreePercent') {
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= MIN_KEEP_FREE_PERCENT && value <= MAX_KEEP_FREE_PERCENT;
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'driveReminderDays') {
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= MIN_DRIVE_REMINDER_DAYS && value <= MAX_DRIVE_REMINDER_DAYS;
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'activePerson') {
    const ok = value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1);
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'writeProtectedDrives') {
    if (!Array.isArray(value) || value.length > 50) return undefined;
    const ok = value.every((n) => typeof n === 'string' && n.trim().length > 0 && n.length <= 200);
    return (ok ? [...new Set((value as string[]).map((n) => n.trim()))] : undefined) as AppSettings[K] | undefined;
  }
  if (key === 'appDataSources') return (toAppDataSources(value) ?? undefined) as AppSettings[K] | undefined;
  if (key === 'recoveryGoogleAccount') {
    const ok = value === null || (typeof value === 'string' && value.length > 0 && value.length <= 100);
    return (ok ? value : undefined) as AppSettings[K] | undefined;
  }
  return undefined;
}

export interface SettingsState {
  settings: AppSettings;
  dataDir: string;
  logsDir: string;
}

export type SettingResult = { ok: true; settings: AppSettings } | { ok: false; message: string };

// ---- Profiles ------------------------------------------------------------------------------

export interface ProfileView {
  id: number;
  name: string;
  color: string;
  createdAt: number;
  /** Places (laptop, drives, phones...) this profile owns. */
  placeCount: number;
  /** What the person owns, for "Owns 1 backup and 1 phone" and the rule for removing them. */
  backups: number;
  phones: number;
  accounts: number;
  /** True for the first person ("You"): never removed. */
  isFirst: boolean;
}

export type ProfileResult = { ok: true; profiles: ProfileView[] } | { ok: false; message: string };

// ---- Export, import, save to drive --------------------------------------------------------

export type FileActionResult =
  | { ok: true; message: string }
  | { ok: false; canceled: boolean; message: string };

export type SaveNowResult = { ok: true; jobId: number } | { ok: false; message: string };

/** One saved file on a backup drive (read only; the Settings screen lists these). */
export interface SavedCopy {
  name: string;
  kind: 'settings' | 'database';
  /** When it was saved, from its name (ms since 1970, local time as written). */
  savedAt: number;
  bytes: number;
}

export interface SavedCopiesDrive {
  placeId: string;
  /** The drive's name. */
  label: string;
  /** Newest first. */
  copies: SavedCopy[];
  /** How many are older than the newest `keep` of their kind (what "Remove old copies" would remove). */
  exceeding: number;
}

export interface SavedCopiesOverview {
  /** The `savedCopiesKeep` setting the counts use. */
  keep: number;
  /** Connected named drives only. */
  drives: SavedCopiesDrive[];
}

/** The answer to "Remove old copies". */
export interface SavedCopyActionResult {
  ok: boolean;
  message: string;
}

/** The answer to "Restore Backup Hub" (a copy was checked and staged, or why not). */
export interface RestoreResult {
  ok: boolean;
  message: string;
  /** True when the file is a recovery file and the passphrase is missing or wrong. */
  needsPassphrase?: boolean;
}

/** A restore waiting for the next start (or null). */
export interface RestoreStatus {
  pending: { source: string; stagedAt: number; summary: string } | null;
}

/** The file the person picked for a restore (what kind it is, from its first bytes). */
export type ChosenRestoreFile = { ok: true; name: string; kind: 'database' | 'recovery'; bytes: number } | { ok: false; canceled: boolean; message: string };

/** The answer to "Test restore": a plain sentence, and what the copy holds when it passed. */
export interface TestRestoreResult {
  ok: boolean;
  message: string;
  details: { profiles: number; places: number; collections: number; files: number } | null;
}
