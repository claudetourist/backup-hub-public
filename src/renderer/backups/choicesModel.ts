/** The words and sums behind "your choices" and the things no backup can copy (R1.2b part 1). Pure. */
import { draftCovers, draftProblem, fileExtension, folderOfPath, notCoveredHeader, patternExtension, PHONE_ROOT_FOLDER, type NotCoveredResult, type RuleDraft, type RuleEffectResult, type RuleView } from '../../shared/rules';
import { FOLDER_TOP_WORDS } from '../../shared/folderBackup';
import { formatBytes, formatCount, plural } from '../lib/format';

export interface ChoiceOption {
  /** Stable id of the menu entry. */
  id: 'file' | 'folder' | 'kind';
  label: string;
  /** Small text under the label: what exactly it names. */
  hint: string;
  draft: RuleDraft;
}

export const NEVER_FILE = 'Never back up this file';
export const NEVER_FOLDER = 'Never back up this folder';
export const neverKind = (ext: string): string => `Never back up ${ext} files`;

const shown = (path: string): string => path.replace(/^\/(sdcard|source)\//, '');

/**
 * The menu of one row of the list before the copy: this file, its folder, its kind. An entry that cannot be saved (a file straight in the
 * phone's top folder has no smaller folder, a file with no extension has no kind) is left out of the menu.
 */
export function choiceOptions(path: string): ChoiceOption[] {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const folder = folderOfPath(path);
  const ext = fileExtension(path);
  const all: ChoiceOption[] = [
    { id: 'file', label: NEVER_FILE, hint: name, draft: { scope: 'file', pattern: path, choice: 'leave_out' } },
    { id: 'folder', label: NEVER_FOLDER, hint: shown(folder), draft: { scope: 'folder', pattern: folder, choice: 'leave_out' } },
    { id: 'kind', label: neverKind(ext), hint: 'In every folder', draft: { scope: 'pattern', pattern: '*' + ext, choice: 'leave_out' } },
  ];
  return all.filter((o) => draftProblem(o.draft) === null);
}

/** The one entry for a folder of the "By folder" fold ("DCIM/Camera"); null for "Phone storage" (the top folder: too broad). */
export function folderChoice(folder: string, root: string = PHONE_ROOT_FOLDER): ChoiceOption | null {
  if (folder === 'Phone storage' || folder === FOLDER_TOP_WORDS) return null;
  const draft: RuleDraft = { scope: 'folder', pattern: `${root}/${folder}`, choice: 'leave_out' };
  return draftProblem(draft) === null ? { id: 'folder', label: NEVER_FOLDER, hint: folder, draft } : null;
}

/** "Always include" for a group the filters left out; null when its folder is the whole phone. */
export function includeChoice(folder: string): RuleDraft | null {
  const draft: RuleDraft = { scope: 'folder', pattern: folder, choice: 'include' };
  return draftProblem(draft) === null ? draft : null;
}

/** What the confirm box calls the thing: "Never back up this folder: Android/media/.../.Statuses". */
export function draftTitle(draft: RuleDraft): string {
  if (draft.scope === 'pattern') return neverKindOrInclude(draft, draft.pattern.replace(/^\*/, ''));
  const where = shown(draft.pattern.replace(/\/+$/, ''));
  if (draft.choice === 'include') return `Always include this folder: ${where}`;
  return `${draft.scope === 'folder' ? NEVER_FOLDER : NEVER_FILE}: ${where}`;
}

function neverKindOrInclude(draft: RuleDraft, ext: string): string {
  return draft.choice === 'include' ? `Always include ${ext.toLowerCase()} files` : neverKind(ext.toLowerCase());
}

/** The paths of a list a draft names: they are unticked at once, exactly as if the person had unticked them. */
export function pathsCoveredBy(draft: RuleDraft, rows: readonly { path: string }[]): string[] {
  return rows.filter((r) => draftCovers(draft, r.path)).map((r) => r.path);
}

/** A new set with every row the draft names unticked (the rows the person had unticked stay unticked). */
export function untickCovered(unticked: ReadonlySet<string>, draft: RuleDraft, rows: readonly { path: string }[]): Set<string> {
  const next = new Set(unticked);
  for (const p of pathsCoveredBy(draft, rows)) next.add(p);
  return next;
}

type Effect = Extract<RuleEffectResult, { ok: true }>;

const countWords = (n: { files: number; bytes: number }): string => `${formatCount(n.files)} ${plural(n.files, 'file', 'files')} (${formatBytes(n.bytes)})`;

/**
 * The line shown before a choice is saved or removed, from the effect main computed on the plan it holds:
 * "This leaves out 1,234 files (2.1 GB) now and in every later backup of Sam phone."
 * Without a plan only the plain promise is given.
 */
export function effectLines(effect: Effect, change: 'add' | 'remove'): string[] {
  const when = change === 'add' ? `now and in every later backup of ${effect.backupName}` : `in the next backup of ${effect.backupName}`;
  if (!effect.hasPlan) return change === 'add' ? [`This applies to every later backup of ${effect.backupName}.`] : [];
  const lines: string[] = [];
  if (effect.leavesOut.files > 0) lines.push(`This leaves out ${countWords(effect.leavesOut)} ${when}.`);
  if (effect.bringsBack.files > 0) lines.push(`This brings back ${countWords(effect.bringsBack)} ${when}.`);
  if (lines.length === 0) lines.push(change === 'add' ? `This changes nothing in the list you see now. It applies to every later backup of ${effect.backupName}.` : 'This changes nothing in the list you see now.');
  return lines;
}

/** "Your choices (3)" on the backup's row. */
export const yourChoicesButton = (count: number): string => `Exclusions (${formatCount(count)})`;

export const yourChoicesTitle = (backupName: string): string => `Exclusions: ${backupName}`;

/** The empty state of the Exclusions list. */
export const NOTHING_EXCLUDED = 'Nothing excluded. Use Exclude on a file to never back it up.';

/** The toast after an exclusion was undone. */
export const BACK_IN_LINE = 'Back in. It will be offered from now on.';

/** One line of the Exclusions list: what kind of thing, its name, where it is, when it was added. */
export interface ExclusionLine {
  id: number;
  kind: 'File' | 'Folder' | 'Type';
  /** Bold: the file name, the folder name, or ".pdf". */
  name: string;
  /** Small, under the name: the folder it is in, or "Every folder" for a type. */
  where: string;  added: string;
}

/** A full Windows path as the old tool stored it ("C:\\Users\\x\\a.zip"), still shown whole when it is not under the backup's folder. */
const isWindowsPath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
const cutAt = (path: string): number => (isWindowsPath(path) ? Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) : path.lastIndexOf('/'));
const lastPart = (path: string): string => path.slice(cutAt(path) + 1);
/**
 * The folder shown under the name. "Phone storage" only for a phone path straight in the phone's top folder; a folder backup's file straight in
 * its folder says "Main folder" (never "Phone storage").
 */
