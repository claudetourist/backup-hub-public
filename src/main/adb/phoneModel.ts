/**
 * Pure rules for talking to the phone through adb: which phone folders and paths are acceptable, how adb's text is read and
 * which files are left out. No adb, no files, no database.
 */
import type { PhoneDevice } from '../../shared/phone';
import { finishSync, STEP_ITEMS, type Steps } from '../sliceWork';

export const PHONE_STORAGE = '/sdcard';

/**
 * A path on the phone that Backup Hub will put inside a single-quoted adb shell word: under /sdcard, no "..", no control
 * characters and no single quote (the only character that can end a single-quoted word).
 */
export function isSafePhonePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 1024) return false;
  if (p !== PHONE_STORAGE && !p.startsWith(`${PHONE_STORAGE}/`)) return false;
  if (p.split('/').some((s) => s === '..' || s === '.')) return false;
  for (const ch of p) if (ch === "'" || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) return false;
  return true;
}

/**
 * A path on the phone that may be handed to `adb pull` (no shell: nothing to escape) or, through `quotePhonePath`, to a shell line:
 * the same rules as `isSafePhonePath` except that a single quote is allowed (R1.2a: "Mom's photo.jpg" is an ordinary name).
 */
export function isPullablePhonePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 1024) return false;
  if (p !== PHONE_STORAGE && !p.startsWith(`${PHONE_STORAGE}/`)) return false;
  if (p.split('/').some((s) => s === '..' || s === '.')) return false;
  for (const ch of p) if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) return false;
  return true;
}

/**
 * Folders the person picked, kept only when they are safe, without a trailing slash and without repeats. `allowRoot` lets the whole
 * storage (/sdcard) through: the phone backup looks at all of it (PhoneBackup did); the clean-up screens never ask for it.
 */
