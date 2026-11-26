/** The dependencies and in-memory plan of the phone backup (R1.2a). */
import type { Db } from '../db';
import type { PhoneBackupAdb } from '../adb/adbPort';
import type { CheckOldCountsResult, LeftOutFilter } from '../../shared/phoneBackup';
import type { BackupDrive } from './backupDrive';
import type { LeftOutBucket, PlanItem } from './planModel';
import type { ConfirmedRun } from './runStore';

export interface PhoneBackupLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface PhoneBackupDeps {
  db: Db;
  adb: PhoneBackupAdb;
  log: PhoneBackupLog;
  now?: () => number;
  /** The drive of a place right now (its root and the safe-copy pieces), or null when it is not plugged in. */
  driveFor(placeId: string): Promise<{ drive: BackupDrive; label: string } | null>;
  /** Told which phone serials adb reported as ready (whenever adb was asked), so the Devices screen can show the phone as connected. */
  phonesSeen?(serials: string[]): void;
  /** Told which phones are in the "Safe to unplug" state (adb let go), so the Devices screen can say so. Empty when none. */
  phonesReleased?(serials: string[]): void;
  /** Is the phone plugged into the PC? Asked of Windows, never adb (adb is stopped while a phone is released). null = could not tell. */
  phonePlugged?(serial: string): Promise<boolean | null>;
  /** The Backups card's counts counted on a worker thread (read only); null = no worker could run, then main counts in slices. Absent in tests. */
  countsInWorker?(backupId: number): Promise<CheckOldCountsResult | null>;
  /** The named drives plugged in right now, for "Make a new backup for this phone" (read only). `unreadable`: plugged in but its card cannot be read; `blocked`: the plain line of an open question about the drive. */
  connectedDrives?(): Promise<{ placeId: string; label: string; root: string; unreadable: boolean; blocked: string | null }[]>;
  /** The plain "read-only" line for a drive that must not be written to, else null. */
  writeProtected?(placeId: string): string | null;
  /** Stops the laptop from sleeping; returns the function that lets it sleep again. */
  keepAwake?(): () => void;
  /** How often the laptop has woken up so far: a change between two files is treated like an unplug. */
  wakeCount?(): number;
  /** Waits between the retries of a failed pull (tests pass an instant one). */
  sleep?(ms: number): Promise<void>;
  /** Extra tries after a failed pull (default 2). */
  retries?: number;
}

/** The slice of a job context the plan and the run use (the real JobContext fits). */
export interface RunCtx {
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

/** A plan kept in memory until it is confirmed (or replaced). The window only ever sees `PhonePlanView` and sends back ids and a hash. */
export interface StoredPlan {
  planId: string;
  hash: string;
  createdAt: number;
  base: Omit<ConfirmedRun, 'items' | 'relinks' | 'leftOut'>;
  items: PlanItem[];
  relinks: ConfirmedRun['relinks'];
  buckets: LeftOutBucket[];
  /** Which left-out groups may be included. */
  canInclude: ReadonlySet<LeftOutFilter>;
  /** For every file a choice of the person names: the built-in filter that would have left it out (null: none); see planModel. */
  ruledBuiltin: ReadonlyMap<string, LeftOutFilter | null>;
  total: { files: number; bytes: number };
}
