/**
 * "Get files back" (restore): what the window and main say to each other. Plain data only (no node imports).
 *
 * A backup keeps its files in dated folders on a drive ("Poco-F4-23Nov26"); the Google Keep notes are one flat folder. Getting files back
 * copies them from the best copy there is (the T7 first, then the Seagate, then a download from Google when no drive copy can be used) into a NEW
 * folder on the laptop, or back to where they were when nothing is there now. Every file is checked against its known SHA-256 before it counts; a
 * copy that does not match is thrown away and the next copy is tried. Nothing is ever replaced, and nothing on a drive, the phone or Google is changed.
 */

export const RESTORE_JOB_KIND = 'restore.files';
export const RESTORE_TITLE = 'Get files back';
/** The folder every restore goes into by default (one new folder per restore below it). */
export const RESTORE_FOLDER = 'Restored';
export const RESTORE_PLAN_LIFETIME_MS = 30 * 60 * 1000;

/** What to bring back. */
export type RestorePick =
  /** One dated folder (`folder` is null for a flat backup): `items` are paths below it (a folder ends with "/"); an empty list is everything in it. */
  | { kind: 'date'; backupId: number; folder: string | null; items: string[] }
  /** The newest copy of every file of the backup. */
  | { kind: 'newest'; backupId: number }
  /** Files picked on the Files screen (the ids of their copies; main finds the copy on a drive). */
  | { kind: 'files'; fileIds: number[] };

/** Where it goes. 'new': a new folder (named after the backup and the day) inside `parent` (default: the "Restored" folder (D:\Restored)). 'original': back to where each file was. */
export interface RestoreDestination {
  mode: 'new' | 'original';
  /** Only for 'new': a folder the person chose with "Choose another folder" (main remembers what it handed out). Absent: the default. */
  parent?: string;
}

export interface RestoreSourceView {
  placeId: string;
  label: string;
  connected: boolean;
}

export type RestoreInfoResult =
  | {
      ok: true;
      backupName: string;
      /** 'dated': one folder per backup day. 'flat': one set (the Keep notes). */
      layout: 'dated' | 'flat';
      sources: RestoreSourceView[];
      /** The drive the files come from now; null when none is plugged in (then only what Google has can come back). */
      from: RestoreSourceView | null;
      /** "Back to where it was" is possible (a folder backup); the folder as the person knows it. */
      originalWords: string | null;
      /** The folder a restore goes into unless the person chooses another. */
      defaultParent: string;
      message: string | null;
    }
  | { ok: false; message: string };

export interface RestoreDateView {
  /** The dated folder's name. */
  folder: string;
  /** Local noon of that day (epoch ms). */
  at: number;
}

export type RestoreDatesResult = { ok: true; dates: RestoreDateView[] } | { ok: false; message: string };

export interface RestoreEntry {
  name: string;
  folder: boolean;
  /** Files in it (1 for a file). */
  files: number;
  bytes: number;
  mtime: number | null;
  /** Files in it that cannot be brought back (no checksum, or found different). */
  held: number;
}

export interface RestoreBrowseRequest {
  backupId: number;
  /** The dated folder; null for a flat backup. */
  folder: string | null;
  /** The folder below it, "" for the top, else "DCIM/Camera" (no slash at either end). */
  path: string;
}

export type RestoreBrowseResult =
  | { ok: true; entries: RestoreEntry[]; /** Files left out of the list (a folder with thousands of them): tick the folder to take them all. */ moreFiles: number }
  | { ok: false; message: string };

export interface RestorePlanRequest {
  pick: RestorePick;
  destination: RestoreDestination;
}

export interface RestoreHeldView {
  path: string;
  why: string;
}

export interface RestorePlanView {
  planId: string;
  files: number;
  bytes: number;
  /** Where the files come from: the drive(s) plugged in, and Google when a file has no drive copy to use. */
  fromWords: string;
  /** How many of the files will be downloaded from Google (no plugged-in drive has them). */
  fromGoogle: number;
  /** Where they will go, as a path or "Back to where they were". */
  toWords: string;
  /** Files that will not come back, and why (the first few). */
  held: { count: number; examples: RestoreHeldView[] };
  /** Files of the pick that no plugged-in drive and no Google copy can give now. */
  notAvailable: number;
  /** Free bytes where they go, null when unknown. */
  freeBytes: number | null;
}

export type RestorePlanResult = { ok: true; plan: RestorePlanView } | { ok: false; message: string };

export type RestoreStartResult = { ok: true; jobId: number } | { ok: false; message: string };

export type RestoreChooseFolderResult = { ok: true; parent: string } | { ok: false; canceled: boolean; message: string };

/** What the job adds up for its report. */
export type RestoreOutcome = 'copied' | 'there' | 'no_checksum' | 'differs' | 'damaged' | 'missing' | 'protected' | 'failed' | 'no_space';

export const HELD_WORDS: Readonly<Record<'no_checksum' | 'differs' | 'damaged' | 'missing' | 'protected' | 'failed' | 'no_space', string>> = {
  no_checksum: 'This copy was never checked, so Backup Hub cannot prove it is whole.',
  differs: 'Backup Hub checked this copy and found it different from the original.',
  damaged: 'The copy on the drive no longer matches its checksum. It may be damaged.',
  missing: 'The file is not on the drive any more.',
  protected: 'This folder is protected. Backup Hub never writes there.',
  failed: 'The file could not be copied.',
  no_space: 'There was no room left.',
};

/** Why files were not brought back, short, for the one report line ("2 never checked, 1 not found"). */
export const REASON_WORDS: Readonly<Record<'no_checksum' | 'differs' | 'damaged' | 'missing' | 'protected' | 'failed' | 'no_space', string>> = {
  no_checksum: 'never checked',
  differs: 'found different',
  damaged: 'did not match their checksum',
  missing: 'no copy to reach now',
  protected: 'in a protected folder',
  failed: 'could not be copied',
  no_space: 'no room left',
};

/** "Sat 22 Nov 2026" */
export function restoreDateText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
