import type { BackupRow, BackupSize } from '../../shared/backups';
import { progressPercent, type JobRecord } from '../../shared/jobs';
import type { MirrorBackupStatus, MirrorStatusResult } from '../../shared/mirror';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import type { BackupKind } from '../components/backupKinds';
import { backupKindOf } from '../components/backupKinds';
import type { BackupStatus } from '../components/backupStatus';
import { wholePercent } from '../components/progressModel';
import { formatBytes, formatCount, plural } from '../lib/format';
import { agoText, backupStatusOf, lastBackupText, shortDate } from './backupsModel';
import { bringAllButton, bringUpButton, bringUpState, checkAllButton, combinedStatus } from './mirrorModel';

/** Pure parts of the Backups list and of a backup's page (no React), so they can be tested. */

// ---- the address of a backup's page ---------------------------------------------------------------------------------------------------

export type BackupTab = 'overview' | 'backup' | 'second' | 'check' | 'google' | 'choices' | 'covered' | 'history' | 'free' | 'restore';

export const TAB_LABELS: Readonly<Record<BackupTab, string>> = {
  overview: 'Overview',
  backup: 'Back up now',
  second: 'Second copy',
  check: 'Check old copies',
  google: 'Google',
  choices: 'Exclusions',
  covered: 'Not covered',
  history: 'History',
  free: 'Free up phone space',
  restore: 'Get files back',
};

const TAB_IDS = Object.keys(TAB_LABELS) as BackupTab[];

/** The part of the address after "#/backups/": "12", "12/second" or "12/second/go" ("go" = start the look at once, as the button on the list asked). */
export function backupSub(id: number, tab: BackupTab = 'overview', go = false): string {
  return tab === 'overview' && !go ? String(id) : go ? `${id}/${tab}/go` : `${id}/${tab}`;
}

export interface BackupAddress {
  id: number;
  tab: BackupTab;
  go: boolean;
}

/** Null when the address is the list (no sub) or not a backup's page. */
export function parseBackupSub(sub: string | null): BackupAddress | null {
  if (sub === null) return null;
  const [idText = '', tabText, goText] = sub.split('/');
  if (!/^\d{1,9}$/.test(idText)) return null;
  const tab = TAB_IDS.find((t) => t === tabText) ?? 'overview';
  return { id: Number(idText), tab, go: goText === 'go' };
}

/** The tabs a backup's page has: what does not apply to this backup is not offered. */
export function tabsFor(row: Pick<BackupRow, 'kind' | 'destinations'>): { id: BackupTab; label: string }[] {
  const second = (row.destinations?.length ?? 1) > 1;
  const ids: BackupTab[] = ['overview', 'backup'];
  if (second) ids.push('second');
  if (row.kind === 'phone' || second) ids.push('check');
  if (row.kind === 'phone') ids.push('google', 'free');
  ids.push('choices');
  if (row.kind === 'phone') ids.push('covered');
  ids.push('history');
  ids.push('restore');
  return ids.map((id) => ({ id, label: TAB_LABELS[id] }));
}

// ---- jobs ----------------------------------------------------------------------------------------------------------------------------------

const ACTIVE = new Set<string>(['queued', 'running', 'needs_you']);
export const isActiveJob = (job: Pick<JobRecord, 'state'>): boolean => ACTIVE.has(job.state);

/** The jobs that work on this backup (a second-copy job over all backups names each of them), newest first. */
export function jobsOf(jobs: readonly JobRecord[], backupId: number): JobRecord[] {
  return jobs.filter((j) => j.backupIds?.includes(backupId) === true).toSorted((a, b) => b.id - a.id);
}

/** The job of this backup that is going on now (running, waiting for its turn, or asking you), the newest one. Heavy ones before a look. */
export function activeJobOf(jobs: readonly JobRecord[], backupId: number): JobRecord | null {
  const active = jobsOf(jobs, backupId).filter(isActiveJob);
  return active.find((j) => !j.kind.endsWith('.look')) ?? active[0] ?? null;
}

/** Whole percent done (bytes when known, else files), or null when the size is not known yet. The progress panel shows the same number (`percentDone` + `wholePercent`). */
export function jobPercent(job: Pick<JobRecord, 'bytesDone' | 'bytesTotal' | 'progressDone' | 'progressTotal'>): number | null {
  const percent = progressPercent(job);
  return percent === null ? null : wholePercent(percent);
}

