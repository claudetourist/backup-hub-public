/**
 * The five statuses of a backup at a destination (PLAN section 3), in plain words. These are the only five, everywhere.
 * Pure, so the words, colours and icons can be tested. Colour is never the only signal: each status has a word and an icon,
 * and "Not connected" also has a dashed outline.
 */
import { formatBytes, formatCount, plural } from '../lib/format';

export const BACKUP_STATUSES = ['up-to-date', 'behind', 'never', 'not-connected', 'problem'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/** The words the person reads. */
export const STATUS_WORDS: Readonly<Record<BackupStatus, string>> = {
  'up-to-date': 'Up to date',
  behind: 'Behind',
  never: 'Never backed up',
  'not-connected': 'Not connected',
  problem: 'Problem',
};

/** Which colour family each status uses (the --status-* tokens): green, amber, grey, grey (dashed), red. */
export type StatusTone = 'ok' | 'amber' | 'neutral' | 'offline' | 'crit';
export const STATUS_TONES: Readonly<Record<BackupStatus, StatusTone>> = {
  'up-to-date': 'ok',
  behind: 'amber',
  never: 'neutral',
  'not-connected': 'offline',
  problem: 'crit',
};

export type StatusIconName = 'check' | 'clock' | 'circle' | 'plug' | 'alert';
export const STATUS_ICONS: Readonly<Record<BackupStatus, StatusIconName>> = {
  'up-to-date': 'check',
  behind: 'clock',
  never: 'circle',
  'not-connected': 'plug',
  problem: 'alert',
};

/** Only a status that is not connected is drawn with a dashed outline. */
export function isDashed(status: BackupStatus): boolean {
  return status === 'not-connected';
}

export interface StatusInfo {
  status: BackupStatus;
  /** Behind: how many files and bytes are waiting. */
  files?: number;
  bytes?: number;
  /** Problem: how many files are missing or damaged. */
  problems?: number;
  /** Not connected: what the status was when it was last seen, and the date ("3 Nov"). */
  lastKnown?: BackupStatus;
  lastSeen?: string;
  /** How old this information is, as the person reads it: "2 hours ago". */
  updated?: string;
}

export interface StatusLine {
  word: string;
  /** What follows the word, or null. */
  detail: string | null;
  /** "updated 2 hours ago", or null. */
  age: string | null;
}

/** The words of a status with its numbers: "Behind" + "by 312 files (4.2 GB)". */
export function statusLine(info: StatusInfo): StatusLine {
  const word = STATUS_WORDS[info.status];
  let detail: string | null = null;
  if (info.status === 'behind' && info.files !== undefined) {
    detail = `by ${formatCount(info.files)} ${plural(info.files, 'file', 'files')}${info.bytes !== undefined ? ` (${formatBytes(info.bytes)})` : ''}`;
  } else if (info.status === 'problem' && info.problems !== undefined && info.problems > 0) {
    detail = `${formatCount(info.problems)} ${plural(info.problems, 'file', 'files')} missing or damaged`;
  } else if (info.status === 'not-connected' && info.lastKnown !== undefined && info.lastKnown !== 'not-connected') {
    detail = `last seen ${STATUS_WORDS[info.lastKnown].toLowerCase()}${info.lastSeen ? ` on ${info.lastSeen}` : ''}`;
  }
  return { word, detail, age: info.updated ? `updated ${info.updated}` : null };
}

/** The whole status as one sentence, for a screen reader or a title. */
export function statusText(info: StatusInfo): string {
  const { word, detail, age } = statusLine(info);
  return [detail ? `${word} ${detail}` : word, age].filter((part) => part !== null).join(', ');
}
