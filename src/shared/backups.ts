/**
 * The Backups screen and "Bring in PhoneBackup history" (R1.1): what main answers and the window shows. Plain data only.
 * Words: a "backup" is one backup profile (a phone or a folder, saved to a drive); "history" is PhoneBackup's old record of what it copied.
 */

export interface BackupRow {
  id: number;
  name: string;
  /** The person this backup belongs to (their id). */
  personId: number;
  kind: 'phone' | 'folder';
  /** What is backed up: "Phone" or the folder, as the person knows it. */
  from: string;
  /** The drive the backup goes to, by its name; null when it has no backup folder yet. */
  driveLabel: string | null;
  /** The backup folder on that drive ("MyData/POCO"); null when none. */
  folder: string | null;
  driveConnected: boolean;
  /** Date of the last backup known from the history (the newest dated folder, or a run of Backup Hub), epoch ms; null when none. */
  lastBackupAt: number | null;
  enabled: boolean;
  /** The newest run of Backup Hub for this backup ended in failure (nothing was copied). False when there was no run. */
  lastRunFailed: boolean;
  /** A phone backup that Backup Hub itself has run successfully: PhoneBackup must not be run on that phone any more (it would copy twice and can write over the Hub's files). */
  hubHasRun: boolean;
  /** A phone backup that knows which phone it is for (the "Change phone" link is offered); always false for a folder backup. */
  phoneLinked: boolean;
  /** Every switched-on drive of this backup in order (first drive first), for "T7 + Seagate2TB". Absent in older answers: then only `driveLabel` is known. */
  destinations?: { placeId: string; label: string; position: number; connected: boolean }[];
  /** How many things the person excluded from this backup (never back up: files, folders, kinds of file). The "Always include" choices are not counted. */
  choices: number;
  /** The backup came from the old PhoneBackup tool: its history was brought in. Only then the screens say "do not run the old PhoneBackup" (a backup made by Backup Hub itself never needs it). Absent in older answers: false. */
  fromOldTool?: boolean;
}

/** How many files and bytes one backup holds on its first drive (read from the file list; no drive is read). */
export interface BackupSize {
  backupId: number;
  files: number;
  bytes: number;
}

export type BackupSizesResult = { ok: true; sizes: BackupSize[] } | { ok: false; message: string };

/** A backup taken off the list ("Remove from list"): nothing about it was deleted; "Put back" brings it back. */
export interface RemovedBackup {
  id: number;
  name: string;
  personId: number;
  /** What it backs up: "Phone" or the folder. */
  from: string;
  removedAt: number;
}

export type ArchiveResult = { ok: true; message: string } | { ok: false; message: string };

export interface BackupsOverview {
  backups: BackupRow[];
  /** The backups taken off the list (absent in older answers: none). */
  removed?: RemovedBackup[];
  /** When PhoneBackup's history was last brought in, or null when never. */
  historyBroughtInAt: number | null;
}

/** One file the import will read. Nothing is written to it. */
export interface HistoryFileInfo {
  backup: string;
  path: string;
  found: boolean;
  bytes: number;
  /** When the file was last written (epoch ms), or null. */
  modifiedAt: number | null;
  /** When this backup's history was last brought in, or null. */
  lastBroughtInAt: number | null;
}

export type HistoryPlan =
  | { ok: false; message: string }
  | {
      ok: true;
      driveLabel: string;
      /** PhoneBackup's settings file, read for the list of backups. */
      settingsPath: string;
      files: HistoryFileInfo[];
      /** Backups that do not exist in Backup Hub yet and will be made (the one for OneDrive IMP is made switched off). */
      newBackups: string[];
      /** A plain reason that nothing can be brought in right now (unsaved changes beside a history file), or null. */
      stop: string | null;
    };

export interface HistoryStaleReason {
  reason: string;
  count: number;
  /** A few file paths. */
  examples: string[];
}

export interface HistoryLine {
  backup: string;
  ok: boolean;
  /** Why this one was not brought in (when ok is false). */
  message: string | null;
  /** Rows in the old history. */
  rowsIn: number;
  /** Rows matched to a file Backup Hub knows on the drive (same size). */
  linked: number;
  /** Rows with no original path: PhoneBackup could not tell which phone file they came from. */
  loose: number;
  /** Rows that could not be matched (rowsIn minus linked), with the reason. */
  stale: number;
  staleReasons: HistoryStaleReason[];
}

export interface HistorySpare {
  /** Rows of the old history for Spare (it is only on the Seagate now). */
  inHistory: number;
  /** Marked "kept only on the Seagate". */
  marked: number;
  /** Still shown as on the T7 because the T7's file list is older than the day Spare was removed: check the T7 again, then bring in again. */
  stillShown: number;
}

export type HistoryResult =
  | { ok: false; message: string }
  | {
      ok: true;
      driveLabel: string;
      /** Backups made by this run, and the ones that were already there (left as they were). */
      made: string[];
      alreadyThere: string[];
      lines: HistoryLine[];
      totals: { rowsIn: number; linked: number; loose: number; stale: number };
      spare: HistorySpare;
      notes: string[];
    };
