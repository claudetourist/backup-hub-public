import type { BackupRow } from '../../shared/backups';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import { agoText, backupStatusOf, shortDate } from '../backups/backupsModel';
import { combinedStatus, plugInNote, statusLine } from '../backups/mirrorModel';
import type { MirrorStatusResult } from '../../shared/mirror';
import { backupKindOf, type BackupKind } from '../components/backupKinds';
import type { BackupStatus } from '../components/backupStatus';
import { explainInList, formatWhen, visibleJobs, jobRowLine } from '../jobs/jobsModel';
import { isContinuable, isRealFailure, type JobRecord } from '../../shared/jobs';
import type { PlaceView } from '../../shared/places';
import { formatBytes, formatCount, plural } from '../lib/format';
import { ACCOUNT_RED_PERCENT, accountFacts, DRIVE_AMBER_AT, driveOrder, usedShare } from '../places/devicesModel';

/** Pure helpers behind the Home page: tiles, "Your backups", "Needs you" and the last Activity items. */

const DAY_MS = 86_400_000;
/** Failed jobs older than this no longer ask for attention. */
export const NEEDS_YOU_DAYS = 7;
/** How many lines "Needs you" shows before "and N more". */
export const NEEDS_YOU_SHOWN = 5;
export const RECENT_SHOWN = 5;

export interface HomeTile {
  id: string;
  name: string;
  /** Connected or not; accounts are "connected" when none needs signing in. */
  connected: boolean;
  /** Said in words beside the dot, so colour is never the only sign. */
  word: string;
  /** "322 GB free", or an empty string when not known. */
  space: string;
  /** A drive gets its colour dot; the accounts tile is text only. */
  kind: 'drive' | 'accounts';
}

/** One tile per named drive (plugged in first) and one for all the Google accounts together (there can be dozens). */
export function homeTiles(places: readonly PlaceView[]): HomeTile[] {
  const tiles: HomeTile[] = driveOrder(places.filter((p) => p.kind === 'drive')).map((drive) => ({
    id: drive.id,
    name: drive.label,
    connected: drive.status === 'connected',
    word: drive.status === 'connected' ? 'Connected' : 'Not connected',
    space: drive.freeBytes === null ? '' : `${formatBytes(drive.freeBytes)} free`,
    kind: 'drive',
  }));
  const accounts = places.filter((p) => p.kind === 'gdrive');
  if (accounts.length > 0) {
    let free = 0;
    let known = 0;
    for (const account of accounts) {
      const facts = accountFacts(account);
      if (facts.freeBytes === null) continue;
      free += facts.freeBytes;
      known += 1;
    }
    const signIn = accounts.filter((a) => a.status === 'needs_signin').length;
    tiles.push({
      id: 'google-accounts',
      name: `${formatCount(accounts.length)} Google ${plural(accounts.length, 'account', 'accounts')}`,
      connected: signIn === 0,
      word: signIn === 0 ? 'Signed in' : `${signIn} need signing in`,
      space: known === 0 ? '' : `${formatBytes(free)} free`,
      kind: 'accounts',
    });
  }
  return tiles;
}

/** The small link at the end of each "Needs you" line: where the thing is fixed. */
export const NEEDS_YOU_LINKS: Readonly<Record<NeedsYouItem['target'], string>> = { activity: 'Open Activity', devices: 'Open Devices' };

export interface NeedsYouItem {
  key: string;
  text: string;
  /** Where a click goes. */
  target: 'activity' | 'devices';
}

/**
 * What needs you: jobs waiting for an answer, jobs that really failed in the last 7 days (a job you stopped, or that the app
 * closing interrupted, is not a failure; one that kept a checkpoint waits for Continue or Dismiss), drives 85% full or more, accounts 90% full or more, accounts to sign in again.
 */
export function needsYou(jobs: readonly JobRecord[], places: readonly PlaceView[], now: number): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const cutoff = now - NEEDS_YOU_DAYS * DAY_MS;
  for (const job of jobs) {
    if (job.state === 'needs_you') items.push({ key: `job:${job.id}`, text: `${job.title}: ${job.message ?? 'waiting for your answer'}`, target: 'activity' });
    else if (isContinuable(job) && (job.finishedAt ?? job.startedAt ?? job.createdAt) >= cutoff) {
      // Nothing continues by itself: the person decides in Activity (Continue or Dismiss).
      items.push({ key: `job:${job.id}`, text: `${job.title}: interrupted when the app closed. Continue it or dismiss it in Activity`, target: 'activity' });
    } else if (isRealFailure(job) && (job.finishedAt ?? job.startedAt ?? job.createdAt) >= cutoff) {
      items.push({ key: `job:${job.id}`, text: `${job.title}: ${explainInList(job, jobs).headline}`, target: 'activity' });
    }
  }
  for (const drive of places.filter((p) => p.kind === 'drive' && p.status === 'connected')) {
    const used = usedShare(drive.freeBytes, drive.capacityBytes);
    if (used !== null && used >= DRIVE_AMBER_AT) items.push({ key: `space:${drive.id}`, text: `${drive.label} is ${Math.round(used * 100)}% full`, target: 'devices' });
  }
  for (const drive of places.filter((p) => p.kind === 'drive' && p.status === 'problem')) {
    items.push({ key: `problem:${drive.id}`, text: `${drive.label}: ${drive.problem ?? 'it is plugged in but cannot be read'}`, target: 'devices' });
  }
  const accounts = places.filter((p) => p.kind === 'gdrive');
  const full = accounts.filter((a) => (accountFacts(a).percent ?? 0) >= ACCOUNT_RED_PERCENT).length;
  if (full > 0) items.push({ key: 'accounts-full', text: `${full} Google ${plural(full, 'account is', 'accounts are')} ${ACCOUNT_RED_PERCENT}% full or more`, target: 'devices' });
  const signIn = accounts.filter((a) => a.status === 'needs_signin').length;
  if (signIn > 0) items.push({ key: 'accounts-signin', text: `${signIn} Google ${plural(signIn, 'account needs', 'accounts need')} signing in again`, target: 'devices' });
  return items;
}

