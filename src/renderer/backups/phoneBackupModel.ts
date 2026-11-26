/** The words and sums behind the phone backup panel (R1.2a). Pure. */
import { LEFT_OUT_WORDS, type CopiedFile, type LeftOutGroup, type PhoneBackupProgress, type PhoneBackupReport, type PhonePlanView, type PreviewRow, type ProgressFile } from '../../shared/phoneBackup';
import type { ReportData } from '../components/reportModel';
import { formatBytes, formatCount, plural } from '../lib/format';
import { FOLDER_ROOT_FOLDER, type BackupRule, type RuleView } from '../../shared/rules';
import { FOLDER_TOP_WORDS } from '../../shared/folderBackup';
// Pure and shared by main and the window, so a row is judged here by exactly the order main uses (a file, the deepest folder, a kind; include wins a tie).
import { compileRules } from '../../main/rules/ruleMatcher';

/** What a file straight in the top folder is grouped under: the phone's storage, or the backed-up folder. */
const topWords = (path: string): string => (path.startsWith(FOLDER_ROOT_FOLDER + '/') ? FOLDER_TOP_WORDS : 'Phone storage');
const BELOW_ROOT = /^\/(sdcard|source)\/?/;

/** The folder a row is shown under: the first two folders below /sdcard ("DCIM/Camera") or below the backed-up folder, or the one folder, or "Phone storage" / "Main folder". */
export function folderOf(path: string): string {
  const parts = path.replace(BELOW_ROOT, '').split('/');
  const dirs = parts.slice(0, -1);
  return dirs.length === 0 ? topWords(path) : dirs.slice(0, 2).join('/');
}

export interface FolderTotal {
  folder: string;
  files: number;
  bytes: number;
  tickedFiles: number;
}

/** One line per folder, biggest first, with how many of its files are still ticked. */
export function folderTotals(rows: readonly PreviewRow[], unticked: ReadonlySet<string>): FolderTotal[] {
  const map = new Map<string, FolderTotal>();
  for (const r of rows) {
    const f = folderOf(r.path);
    const t = map.get(f) ?? { folder: f, files: 0, bytes: 0, tickedFiles: 0 };
    t.files += 1;
    t.bytes += r.size;
    if (!unticked.has(r.path)) t.tickedFiles += 1;
    map.set(f, t);
  }
  return [...map.values()].toSorted((a, b) => b.bytes - a.bytes || (a.folder < b.folder ? -1 : 1));
}

/** The paths of every row in a folder. */
export const pathsInFolder = (rows: readonly PreviewRow[], folder: string): string[] => rows.filter((r) => folderOf(r.path) === folder).map((r) => r.path);

/** Ticks or unticks a whole folder (a new set). A folder with any file unticked is ticked all; otherwise it is unticked all. */
export function toggleFolder(rows: readonly PreviewRow[], unticked: ReadonlySet<string>, folder: string): Set<string> {
  const paths = pathsInFolder(rows, folder);
  const next = new Set(unticked);
  const allTicked = paths.every((p) => !unticked.has(p));
  for (const p of paths) {
    if (allTicked) next.add(p);
    else next.delete(p);
  }
  return next;
}

/** Every row unticked (a new set holding every path). Tick all is an empty set. */
export const untickEveryRow = (rows: readonly PreviewRow[]): Set<string> => new Set(rows.map((r) => r.path));

export interface Selection {
  files: number;
  bytes: number;
}

/** What "Copy N files (X GB) to T7" will copy: the ticked rows plus the left-out groups the person chose to include. */
export function selectionTotals(plan: Pick<PhonePlanView, 'rows' | 'leftOut'>, unticked: ReadonlySet<string>, included: ReadonlySet<string>): Selection {
  let files = 0;
  let bytes = 0;
  for (const r of plan.rows) {
    if (unticked.has(r.path)) continue;
    files += 1;
    bytes += r.size;
  }
  for (const g of plan.leftOut) {
    if (!included.has(g.key)) continue;
    files += g.files;
    bytes += g.bytes;
  }
  return { files, bytes };
}

export function confirmText(sel: Selection, driveLabel: string): string {
  return `Copy ${formatCount(sel.files)} ${plural(sel.files, 'file', 'files')} (${formatBytes(sel.bytes)}) to ${driveLabel}`;
}

/** "Left out: 1,204 files, 3.1 GB" per filter and folder; a group made by one of your choices says which choice. */
export function leftOutLine(g: LeftOutGroup): string {
  if (g.rule) return `${g.rule.words}. Left out by your choice: ${formatCount(g.files)} ${plural(g.files, 'file', 'files')}, ${formatBytes(g.bytes)}.`;
  return `${LEFT_OUT_WORDS[g.filter]}: ${g.folder}: left out: ${formatCount(g.files)} ${plural(g.files, 'file', 'files')}, ${formatBytes(g.bytes)}`;
}

