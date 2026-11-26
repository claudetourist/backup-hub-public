/**
 * Your choices (R1.2b part 1, PLAN.md section 3b): what the person told a phone backup about files, folders and kinds of file, and the
 * list of things no backup can copy. Plain data and pure helpers only (main and the window both use them).
 * On screen these are "your choices", "never back up" and "always include": the words rule, pattern, scope and destination stay inside.
 */

export type RuleScope = 'file' | 'folder' | 'pattern';
export type RuleChoice = 'leave_out' | 'include';

/** A stored choice (a row of `backup_rules`). `backupId` null means every backup. `destination` is not used yet. */
export interface BackupRule {
  id: number;
  backupId: number | null;
  scope: RuleScope;
  /** The phone path for a file or a folder ("/sdcard/DCIM/a.jpg"), "*.ext" for a kind of file. */
  pattern: string;
  choice: RuleChoice;
  destination: string | null;
  note: string | null;
  createdAt: number;
}

/** What the person proposes (nothing is stored until it is saved). */
export interface RuleDraft {
  scope: RuleScope;
  pattern: string;
  choice: RuleChoice;
}

/** A stored choice as the window shows it. */
export interface RuleView {
  id: number;
  scope: RuleScope;
  choice: RuleChoice;
  pattern: string;
  /** "Never back up: DCIM/Camera/a.jpg (file)". */
  words: string;
  createdAt: number;
  /** Applies to every backup, not only this one. */
  everyBackup: boolean;
}

export type RuleChange = { kind: 'add'; draft: RuleDraft } | { kind: 'remove'; ruleId: number };

export interface RuleEffectRequest {
  backupId: number;
  /** The plan open in the window; without it main uses the newest plan it still holds for this backup. */
  planId?: string | undefined;
  change: RuleChange;
}

export interface FilesAndBytes {
  files: number;
  bytes: number;
}

/** What a change would do to the plan main holds: files that would be left out, files that would be brought back. */
export type RuleEffectResult =
  | { ok: true; backupName: string; /** False when no plan is held: only the plain line is shown. */ hasPlan: boolean; leavesOut: FilesAndBytes; bringsBack: FilesAndBytes }
  | { ok: false; message: string };

export interface RuleAddRequest extends RuleDraft {
  backupId: number;
}

export type RuleAddResult = { ok: true; message: string; rule: RuleView; count: number; added: boolean } | { ok: false; message: string };

export interface RuleRemoveRequest {
  backupId: number;
  ruleId: number;
  /** Only a real true removes anything. */
  confirmed: boolean;
}

export type RuleRemoveResult = { ok: true; message: string; count: number } | { ok: false; message: string };

export type RulesListResult = { ok: true; backupId: number; backupName: string; rules: RuleView[] } | { ok: false; message: string };

/** The line under Remove: removing a choice changes what the next backup offers, never a file. */
export const REMOVE_CHOICE_LINE = 'Removing this changes only what the next backup offers. Nothing is deleted.';

// ---- paths and kinds ----------------------------------------------------------------------------------------------------------------

/** Folders and files a choice may name live below this one. */
export const PHONE_ROOT_FOLDER = '/sdcard';
/** A folder backup's paths in choices and in the list: this root, then the path below the backed-up folder ("/source/Photos/a.jpg"). */
export const FOLDER_ROOT_FOLDER = '/source';

/**
 * The extension of a file name, lower case, with its dot (".jpg"), or "" when it has none. Leading dots of the name never start an
 * extension, so ".nomedia" has none (the same as Python's splitext, which the old filters use).
 */
export function fileExtension(path: string): string {
  // The same answer as Python's splitext on the name, without cutting the name out first (this runs for every file of a plan).
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash) return '';
  let start = slash + 1;
  while (start < path.length && path.charCodeAt(start) === 46) start += 1;
  return dot > start ? path.slice(dot).toLowerCase() : '';
}

/** A folder choice without trailing slashes ("/sdcard/A/B/" -> "/sdcard/A/B"). */
export const cleanFolder = (folder: string): string => folder.replace(/\/+$/, '');

/** True when `path` is inside `folder` (a path-prefix match with a "/" boundary, case-sensitive: phone paths). */
export const isInsideFolder = (path: string, folder: string): boolean => path.startsWith(cleanFolder(folder) + '/');

/** "*.JPG" -> ".jpg"; null when it is not a kind of file we can match ("*.ext" only). */
export function patternExtension(pattern: string): string | null {
  const m = /^\*\.([A-Za-z0-9]{1,16})$/.exec(pattern.trim());
  return m ? '.' + m[1]!.toLowerCase() : null;
}