export function cleanFolders(folders: readonly unknown[], options: { allowRoot?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const f of folders) {
    if (typeof f !== 'string') continue;
    const trimmed = f.replace(/\/+$/, '');
    if (isSafePhonePath(trimmed) && (trimmed !== PHONE_STORAGE || options.allowRoot === true) && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * THE one way a phone path goes into an adb shell line (PLAN.md section 4 rule 6): it must pass `isPullablePhonePath` (no control
 * character, no "..", under /sdcard) and is then wrapped in single quotes, inside which the shell reads every other character
 * ($, backtick, ;, |, spaces, a leading dash) literally. The one character a single-quoted word cannot hold, the single quote itself,
 * is written the one standard way: close the quote, a backslash-escaped quote, open it again. Anything else throws; nothing is ever
 * escaped "almost". (R1.2a: before, a name with a quote was refused, so "Mom's photo.jpg" could never be checked on the phone.)
 */
export function quotePhonePath(p: string): string {
  if (!isPullablePhonePath(p)) throw new Error('Not a safe phone path.');
  return `'${p.replaceAll("'", "'\\''")}'`;
}

/** The lines the listing command adds to its output (see `listCommand`). Both start with characters no file line can start with (a digit). */
export const LIST_STATUS_MARKER = '@@BH_STATUS';
export const LIST_END_MARKER = '@@BH_END';

/**
 * The one shell line that lists a folder, read only. Nothing is hidden: the errors of `find` and `stat` go to the shell's own error
 * stream (adb hands that over separately) and the output ends with a marker line `@@BH_END|<status>|<count>`: the exit status of `find`
 * (`stat` failures count too) and the number of file lines the phone printed. `parseListing` judges the whole.
 * One pass over the folder; no pipe hides a failure; no `pipefail` is needed. File lines come from find's own
 * `-printf`: on the Poco F4 (toybox 0.8.9) `-exec stat {} +` overran the argument limit ("Argument list too long", exit 126) and lost
 * about 20,000 of 33,719 files. `-H` follows the folder itself when it is a link (on Android
 * /sdcard is a link to /storage/self/primary; without -H toybox find lists nothing and says nothing). Inside the folder no link is
 * followed. The counting is done by the phone's awk (Android 9+ has /system/bin/awk): the earlier `while read` loop in
 * mksh took about 10 minutes for 33,700 files, awk takes 14 s. A phone without awk prints no end marker, so the look is refused, not wrong.
 */
export function listCommand(folder: string): string {
  const q = quotePhonePath(folder);
  const status = LIST_STATUS_MARKER;
  const end = LIST_END_MARKER;
  return [
    `{ find -H ${q} -type f -printf '%s|%T@|%p\\n'; echo "${status}|$?"; }`,
    '|',
    `awk 'BEGIN{s="none"} /^${status}\\|/{s=substr($0,${status.length + 2}); next} {n++; print} END{print "${end}|" s "|" n+0}'`,
  ].join(' ');
}

/** The one shell line that fingerprints a file on the phone. */
export function sha256Command(remotePath: string): string {
  return `sha256sum ${quotePhonePath(remotePath)}`;
}

export interface ListedPhoneFile {
  path: string;
  size: number;
  mtimeSec: number;
}

// The time is `%T@`: seconds, with a fraction on most phones ("1720792365.599221330"); the fraction is dropped.
const FILE_LINE = /^(\d+)\|(\d+)(?:\.\d+)?\|(\/.+)$/;
const END_LINE = /^@@BH_END\|([^|]*)\|(\d+)$/;
// toybox: "find: /p: Permission denied"; GNU and busybox: "find: '/p': Permission denied" (or typographic quotes); stat adds "cannot statx".
const STDERR_PATH_LINE = /^(?:find|stat|xargs): (?:cannot (?:stat|statx|read|open|access) )?(?:['"\p{Pi}](\/.+)['"\p{Pf}]|(\/.+)): (Permission denied|No such file or directory)$/u;

/** What one adb call gave back, untouched: the exit code (null when it did not end normally), both streams, and why it failed. */
export interface RawListing {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string | undefined;
}

export type ListingProblemKind = 'adb_failed' | 'no_marker' | 'bad_marker' | 'status' | 'count' | 'unparsed' | 'stderr' | 'bad_folder';

export interface ListingProblem {
  kind: ListingProblemKind;
  detail: string;
}

/** One folder's listing and whether it can be trusted. `files` is filled even when the listing is not complete, for the record only. */
export interface FolderListing {
  folder: string;
  files: ListedPhoneFile[];
  complete: boolean;
  problems: ListingProblem[];
  /** The folder itself is not on this phone (a harmless, explained difference). */
  absent: boolean;
  /** Folders inside it that the phone refused to read and that the filters leave out anyway: their files were not seen. */
  unreadable: string[];
}

/**
 * Folders whose "permission denied" is harmless: the filters would leave them out anyway (caches and thumbnails, the other apps' private
 * Android/data and Android/obb). A refused folder anywhere else means files were not seen.
 */
export function isDroppedPath(p: string): boolean {
  return skipReason(`${p}/x`) !== null || /^\/sdcard\/Android\/(?:data|obb)(?:\/|$)/.test(p);
}

const isInside = (p: string, folder: string): boolean => p === folder || p.startsWith(`${folder}/`);

/**
 * Judges the output of `listCommand` (PLAN.md section 7, R1.0a). The listing is COMPLETE only if all of these hold: adb exited 0; the
 * marker is there once, last, and its status is 0 (status 1 is accepted only when `find` said why on stderr and every such line is a
 * known harmless one); the number of lines read equals the marker's count, so no line was dropped as unparseable; every stderr line is a
 * known harmless one (a refused folder the filters drop anyway, the folder itself missing, adb's own daemon notice). Nothing is
 * guessed: a line that does not read is a problem, never skipped.
 */
export function parseListing(folder: string, raw: RawListing, isDropped: (p: string) => boolean = isDroppedPath): FolderListing {
  return finishSync(parseListingSteps(folder, raw, isDropped));
}

/** `parseListing` as slices (a 60,000-line listing is read in a few milliseconds at a time; see sliceWork.ts). The answer is the same. */
export function* parseListingSteps(folder: string, raw: RawListing, isDropped: (p: string) => boolean = isDroppedPath): Steps<FolderListing> {
  const problems: ListingProblem[] = [];
  const files: ListedPhoneFile[] = [];
  const unparsed: string[] = [];
  const unreadable: string[] = [];
  let absent = false;
  let harmless = 0;
  const unknownErr: string[] = [];

  if (raw.exitCode !== 0) problems.push({ kind: 'adb_failed', detail: raw.error?.trim() || `adb ended with ${raw.exitCode === null ? 'no exit code' : `exit code ${raw.exitCode}`}` });

  for (const rawLine of raw.stderr.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('* daemon ')) continue;
    const m = STDERR_PATH_LINE.exec(line);
    const at = m ? (m[1] ?? m[2]!) : '';
    if (m && m[3] === 'Permission denied' && isInside(at, folder) && isDropped(at)) {
      unreadable.push(at);
      harmless += 1;
    } else if (m && m[3] === 'No such file or directory' && at === folder) {
      absent = true;
      harmless += 1;
    } else unknownErr.push(line);
  }
  if (unknownErr.length > 0) problems.push({ kind: 'stderr', detail: `${unknownErr.length} unexpected message(s) from the phone, for example: ${unknownErr.slice(0, 3).join(' / ')}` });

  const lines = raw.stdout.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] = lines[i]!.replace(/\r$/, '');
    if (i % STEP_ITEMS === STEP_ITEMS - 1) yield;
  }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // Only a line that starts with "@" can be the end marker; the regex runs on those alone.
  const markerAt: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.charCodeAt(0) === 64 && END_LINE.test(lines[i]!)) markerAt.push(i);
    if (i % (STEP_ITEMS * 10) === STEP_ITEMS * 10 - 1) yield;
  }
  let marker: { status: string; count: number } | null = null;
  if (markerAt.length === 0) problems.push({ kind: 'no_marker', detail: 'The file list from the phone did not end with its end marker (it stopped part-way).' });
  else {
    const m = END_LINE.exec(lines[markerAt[markerAt.length - 1]!]!)!;
    marker = { status: m[1]!, count: Number(m[2]) };
    if (markerAt.length > 1 || markerAt[0] !== lines.length - 1) problems.push({ kind: 'bad_marker', detail: 'The end marker is repeated or is not the last line.' });
  }

  const dataLines = markerAt.length > 0 ? lines.slice(0, markerAt[0]) : lines;
  for (let i = 0; i < dataLines.length; i += 1) {
    const line = dataLines[i]!;
    const m = FILE_LINE.exec(line);
    if (m && isInside(m[3]!, folder) && m[3] !== folder) files.push({ size: Number(m[1]), mtimeSec: Number(m[2]), path: m[3]! });
    else unparsed.push(line);
    if (i % STEP_ITEMS === STEP_ITEMS - 1) yield;
  }
  if (unparsed.length > 0) problems.push({ kind: 'unparsed', detail: `${unparsed.length} line(s) could not be read, for example: ${unparsed.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 80))).join(', ')}` });

  if (marker) {
    const statusOk = marker.status === '0' || (marker.status === '1' && harmless > 0 && unknownErr.length === 0);
    if (!statusOk) problems.push({ kind: 'status', detail: `The phone's file-list command ended with status "${marker.status}".` });
    if (marker.count !== files.length) problems.push({ kind: 'count', detail: `The phone printed ${marker.count} line(s); ${files.length} were read.` });
  }

  return { folder, files, complete: problems.length === 0, problems, absent, unreadable };
}