/** The groups the person's own choices made, and the groups the built-in filters made (the preview shows them apart). */
export function splitLeftOut(groups: readonly LeftOutGroup[]): { byYou: LeftOutGroup[]; byFilters: LeftOutGroup[] } {
  return { byYou: groups.filter((g) => g.rule !== undefined), byFilters: groups.filter((g) => g.rule === undefined) };
}

export function leftOutTotal(groups: readonly LeftOutGroup[]): Selection {
  return groups.reduce((a, g) => ({ files: a.files + g.files, bytes: a.bytes + g.bytes }), { files: 0, bytes: 0 });
}

/** The generic Report of the kit, from the report main kept. */
export function reportData(r: PhoneBackupReport, formatWhen: (ms: number) => string): ReportData {
  const skipped = [...r.skipped];
  if (r.linked > 0) skipped.push({ reason: 'already on the drive (confirmed, not copied again)', count: r.linked, examples: [] });
  return { copied: r.copied, skipped, failed: r.failed, where: r.where, finished: formatWhen(r.finishedAt) };
}

export const OLD_TOOL_WARNING = 'Do not run the old PhoneBackup on this phone any more.';

// ---- the card of a connected phone: the backup's own name, never the phone's model ("SM M356B") -------------------------------

export const cardTitle = (backupName: string): string => `${backupName} is connected: back up now?`;
export const backUpNowButton = (backupName: string): string => `Back up ${backupName} now`;
export const copyingTitle = (backupName: string, driveLabel: string | null): string => `Copying ${backupName} to ${driveLabel ?? 'the drive'}`;

/** "Phone: SM M356B": the model, as a quiet line; null when it adds nothing (empty, or the same as the backup's name). */
export function phoneModelLine(backupName: string, phoneName: string): string | null {
  const model = phoneName.trim();
  return model === '' || model.toLowerCase() === backupName.trim().toLowerCase() ? null : `Phone: ${model}`;
}

// ---- the list before the copy (R1.2a fix: unmistakable, largest first, with a search) ----------------------------------------------

export const PREVIEW_HEADLINE = 'Files to copy, largest first.';

/** The second line of the headline: the two ways of not copying a file are different things. */
export const UNTICK_VS_EXCLUDE = 'Untick = skip this time. Exclude = never back up.';

/** The word on a row that a "never back up" choice names (it has no tick box). */
export const EXCLUDED_WORD = 'Excluded';

/**
 * The rows a "never back up" choice names, each with the choice that decides it (the same order main uses: a file, the deepest folder, then a
 * kind of file; an "always include" choice that is more specific brings the row back). A row not in the map is offered normally.
 */
export function excludedBy(rows: readonly { path: string }[], rules: readonly RuleView[]): Map<string, RuleView> {
  const out = new Map<string, RuleView>();
  if (!rules.some((r) => r.choice === 'leave_out')) return out;
  const compiled = compileRules(rules.map((r): BackupRule => ({ id: r.id, backupId: null, scope: r.scope, pattern: r.pattern, choice: r.choice, destination: null, note: null, createdAt: r.createdAt })));
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const row of rows) {
    const hit = compiled.match(row.path);
    if (hit !== null && hit.choice === 'leave_out') out.set(row.path, byId.get(hit.id)!);
  }
  return out;
}

