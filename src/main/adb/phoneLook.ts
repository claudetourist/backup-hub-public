/**
 * The phone listing as one "look" (PLAN.md section 3c rule 1 and section 7 R1.0a): every folder is listed with the complete-listing
 * check of `parseListing`, and the look is complete only if every folder's listing is. Reading only; it changes nothing anywhere.
 * The shell runner is a parameter, so tests use a fake phone and the real one is `AdbClient`.
 */
import { finishSliced } from '../sliceWork';
import { cleanFolders, isDroppedPath, listCommand, parseListingSteps, type FolderListing, type ListedPhoneFile, type ListingProblemKind, type RawListing } from './phoneModel';

/** Runs one shell line on the phone and returns everything it gave back (never throws for a failed command; may throw when aborted). */
export type ShellRunner = (serial: string, command: string, signal?: AbortSignal, onStdout?: (chunk: string) => void) => Promise<RawListing>;

export interface LookProblem {
  folder: string;
  kind: ListingProblemKind;
  detail: string;
}

export interface PhoneLook {
  serial: string;
  /** The folders that were asked for. */
  folders: string[];
  /** True only when every folder's listing passed every check. When false, `files` is for the record only: nothing may be decided from it. */
  complete: boolean;
  files: ListedPhoneFile[];
  perFolder: FolderListing[];
  problems: LookProblem[];
  /** Refused folders the filters drop anyway: files below them were not seen and are neither new nor gone. */
  unreadable: string[];
  /** Asked-for folders that are not on the phone. */
  absentFolders: string[];
}

export interface LookOptions {
  signal?: AbortSignal | undefined;
  isDropped?: ((p: string) => boolean) | undefined;
  /** The phone backup looks at the whole storage (/sdcard) like PhoneBackup did; no other caller asks for it. */
  allowRoot?: boolean | undefined;
  /** Told the number of lines the phone has sent so far (about one per file), at most twice a second. For the person, never for decisions. */
  onCount?: ((lines: number) => void) | undefined;
  /** Gives the window a turn between slices of work on a big listing (a job passes its own `yield`; the default is one event-loop turn). */
  pause?: (() => Promise<void>) | undefined;
}

export async function lookPhone(run: ShellRunner, serial: string, folders: readonly string[], options: LookOptions = {}): Promise<PhoneLook> {
  const asked = cleanFolders(folders, { allowRoot: options.allowRoot === true });
  const perFolder: FolderListing[] = [];
  const problems: LookProblem[] = [];
  let lines = 0;
  let toldAt = 0;
  const onCount = options.onCount;
  const see = onCount
    ? (chunk: string): void => {
        for (let i = chunk.indexOf('\n'); i !== -1; i = chunk.indexOf('\n', i + 1)) lines += 1;
        const now = Date.now();
        if (now - toldAt >= 500) {
          toldAt = now;
          onCount(lines);
        }
      }
    : undefined;
  for (const folder of asked) {
    let raw: RawListing;
    try {
      raw = await run(serial, listCommand(folder), options.signal, see);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      raw = { exitCode: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
    }
    perFolder.push(await finishSliced(parseListingSteps(folder, raw, options.isDropped ?? isDroppedPath), options.pause));
  }
  // A folder the caller asked for that is not safe to send to the phone is a problem of its own, never silently dropped.
  const rejected = folders.filter((f) => typeof f !== 'string' || !asked.includes(f.replace(/\/+$/, '')));
  for (const f of rejected) problems.push({ folder: String(f), kind: 'bad_folder', detail: 'Not a folder Backup Hub can list safely.' });
  for (const l of perFolder) for (const p of l.problems) problems.push({ folder: l.folder, kind: p.kind, detail: p.detail });

  const seen = new Map<string, ListedPhoneFile>();
  for (const l of perFolder) for (const f of l.files) if (!seen.has(f.path)) seen.set(f.path, f);
  return {
    serial,
    folders: asked,
    complete: problems.length === 0 && asked.length > 0,
    files: [...seen.values()],
    perFolder,
    problems,
    unreadable: [...new Set(perFolder.flatMap((l) => l.unreadable))],
    absentFolders: perFolder.filter((l) => l.absent).map((l) => l.folder),
  };
}