const parentShown = (path: string): string => {
  if (isWindowsPath(path)) return path.slice(0, Math.max(0, cutAt(path))) || path;
  return folderOfPath(path).replace(/^\/(sdcard|source)\/?/, '') || (path.startsWith(PHONE_ROOT_FOLDER + '/') ? 'Phone storage' : FOLDER_TOP_WORDS);
};

export function exclusionLine(rule: RuleView): ExclusionLine {
  const added = savedOn(rule.createdAt);
  if (rule.scope === 'pattern') return { id: rule.id, kind: 'Type', name: patternExtension(rule.pattern) ?? rule.pattern, where: 'Every folder', added };
  const path = rule.pattern.replace(/[\\/]+$/, '');
  return { id: rule.id, kind: rule.scope === 'folder' ? 'Folder' : 'File', name: lastPart(path), where: parentShown(path), added };
}

/** The label of the button that takes a choice back: "Undo", "Undo (folder)", "Undo (.pdf)". */
export function undoLabel(rule: RuleView): string {
  if (rule.scope === 'folder') return 'Undo (folder)';
  if (rule.scope === 'pattern') return `Undo (${patternExtension(rule.pattern) ?? rule.pattern})`;
  return 'Undo';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "20 Nov 2026" (the laptop's time zone). */
export function savedOn(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]!} ${d.getFullYear()}`;
}

// ---- things no backup can copy ---------------------------------------------------------------------------------------------------

export const NOT_COVERED_TITLE = 'Not covered by this backup';

export const notCoveredIntro = 'These are not on the phone in a way a backup can copy. Tick each one when you have dealt with it.';

export function notCoveredHeaderOf(r: Extract<NotCoveredResult, { ok: true }>): string {
  return notCoveredHeader(r.done, r.total);
}

/** The words of a tick: "Done 12 Nov 2026". */
export const tickedText = (tickedAt: number | null): string => (tickedAt === null ? '' : `Done ${savedOn(tickedAt)}`);
