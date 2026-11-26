/** The words and sums behind the folder backup panel (R2.1, R2.8). Pure. */
import { FOLDER_TOP_WORDS, IN_USE_REASON, KEEP_SYNC_PRIVACY, ONLINE_ONLY_WORDS, type FolderBackupCard, type FolderBackupReport, type FolderPlanView, type MovedGroup, type OnlineOnlyInfo } from '../../shared/folderBackup';
import type { ReportData } from '../components/reportModel';
import { formatBytes, formatCount, plural } from '../lib/format';

export const folderCardTitle = (c: Pick<FolderBackupCard, 'backupName'>): string => `Back up ${c.backupName} now?`;
export const folderButton = (name: string): string => `Back up ${name} now`;
export const FOLDER_OLD_TOOL_WARNING = 'Do not run the old PhoneBackup for this folder any more.';

/** The lines under the title before anything has happened. */
export function folderIdleLines(c: Pick<FolderBackupCard, 'sourceWords' | 'layout'>): string[] {
  if (c.layout === 'flat') {
    return [
      `Looks at ${c.sourceWords} and at the drive and shows you the files not on the drive yet. Nothing is copied until you confirm, and nothing on the drive is ever replaced or deleted.`,
      KEEP_SYNC_PRIVACY,
    ];
  }
  return [`Looks at ${c.sourceWords} and shows you the files that are new or changed first. Nothing is copied until you confirm.`];
}

export const looking = (c: Pick<FolderBackupCard, 'sourceWords'>): string => `Looking at ${c.sourceWords}. This can take a few minutes. Nothing is copied.`;

/** "Online only, not copied this time: 12 files, 3.1 GB. They are in OneDrive but not on this computer, so nothing was opened or downloaded." Null when there are none. */
export function onlineOnlyLine(info: OnlineOnlyInfo): string | null {
  if (info.files === 0) return null;
  return `${ONLINE_ONLY_WORDS}: ${formatCount(info.files)} ${plural(info.files, 'file', 'files')}, ${formatBytes(info.bytes)}. They are in OneDrive but not on this computer, so nothing was opened or downloaded.`;
}

/** What the person is told about files that are already in the backup. */
export function alreadyLine(plan: Pick<FolderPlanView, 'alreadyBackedUp' | 'sameContentElsewhere' | 'differentOnDrive' | 'layout' | 'driveLabel'>): string {
  const parts = [`Already backed up: ${formatCount(plan.alreadyBackedUp)} ${plural(plan.alreadyBackedUp, 'file', 'files')}.`];
  if (plan.sameContentElsewhere > 0) parts.push(`${formatCount(plan.sameContentElsewhere)} of them were found by their content under another name or date, so they are linked and not copied again.`);
  if (plan.differentOnDrive > 0) parts.push(`${formatCount(plan.differentOnDrive)} files have the same name as one on ${plan.driveLabel} but another size. They are never replaced, so they were left alone.`);
  return parts.join(' ');
}

const MOVED_LINES_SHOWN = 3;
const folderWords = (p: string): string => (p === '' ? FOLDER_TOP_WORDS : p.split('/').join('\\'));

/** One plain line for a group of files renamed or moved since they were backed up: they are the same files, so nothing is copied. */
export function movedLine(g: MovedGroup): string {
  const n = `${formatCount(g.files)} ${plural(g.files, 'file', 'files')}`;
  if (g.kind === 'files') return `${n} renamed or moved on their own: nothing to copy.`;
  return `${g.kind === 'folder_renamed' ? 'Folder renamed' : 'Folder moved'}: ${folderWords(g.from)} > ${folderWords(g.to)} (${n}): nothing to copy.`;
}

/** The lines under the counts for files renamed or moved (the biggest three groups, then one line for the rest). Empty when nothing was. */
export function movedLines(plan: Pick<FolderPlanView, 'moved' | 'movedFiles'>): string[] {
  if (plan.movedFiles === 0) return [];
  const shown = plan.moved.slice(0, MOVED_LINES_SHOWN);
  const lines = shown.map(movedLine);
  const rest = plan.movedFiles - shown.reduce((s, g) => s + g.files, 0);
  if (rest > 0) lines.push(`And ${formatCount(rest)} more ${plural(rest, 'file', 'files')} renamed or moved: nothing to copy.`);
  return lines;
}

/** The generic Report of the kit, from the report main kept: files in use and online-only files are skipped, with their reason. */
export function folderReportData(r: FolderBackupReport, formatWhen: (ms: number) => string): ReportData {
  const skipped = r.skipped.filter((s) => s.count > 0);
  if (r.inUseCount > 0) skipped.push({ reason: IN_USE_REASON, count: r.inUseCount, examples: r.inUse.flatMap((l) => l.examples).slice(0, 5) });
  if (r.linked > 0) skipped.push({ reason: 'already in the backup (not copied again)', count: r.linked, examples: [] });
  return { copied: r.copied, skipped, failed: r.failed, where: r.where, finished: formatWhen(r.finishedAt) };
}