const secondLabelOf = (row: Pick<BackupRow, 'destinations'>): string => row.destinations?.[1]?.label ?? 'the second drive';
const firstLabelOf = (row: Pick<BackupRow, 'driveLabel'>): string => row.driveLabel ?? 'the drive';

/** What the job is doing, in the backup's own words: "Copying to Seagate2TB". */
export function jobWhat(row: Pick<BackupRow, 'kind' | 'driveLabel' | 'destinations'>, job: Pick<JobRecord, 'kind' | 'title'>): string {
  switch (job.kind) {
    case 'phone.backup':
    case 'folder.backup':
      return 'Copying to ' + firstLabelOf(row);
    case 'mirror.copy':
      return 'Copying to ' + secondLabelOf(row);
    case 'mirror.checkOld':
      return 'Checking old copies on ' + secondLabelOf(row);
    case 'phone.checkOld':
      return 'Checking old copies on ' + firstLabelOf(row);
    case 'phone.look':
      return 'Looking at the phone';
    case 'folder.look':
      return 'Looking at the folder';
    case 'mirror.look':
      return 'Looking at both drives';
    case 'google.copy':
      return 'Copying to Google';
    case 'restore.files':
      return 'Getting files back';
    default:
      return job.title;
  }
}

/** The live line of a row: "Copying to Seagate2TB, 17%". */
export function progressLine(row: Pick<BackupRow, 'kind' | 'driveLabel' | 'destinations'>, job: JobRecord): string {
  const what = jobWhat(row, job);
  const percent = jobPercent(job);
  const pct = percent === null ? '' : `${percent}%`;
  if (job.state === 'needs_you') return what + ': waiting for you';
  if (job.paused && job.pausing === true) return what + ', pausing: saving your place' + (pct ? ' at ' + pct : '');
  if (job.paused) return what + ', paused' + (pct ? ' at ' + pct : '');
  if (job.state === 'queued') return what + ', waiting for its turn';
  return what + (pct ? ', ' + pct : '');
}

/** A look or a copy of this backup that is still going: a panel that opens now picks it up instead of offering the button again. */
export interface ResumeJob {
  jobId: number;
  phase: 'look' | 'run';
  driveLabel: string | null;
}

export function resumeOf(jobs: readonly JobRecord[], backupId: number, kinds: { look: string; run: string }, driveLabel: string | null): ResumeJob | null {
  const job = jobsOf(jobs, backupId).find((j) => isActiveJob(j) && (j.kind === kinds.run || j.kind === kinds.look));
  return job ? { jobId: job.id, phase: job.kind === kinds.run ? 'run' : 'look', driveLabel } : null;
}

// ---- one row of the list -------------------------------------------------------------------------------------------------------------------

/** Where the sizes stand: not asked back yet, could not be counted, or here. */
export type SizesState = 'loading' | 'failed' | ReadonlyMap<number, BackupSize>;

/** "1,204 files · 3.2 GB"; a placeholder while the count is running. */
export function numbersText(sizes: SizesState, backupId: number): string {
  if (sizes === 'loading') return 'Counting…';
  if (sizes === 'failed') return 'Not counted';
  const size = sizes.get(backupId);
  if (size === undefined) return 'Not counted';
  if (size.files === 0) return 'No files yet';
  return formatCount(size.files) + ' ' + plural(size.files, 'file', 'files') + ' · ' + formatBytes(size.bytes);
}

/** "T7 · MyData/POCO", with the second drive: "T7 + Seagate2TB · MyData/POCO". */
export function keptText(row: Pick<BackupRow, 'driveLabel' | 'folder' | 'destinations'>): string {
  if (row.driveLabel === null || row.folder === null) return 'No backup folder yet';
  const drives = row.destinations && row.destinations.length > 1 ? row.destinations.map((d) => d.label).join(' + ') : row.driveLabel;
  return drives + ' · ' + row.folder;
}

/** What is plugged in or not, in a short note ("Seagate2TB is not plugged in"), or null. */
export function plugNote(row: Pick<BackupRow, 'driveConnected' | 'driveLabel' | 'destinations'>): string | null {
  const away = row.destinations && row.destinations.length > 0 ? row.destinations.filter((d) => !d.connected).map((d) => d.label) : row.driveConnected || row.driveLabel === null ? [] : [row.driveLabel];
  if (away.length === 0) return null;
  return away.join(' and ') + (away.length === 1 ? ' is' : ' are') + ' not plugged in';
}

