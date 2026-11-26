import type { BigIntStats, Dir } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { fsIdOf } from './fsId';
import { isInsideOrSame, isOneDriveMarkerName, isSkippedEntry, pathKey, skipSet } from './skipRules';

/** One file found by the walk. Only `lstat` information: no file is ever opened. */
export interface WalkedFile {
  /** Full path on disk (OS separators). */
  absPath: string;
  size: number;
  /** Epoch ms. */
  mtimeMs: number;
  /** The file system's id of the file (from the same lstat), or null. Callers store it only where it is trusted (NTFS). */
  fsId: string | null;
}

export interface WalkOptions {
  /** Folder to walk. */
  root: string;
  /** Receives files in batches of at most `chunkSize`. May wait (the job yields there) or throw to stop the walk. */
  onBatch: (files: WalkedFile[]) => Promise<void>;
  /** Folders (absolute) never entered, e.g. a OneDrive root, the app's data and logs folders. */
  excludeDirs?: readonly string[];
  /** Folder names never entered, whatever their place in the tree (compared without regard to case). The skip list; sources only. */
  skipFolders?: readonly string[];
  chunkSize?: number;
  /** Access-denied folders and files, as plain sentences. */
  onDenied?: (absPath: string, kind: 'folder' | 'file') => void;
  /** A OneDrive root: a dot-plus-GUID file directly inside it (OneDrive's own locked marker) is not listed. */
  oneDriveRoot?: string;
  /** Checked between entries; the walk throws when it is aborted. */
  signal?: AbortSignal;
  /**
   * A folder whose entries were all read: its path and its modified time as it was BEFORE the entries were read (so a
   * change made meanwhile shows up as a different time next time). Called after the folder's files were handed to `onBatch`
   * or are waiting in the current batch; the caller must save it only after that batch is saved.
   */
  onFolder?: (absDir: string, mtimeMs: number) => void;
}

export interface WalkResult {
  filesSeen: number;
  foldersSeen: number;
  /** Symlinks, junctions and other things not followed. */
  skippedLinks: number;
  /** Folders and files whose entry could not be read (access denied): their old rows must not be marked gone. */
  deniedFolders: string[];
  deniedFiles: string[];
  /**
   * False when anything other than access-denied went wrong (a folder vanished, an I/O error, the
   * root itself is missing). An incomplete walk must never be used to mark files as gone.
   */
  complete: boolean;
  /** The root itself could not be opened because it does not exist (drive unplugged, folder deleted). */
  rootMissing: boolean;
  /** First unexpected error, for the job log. */
  firstError: string | null;
}

export const DEFAULT_CHUNK = 2000;

function isDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return `${e.code ?? 'error'}: ${e.message}`;
}

/**
 * Walk a folder tree with async `opendir` and `lstat`, depth first. Symlinks, junctions and anything
 * that is not a plain file or folder are not followed and not listed. Never opens a file.
 */
export async function walkRoot(options: WalkOptions): Promise<WalkResult> {
  const chunk = options.chunkSize ?? DEFAULT_CHUNK;
  const exclude = options.excludeDirs ?? [];
  const skipDirs = skipSet(options.skipFolders);
  const markerDir = options.oneDriveRoot === undefined ? null : pathKey(options.oneDriveRoot);
  const result: WalkResult = {
    filesSeen: 0,
    foldersSeen: 0,
    skippedLinks: 0,
    deniedFolders: [],
    deniedFiles: [],
    complete: true,
    rootMissing: false,
    firstError: null,
  };
  let batch: WalkedFile[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    await options.onBatch(out);
  };
  const problem = (err: unknown): void => {
    result.complete = false;
    result.firstError ??= describe(err);
  };

  // Directories to visit (with their modified time when known), and the flag that the root's own failure means "missing".
  let rootMtime: number | null = null;
  if (options.onFolder) {
    try {
      rootMtime = Math.trunc((await fs.promises.lstat(options.root)).mtimeMs);
    } catch {
      // The opendir below reports the real problem.
    }
  }
  const stack: { dir: string; mtime: number | null }[] = [{ dir: options.root, mtime: rootMtime }];
  let first = true;
  while (stack.length > 0) {
    if (options.signal?.aborted) throw new Error('The check was stopped');
    const { dir, mtime: dirMtime } = stack.pop()!;
    const isRoot = first;
    first = false;
    let handle: Dir;
    try {
      handle = await fs.promises.opendir(dir);
    } catch (err) {
      if (isDenied(err)) {
        result.deniedFolders.push(dir);
        options.onDenied?.(dir, 'folder');
      } else {
        problem(err);
        if (isRoot && (err as NodeJS.ErrnoException).code === 'ENOENT') result.rootMissing = true;
      }
      continue;
    }
    result.foldersSeen += 1;
    let entriesOk = true;
    try {
      for await (const entry of handle) {
        if (options.signal?.aborted) throw new Error('The check was stopped');
        if (isSkippedEntry(dir, entry.name)) continue;
        if (markerDir !== null && isOneDriveMarkerName(entry.name) && pathKey(dir) === markerDir) continue;
        const abs = path.join(dir, entry.name);
        let st: BigIntStats;
        try {
          st = await fs.promises.lstat(abs, { bigint: true });
        } catch (err) {
          if (isDenied(err)) {
            result.deniedFiles.push(abs);
            options.onDenied?.(abs, 'file');
          } else {
            problem(err);
            entriesOk = false;
          }
          continue;
        }
        if (st.isSymbolicLink()) {
          result.skippedLinks += 1;
          continue;
        }
        if (st.isDirectory()) {
          if (exclude.some((x) => isInsideOrSame(abs, x)) || skipDirs.has(entry.name.toLowerCase())) continue;
          stack.push({ dir: abs, mtime: Number(st.mtimeMs) });
        } else if (st.isFile()) {
          batch.push({ absPath: abs, size: Number(st.size), mtimeMs: Number(st.mtimeMs), fsId: fsIdOf(st) });
          result.filesSeen += 1;
          if (batch.length >= chunk) await flush();
        } else {
          result.skippedLinks += 1;
        }
      }
    } catch (err) {
      // Errors without an OS code come from our own callbacks (stop, unplug); pass them on.
      if ((err as NodeJS.ErrnoException).code === undefined) {
        await handle.close().catch(() => undefined);
        throw err;
      }
      if (isDenied(err)) {
        result.deniedFolders.push(dir);
        options.onDenied?.(dir, 'folder');
      } else problem(err);
      continue;
    }
    if (entriesOk && dirMtime !== null) options.onFolder?.(dir, dirMtime);
  }
  await flush();
  return result;
}
