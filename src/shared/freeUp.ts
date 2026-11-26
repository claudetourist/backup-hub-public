/**
 * Free up phone space (R1.5): what main answers and the window shows. Plain data and pure functions only.
 * THE RULE (user decision), in two modes the person chooses, separately for the CHECK and for the REMOVAL:
 *   - FULL: a phone file is offered, and removed, only when its SHA-256 read FROM THE PHONE right now equals a checked copy re-read now on
 *     the T7, one re-read now on the second drive (Seagate) and a Google copy whose MD5 equals the MD5 of the T7 copy just read.
 *     (Reads every file: about an hour for 46 GB.)
 *   - QUICK: nothing is read in full. The phone still has the file at the size (and, for the check, date) it had at the backup; each drive
 *     copy is there at its size and its checksum was proved when it was copied (read_both); both drives agree; Google, asked now, gives
 *     the MD5 and size the index holds. (Seconds.)
 * Whatever the mode, the removal logs each file, locks the copies and goes through the guarded path with three survivors.
 */
import { formatGb } from './cloudCopy';
import type { FileKind } from './fileKinds';

/** How hard a check or a removal looks: quick = lists and sizes, full = reads every file. */
export type FreeUpMode = 'quick' | 'full';
export const FREEUP_MODES: readonly FreeUpMode[] = ['quick', 'full'];
export const isFreeUpMode = (v: unknown): v is FreeUpMode => v === 'quick' || v === 'full';

export const FREEUP_CHECK_JOB_KIND = 'freeup.check';
export const FREEUP_REMOVE_JOB_KIND = 'freeup.remove';

/** A video this big goes to the top of the list, whatever its kind. */
export const BIG_VIDEO_BYTES = 100_000_000;
/** A check result older than this is not removed from (the phone may have changed). */
export const FREEUP_RESULT_LIFETIME_MS = 30 * 60 * 1000;
/** How many files of one list a page shows. */
export const FREEUP_PAGE = 100;
/** How many removed files a page of the put-back list shows. */
export const FREEUP_REMOVED_PAGE = 100;
/** The most files one put-back takes (and the most ids "Tick all" hands over). */
export const FREEUP_MAX_PUT_BACK = 50_000;
/** The most files one removal takes. */
export const FREEUP_MAX_REMOVE = 50_000;
/** The most not-ready files whose names are kept for the list (all of them are counted). */
export const FREEUP_MAX_NOT_READY_ROWS = 20_000;

/** The only kinds Free up phone space may offer. */
export const OFFERED_KINDS: readonly FileKind[] = ['video-camera', 'video-whatsapp', 'video-other', 'photo-screenshot', 'photo-camera', 'photo-whatsapp', 'photo-other'];

export const FREEUP_GROUPS = ['big-videos', 'camera-videos', 'whatsapp-videos', 'other-videos', 'screenshots', 'camera-photos', 'whatsapp-photos', 'other-photos'] as const;
export type FreeUpGroupId = (typeof FREEUP_GROUPS)[number];

export const FREEUP_GROUP_LABELS: Readonly<Record<FreeUpGroupId, string>> = {
  'big-videos': 'Big videos (over 100 MB)',
  'camera-videos': 'Camera videos',
  'whatsapp-videos': 'WhatsApp videos',
  'other-videos': 'Other videos',
  screenshots: 'Screenshots',
  'camera-photos': 'Camera photos',
  'whatsapp-photos': 'WhatsApp photos',
  'other-photos': 'Other photos',
};

export const isFreeUpGroup = (v: unknown): v is FreeUpGroupId => typeof v === 'string' && (FREEUP_GROUPS as readonly string[]).includes(v);

/** The three places a file needs, as named on screen (the drives use their own names). */
export const GOOGLE_WORD = 'Google';

export interface FreeUpGroupView {
  id: FreeUpGroupId;
  label: string;
  /** The files of the group that are ticked (in this removal): all of them until the person unticks some. */
  files: number;
  bytes: number;
  /** The files of the group the person unticked ("stays this time"); absent or 0 when none. */
  leftOutFiles?: number;
  leftOutBytes?: number;
}

export interface FreeUpReasonCount {
  /** Plain words: "No copy on Seagate2TB", "Changed on the phone since the backup". */
  what: string;
  files: number;
}

/** One thing the check looked at, and for how many files it held or did not ("Phone: file still there with the same size and date"). */
export interface FreeUpCheckStep {
  what: string;
  passed: number;
  failed: number;
}

/** What the screen shows of one finished check. */
export interface FreeUpResultView {
  checkId: number;
  /** How the check looked: quick (lists and sizes) or full (every file read). */
  mode: FreeUpMode;
  /** What each step of the check did, in plain words, with how many files passed it. A file that failed a step is not tried at the next. */
  steps: FreeUpCheckStep[];
  backupId: number;
  at: number;
  phoneName: string;
  /** Plain sentences of what is missing (a drive not plugged in, Google not reachable). When this is not empty nothing is offered. */
  blocked: string[];
  groups: FreeUpGroupView[];
  readyFiles: number;
  readyBytes: number;
  notReady: { files: number; bytes: number; reasons: FreeUpReasonCount[] };
  /** The space this screen will never touch, and why. */
  locked: {
    keepFiles: number;
    keepBytes: number;
    googleKinds: { label: string; files: number; bytes: number }[];
    /** Files of other kinds (documents, downloads, audio, archives, Android folders, WhatsApp databases). */
    otherFiles: number;
    otherBytes: number;
  };
  /** The places the copies are on, for the confirm screen ("T7", "Seagate2TB", "Google"). */
  places: string[];
}

