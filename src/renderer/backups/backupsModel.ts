import type { BackupRow, HistoryFileInfo, HistoryResult } from '../../shared/backups';
import { MY_DATA_FOLDER } from '../../shared/appFolders';
import { NEW_BACKUP_NAME_MAX, folderPrefixFor, safeFolderName } from '../../shared/newPhoneBackup';
import type { ConnectedPhones, CreatePhoneBackupRequest, NewBackupChoices, NewBackupDrive, NewPhone } from '../../shared/phoneBackup';
import type { BackupStatus } from '../components/backupStatus';
import { formatBytes, formatCount, plural } from '../lib/format';

/** Pure words for the Backups screen (no React), so they can be tested. */

const DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

/** "17 Jul 2026", or "Not known yet" when the history has no date for it. */
export function lastBackupText(ms: number | null): string {
  return ms === null ? 'Not known yet' : new Date(ms).toLocaleDateString('en-GB', DATE);
}

const DAY_MS = 86_400_000;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A backup whose last run is older than this many days is "Behind" (one rule for Home and for Backups). */
export const BEHIND_AFTER_DAYS = 14;

/**
 * The one status word of a backup: Problem when its last run failed, Never backed up when there is no date, Behind when the last
 * backup is older than BEHIND_AFTER_DAYS, else Up to date.
 */
export function backupStatusOf(row: Pick<BackupRow, 'lastBackupAt' | 'lastRunFailed'>, now: number): BackupStatus {
  if (row.lastRunFailed) return 'problem';
  if (row.lastBackupAt === null) return 'never';
  return now - row.lastBackupAt > BEHIND_AFTER_DAYS * DAY_MS ? 'behind' : 'up-to-date';
}

/** "23 Nov", or "23 Nov 2025" when it is not this year. */
export function shortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ' ' + d.getFullYear();
  return d.getDate() + ' ' + MONTH_SHORT[d.getMonth()]! + year;
}

const dayNumber = (ms: number): number => {
  const d = new Date(ms);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
};

/** "today", "yesterday", "9 days ago", "4 months ago", "2 years ago" (by calendar day; a date in the future reads "today"). */
export function agoText(ms: number, now: number): string {
  const days = Math.max(0, dayNumber(now) - dayNumber(ms));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months + ' ' + plural(months, 'month', 'months') + ' ago';
  }
  const years = Math.floor(days / 365);
  return years + ' ' + plural(years, 'year', 'years') + ' ago';
}

/** "PhoneBackup history brought in on 23 Nov." */
export const historyBroughtInText = (ms: number, now: number): string => 'PhoneBackup history brought in on ' + shortDate(ms, now) + '.';

/** Where a backup goes: "T7, folder MyData/POCO", or a plain line when it has no backup folder yet. */
export function driveText(row: Pick<BackupRow, 'driveLabel' | 'folder' | 'driveConnected'>): string {
  if (row.driveLabel === null || row.folder === null) return 'No backup folder yet';
  return row.driveLabel + ', folder ' + row.folder + (row.driveConnected ? '' : ' (not plugged in)');
}

/** One file the import will read: "POCO: 14.6 MB, last written 26 Oct 2026". */
export function readLine(file: HistoryFileInfo): string {
  if (!file.found) return file.backup + ': no history file found';
  const when = file.modifiedAt === null ? '' : ', last written ' + new Date(file.modifiedAt).toLocaleDateString('en-GB', DATE);
  return file.backup + ': ' + formatBytes(file.bytes) + when;
}

/** The headline of the counts report. */
export function reportHeadline(result: Extract<HistoryResult, { ok: true }>): string {
  const t = result.totals;
  return formatCount(t.rowsIn) + ' ' + plural(t.rowsIn, 'row', 'rows') + ' brought in: ' + formatCount(t.linked) + ' matched to files on the ' + result.driveLabel + ', ' + formatCount(t.loose) + ' with no original path, ' + formatCount(t.stale) + ' could not be matched.';
}

export function spareText(spare: Extract<HistoryResult, { ok: true }>['spare']): string | null {
  if (spare.inHistory === 0) return null;
  let text = 'Spare: ' + formatCount(spare.inHistory) + ' ' + plural(spare.inHistory, 'row', 'rows') + ' in the history, ' + formatCount(spare.marked) + ' marked as kept only on the Seagate.';
  if (spare.stillShown > 0) text += ' ' + formatCount(spare.stillShown) + ' still show as on the T7 because the T7 was last checked before Spare was removed. Check the T7 again in Devices, then bring in the history again.';
  return text;
}

/** The question on the card for a phone that is plugged in and belongs to no backup yet. */
export function newPhoneQuestion(phoneName: string, backupNames: readonly string[]): string {
  const first = backupNames[0];
  if (first === undefined) return 'A phone is plugged in: ' + phoneName + '. It has no backup yet.';
  if (first !== undefined && backupNames.length === 1) return 'A phone is plugged in: ' + phoneName + ". Is this the phone for '" + first + "'?";
  return 'A phone is plugged in: ' + phoneName + '. Is this the phone for one of these backups?';
}

/** The button that links the phone to one backup. */
export const yesThisIsText = (backupName: string): string => 'Yes, this is ' + backupName;