/** Why a backup is Behind when its own copy is fresh: "Seagate2TB is 9,168 files (3.7 GB) behind". Null when no second drive is behind. */
export function behindNote(m: MirrorBackupStatus | undefined): string | null {
  const parts = (m?.mirrors ?? []).filter((x) => (x.behindFiles ?? 0) > 0).map((x) => `${x.label} is ${formatCount(x.behindFiles!)} ${plural(x.behindFiles!, 'file', 'files')} (${formatBytes(x.behindBytes)}) behind`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** "Last backup 23 Nov, 4 months ago" for the list, "Never backed up" when there is no date. */
export function lastLine(ms: number | null, now: number): string {
  return ms === null ? 'No backup yet' : shortDate(ms, now) + ' · ' + agoText(ms, now);
}

export type RowAction = { label: string; tab: BackupTab; go: boolean; primary: boolean };

export interface ListContext {
  now: number;
  mirror: MirrorStatusResult | null;
  sizes: SizesState;
  jobs: readonly JobRecord[];
  connected: ConnectedPhones | null;
  /** The owner's name by person id, for the search. */
  ownerNames: ReadonlyMap<number, string>;
}

export interface BackupEntry {
  row: BackupRow;
  kind: BackupKind;
  /** The one status word; null for a backup that is switched off (it has none). */
  status: BackupStatus | null;
  /** "Behind by 1,234 files (12 GB)" style detail is shown by the status pill; this is the short second-drive line when there is one. */
  source: string;
  kept: string;
  note: string | null;
  last: string;
  numbers: string;
  job: JobRecord | null;
  progress: string | null;
  percent: number | null;
  action: RowAction;
  haystack: string;
}

const mirrorOf = (mirror: MirrorStatusResult | null, id: number): MirrorBackupStatus | undefined => mirror?.backups.find((m) => m.backupId === id);

/** The one status of a backup, the same as Home's: a second drive that is behind makes it Behind. */
export function statusOf(row: BackupRow, mirror: MirrorStatusResult | null, now: number): BackupStatus {
  return combinedStatus(backupStatusOf(row, now), mirrorOf(mirror, row.id));
}

/** The one button of a row: the most useful next step. Always opens the backup's page, at the part that does it. */
export function mainAction(row: BackupRow, ctx: Pick<ListContext, 'now' | 'mirror' | 'connected' | 'jobs'>): RowAction {
  const open: RowAction = { label: 'Open', tab: 'overview', go: false, primary: false };
  if (!row.enabled) return open;
  const job = activeJobOf(ctx.jobs, row.id);
  if (job) {
    const tab: BackupTab = job.kind.startsWith('freeup.') ? 'free' : job.kind.startsWith('mirror.checkOld') || job.kind === 'phone.checkOld' ? 'check' : job.kind.startsWith('mirror.') ? 'second' : job.kind === 'google.copy' ? 'google' : 'backup';
    return job.state === 'needs_you' ? { label: 'Continue', tab, go: false, primary: true } : { ...open, tab };
  }
  const canBackUp = row.kind === 'phone' ? (ctx.connected?.phones.some((p) => p.backupId === row.id) ?? false) && row.driveConnected : row.driveConnected;
  const backUp: RowAction = { label: 'Back up now', tab: 'backup', go: true, primary: true };
  const m = mirrorOf(ctx.mirror, row.id);
  const behindSecond = m !== undefined && m.mirrors.some((x) => (x.behindFiles ?? 0) > 0) && bringUpState(m).enabled;
  if (canBackUp && backupStatusOf(row, ctx.now) !== 'up-to-date') return backUp;
  if (behindSecond) return { label: bringUpButton(m!.mirrors[0]!.label), tab: 'second', go: true, primary: true };
  return canBackUp ? { ...backUp, primary: false } : open;
}

export function buildEntries(rows: readonly BackupRow[], rowCtx: ListContext): BackupEntry[] {
  // Only the jobs that are going matter to a row: sift them once, not once per row.
  const ctx: ListContext = { ...rowCtx, jobs: rowCtx.jobs.filter(isActiveJob) };
  return rows.map((row): BackupEntry => {
    const job = activeJobOf(ctx.jobs, row.id);
    const phone = row.kind === 'phone' ? ctx.connected?.phones.find((p) => p.backupId === row.id) : undefined;
    const source = row.kind === 'phone' ? (phone && phone.phoneName !== '' && phone.phoneName !== row.name ? 'Phone: ' + phone.phoneName : 'Phone') : row.from;
    const kept = keptText(row);
    const owner = ctx.ownerNames.get(row.personId) ?? '';
    return {
      row,
      kind: backupKindOf(row),
      status: row.enabled ? statusOf(row, ctx.mirror, ctx.now) : null,
      source,
      kept,
      note: [behindNote(mirrorOf(ctx.mirror, row.id)), plugNote(row)].filter((x): x is string => x !== null).join(' · ') || null,
      last: lastLine(row.lastBackupAt, ctx.now),
      numbers: numbersText(ctx.sizes, row.id),
      job,
      progress: job ? progressLine(row, job) : null,
      percent: job ? jobPercent(job) : null,
      action: mainAction(row, ctx),
      haystack: [row.name, source, kept, owner].join(' ').toLowerCase(),
    };
  });
}

// ---- search and sort -----------------------------------------------------------------------------------------------------------------------

export type ListSort = 'name' | 'status' | 'last';

export const LIST_SORTS: readonly { id: ListSort; label: string }[] = [
  { id: 'status', label: 'Needs attention first' },
  { id: 'name', label: 'Name' },
  { id: 'last', label: 'Last backup' },
];

/** Every word typed has to be somewhere in the name, source, drives or owner. */
export function filterEntries(entries: readonly BackupEntry[], query: string): BackupEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  return words.length === 0 ? [...entries] : entries.filter((e) => words.every((w) => e.haystack.includes(w)));
}

/** Problem first, then Behind, Never backed up, Not connected, Up to date, and the ones switched off last (the order of Home). */
const STATUS_ORDER: Readonly<Record<BackupStatus, number>> = { problem: 0, behind: 1, never: 2, 'not-connected': 3, 'up-to-date': 4 };
// One collator for the whole sort: localeCompare with options builds a new one on every call, which is slow for hundreds of rows.
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a: BackupEntry, b: BackupEntry): number => COLLATOR.compare(a.row.name, b.row.name) || a.row.id - b.row.id;

