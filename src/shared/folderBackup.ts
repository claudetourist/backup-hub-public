/**
 * The folder backup (R2.1) and the Google Keep notes backup (R2.8): what main answers and the window shows. Plain data only.
 * A folder backup is the same run as the phone backup: look, a list to look through, one confirm, a verified copy that never overwrites or
 * deletes, a report and a list on the drive. The list rows, the live progress and the copied-files list are the phone backup's own types.
 */
import type { CopiedFiles, LeftOutGroup, PhoneBackupProgress, PhoneBackupSelection, PhoneBackupStartResult, PreviewRow, ReasonLine } from './phoneBackup';

export const FOLDER_LOOK_JOB_KIND = 'folder.look';
export const FOLDER_BACKUP_JOB_KIND = 'folder.backup';
export const FOLDER_LOOK_TITLE = 'Look at the folder';

/** The key of the Google Keep notes backup (`backup_profiles.import_key`): its own flat, add-only layout, and its own privacy rules. */
export const KEEP_SYNC_KEY = 'keep-sync';
export const KEEP_SYNC_NAME = 'Google Keep notes (keep-sync)';
export const KEEP_SYNC_ADD_BUTTON = 'Add Google Keep notes backup';
/** What every screen about the notes says: the files hold the notes themselves, so Backup Hub only copies them. */
export const KEEP_SYNC_PRIVACY = 'These files hold your notes. Backup Hub only copies them: it never opens, reads or shows what is inside.';

/** The folder a row is grouped under when its file lies straight in the backed-up folder. */
export const FOLDER_TOP_WORDS = 'Main folder';

/** What is in an online-only count: OneDrive files that are not on this PC (read later, R2.2). */
export interface OnlineOnlyInfo {
  files: number;
  bytes: number;
  examples: string[];
}

export const ONLINE_ONLY_WORDS = 'Online only, not copied this time';
export const ONLINE_ONLY_REASON = 'Online only: the file is in OneDrive but not on this computer. It was not opened, so nothing was downloaded.';
export const IN_USE_REASON = 'In use by another program. It was skipped and the next backup tries it again.';

export type FolderBackupKind = 'dated' | 'flat';

/**
 * Files that were renamed or moved since they were backed up (R1.6): the file is the same, so it is already in the backup and nothing is copied.
 * One line per folder: a folder renamed ("Trip" to "Goa 2026"), a folder moved, or single files renamed or moved on their own (`from` and `to` empty).
 */
export interface MovedGroup {
  kind: 'folder_renamed' | 'folder_moved' | 'files';
  /** The folder as it was when it was backed up, below the backed-up folder ('' = the backed-up folder itself). */
  from: string;
  /** The folder as it is now. */
  to: string;
  files: number;
}

/** Most groups a plan carries (the biggest first); the rest are only in `movedFiles`. */
export const MAX_MOVED_GROUPS = 20;

export interface FolderPlanView {
  planId: string;
  hash: string;
  backupId: number;
  backupName: string;
  /** The folder that is backed up, in words ("C:\\Users\\you\\OneDrive"). */
  sourceWords: string;
  driveLabel: string;
  /** Where the files will go, in words ("MyData\\OneDriveBackup\\OneDrive-25Nov26"). */
  folderWords: string;
  layout: FolderBackupKind;
  rows: PreviewRow[];
  totals: { files: number; bytes: number };
  /** Already in the backup: same file with the same size and date (or the same content under another name). */
  alreadyBackedUp: number;
  /** Of those, the ones found by their content under another name (not copied again, only linked). */
  sameContentElsewhere: number;
  /** Keep notes only: a file with this name is on the drive with another size. It is never replaced. */
  differentOnDrive: number;
  /** Of the files already backed up: those renamed or moved since (found by the file's own identity). The biggest groups first. */
  moved: MovedGroup[];
  /** All the files renamed or moved since they were backed up (the groups may show only the biggest). */
  movedFiles: number;
  leftOut: LeftOutGroup[];
  onlineOnly: OnlineOnlyInfo;
  notes: string[];
  freeBytes: number | null;
  /** A plain reason the copy cannot start (not enough room, drive read-only), or null. */
  blocked: string | null;
}

export type FolderLookResult = { ok: true; plan: FolderPlanView } | { ok: false; message: string };

export type FolderBackupSelection = PhoneBackupSelection;
export type FolderBackupStartResult = PhoneBackupStartResult;
export type FolderBackupProgress = PhoneBackupProgress;
export type FolderCopiedFiles = CopiedFiles;

export interface FolderBackupReport {
  jobId: number;
  runId: number;
  backupName: string;
  sourceWords: string;
  layout: FolderBackupKind;
  startedAt: number;
  finishedAt: number;
  copied: { files: number; bytes: number };
  /** Already in the backup under another name or date: linked, not copied again. */
  linked: number;
  /** In use by another program: skipped, listed, tried again next time. */
  inUse: ReasonLine[];
  inUseCount: number;
  skipped: ReasonLine[];
  failed: ReasonLine[];
  leftOut: { files: number; bytes: number };
  onlineOnly: OnlineOnlyInfo;
  /** One line per place the files went to. */
  where: string[];
  /** The list of this run on the drive (path, original path, size, date, checksum), or null when it could not be written. */
  listPath: string | null;
  listProblem: string | null;
}

/** One folder backup that is switched on, for the Backups screen's "Back up now" cards. */
export interface FolderBackupCard {
  backupId: number;
  backupName: string;
  /** The folder that is backed up, in words. */
  sourceWords: string;
  driveLabel: string | null;
  /** The drive of the backup is plugged in. */
  driveConnected: boolean;
  layout: FolderBackupKind;
}

export interface KeepSyncStatus {
  /** The keep-sync snapshots folder exists on this PC, so the backup can be offered. */
  available: boolean;
  /** The backup exists already. */
  exists: boolean;
}

export interface FolderBackupCards {
  cards: FolderBackupCard[];
  keepSync: KeepSyncStatus;
}

export type KeepSyncAddResult = { ok: true; backupId: number; message: string } | { ok: false; message: string };