/** The one shell line that lists the spaces of the phone's shared storage (read only): "0" is the owner, others are second spaces. */
export const SPACES_COMMAND = 'ls -1 /storage/emulated';

/** The other user spaces named by `SPACES_COMMAND` (digits only, never "0"), in order. Anything that is not a plain number is ignored. */
export function parseSpaces(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => /^\d{1,6}$/.test(l) && l !== '0');
}

/** The one shell line that tells whether a second space can be read: it ends with status 0 only when the folder lists. Digits only. */
export function spaceProbeCommand(id: string): string {
  if (!/^\d{1,6}$/.test(id)) throw new Error('Not a space number.');
  return `ls /storage/emulated/${id}`;
}

/** One line that fingerprints several files on the phone (every path through `quotePhonePath`; one adb call for the whole batch). */
export function sha256ManyCommand(remotePaths: readonly string[]): string {
  if (remotePaths.length === 0) throw new Error('No files to read.');
  return `sha256sum ${remotePaths.map(quotePhonePath).join(' ')}`;
}

/** What the phone said about one file of a batch. */
export type Sha256Answer = { kind: 'sha256'; sha256: string } | { kind: 'missing' } | { kind: 'error'; reason: string };

export interface Sha256Batch {
  answers: Map<string, Sha256Answer>;
  /** The whole call failed (phone away, adb stopped), so nothing can be said about any file; null otherwise. */
  adbError: string | null;
}

