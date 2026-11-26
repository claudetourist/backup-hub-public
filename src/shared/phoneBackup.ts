/**
 * The phone backup (R1.2a): what main answers and the window shows. Plain data only.
 * Words: "back up <phone> now" is a look, then a preview, then a confirmed copy to the T7, then a report.
 */
import type { NewPhoneOwner } from './people';

export const PHONE_LOOK_JOB_KIND = 'phone.look';
export const PHONE_BACKUP_JOB_KIND = 'phone.backup';
export const PHONE_LOOK_TITLE = 'Look at the phone';

/** The filters of PhoneBackup, named as the person reads them. A file a filter drops is "left out", never silently. */
export type LeftOutFilter = 'android_data' | 'nomedia' | 'cache_folder' | 'temporary_file' | 'whatsapp_hidden' | 'your_rule';

export const LEFT_OUT_WORDS: Record<LeftOutFilter, string> = {
  android_data: "Other apps' own data in the Android folder",
  nomedia: 'Folders the phone marks as not for the gallery (.nomedia)',
  cache_folder: 'Cache and thumbnail folders',
  temporary_file: 'Temporary and marker files',
  whatsapp_hidden: 'WhatsApp hidden folders other than Status',
  your_rule: 'Left out by your choice',
};

export interface PreviewRow {
  /** The phone path ("/sdcard/DCIM/Camera/a.jpg"): the id of the row. */
  path: string;
  size: number;
  mtimeSec: number;
  kind: 'new' | 'changed';
}

export interface LeftOutGroup {
  /** Stable id of the group (filter and folder). */
  key: string;
  filter: LeftOutFilter;
  folder: string;
  files: number;
  bytes: number;
  /** False for the person's own choices: those are changed in "Your choices" (the Backups screen), not here. */
  canInclude: boolean;
  /** Set for a group made by one of the person's choices ("never back up"): the choice and its plain words. */
  rule?: { id: number; words: string };
}

export interface PhonePlanView {
  planId: string;
  hash: string;
  backupId: number;
  backupName: string;
  phoneName: string;
  driveLabel: string;
  /** Where the files will go, in words: "MyData\POCO\Poco-F4-23Nov26". */
  folderWords: string;
  rows: PreviewRow[];
  totals: { files: number; bytes: number };
  /** Already on the drive and now confirmed by the phone's checksum: linked, not copied again. */
  confirmedOnDrive: number;
  /** Looked like a copy already on the drive (same name and size) but the checksum differs: copied as a new file. */
  notConfirmed: number;
  alreadyBackedUp: number;
  leftOut: LeftOutGroup[];
  notes: string[];
  freeBytes: number | null;
  /** A plain reason the copy cannot start (not enough room, drive read-only), or null. */
  blocked: string | null;
}

export type PhoneLookResult =
  | { ok: true; plan: PhonePlanView }
  | { ok: false; message: string; /** The look needs a decision: try again, or accept (only for an empty or mass-change look). */ decision: { kind: string; canAccept: boolean } | null };

export interface PhoneBackupStartResult {
  ok: boolean;
  message: string;
  jobId: number | null;
}

export interface PhoneBackupSelection {
  planId: string;
  hash: string;
  /** Phone paths the person unticked. */
  unticked: string[];
  /** Phone folders the person unticked ("/sdcard/Download"): every file below them. */
  untickedFolders: string[];
  /** Left-out groups the person chose to include. */
  included: string[];
}

export interface ConnectedPhone {
  backupId: number;
  backupName: string;
  phoneName: string;
  serial: string;
  /** The drive of the backup is plugged in. */
  driveConnected: boolean;
}

/** A phone that is plugged in and belongs to no backup yet. Nothing is ever linked by itself: the person says which backup it is for. */
export interface NewPhone {
  serial: string;
  /** "Poco F4", or "a phone" when the phone has not allowed this computer yet and gives no name. */
  phoneName: string;
  /** False when the phone first has to allow this computer (then `hint` says how). */
  ready: boolean;
  hint: string | null;
}

/** A phone backup that is switched on but has no phone yet. */
export interface BackupWithoutPhone {
  backupId: number;
  backupName: string;
}

