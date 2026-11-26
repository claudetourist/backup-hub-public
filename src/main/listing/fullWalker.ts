import type { PlaceFileStats } from '../../shared/listing';
import type { Db } from '../db';
import { fileStatsFor, markGoneSliced, upsertFiles, type ListedFile } from './fileStore';
import { FolderIndex, parentOf, type FolderRecord } from './folderIndex';
import { matchMoves } from './moveMatch';
import { relOfMode, type RelMode } from './relPaths';
import { walkRoot } from './walker';

/**
 * The full listing of ONE root (walk + saving), written so it can run on a worker thread: plain data in, plain data out.
 * The job (listJob.ts) stays on the main thread and only reports progress, pauses and keeps the checkpoint.
 */
export interface FullWalkRequest {
  placeId: string;
  /** The folder to walk, as a path on this PC. */
  root: string;
  rel: RelMode;
  excludeDirs: readonly string[];
  /** The skip list (folder names, any depth, any case). Empty for a backup drive. */
  skipFolders?: readonly string[];
  /** A OneDrive root: its own locked marker file is not listed. */
  oneDriveRoot: string | null;
  /** OneDrive: the rel paths of the files that are only in the cloud. Null = could not be found out (the flags stay as they were). */
  cloudRels: string[] | null;
  chunkSize: number;
  /** NTFS (the laptop, OneDrive): the file system's id of each file is saved and used to recognise a renamed or moved file. Never for a drive or a phone. */
  trustFsId?: boolean;
}

export interface DeniedSample {
  kind: 'folder' | 'file';
  path: string;
}

/** Sent after every saved batch. `deniedSamples` are the access-denied entries found since the last tick (at most MAX_SAMPLES in all). */
export interface FullWalkCounts {
  filesSeen: number;
  denied: number;
  deniedSamples: DeniedSample[];
}

export interface FullWalkResult {
  complete: boolean;
  rootMissing: boolean;
  firstError: string | null;
  skippedLinks: number;
  filesSeen: number;
  denied: number;
  /** Stored rel paths of the unreadable folders and files: their old rows must not be marked gone. */
  deniedFolders: string[];
  deniedFiles: string[];
  /** Access-denied entries found after the last tick (not yet sent). */
  deniedSamples: DeniedSample[];
}

/** Rows saved per transaction, with a short pause between: another connection (the main thread) can write in between. */
const UPSERT_SLICE = 250;
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/** Access-denied entries sent back by name (the rest are only counted). */
export const MAX_DENIED_SAMPLES = 10;

export interface FullWalkOptions {
  db: Db;
  request: FullWalkRequest;
  now?: () => number;
  signal?: AbortSignal;
  /** After each saved batch; the walk waits for it (that is where the job reports progress and pauses). */
  tick?: (counts: FullWalkCounts) => Promise<void> | void;
}

export async function fullWalk(o: FullWalkOptions): Promise<FullWalkResult> {
  const { db, request } = o;
  const now = o.now ?? Date.now;
  const relOf = relOfMode(request.rel);
  const cloud = request.cloudRels === null ? null : new Set(request.cloudRels);
  const keepCloud = cloud === null;
  const folderIndex = new FolderIndex(db);
  // Folders read completely are remembered (with their modified time) for "Look again", saved after their files.
  let readFolders: (FolderRecord & { parent: string })[] = [];
  const saveFolders = (): void => {
    if (readFolders.length === 0) return;
    folderIndex.record(request.placeId, readFolders, now());
    readFolders = [];
  };
  const deniedFolders: string[] = [];
  const deniedFiles: string[] = [];
  let denied = 0;
  let sampled = 0;
  let fresh: DeniedSample[] = [];
  let filesSeen = 0;
  const result = await walkRoot({
    root: request.root,
    excludeDirs: request.excludeDirs,
    ...(request.skipFolders ? { skipFolders: request.skipFolders } : {}),
    ...(request.oneDriveRoot !== null ? { oneDriveRoot: request.oneDriveRoot } : {}),
    chunkSize: request.chunkSize,
    ...(o.signal ? { signal: o.signal } : {}),
    onDenied: (p, kind) => {
      denied += 1;
      if (sampled < MAX_DENIED_SAMPLES) {
        sampled += 1;
        fresh.push({ kind, path: p });
      }
      (kind === 'folder' ? deniedFolders : deniedFiles).push(relOf(p));
    },
    onFolder: (dir, mtimeMs) => {
      const relPath = relOf(dir);
      readFolders.push({ relPath, parent: parentOf(relPath), mtime: mtimeMs });
    },
    onBatch: async (files) => {
      const listed: ListedFile[] = files.map((f) => {
        const relPath = relOf(f.absPath);
        return { relPath, size: f.size, mtimeMs: f.mtimeMs, cloudOnly: cloud?.has(relPath) ?? false, fsId: request.trustFsId === true ? f.fsId : null };
      });
      for (let i = 0; i < listed.length; i += UPSERT_SLICE) {
        if (i > 0) await pause();
        upsertFiles(db, request.placeId, listed.slice(i, i + UPSERT_SLICE), now(), keepCloud);
      }
      saveFolders();
      filesSeen += files.length;
      const samples = fresh;
      fresh = [];
      await o.tick?.({ filesSeen, denied, deniedSamples: samples });
    },
  });
  saveFolders();
  return {
    complete: result.complete,
    rootMissing: result.rootMissing,
    firstError: result.firstError,
    skippedLinks: result.skippedLinks,
    filesSeen,
    denied,
    deniedFolders,
    deniedFiles,
    deniedSamples: fresh,
  };
}

/** After a complete walk (and a drive that is still plugged in): mark what was not seen as gone, forget vanished folders. */
export interface FinishRequest {
  placeId: string;
  /** Rel path prefix ending in "/" for one folder, or '' for the whole place. */
  scopePrefix: string;
  keepPrefixes: string[];
  keepPaths: string[];
  runStart: number;
  /** The stored rel path of the walked root (for the folder times). */
  folderRoot: string;
  /** NTFS: after marking, recognise files that were renamed or moved (see moveMatch.ts). */
  trustFsId?: boolean;
}

export interface FinishResult {
  /** Rows marked gone (a renamed or moved file is not one of them: it is `moved`). */
  gone: number;
  /** Files recognised as renamed or moved: the old row kept, with its new path. */
  moved: number;
}

export async function finishWalk(db: Db, request: FinishRequest, now: () => number = Date.now): Promise<FinishResult> {
  const gone = await markGoneSliced(db, request.placeId, { prefix: request.scopePrefix, keepPrefixes: request.keepPrefixes, keepPaths: request.keepPaths }, request.runStart, now(), pause);
  new FolderIndex(db).forgetUnseen(request.placeId, request.folderRoot, request.runStart);
  const moved = request.trustFsId === true ? (await matchMoves(db, { placeId: request.placeId, runStart: request.runStart, now: now(), pause })).moved : 0;
  return { gone: Math.max(0, gone - moved), moved };
}

/** The counts shown when a listing ends (a count over the whole place: kept off the main thread). */
export function placeStats(db: Db, placeId: string): PlaceFileStats {
  return fileStatsFor(db, placeId);
}