export function sortEntries(entries: readonly BackupEntry[], sort: ListSort): BackupEntry[] {
  const rank = (e: BackupEntry): number => (e.status === null ? 9 : STATUS_ORDER[e.status]);
  if (sort === 'name') return entries.toSorted(byName);
  if (sort === 'status') return entries.toSorted((a, b) => rank(a) - rank(b) || byName(a, b));
  // Newest first; a backup with no date last.
  return entries.toSorted((a, b) => (b.row.lastBackupAt ?? -1) - (a.row.lastBackupAt ?? -1) || byName(a, b));
}

/** "3 backups", "2 of 5 backups" with a search. */
export function countLine(shown: number, all: number): string {
  return shown === all ? formatCount(all) + ' ' + plural(all, 'backup', 'backups') : formatCount(shown) + ' of ' + formatCount(all) + ' ' + plural(all, 'backup', 'backups');
}

export const NO_MATCH = (query: string): string => `No backup matches "${query.trim()}".`;

// ---- the actions that cover all backups -----------------------------------------------------------------------------------------------------

export interface BulkActions {
  /** "Bring Seagate2TB up to date (all backups)", or null when fewer than two backups have a second drive that is behind. */
  mirror: string | null;
  /** "Check old copies on Seagate2TB (all backups)", or null. */
  check: string | null;
}

/** Only offered when it covers more than one backup (one backup has its own button). */
export function bulkActions(rows: readonly BackupRow[], mirror: MirrorStatusResult | null): BulkActions {
  const withSecond = (mirror?.backups ?? []).filter((m) => rows.some((r) => r.id === m.backupId && r.enabled) && m.mirrors.length > 0 && bringUpState(m).enabled);
  const label = withSecond[0]?.mirrors[0]?.label;
  if (label === undefined || withSecond.length < 2) return { mirror: null, check: null };
  const behind = withSecond.some((m) => m.mirrors.some((x) => (x.behindFiles ?? 0) > 0));
  return { mirror: behind ? bringAllButton(label) : null, check: checkAllButton(label) };
}

/** The date text the header uses ("17 Jul 2026" or "Not known yet"). */
export const lastDateText = lastBackupText;