/** The rows that are not excluded (an excluded row is never counted, ticked or copied). */
export function withoutExcluded<T extends { path: string }>(rows: readonly T[], excluded: ReadonlyMap<string, RuleView>): T[] {
  return excluded.size === 0 ? [...rows] : rows.filter((r) => !excluded.has(r.path));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "DCIM/Camera/IMG_1.jpg" -> "IMG_1.jpg". */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The whole folder under /sdcard or the backed-up folder ("DCIM/Camera"), or "Phone storage" / "Main folder" for a file in the top folder. */
export function folderPathOf(path: string): string {
  const dirs = path.replace(BELOW_ROOT, '').split('/').slice(0, -1);
  return dirs.length === 0 ? topWords(path) : dirs.join('/');
}

/** "23 Nov 2026" (the phone's date for the file, in the laptop's time zone). */
export function dateText(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]!} ${d.getFullYear()}`;
}

export interface ListRow {
  /** The phone path: the id of the row (what is unticked is sent back by it). */
  path: string;
  name: string;
  folder: string;
  size: number;
  date: string;
  kind: 'new' | 'changed';
  /** Lower case name and folder, for the search box. */
  haystack: string;
}

/** The rows of the list, largest first (same size: by name, then path, so the order never jumps). */
export function listRows(rows: readonly PreviewRow[]): ListRow[] {
  return rows
    .map((r): ListRow => {
      const name = fileNameOf(r.path);
      const folder = folderPathOf(r.path);
      return { path: r.path, name, folder, size: r.size, date: dateText(r.mtimeSec), kind: r.kind, haystack: `${name} ${folder}`.toLowerCase() };
    })
    .toSorted((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The rows whose name or folder holds every word typed (any case). An empty box shows everything. */
export function filterListRows(rows: readonly ListRow[], query: string): ListRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  return words.length === 0 ? [...rows] : rows.filter((r) => words.every((w) => r.haystack.includes(w)));
}

/** Ticks or unticks exactly the rows given (the ones the search shows); every other row keeps its tick. A new set. */
export function setTicks(unticked: ReadonlySet<string>, rows: readonly ListRow[], ticked: boolean): Set<string> {
  const next = new Set(unticked);
  for (const r of rows) {
    if (ticked) next.delete(r.path);
    else next.add(r.path);
  }
  return next;
}

export interface ListCount {
  /** Files shown that can be ticked (an excluded row is not one of them). */
  shown: number;
  shownTicked: number;
  /** Files in the list that can be ticked. */
  all: number;
  allTicked: number;
  /** Rows a "never back up" choice names: in the list, dimmed, never counted as ticked. */
  excluded: number;
}

export function listCount(all: readonly ListRow[], shown: readonly ListRow[], unticked: ReadonlySet<string>, excluded: ReadonlyMap<string, RuleView> = new Map()): ListCount {
  const liveAll = withoutExcluded(all, excluded);
  const liveShown = withoutExcluded(shown, excluded);
  return {
    shown: liveShown.length,
    shownTicked: liveShown.filter((r) => !unticked.has(r.path)).length,
    all: liveAll.length,
    allTicked: liveAll.filter((r) => !unticked.has(r.path)).length,
    excluded: all.length - liveAll.length,
  };
}

/** "47 of 47 files ticked · 1 excluded", and with a search: "Showing 12 of 230 files (12 ticked). 180 of 230 files ticked." */
export function listCountText(c: ListCount): string {
  const base = `${formatCount(c.allTicked)} of ${formatCount(c.all)} ${plural(c.all, 'file', 'files')} ticked${c.excluded > 0 ? ` · ${formatCount(c.excluded)} excluded` : ''}`;
  return c.shown === c.all ? base : `Showing ${formatCount(c.shown)} of ${formatCount(c.all)} ${plural(c.all, 'file', 'files')} (${formatCount(c.shownTicked)} ticked). ${base}.`;
}

export const kindWord = (kind: 'new' | 'changed'): string => (kind === 'changed' ? 'Changed' : 'New');

// ---- the copy while it runs ----------------------------------------------------------------------------------------------------

/** The window asks main how the copy is going this often (never faster than once a second). */
export const PROGRESS_POLL_MS = 1000;

export function copyingNowText(current: ProgressFile | null): string {
  return current ? `Copying now: ${fileNameOf(current.path)} (${formatBytes(current.size)})` : 'Getting the next file ready';
}

/** "203 of 204 files" (files finished, whether copied or not, of all files in the run). */
export function filesDoneText(p: Pick<PhoneBackupProgress, 'done' | 'failedCount' | 'total'>): string {
  return `${formatCount(p.done + p.failedCount)} of ${formatCount(p.total)} ${plural(p.total, 'file', 'files')}`;
}

export const stillToCopyTitle = (p: Pick<PhoneBackupProgress, 'waiting'>): string => `Still to copy (${formatCount(p.waiting)})`;
export const doneTitle = (p: Pick<PhoneBackupProgress, 'done'>): string => `Done (${formatCount(p.done)})`;
export const notCopiedTitle = (p: Pick<PhoneBackupProgress, 'failedCount'>): string => `Not copied (${formatCount(p.failedCount)})`;

/** A small note when a list shows only the start of what there is: "Showing the first 200 of 1,204." Null when it shows all. */
export function cappedNote(shown: number, all: number): string | null {
  return shown < all ? `Showing the first ${formatCount(shown)} of ${formatCount(all)}.` : null;
}

export interface ProgressRow {
  key: string;
  name: string;
  folder: string;
  size: number;
}

export const progressRow = (f: ProgressFile): ProgressRow => ({ key: f.path, name: fileNameOf(f.path), folder: folderPathOf(f.path), size: f.size });

/** The fold of the report: "Show all copied files (203)". */
export const copiedFoldTitle = (total: number): string => `Show all copied files (${formatCount(total)})`;

export interface CopiedRow {
  key: string;
  name: string;
  folder: string;
  size: number;
  date: string;
}

/** The copied files, largest first, as rows. */
export function copiedRows(files: readonly CopiedFile[]): CopiedRow[] {
  return files
    .map((f): CopiedRow => ({ key: f.path, name: fileNameOf(f.path), folder: folderPathOf(f.path), size: f.size, date: f.mtimeMs === null ? '' : dateText(f.mtimeMs / 1000) }))
    .toSorted((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