/** The full folder of a phone path ("/sdcard/DCIM/Camera/a.jpg" -> "/sdcard/DCIM/Camera"). */
export const folderOfPath = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Why a draft cannot be saved, in plain words, or null when it is fine. The same check runs in main. `root` is the root of the backup's paths
 * (the phone's, or a folder backup's); left out, either root is accepted and the phone's words are used.
 */
export function draftProblem(draft: RuleDraft, root?: string): string | null {
  const folderBackup = root === FOLDER_ROOT_FOLDER;
  const roots = root === undefined ? [PHONE_ROOT_FOLDER, FOLDER_ROOT_FOLDER] : [root];
  const under = (p: string): boolean => roots.some((r) => p.startsWith(r + '/'));
  const where = folderBackup ? 'in this folder' : 'on the phone';
  if (draft.choice !== 'leave_out' && draft.choice !== 'include') return 'That choice is not known.';
  if (draft.scope === 'pattern') return patternExtension(draft.pattern) === null ? 'Only a kind of file such as .jpg can be chosen this way.' : null;
  if (draft.scope !== 'file' && draft.scope !== 'folder') return 'That choice is not known.';
  const p = draft.pattern;
  if (p.length === 0 || p.length > 4000 || p.includes('\0') || p.split('/').includes('..')) return `That is not a place ${where}.`;
  if (draft.scope === 'file') return under(p) && !p.endsWith('/') ? null : `That is not a file ${where}.`;
  const folder = cleanFolder(p);
  if (roots.includes(folder)) return folderBackup ? 'That is the whole folder. Choose a smaller folder.' : 'That is the whole phone. Choose a smaller folder.';
  return under(folder) ? null : `That is not a folder ${where}.`;
}

/** The pattern as it is stored (a folder without its trailing slash, a kind of file in lower case). */
export function storedPattern(draft: RuleDraft): string {
  return draft.scope === 'folder' ? cleanFolder(draft.pattern) : draft.scope === 'pattern' ? '*' + (patternExtension(draft.pattern) ?? '') : draft.pattern;
}

/** True when the draft names this phone path (used to untick the matching rows of an open list, exactly like unticking them). */
export function draftCovers(draft: RuleDraft, path: string): boolean {
  if (draft.scope === 'file') return path === draft.pattern;
  if (draft.scope === 'folder') return isInsideFolder(path, draft.pattern);
  const ext = patternExtension(draft.pattern);
  return ext !== null && fileExtension(path) === ext;
}

// ---- words ---------------------------------------------------------------------------------------------------------------------------

const shown = (path: string): string => path.replace(/^\/(sdcard|source)\//, '');

/** "Never back up: Android/media/com.x/Media/.Statuses (folder)", "Always include: .jpg files (this kind of file)". */
export function ruleWords(rule: Pick<BackupRule, 'scope' | 'pattern' | 'choice'>): string {
  const lead = rule.choice === 'leave_out' ? 'Never back up' : 'Always include';
  if (rule.scope === 'pattern') return `${lead}: ${patternExtension(rule.pattern) ?? rule.pattern} files (this kind of file)`;
  return `${lead}: ${shown(rule.pattern)} (${rule.scope === 'folder' ? 'folder' : 'file'})`;
}

// ---- things no backup can copy (the "Not covered by this backup" card) ------------------------------------------------------------

export interface NotCoveredItem {
  id: string;
  title: string;
  /** One short line: what to do about it. */
  howTo: string;
}

export const NOT_COVERED_ITEMS: readonly NotCoveredItem[] = [
  { id: 'authenticator', title: 'Authenticator app codes', howTo: "Export them, or save each account's recovery codes somewhere safe such as Vault." },
  { id: 'contacts_messages', title: 'Contacts and messages', howTo: "Check that the phone's own sync is turned on." },
  { id: 'whatsapp', title: 'WhatsApp chats', howTo: "Turn on WhatsApp's own backup in its settings. If end-to-end backup is on, keep the 64-digit key safe." },
  { id: 'signal', title: 'Signal', howTo: "Use Signal's own backup in its settings." },
  { id: 'app_logins', title: 'App logins and passwords', howTo: 'Keep them in a password manager or write down how to get back in. A backup cannot copy them.' },
];

export interface NotCoveredLine extends NotCoveredItem {
  ticked: boolean;
  /** When it was ticked (epoch ms), or null. */
  tickedAt: number | null;
}

export type NotCoveredResult = { ok: true; backupId: number; backupName: string; items: NotCoveredLine[]; done: number; total: number } | { ok: false; message: string };

export interface NotCoveredTickRequest {
  backupId: number;
  item: string;
  ticked: boolean;
}

/** "Things no backup can copy: 2 of 5 done". */
export const notCoveredHeader = (done: number, total: number): string => `Things no backup can copy: ${done} of ${total} done`;