const SHA_LINE = /^([0-9a-f]{64}) [ *](\/.+)$/i;

/**
 * Reads the answer of `sha256sum 'a' 'b' ...`: one "<64 hex>  <path>" line per readable file; a message per file on stderr for the
 * others ("No such file or directory" means the file is gone). Lines are matched to the files that were ASKED about by exact path, so a
 * file name that looks like output can never give another file a checksum. A file with no line and no message is an error, never a guess.
 */
export function parseSha256Many(asked: readonly string[], raw: { exitCode: number | null; stdout: string; stderr: string; error?: string | undefined }): Sha256Batch {
  const wanted = new Set(asked);
  const answers = new Map<string, Sha256Answer>();
  for (const line of raw.stdout.split('\n')) {
    const m = SHA_LINE.exec(line.replace(/\r$/, ''));
    if (m && wanted.has(m[2]!) && !answers.has(m[2]!)) answers.set(m[2]!, { kind: 'sha256', sha256: m[1]!.toLowerCase() });
  }
  const errLines = raw.stderr.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  for (const path of asked) {
    if (answers.has(path)) continue;
    const mine = errLines.find((l) => l.includes(path));
    if (mine === undefined) continue;
    answers.set(path, /No such file or directory/i.test(mine) ? { kind: 'missing' } : { kind: 'error', reason: mine.replace(/^sha256sum: /, '').replace(path, 'this file').slice(0, 200) });
  }
  const anySha = [...answers.values()].some((a) => a.kind === 'sha256');
  if (raw.exitCode !== 0 && !anySha && answers.size === 0) {
    const reason = raw.stderr.trim().split('\n')[0] ?? raw.error ?? 'adb stopped';
    return { answers, adbError: (reason || raw.error || 'adb stopped').slice(0, 300) };
  }
  for (const path of asked) if (!answers.has(path)) answers.set(path, { kind: 'error', reason: 'The phone did not give a checksum for this file.' });
  return { answers, adbError: null };
}

/** The first hex digest of `sha256sum` output ("<64 hex>  <path>"), or null. */
export function parseSha256(text: string): string | null {
  const m = /^([0-9a-f]{64})\s/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Reads `adb devices -l`. */
export function parseDevices(text: string): PhoneDevice[] {
  const out: PhoneDevice[] = [];
  for (const raw of text.split('\n').slice(1)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader)\b(.*)$/.exec(raw.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3] ?? '')?.[1]?.replaceAll('_', ' ');
    out.push({ serial: m[1]!, model: model ?? m[1]!, state: m[2]! });
  }
  return out;
}

const SKIP_SEGMENTS = new Set(['.thumbnails', '.cache', '.trash', '.trashed', 'cache', '.tmp']);

/** Why a file is left out, or null when it is wanted. Thumbnails, caches and half-finished downloads are not backed up. */
export function skipReason(p: string): string | null {
  const parts = p.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((s) => SKIP_SEGMENTS.has(s.toLowerCase()))) return 'It is in a cache or thumbnail folder.';
  if (/^\.(?:trashed|pending)-/i.test(name) || /\.(?:tmp|crdownload|part)$/i.test(name)) return 'It is a temporary or half-finished file.';
  if (name === '.nomedia' || name === '.DS_Store') return 'It is a marker file, not your data.';
  return null;
}

