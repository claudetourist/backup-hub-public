/**
 * The narrow entry for the app's OWN files (PLAN.md section 4 rule 3, second paragraph). Backup Hub's temp files, its safety copies,
 * logs, scratch folders, keep-N rotation, the vault key file and the atomic replace of its own config and card files go through here.
 * It needs no checksum proof, but it accepts ONLY paths inside the fixed list of app-owned places below, refuses everything else, and
 * logs each removal. A user's file can never be removed or replaced through this module; `danger/index.ts` is the way for that.
 *
 * App-owned places (a path must be STRICTLY inside one of them, never the folder itself). The drive-side ones are all inside the
 * app's own files folder (names: `shared/appFolders.ts`), and only there:
 *   1. `<anywhere>\<app folder>\<own files>\<card folder>\tmp\...`  the temp folder of a drive (and of the laptop volumes); the card
 *      `<card folder>\drive.json` next to it
 *   2. `<anywhere>\<app folder>\<own files>\<database safety copies>\...`  the saved settings / database copies on a drive, and the
 *      app-data snapshots below them
 *   3. (the old-layout places at a drive root are NOT on the list: nothing is removed or replaced there)
 *   4. in the data folder: `logs`, `snapshots`, `restore`, `before-restore`, `import-tmp`, `drive-tmp`, `tmp`, the vault key file, `this-device.json`
 *      (and the live database files, for the restore swap only: they can be moved, never removed)
 *   5. in the system temp folder: folders whose name starts with `backuphub-`
 *   6. roots added with `configureOwnFiles` (tests only)
 * The set-aside folder is NOT on the list: a file moved aside is never deleted by the app. Backups made by the app and the quarantine are
 * not on the list either (they hold user content and go through `danger/index.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUPS_PARTS, CARD_FILE, CARD_PARTS, DB_COPIES_PARTS, DRIVE_TMP_PARTS } from '../../shared/appFolders';
import { APPDATA_ROOT_FOLDER } from '../../shared/plans';

/** Names of the data-folder side. (The drive-side names come from `shared/appFolders.ts`, which imports nothing.) */
export const OWN_NAMES = {
  keyFile: 'vault-key.bin',
  deviceFile: 'this-device.json',
  liveDb: 'backuphub.db',
  dataFolders: ['logs', 'snapshots', 'restore', 'before-restore', 'import-tmp', 'drive-tmp', 'tmp'] as const,
  osTempPrefix: 'backuphub-',
} as const;

export class OwnFilesRefused extends Error {
  readonly path: string;
  constructor(refusedPath: string, why: string) {
    super(`Backup Hub refused to touch a path that is not one of its own files: ${refusedPath} (${why})`);
    this.name = 'OwnFilesRefused';
    this.path = refusedPath;
  }
}

export interface OwnFilesConfig {
  /** The data folder (`BACKUPHUB_DATA_DIR` or the chosen one). Without it only the drive-side and system-temp places count. */
  dataDir?: string | undefined;
  /** The logs folder (its own setting; normally the data folder's `logs`). */
  logsDir?: string | undefined;
  /** The system temp folder (default os.tmpdir()). */
  tempDir?: string | undefined;
  /** Extra app-owned folders (their contents, never the folder itself). Used by tests. */
  extraRoots?: readonly string[] | undefined;
  /** Where each removal is logged (one plain line). The app wires its logger here. */
  log?: ((line: string) => void) | undefined;
}

let config: OwnFilesConfig = {};

export function configureOwnFiles(next: OwnFilesConfig): void {
  config = { ...next };
}

/** Tests only: the production defaults (no data folder, no extra roots, no log). */
export function resetOwnFilesForTests(): void {
  config = {};
}

const WINDOWS = process.platform === 'win32';
const fold = (s: string): string => (WINDOWS ? s.toLowerCase() : s);

function segmentsOf(p: string): { root: string; parts: string[] } {
  const resolved = path.resolve(p);
  const { root } = path.parse(resolved);
  return { root, parts: resolved.slice(root.length).split(/[\\/]+/).filter((s) => s !== '') };
}

