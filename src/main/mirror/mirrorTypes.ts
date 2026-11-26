/** The dependencies and in-memory plan of the mirror to a second drive (R1.3). */
import type { Db } from '../db';
import type { BackupDrive } from '../phoneBackup/backupDrive';
import type { MirrorPlanView } from '../../shared/mirror';
import type { MirrorCheckPlanView } from '../../shared/mirrorCheck';

export interface MirrorLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** A writer for the temp name of one copy on the second drive. */
export interface TempWriter {
  write(block: Buffer): Promise<void>;
  /** Flushes, closes and gives the file the source's date. */
  finish(mtimeMs: number): Promise<void>;
  /** Closes without keeping anything (the caller removes the temp name). */
  abort(): Promise<void>;
}

/**
 * One drive of a mirror pair: the safe-copy pieces of a backup drive (temp folder, flush, cache-free read, link that cannot replace, lists folder)
 * plus the three things the mirror needs: look again at a folder (brings the index up to date), read a file from the drive itself, write a temp file.
 */
export interface MirrorDrive extends BackupDrive {
  placeId: string;
  label: string;
  /** Looks again at one folder (the listing's own quick look: names, sizes, dates; nothing is opened). `complete` false: the list may be missing files. */
  look(folderRel: string, o: { signal: AbortSignal; progress(message: string): void }): Promise<{ complete: boolean; rootMissing: boolean; message: string | null }>;
  /** Reads a file from the drive without the Windows cache, handing every block on; returns its SHA-256. */
  readFile(rel: string, onBlock: (block: Buffer) => Promise<void> | void, yieldNow: () => Promise<void>): Promise<{ sha256: string; bytes: number }>;
  openTemp(tmp: string): Promise<TempWriter>;
}

export interface MirrorDeps {
  db: Db;
  log: MirrorLog;
  now?: () => number;
  /** The two drives of a pair right now; null for a drive that is not plugged in. */
  drivesFor(srcPlaceId: string, dstPlaceId: string): Promise<{ src: MirrorDrive | null; dst: MirrorDrive | null }>;
  /** The ids of the drives plugged in right now (a refresh of the drive list). Absent in tests that do not need it. */
  pluggedPlaces?(): Promise<ReadonlySet<string>>;
  /** True when this drive logged a USB error after `sinceMs` (Windows events 153 and 129; places/usbHealth.ts). Absent in tests that do not need it. */
  usbTrouble?(placeId: string, sinceMs: number): Promise<boolean>;
  /** The plain "read-only" or "identity question" line for a drive that must not be written to, else null. */
  writeProtected?(placeId: string): string | null;
  keepAwake?(): () => void;
  wakeCount?(): number;
  sleep?(ms: number): Promise<void>;
  /** Extra tries after a copy that did not check out (default 2). */
  retries?: number;
  /** How often the System log is read during a copy (default 60 s). */
  usbEveryMs?: number;
  /** "Behind by N files" counted on a worker thread (read only); null = no worker could run, then main counts in slices. Absent in tests. */
  behindInWorker?(pair: MirrorCountPair): Promise<{ files: number; bytes: number } | null>;
}

/** Where a pair's two folders are in the index (plain data: it crosses to a worker). */
export interface MirrorCountPair {
  srcPlaceId: string;
  srcRoot: string;
  dstPlaceId: string;
  dstRoot: string;
}

/** One backup and its two drives, as the plan and the run use it. */
export interface MirrorPair extends MirrorCountPair {
  backupId: number;
  backupName: string;
  srcLabel: string;
  dstLabel: string;
}

/** One file of the first drive's backup folder, as the plan found it. `rel` is the path inside the folder. */
export interface MirrorItem {
  /** Index in the pairs. */
  b: number;
  rel: string;
  size: number;
  mtimeMs: number;
  /** The first drive's index row (for the checksum it learns and the problems it gets). */
  srcRowId: number;
  /** The phone's row, when the first drive's copy came from the phone. */
  originId: number | null;
  /** The checksum the first drive's file must have (the phone's, or its own recorded one); null = none known yet. */
  sha256: string | null;
  /** True when `sha256` is the phone's (expected_sha256). */
  expected: boolean;
  /** The check job's group (photos and videos, documents, other): set for check items, worked out from the path when missing. */
  group?: 'photos' | 'documents' | 'other';
  /** copy: not on the second drive. different: there with another size. check: there with the same size (only in the check job's list). */
  kind: 'copy' | 'check' | 'different';
}

export interface StoredMirrorPlan {
  planId: string;
  hash: string;
  createdAt: number;
  pairs: MirrorPair[];
  copy: MirrorItem[];
  different: MirrorItem[];
  view: MirrorPlanView;
}

/** The list of a "Check old copies" preview, kept in memory until it is confirmed (or too old). */
export interface StoredCheckPlan {
  planId: string;
  hash: string;
  createdAt: number;
  pairs: MirrorPair[];
  items: MirrorItem[];
  view: MirrorCheckPlanView;
}

/** The slice of a job context the mirror uses (the real JobContext fits). */
export interface MirrorCtx {
  readonly signal: AbortSignal;
  yield(): Promise<void>;
  progress(done: number, total: number, extras?: { bytesDone?: number; bytesTotal?: number; message?: string }): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', text: string): void;
  warn(text: string): void;
  needsYou(message: string, choices?: string[]): Promise<string>;
  checkpoint(resume: unknown): void;
  /** The turn for the middle of a file: a Pause does not hold there (the file finishes first). Absent in a fake: `turnOf` falls back to `yield`. */
  turn?(): Promise<void>;
  /** What to save before a Pause holds the job. */
  beforeHold?(save: () => void | Promise<void>): void;
}
