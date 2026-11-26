/** The dependencies, the folder that is backed up, and the in-memory plan of a folder backup (R2.1, and the Google Keep notes backup R2.8). */
import type { Db } from '../db';
import type { OnlineOnlyInfo } from '../../shared/folderBackup';
import type { CloudCheckState } from '../listing/cloudOnly';
import type { MirrorDrive } from '../mirror/mirrorTypes';
import type { LeftOutBucket, PlanItem } from '../phoneBackup/planModel';
import type { RunCtx } from '../phoneBackup/phoneBackupTypes';
import type { ConfirmedRun } from '../phoneBackup/runStore';

export interface FolderBackupLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** One file of the backed-up folder as the look found it. `rel` is the path below the folder ("Photos/a.jpg"). */
export interface SourceEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  /** The file's row in the index (null when no row is kept: the Google Keep notes). */
  rowId: number | null;
  /** The checksum the index holds for the file as it is now, or null. */
  sha256: string | null;
  /** The index says the content is online only (OneDrive Files On-Demand): never read. */
  cloudOnly: boolean;
}

export interface SourceLookResult {
  complete: boolean;
  rootMissing: boolean;
  message: string | null;
  /** Set when the source keeps no rows in the index: the files the look found. Absent: the plan reads the index. */
  entries?: SourceEntry[];
}

/**
 * The folder that is backed up: looking at it, its facts, and the ONE way to read a file's content (a stream that hands every block on while it
 * is hashed: the file is read once, by the copy). Tests swap in fakes (locked files, online-only files); the real one is `realSourceFor`.
 */
export interface FolderSource {
  /** The folder in words, for the screens. */
  words: string;
  /** The place that holds the source rows in the index; null when the source keeps none (the Google Keep notes: their names stay out of the file list). */
  placeId: string | null;
  /** The rel_path of the folder inside that place ('' = the whole place). */
  relBase: string;
  /** OneDrive: a file may be online only, so every file is asked about before it is read. */
  cloudAware: boolean;
  /** Looks at the whole folder now: every file's name, size and date (never its content). A look that did not finish says so and marks nothing as gone. */
  look(o: { signal: AbortSignal; progress(message: string): void }): Promise<SourceLookResult>;
  /** The file's size and date right now (lstat), or null when it is not there. */
  stat(rel: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** Reads the whole file once, handing every block on, and gives its SHA-256. Throws the system's error (code EBUSY ... for a file in use). */
  readFile(rel: string, onBlock: (block: Buffer) => Promise<void> | void, yieldNow: () => Promise<void>): Promise<{ sha256: string; bytes: number }>;
  /** Asks Windows for the attributes of these files (never opens one): 'cloud' = online only. */
  cloudStates(rels: readonly string[], signal: AbortSignal): Promise<Map<string, CloudCheckState>>;
}

export interface FolderSourceProfile {
  id: number;
  name: string;
  sourceRoot: string;
  importKey: string | null;
  folderPrefix: string;
}

export interface FolderBackupDeps {
  db: Db;
  log: FolderBackupLog;
  now?: () => number;
  /** The drive of a place right now (the safe-copy pieces, a quick look of one folder, a temp writer), or null when it is not plugged in. */
  driveFor(placeId: string): Promise<{ drive: MirrorDrive; label: string } | null>;
  /** The folder of a backup, ready to look at; or the plain reason it cannot be reached. */
  sourceFor(profile: FolderSourceProfile): Promise<{ ok: true; source: FolderSource } | { ok: false; message: string }>;
  /** The plain "read-only" line for a drive that must not be written to, else null. */
  writeProtected?(placeId: string): string | null;
  keepAwake?(): () => void;
  wakeCount?(): number;
  sleep?(ms: number): Promise<void>;
  /** Extra tries after a copy that did not check out (default 2). */
  retries?: number;
}

/** A plan kept in memory until it is confirmed (or replaced). The window only ever sees `FolderPlanView` and sends back ids and a hash. */
export interface StoredFolderPlan {
  planId: string;
  hash: string;
  createdAt: number;
  base: Omit<ConfirmedRun, 'items' | 'relinks' | 'leftOut'>;
  items: PlanItem[];
  relinks: ConfirmedRun['relinks'];
  buckets: LeftOutBucket[];
  total: { files: number; bytes: number };
  onlineOnly: OnlineOnlyInfo;
}

export type { RunCtx };