export interface ConnectedPhones {
  adb: 'ready' | 'missing';
  phones: ConnectedPhone[];
  /** Plain words when a phone is plugged in but cannot be used yet (locked, not allowed). */
  hint: string | null;
  /** Phones plugged in whose serial belongs to no backup. */
  newPhones: NewPhone[];
  /** Phone backups that are on and have no phone yet. */
  backupsWithoutPhone: BackupWithoutPhone[];
  /** Phones the person told "Safe to unplug": adb is let go and is not asked about them until they are plugged in again. */
  released?: ReleasedPhone[];
}

/** A phone that is in the "Safe to unplug" state. */
export interface ReleasedPhone {
  serial: string;
  phoneName: string;
}

/** The answer of "Safe to unplug": adb was let go (ok), or a phone job still uses the phone and which one (not ok). */
export type SafeUnplugResult = { ok: true; message: string } | { ok: false; message: string; busyJob: string | null };

export interface LinkPhoneRequest {
  backupId: number;
  serial: string;
}

export interface LinkPhoneResult {
  ok: boolean;
  message: string;
}

/** Where the backups of a new phone backup go on the drive: a new folder made from the name, or a folder that is already there. */
export type NewBackupFolder = { kind: 'new' } | { kind: 'existing'; name: string };

/** "Make a new backup for this phone": the phone that is plugged in now, the name, the drive and the folder. */
export interface CreatePhoneBackupRequest {
  serial: string;
  name: string;
  placeId: string;
  folder: NewBackupFolder;
  /** Whose phone it is: a person that exists, or a new one made with the backup. Left out = the first person. */
  owner?: NewPhoneOwner | undefined;
}

export type CreatePhoneBackupResult = { ok: true; backupId: number; message: string } | { ok: false; message: string };

/** A drive that may hold the new backup, with the folders already on it (directly in MyData) that may be picked. */
export interface NewBackupDrive {
  placeId: string;
  label: string;
  folders: string[];
}

/** What the form needs: the suggested name (the phone's model) and the drives that may be picked. */
export type NewBackupChoices = { ok: true; suggestedName: string; drives: NewBackupDrive[] } | { ok: false; message: string };

/** One file of the live copy lists: the phone path and its size. */
export interface ProgressFile {
  path: string;
  size: number;
}

/** A file that was not copied in this run, with the plain reason. */
export interface ProgressFailed extends ProgressFile {
  reason: string;
}

/** How many files each live list carries (the rest is only counted). */
export const PROGRESS_NEXT_LIMIT = 200;
export const PROGRESS_RECENT_LIMIT = 50;
export const PROGRESS_FAILED_LIMIT = 200;

/**
 * What the copy is doing right now (read only, asked about once a second while the window shows the running copy). Files are in the
 * order they are copied: `next` is the first ones still waiting, `recent` the last ones done (newest first).
 */
export interface PhoneBackupProgress {
  jobId: number;
  /** Files in this run (the ticked ones). */
  total: number;
  /** Copied and checked, or already on the drive. */
  done: number;
  /** Not started yet (not counting the one being copied now). */
  waiting: number;
  /** Not copied, with the reason (all of them counted; `failed` shows the latest ones). */
  failedCount: number;
  current: ProgressFile | null;
  next: ProgressFile[];
  recent: ProgressFile[];
  failed: ProgressFailed[];
  /** The run is over (finished, stopped or failed): nothing more will change. */
  finished: boolean;
}

/** One copied file for the "Show all copied files" fold of the report. */
export interface CopiedFile {
  /** The name on the phone. */
  path: string;
  size: number;
  /** Date of the file (milliseconds), or null. */
  mtimeMs: number | null;
}

export interface CopiedFiles {
  files: CopiedFile[];
  /** All copied files of the run; `files` stops at a limit. */
  total: number;
}

export const COPIED_FILES_LIMIT = 5000;

/** What the person is told when a phone is plugged in but has not allowed this computer. */
export const ALLOW_PHONE_HINT = 'A phone is plugged in but has not allowed this computer. Unlock it and tap Allow on its screen.';

export interface ReasonLine {
  reason: string;
  count: number;
  examples: string[];
}

