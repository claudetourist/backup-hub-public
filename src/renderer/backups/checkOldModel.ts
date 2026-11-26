/** The words and sums behind "Check old copies" (R1.4b). Pure. Plain words only: no row, index, destination or serial. */
import type { CheckOldCounts, CheckOldFolder, CheckOldFolderCounts, CheckOldNamed, CheckOldReport, CountBucket } from '../../shared/phoneBackup';
import { formatBytes, formatCount, plural } from '../lib/format';

export const CHECK_OLD_BUTTON = 'Check old copies';
export const CHECK_OLD_PREVIEW_HEADLINE = 'Folders with copies that were never checked, largest first. Untick a folder to leave it out.';

const files = (n: number): string => `${formatCount(n)} ${plural(n, 'file', 'files')}`;

/** "Poco F4: 12,345 of 33,721 files have a checked copy on T7." (the name is the backup's name; for a phone never read, see `neverReadText`) */
export function headlineText(backupName: string, driveLabel: string, c: CheckOldCounts): string {
  return `${backupName}: ${formatCount(c.checked.files)} of ${formatCount(c.onPhone.files)} ${plural(c.onPhone.files, 'file has', 'files have')} a checked copy on ${driveLabel}.`;
}

/** True when no file of the phone is known yet: the phone was never read (or the last look found nothing), so the numbers would say nothing. */
export const neverRead = (c: CheckOldCounts): boolean => c.onPhone.files === 0;

/** "Sam phone has not been read yet. Back it up once, then this shows how many files have a checked copy." */
export const neverReadText = (backupName: string): string => `${backupName} has not been read yet. Back it up once, then this shows how many files have a checked copy.`;

/** What the rest are: copies not checked yet, files with no copy, files left out on purpose. Zero parts are not mentioned. */
export function breakdownText(c: CheckOldCounts): string {
  const parts: string[] = [];
  if (c.unchecked.files > 0) parts.push(`${files(c.unchecked.files)} (${formatBytes(c.unchecked.bytes)}) have a copy that was never checked`);
  if (c.noCopy.files > 0) parts.push(`${files(c.noCopy.files)} (${formatBytes(c.noCopy.bytes)}) have no copy yet`);
  if (c.leftOut.files > 0) parts.push(`${files(c.leftOut.files)} (${formatBytes(c.leftOut.bytes)}) are left out on purpose`);
  return parts.length === 0 ? '' : `${parts.join('; ')}.`;
}

/** One line of the "By folder" fold. */
export function folderLine(f: CheckOldFolderCounts): string {
  const rest: string[] = [];
  if (f.unchecked.files > 0) rest.push(`not checked yet: ${formatCount(f.unchecked.files)} (${formatBytes(f.unchecked.bytes)})`);
  if (f.noCopy.files > 0) rest.push(`no copy: ${formatCount(f.noCopy.files)}`);
  if (f.leftOut.files > 0) rest.push(`left out: ${formatCount(f.leftOut.files)}`);
  return `${f.folder}: ${formatCount(f.checked.files)} of ${formatCount(f.onPhone.files)} checked (${formatBytes(f.checked.bytes)} of ${formatBytes(f.onPhone.bytes)})${rest.length > 0 ? '. ' + rest.join(', ') : ''}`;
}

export const lookedAtText = (ms: number | null, formatWhen: (ms: number) => string): string | null => (ms === null ? null : `As of the last look at the phone, ${formatWhen(ms)}.`);

// ---- the preview -------------------------------------------------------------------------------------------------------------

/** What "Check N files (X GB)" will check: the ticked folders. */
export function selectionTotals(folders: readonly CheckOldFolder[], unticked: ReadonlySet<string>): CountBucket {
  return folders.filter((f) => !unticked.has(f.folder)).reduce((a, f) => ({ files: a.files + f.files, bytes: a.bytes + f.bytes }), { files: 0, bytes: 0 });
}

export const confirmText = (sel: CountBucket): string => `Check ${formatCount(sel.files)} ${plural(sel.files, 'file', 'files')} (${formatBytes(sel.bytes)})`;

export const folderTickLine = (f: CheckOldFolder): string => `${f.folder}: ${files(f.files)}, ${formatBytes(f.bytes)}`;

/** A set with one folder ticked or unticked (a new set). */
export function toggleFolder(unticked: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(unticked);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  return next;
}

/** Every folder ticked (a new, empty set of unticked folders). */
export const tickAll = (): Set<string> => new Set();

/** Every folder unticked (a new set holding all of them). */
export const untickAll = (folders: readonly CheckOldFolder[]): Set<string> => new Set(folders.map((f) => f.folder));

/** How many of the folders are ticked. */
export const tickedFolders = (folders: readonly CheckOldFolder[], unticked: ReadonlySet<string>): number => folders.filter((f) => !unticked.has(f.folder)).length;

// ---- the report --------------------------------------------------------------------------------------------------------------

export interface ReportLine {
  key: string;
  text: string;
  tone: 'ok' | 'warn' | 'plain';
}

/** The report in plain sentences: what is now checked, what differs, what is missing, what is gone from the phone, what could not be read. */
export function reportLines(r: CheckOldReport): ReportLine[] {
  const lines: ReportLine[] = [];
  lines.push({ key: 'verified', tone: 'ok', text: `${files(r.verified.files)} (${formatBytes(r.verified.bytes)}) are the same on the phone and on ${r.driveLabel}. They now count as checked copies.` });
  if (r.differCount > 0) {
    lines.push({ key: 'differ', tone: 'warn', text: `${files(r.differCount)} ${plural(r.differCount, 'is', 'are')} not the same on ${r.driveLabel} as on the phone. The copy on ${r.driveLabel} was left exactly as it is. The next backup copies ${plural(r.differCount, 'this file', 'these files')} again, into a new folder.` });
  }
  if (r.missingCount > 0) {
    lines.push({ key: 'missing', tone: 'warn', text: `${files(r.missingCount)} ${plural(r.missingCount, 'is', 'are')} not on ${r.driveLabel} any more. The next backup copies ${plural(r.missingCount, 'it', 'them')} again.` });
  }
  if (r.noLongerOnPhone > 0) lines.push({ key: 'gone', tone: 'plain', text: `${files(r.noLongerOnPhone)} ${plural(r.noLongerOnPhone, 'is', 'are')} no longer on the phone. Skipped.` });
  for (const c of r.couldNotRead) {
    lines.push({ key: `unread:${c.reason}`, tone: 'warn', text: `${files(c.count)} could not be read: ${c.reason} They stay as they were and can be checked again.${c.examples.length > 0 ? ' For example: ' + c.examples.map(nameOf).join(', ') + '.' : ''}` });
  }
  return lines;
}

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The files named in a fold of the report: name, folder, size. */
export function namedRows(list: readonly CheckOldNamed[]): { key: string; name: string; folder: string; size: string }[] {
  return list.map((f) => ({ key: f.path, name: nameOf(f.path), folder: f.path.replace(/^\/sdcard\/?/, '').split('/').slice(0, -1).join('/') || 'Phone storage', size: formatBytes(f.size) }));
}

export const foldTitle = (what: string, total: number, shown: number): string => (shown < total ? `${what} (${formatCount(total)}, the first ${formatCount(shown)} are named)` : `${what} (${formatCount(total)})`);

export const reportTitle = (r: Pick<CheckOldReport, 'asked' | 'phoneName'>): string => `Checked ${files(r.asked)} from ${r.phoneName}`;
