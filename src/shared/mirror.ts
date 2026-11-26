/**
 * The second drive (R1.3): "Also keep a copy on <drive>" for a backup, and "Bring <drive> up to date" (a mirror of the first drive's
 * backup folder: same relative folder, copied from the first drive, never from the phone, never deleting or changing anything on the
 * second drive). Types and constants only; main and the window share them. Words for the screens live in renderer/backups/mirrorModel.ts.
 */
import type { ReasonLine } from './phoneBackup';

/** The light job that looks at both drives and makes the list (nothing is copied), and the heavy resumable copy. */
export const MIRROR_LOOK_JOB_KIND = 'mirror.look';
export const MIRROR_COPY_JOB_KIND = 'mirror.copy';

/** The kinds of "Needs your decision" a mirror can leave (file_problems.kind). */
export const MIRROR_DAMAGED_PROBLEM = 'mirror_damaged';
export const MIRROR_DIFFERS_PROBLEM = 'mirror_differs';

/** A plan older than this is not started (the drives may have changed; the run looks at every file again anyway). */
export const MIRROR_PLAN_LIFETIME_MS = 60 * 60 * 1000;

export interface MirrorStartResult {
  ok: boolean;
  message: string;
  jobId: number | null;
}

// ---- "Also keep a copy on ..." ---------------------------------------------------------------------------------------------------------

export interface MirrorDriveChoice {
  placeId: string;
  label: string;
}

export type MirrorChoicesResult =
  | {
      ok: true;
      backupId: number;
      backupName: string;
      /** The first drive: where the backup is now ("T7"). */
      sourceLabel: string;
      /** The folder both drives will use ("MyData/POCO"). */
      folder: string;
      /** The drives that can hold the second copy, never the first drive and never one that already holds it. */
      drives: MirrorDriveChoice[];
    }
  | { ok: false; message: string };

export interface MirrorAddRequest {
  backupId: number;
  placeId: string;
}

export interface MirrorAddResult {
  ok: boolean;
  message: string;
}

// ---- status per drive ----------------------------------------------------------------------------------------------------------------

export interface MirrorDestinationStatus {
  placeId: string;
  label: string;
  position: number;
  connected: boolean;
  /** Files of the first drive's backup folder this drive does not hold (by the file list; the look refreshes it). Null while it is being counted. */
  behindFiles: number | null;
  behindBytes: number;
  /** Files of this backup waiting for the person's decision (a damaged copy on the first drive, a different file already on this drive). */
  needYou: number;
}

export interface MirrorBackupStatus {
  backupId: number;
  /** The first drive. */
  sourceLabel: string;
  sourceConnected: boolean;
  /** The second (and later) drives of the backup. */
  mirrors: MirrorDestinationStatus[];
}

export interface MirrorStatusResult {
  backups: MirrorBackupStatus[];
}

// ---- the list before anything is copied ------------------------------------------------------------------------------------------------

/** One file that would be copied. `id` is what an untick is sent back by. */
export interface MirrorRow {
  id: string;
  /** Which of `plan.backups` it belongs to. */
  backupIndex: number;
  /** The path inside the backup folder ("Poco-F4-24Nov26/DCIM/Camera/IMG_1.jpg"). */
  path: string;
  size: number;
  mtimeMs: number;
  /** The first drive's copy has no checksum from the phone: it is read now and its own checksum is used (flagged in the report). */
  ownChecksum: boolean;
}

export interface MirrorPlanBackup {
  backupId: number;
  backupName: string;
  sourceLabel: string;
  targetLabel: string;
  /** "MyData\\POCO" */
  folderWords: string;
  files: number;
  bytes: number;
}

export interface MirrorPlanView {
  planId: string;
  hash: string;
  backups: MirrorPlanBackup[];
  /** Every file that would be copied, largest first. */
  rows: MirrorRow[];
  totals: { files: number; bytes: number };
  /** Already on the second drive with the same size and not proven yet: NOT read by the copy; "Check old copies" proves them (shared/mirrorCheck.ts). */
  toCheck: { files: number; bytes: number };
  /** Already on the second drive with another size: never replaced, each one goes to "Needs your decision". */
  different: { files: number; examples: string[] };
  /** Files the person was already asked about (a damaged copy, a different file): not offered again, still not on the second drive. */
  knownProblems: number;
  /** Of the files to copy, how many have no phone checksum (see MirrorRow.ownChecksum). */
  ownChecksums: number;
  notes: string[];
  /** Free room on the second drive (the smallest, when several), or null when it is not known. */
  freeBytes: number | null;
  /** A plain reason the copy cannot start (no room, drive read-only), or null. */
  blocked: string | null;
}

export type MirrorLookResult =
  | { ok: true; plan: MirrorPlanView }
  | { ok: false; message: string; /** 'source_missing' = the first drive is not plugged in ("Plug in the T7 ..."). */ reason: 'source_missing' | 'target_missing' | 'usb' | 'incomplete' | 'nothing' | 'other' };

export interface MirrorSelection {
  planId: string;
  hash: string;
  /** Row ids the person unticked. */
  unticked: string[];
}

// ---- the report --------------------------------------------------------------------------------------------------------------------

export interface MirrorReportBackup {
  backupId: number;
  backupName: string;
  targetLabel: string;
  copied: { files: number; bytes: number };
  /** Already on the second drive, read and found the same: linked, not copied. */
  linked: number;
  damaged: number;
  different: number;
  failed: number;
}

export interface MirrorReport {
  jobId: number;
  startedAt: number;
  finishedAt: number;
  backups: MirrorReportBackup[];
  copied: { files: number; bytes: number };
  linked: number;
  /** The first drive's copy did not match its checksum: not copied; each is in "Needs your decision". */
  damaged: number;
  /** A different file was already on the second drive: not replaced; each is in "Needs your decision". */
  different: number;
  /** Copied with the first drive's own checksum (it had none from the phone). */
  ownChecksums: number;
  skipped: ReasonLine[];
  failed: ReasonLine[];
  /** "Seagate2TB: MyData\\POCO". */
  where: string[];
  /** The lists written on the second drive (its own files folder), one per backup. */
  listPaths: string[];
  listProblem: string | null;
  /** How many times the copy paused for USB trouble. */
  usbPauses: number;
}