export interface PhoneBackupReport {
  jobId: number;
  runId: number;
  backupName: string;
  phoneName: string;
  startedAt: number;
  finishedAt: number;
  copied: { files: number; bytes: number };
  /** Linked to copies that were already on the drive (confirmed by checksum). */
  linked: number;
  skipped: ReasonLine[];
  failed: ReasonLine[];
  leftOut: { files: number; bytes: number };
  /** One line per place the files went to. */
  where: string[];
  /** Second spaces on the phone and similar: named here, never backed up by this run. */
  notCovered: string[];
  /** The list of this run on the drive (path, real name, size, date, checksum), or null when it could not be written. */
  listPath: string | null;
  listProblem: string | null;
}

// ---- "Check old copies" (R1.4b, the T7 only for now) --------------------------------------------------------------------------------

export const PHONE_CHECK_OLD_JOB_KIND = 'phone.checkOld';
export const PHONE_CHECK_OLD_TITLE = 'Check old copies';
/** What the person is told before they confirm (nothing is copied, changed or removed). */
export const CHECK_OLD_PROMISE = 'Reads each file on the phone and on the drive and compares them. Nothing is copied, changed or removed on the phone or the drive.';

/**
 * The folder a phone file is grouped under in the counts and the check: the first two folders below /sdcard ("DCIM/Camera"), or the one
 * folder, or "Phone storage" for a file straight in /sdcard. The same grouping as the "By folder" list of the backup preview.
 */
export function phoneFolderGroup(path: string): string {
  const rest = path.startsWith('/sdcard/') ? path.slice(8) : path.replace(/^\/sdcard\/?/, '');
  const first = rest.indexOf('/');
  if (first < 0) return 'Phone storage';
  const second = rest.indexOf('/', first + 1);
  return second < 0 ? rest.slice(0, first) : rest.slice(0, second);
}

export interface CountBucket {
  files: number;
  bytes: number;
}

/** The phone files of one folder (or all of them) by what the drive holds for them, as of the last look at the phone. */
export interface CheckOldCounts {
  /** Phone files on the phone at the last look. */
  onPhone: CountBucket;
  /** A copy on the drive that Backup Hub itself read back and compared (counts for clean-up). */
  checked: CountBucket;
  /** A copy on the drive that came from the old tool and was never compared (does not count for clean-up). */
  unchecked: CountBucket;
  /** No copy on the drive for the file as it is now. */
  noCopy: CountBucket;
  /** No copy, and left out on purpose (a filter or your own rule). */
  leftOut: CountBucket;
}

export interface CheckOldFolderCounts extends CheckOldCounts {
  folder: string;
}

export type CheckOldCountsResult =
  | { ok: true; backupId: number; driveLabel: string; /** When Backup Hub last looked at the phone, or null. */ lookedAt: number | null; total: CheckOldCounts; folders: CheckOldFolderCounts[]; /** True when these are the last numbers and a fresh count is running: ask again in a moment. */ stale?: boolean }
  | { ok: false; message: string };

export interface CheckOldFolder {
  folder: string;
  files: number;
  bytes: number;
}

/** The preview of "Check old copies": the folders with copies not yet checked, largest first. */
export type CheckOldPlanResult =
  | { ok: true; backupId: number; phoneName: string; driveLabel: string; folders: CheckOldFolder[]; totals: CountBucket }
  | { ok: false; message: string };

export interface CheckOldRequest {
  backupId: number;
  /** The folders that stayed ticked. */
  folders: string[];
}

export interface CheckOldNamed {
  /** The phone path. */
  path: string;
  size: number;
}

/** What a finished check says (kept with the job in Activity, shown on the backup's card). */
export interface CheckOldReport {
  jobId: number;
  backupName: string;
  phoneName: string;
  driveLabel: string;
  startedAt: number;
  finishedAt: number;
  /** Files the check was asked to look at. */
  asked: number;
  /** Same content on the phone and on the drive: now checked. */
  verified: CountBucket;
  /** Different content: these will be copied fresh (into a new dated folder) by the next backup. The drive's file was not touched. */
  differ: CheckOldNamed[];
  differCount: number;
  /** The drive's file is not there any more: the next backup copies the file again. */
  missing: CheckOldNamed[];
  missingCount: number;
  /** No longer on the phone: skipped. */
  noLongerOnPhone: number;
  /** Could not be read, with the plain reason (these stay as they were and can be checked again). */
  couldNotRead: ReasonLine[];
}