/** True when `parts` begins with `prefix` and has at least one more segment. */
function strictlyUnder(parts: readonly string[], prefix: readonly string[]): boolean {
  if (parts.length <= prefix.length) return false;
  return prefix.every((s, i) => fold(parts[i]!) === fold(s));
}

/** Where `run` begins in `parts` with at least `minAfter` segments after it, or -1. */
function findRun(parts: readonly string[], run: readonly string[], minAfter: number): number {
  for (let i = 0; i + run.length + minAfter <= parts.length; i += 1) {
    if (run.every((s, j) => fold(parts[i + j]!) === fold(s))) return i;
  }
  return -1;
}

function containsRun(parts: readonly string[], run: readonly string[], minAfter: number): boolean {
  return findRun(parts, run, minAfter) >= 0;
}

/** The reason a path is not app-owned, or null when it is. */
export function ownPathProblem(p: string): string | null {
  if (typeof p !== 'string' || p.trim() === '') return 'empty path';
  if (p.includes('\0')) return 'invalid path';
  const { parts } = segmentsOf(p);
  if (parts.length === 0) return 'a drive or volume root';
  if (containsRun(parts, DRIVE_TMP_PARTS, 1)) return null;
  const lastOfCard = parts.slice(-(CARD_PARTS.length + 1));
  if (lastOfCard.length === CARD_PARTS.length + 1 && CARD_PARTS.every((s, i) => fold(lastOfCard[i]!) === fold(s)) && (fold(lastOfCard[CARD_PARTS.length]!) === CARD_FILE || fold(lastOfCard[CARD_PARTS.length]!) === `${CARD_FILE}.tmp`)) return null;
  const dbCopies = findRun(parts, DB_COPIES_PARTS, 1);
  if (dbCopies >= 0) {
    // The folder that holds the app data copies is never removed as a whole (the dated copies below it are).
    const rest = parts.slice(dbCopies + DB_COPIES_PARTS.length);
    if (!(rest.length === 1 && fold(rest[0]!) === fold(APPDATA_ROOT_FOLDER))) return null;
  }
  // The laptop app data copies: only what is below `<backups>\Laptop-AppData\<laptop>\` (the dated copies the keep-N rotation removes).
  // The Laptop-AppData folder and a laptop's folder are never removed, and nothing else in the backups folder is the app's own.
  if (containsRun(parts, [...BACKUPS_PARTS, APPDATA_ROOT_FOLDER], 2)) return null;
  if (config.dataDir !== undefined) {
    const data = segmentsOf(config.dataDir).parts;
    const dataRoot = segmentsOf(config.dataDir).root;
    const here = segmentsOf(p);
    if (fold(dataRoot) === fold(here.root) && strictlyUnder(parts, data)) {
      const rel = parts.slice(data.length);
      if (rel.length >= 2 && OWN_NAMES.dataFolders.some((f) => fold(f) === fold(rel[0]!))) return null;
      if (rel.length === 1) {
        const name = fold(rel[0]!);
        if (name === OWN_NAMES.keyFile || name === OWN_NAMES.deviceFile || name === `${OWN_NAMES.deviceFile}.tmp` || name.startsWith(`${OWN_NAMES.deviceFile}.unreadable-`)) return null;
        if (name === `${OWN_NAMES.keyFile}.tmp`) return null;
      }
    }
  }
  if (config.logsDir !== undefined) {
    const logs = segmentsOf(config.logsDir);
    if (fold(logs.root) === fold(segmentsOf(p).root) && strictlyUnder(parts, logs.parts)) return null;
  }
  const temp = segmentsOf(config.tempDir ?? os.tmpdir());
  const here = segmentsOf(p);
  if (fold(temp.root) === fold(here.root) && strictlyUnder(parts, temp.parts)) {
    const rel = parts.slice(temp.parts.length);
    if (rel.length >= 1 && fold(rel[0]!).startsWith(OWN_NAMES.osTempPrefix)) return null;
  }
  for (const extra of config.extraRoots ?? []) {
    const e = segmentsOf(extra);
    if (fold(e.root) === fold(here.root) && strictlyUnder(parts, e.parts)) return null;
  }
  return 'it is not in a folder Backup Hub owns';
}