export type FreeUpResultResult = { ok: true; result: FreeUpResultView } | { ok: false; message: string };

export interface FreeUpOverview {
  ok: true;
  backupId: number;
  backupName: string;
  serial: string | null;
  /** Checked now: the newest finished check of this backup that is still fresh (null when none). */
  checkId: number | null;
  keep: FreeUpKeepRule[];
  /** How many removed files can still be put back (the list itself is paged: `removedPage`). */
  removedTotal: { files: number; bytes: number };
}
export type FreeUpOverviewResult = FreeUpOverview | { ok: false; message: string };

export interface FreeUpKeepRule {
  id: number;
  scope: 'file' | 'folder';
  path: string;
}

/** One removed file that can still be put back (a line of the put-back list). */
export interface FreeUpRemoved {
  id: number;
  /** Where it was on the phone. */
  path: string;
  size: number;
  /** When it was removed (ms since 1970). */
  removedAt: number;
  /** When it was taken (seconds since 1970), from the phone's file row; 0 when not known. */
  takenSec: number;
}

export interface FreeUpRemovedPageRequest {
  backupId: number;
  offset: number;
  /** At most `FREEUP_REMOVED_PAGE`. */
  limit: number;
}
/** One page of the removed files not put back (newest removal first). */
export type FreeUpRemovedPageResult = { ok: true; total: number; totalBytes: number; offset: number; rows: FreeUpRemoved[] } | { ok: false; message: string };

/** Every removed file not put back, for "Tick all": ids and their sizes in the same order (at most `FREEUP_MAX_PUT_BACK`). */
export type FreeUpRemovedIdsResult = { ok: true; total: number; totalBytes: number; ids: number[]; sizes: number[] } | { ok: false; message: string };

export interface FreeUpFileRowView {
  path: string;
  name: string;
  folder: string;
  size: number;
  /** When it was taken or last changed on the phone (seconds since 1970; 0 when unknown). */
  mtimeSec: number;
  /** For a not-ready file: which copy is missing and why. */
  missing: string[];
  /** The first drive has a copy the person can be shown in Explorer. */
  hasCopy: boolean;
  /** A file that can go: ticked (in this removal) or not (stays this time). Absent for a file that is not ready. */
  ticked?: boolean;
}
export type FreeUpFilesResult = { ok: true; total: number; offset: number; rows: FreeUpFileRowView[] } | { ok: false; message: string };

export interface FreeUpFilesRequest {
  checkId: number;
  /** A group, or 'notReady'. */
  list: FreeUpGroupId | 'notReady';
  offset: number;
}

/**
 * Tick or untick files of one group ("stays this time"; not the same as "Keep on the phone", which means never offered). `all`: every file of the group
 * (Tick all / Untick all); else the `paths` (a page's worth at most). The ticks are kept in main with the check; the removal takes only ticked files.
 */
export interface FreeUpTickRequest {
  checkId: number;
  list: FreeUpGroupId;
  ticked: boolean;
  all?: boolean;
  paths?: string[];
}
/** What the group holds after the change. */
export type FreeUpTickResult = { ok: true; files: number; bytes: number; leftOut: number } | { ok: false; message: string };

export interface FreeUpShowCopyRequest {
  checkId: number;
  path: string;
}
export type FreeUpShowCopyResult = { ok: true } | { ok: false; message: string };

export interface FreeUpPrepareRequest {
  checkId: number;
  groups: FreeUpGroupId[];
}
export interface FreeUpPrepareView {
  checkId: number;
  groups: FreeUpGroupView[];
  files: number;
  bytes: number;
  /** "T7, Seagate2TB and Google". */
  places: string[];
  hash: string;
}
export type FreeUpPrepareResult = { ok: true; prepare: FreeUpPrepareView } | { ok: false; message: string };

export interface FreeUpStartRequest {
  checkId: number;
  groups: FreeUpGroupId[];
  hash: string;
  expectFiles: number;
  expectBytes: number;
  confirmed: boolean;
  /** How the removal re-proves each file: full (default) reads the copies again, quick only looks. */
  removeMode?: FreeUpMode;
}
export type FreeUpStartResult = { ok: true; jobId: number } | { ok: false; message: string };

export interface FreeUpKeepRequest {
  backupId: number;
  scope: 'file' | 'folder';
  path: string;
}
export type FreeUpKeepResult = { ok: true; keep: FreeUpKeepRule[] } | { ok: false; message: string };

export interface FreeUpPutBackRequest {
  backupId: number;
  removalIds: number[];
  confirmed: boolean;
}

export interface FreeUpRemoveJobParams {
  backupId: number;
  serial: string;
  model: string;
  listId: string;
  listHash: string;
  /** What the person confirmed (the files themselves stay in main: `FreeUpResults.takeRemoval(listId)`). */
  count: number;
  bytes: number;
  /** Default full. */
  removeMode?: FreeUpMode;
}

/** What the removal job takes for one file (made in main from the check, never sent by the window). */
export interface FreeUpRemoveFile {
  path: string;
  size: number;
  sha256: string;
  kind: string;
  vouchers: {
    placeId: string;
    placeLabel: string;
    placeKind: string;
    relPath: string;
    size: number;
    sha256: string | null;
    md5: string | null;
  }[];
  google: { placeId: string; fileId: string; name: string; parentId: string | null; md5: string; size: number };
}

export const freeLine = (files: number, bytes: number): string => `Free ${formatGb(bytes)}: ${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}`;

/** "T7, Seagate2TB and Google". */
export function placesText(places: readonly string[]): string {
  if (places.length <= 1) return places[0] ?? '';
  return `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]!}`;
}