/** The phones the card still asks about: plugged in, belonging to no backup, and not put off with "Not now". */
export function phonesToAsk(connected: ConnectedPhones | null, hidden: ReadonlySet<string>): NewPhone[] {
  if (connected === null) return [];
  return connected.newPhones.filter((p) => !hidden.has(p.serial));
}

/** "Not now" holds only until the phone is plugged in again: a serial that is no longer plugged in is forgotten. */
export function forgetUnplugged(hidden: ReadonlySet<string>, connected: ConnectedPhones | null): Set<string> {
  const still = new Set((connected?.newPhones ?? []).map((p) => p.serial));
  return new Set([...hidden].filter((serial) => still.has(serial)));
}

/** What the "Change phone" question says. */
export const changePhoneWarning = (backupName: string): string =>
  'Backup Hub will forget which phone is ' + backupName + '. Nothing on the phone or on the drive is changed. When a phone is plugged in you can say again which backup it is for.';

// ---- Make a new backup for this phone ------------------------------------------------------

/** The button on the card of a new phone. */
export const MAKE_NEW_BACKUP_TEXT = 'Make a new backup for this phone';
export const NO_DRIVE_LINE = 'Plug in the drive you want the backups on, then press Check for a phone.';
export const EXISTING_FOLDER_NOTE = 'Files already in this folder are recognised by their checksum and not copied again. Nothing in it is changed or removed.';
export const EXISTING_FOLDER_CHOICE = 'A folder already on the drive';
export const NO_EXISTING_FOLDERS = 'There is no folder on this drive that can be used.';

export interface NewBackupForm {
  name: string;
  /** The drive picked, or null when none is picked yet. */
  placeId: string | null;
  folderKind: 'new' | 'existing';
  /** The folder picked from the drive (only for folderKind 'existing'). */
  existingName: string | null;
  /** Whose phone it is: a person's id, 'new' for someone new (named below), or null when the form is not asked (no people known). */
  ownerId: number | 'new' | null;
  newPersonName: string;
}

/** The form as it opens: the phone's name, the drive when there is only one, "A new folder". */
export function initialForm(choices: Extract<NewBackupChoices, { ok: true }>, ownerId: number | null = null): NewBackupForm {
  return { name: choices.suggestedName, placeId: choices.drives.length === 1 ? choices.drives[0]!.placeId : null, folderKind: 'new', existingName: null, ownerId, newPersonName: '' };
}

export const driveOf = (choices: Extract<NewBackupChoices, { ok: true }>, placeId: string | null): NewBackupDrive | null => choices.drives.find((d) => d.placeId === placeId) ?? null;

/** Picking another drive drops a folder that the new drive does not have. */
export function pickDrive(form: NewBackupForm, choices: Extract<NewBackupChoices, { ok: true }>, placeId: string): NewBackupForm {
  const folders = driveOf(choices, placeId)?.folders ?? [];
  return { ...form, placeId, existingName: form.existingName !== null && folders.includes(form.existingName) ? form.existingName : null };
}

/** "A new folder: MyData\Sam phone" (the name is made Windows-safe live), or what is missing. */
export function newFolderChoiceText(name: string): string {
  const folder = safeFolderName(name.trim());
  return folder === null ? 'A new folder (the name needs letters or numbers)' : 'A new folder: ' + MY_DATA_FOLDER + '\\' + folder;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Each backup goes in a dated folder, like Sam-phone-23Nov26." */
export function datedFolderExample(name: string, today: Date): string {
  const day = String(today.getDate()).padStart(2, '0') + MONTHS[today.getMonth()]! + String(today.getFullYear()).slice(-2);
  return 'Each backup goes in a dated folder, like ' + folderPrefixFor(name) + '-' + day + '.';
}

/** Why Save is off (null when the form can be saved). Main checks everything again. */
export function formProblem(form: NewBackupForm): string | null {
  const name = form.name.trim();
  if (name === '') return 'Type a name for the backup.';
  if (Array.from(name).length > NEW_BACKUP_NAME_MAX) return 'Keep the name under ' + (NEW_BACKUP_NAME_MAX + 1) + ' characters.';
  if (form.placeId === null) return 'Choose the drive.';
  if (form.folderKind === 'new' && safeFolderName(name) === null) return 'The name needs letters or numbers, so a folder can be made from it.';
  if (form.folderKind === 'existing' && form.existingName === null) return 'Choose the folder.';
  if (form.ownerId === 'new' && form.newPersonName.trim() === '') return 'Type the name of the person this phone belongs to.';
  return null;
}

/** What is sent to main when Save is pressed (only for a form without a problem). */
export function createRequest(form: NewBackupForm): Omit<CreatePhoneBackupRequest, 'serial'> | null {
  if (formProblem(form) !== null || form.placeId === null) return null;
  const folder: CreatePhoneBackupRequest['folder'] = form.folderKind === 'new' || form.existingName === null ? { kind: 'new' } : { kind: 'existing', name: form.existingName };
  const base = { name: form.name.trim(), placeId: form.placeId, folder };
  if (form.ownerId === null) return base;
  return { ...base, owner: form.ownerId === 'new' ? { newName: form.newPersonName.trim() } : { id: form.ownerId } };
}