function checked(p: string): string {
  const problem = ownPathProblem(p);
  if (problem !== null) throw new OwnFilesRefused(p, problem);
  return path.resolve(p);
}

function note(verb: string, p: string, quiet: boolean | undefined): void {
  if (quiet === true) return;
  try {
    config.log?.(`ownFiles: ${verb} ${p}`);
  } catch {
    // Logging must never stop a clean-up of the app's own files.
  }
}

/** Removes one app-owned file, or (recursive) an app-owned folder with everything below it. A path that is not there is fine. */
export function ownRemove(p: string, opts: { recursive?: boolean; quiet?: boolean } = {}): void {
  const abs = checked(p);
  fs.rmSync(abs, { recursive: opts.recursive === true, force: true });
  note(opts.recursive === true ? 'removed folder' : 'removed', abs, opts.quiet);
}

/**
 * The same as `ownRemove` without waiting for the drive on the window's thread (fs.promises: the call runs on the thread pool). The copy
 * paths use this one; the checks are the same and run first.
 */
export async function ownRemoveAsync(p: string, opts: { recursive?: boolean; quiet?: boolean } = {}): Promise<void> {
  const abs = checked(p);
  await fs.promises.rm(abs, { recursive: opts.recursive === true, force: true });
  note(opts.recursive === true ? 'removed folder' : 'removed', abs, opts.quiet);
}

/** Removes an empty app-owned folder (fails when it holds anything). */
export function ownRemoveEmptyDir(p: string): void {
  const abs = checked(p);
  fs.rmdirSync(abs);
  note('removed empty folder', abs, false);
}

/** Moves an app-owned file or folder to another app-owned place. It may replace an app-owned file there (log rotation). */
export function ownMove(from: string, to: string, opts: { quiet?: boolean } = {}): void {
  const a = checked(from);
  const b = checked(to);
  fs.renameSync(a, b);
  note(`moved to ${b}:`, a, opts.quiet);
}

/** The live database name: it may be moved by the restore swap (aside, back, or a staged copy onto it), never removed. */
function isLiveDb(p: string): boolean {
  if (config.dataDir === undefined) return false;
  const here = fold(path.resolve(p));
  const live = fold(path.join(path.resolve(config.dataDir), OWN_NAMES.liveDb));
  return here === live || here === `${live}-wal` || here === `${live}-shm`;
}

/**
 * The restore swap: moves app-owned files and the live database files (data folder) to a name that is FREE. It never replaces: EEXIST
 * when anything is at the target.
 */
export function ownMoveDb(from: string, to: string): void {
  const a = isLiveDb(from) ? path.resolve(from) : checked(from);
  const b = isLiveDb(to) ? path.resolve(to) : checked(to);
  if (fs.existsSync(b)) throw Object.assign(new Error('The name is not free.'), { code: 'EEXIST' });
  fs.renameSync(a, b);
  note(`moved to ${b}:`, a, false);
}

/** Atomic replace of an app-owned file (config, card, key, manifest): `tmp` becomes `final`, whatever was there goes. */
export function ownReplace(tmp: string, final: string): void {
  const a = checked(tmp);
  const b = checked(final);
  fs.renameSync(a, b);
  note(`replaced ${b} with`, a, true);
}

/** The same as `ownReplace`, off the window's thread (fs.promises). */
export async function ownReplaceAsync(tmp: string, final: string): Promise<void> {
  const a = checked(tmp);
  const b = checked(final);
  await fs.promises.rename(a, b);
  note(`replaced ${b} with`, a, true);
}

/**
 * Puts an app-owned `tmp` at `final` WITHOUT ever replacing: EEXIST when anything is there. A hard link where the file system has them
 * (NTFS), otherwise an exclusive copy (never overwrites either). `tmp` is removed afterwards.
 */
export function ownCreateNew(tmp: string, final: string): void {
  const a = checked(tmp);
  const b = checked(final);
  try {
    fs.linkSync(a, b);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
  }
  fs.rmSync(a, { force: true });
  note(`created ${b} from`, a, true);
}