export interface HomeBackup {
  id: number;
  name: string;
  /** What it is of (phone, laptop, cloud, drive): the colour of the icon beside the name. */
  kind: BackupKind;
  status: BackupStatus;
  /** "Last backup 23 Nov, 4 months ago", or "No backup yet". */
  lastLine: string;
  /** "T7: up to date · Seagate2TB: behind by 1,234 files (12 GB)" for a backup with a second drive, else null. */
  mirrorLine?: string;
  /** "Plug in the T7 to bring the Seagate2TB up to date" when only the second drive is here, else null. */
  mirrorNote?: string;
  /** A phone backup whose phone is plugged in: "Back up now" is offered. */
  canBackUpNow: boolean;
  /** A phone backup whose phone is not plugged in: "Plug in Poco F4 to back it up". Null otherwise. */
  plugNote: string | null;
}

/** The two quiet lines of a backup with a second drive (absent for the others). */
function mirrorLines(row: BackupRow, mirror: MirrorStatusResult | null, now: number): { mirrorLine?: string; mirrorNote?: string } {
  if ((row.destinations?.length ?? 1) < 2) return {};
  const status = mirror?.backups.find((m) => m.backupId === row.id);
  const first = row.destinations![0]!.label;
  const note = plugInNote(status);
  return { mirrorLine: statusLine(first, backupStatusOf(row, now), status) ?? first + ': counting the second drive...', ...(note ? { mirrorNote: note } : {}) };
}

/** Problem first, then Behind, then Never backed up, then Up to date. */
const BACKUP_ORDER: Readonly<Record<BackupStatus, number>> = { problem: 0, behind: 1, never: 2, 'not-connected': 3, 'up-to-date': 4 };

/**
 * "Your backups" on Home: one row per backup that is switched on, the worst first (same order inside a status: by name).
 * `connected` is which phones are plugged in; null when that is not known (then no phone row asks to plug anything in).
 */
export function yourBackups(rows: readonly BackupRow[], connected: ConnectedPhones | null, now: number, mirror: MirrorStatusResult | null = null): HomeBackup[] {
  return rows
    .filter((row) => row.enabled)
    .map((row): HomeBackup => {
      const phone = row.kind === 'phone';
      const plugged = phone && (connected?.phones.some((p) => p.backupId === row.id) ?? false);
      const item: HomeBackup = {
        id: row.id,
        name: row.name,
        kind: backupKindOf(row),
        // Up to date only if each drive of the backup is: a second drive that is behind makes it Behind.
        status: combinedStatus(backupStatusOf(row, now), mirror?.backups.find((m) => m.backupId === row.id)),
        lastLine: row.lastBackupAt === null ? 'No backup yet' : `Last backup ${shortDate(row.lastBackupAt, now)}, ${agoText(row.lastBackupAt, now)}`,
        canBackUpNow: plugged,
        plugNote: phone && !plugged && connected !== null ? `Plug in ${row.name} to back it up` : null,
      };
      return Object.assign(item, mirrorLines(row, mirror, now));
    })
    .toSorted((a, b) => BACKUP_ORDER[a.status] - BACKUP_ORDER[b.status] || a.name.localeCompare(b.name));
}

export interface ReminderItem {
  key: string;
  text: string;
}

/**
 * Reminders: "T7 not plugged in for 14 days" for each named drive that is not connected and was last seen more than `days` days ago.
 * Longest away first. A drive never seen (no date) or connected now is left out. Nothing runs because of a reminder.
 */
export function driveReminders(places: readonly PlaceView[], days: number, now: number): ReminderItem[] {
  const out: { item: ReminderItem; away: number }[] = [];
  for (const drive of places) {
    if (drive.kind !== 'drive' || drive.status === 'connected' || drive.lastConnectedAt === null) continue;
    const away = Math.floor((now - drive.lastConnectedAt) / DAY_MS);
    if (away < days || away < 1) continue;
    out.push({ item: { key: `away:${drive.id}`, text: `${drive.label} not plugged in for ${formatCount(away)} ${plural(away, 'day', 'days')}` }, away });
  }
  return out.toSorted((a, b) => b.away - a.away || a.item.text.localeCompare(b.item.text)).map((o) => o.item);
}

export interface RecentItem {
  id: number;
  title: string;
  line: string;
  when: string;
}

/** The last 5 Activity items, newest first, one line each. The app's quiet upkeep is left out, as on the Activity screen. */
export function recentActivity(jobs: readonly JobRecord[], now: number, count = RECENT_SHOWN): RecentItem[] {
  return visibleJobs(jobs, false)
    .toSorted((a, b) => b.id - a.id)
    .slice(0, count)
    .map((job) => ({
      id: job.id,
      title: job.title,
      line: jobRowLine(job, jobs),
      when: job.state === 'queued' ? '' : formatWhen(job.finishedAt ?? job.startedAt ?? job.createdAt, now),
    }));
}
