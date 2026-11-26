/**
 * "Clean up" types shared by main, preload and the Clean up screen. Pure data and pure functions only.
 *
 * This is the only feature that removes anything. The rules (all enforced in main, never in the window):
 * - match by content fingerprint only (SHA-256; Google Drive rows are matched through the T7 copy's MD5 + size);
 * - nothing is removed without a list the person ticked AND the exact "Remove N files (X GB)" confirm of that run;
 * - the copies that vouched for a removed file are LOCKED for 30 days and never offered by any clean-up;
 * - right before a removal the vouching copies are checked again, and the place must have been looked at in the last 24 h.
 */

export const CLEAN_PHONE_JOB_KIND = 'clean.phone';
export const PUT_BACK_JOB_KIND = 'clean.putBack';
export const CLEAN_LAPTOP_JOB_KIND = 'clean.laptop';

/** Jobs that remove or move things: never retried or resumed by themselves. Running one again needs a new plan and a new confirm. */
export const NO_RETRY_JOB_KINDS: readonly string[] = [CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND, CLEAN_LAPTOP_JOB_KIND, 'freeup.check', 'freeup.remove'];

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The copies that vouched for a removal stay locked this long. */
export const LOCK_DAYS = 30;
export const LOCK_MS = LOCK_DAYS * DAY_MS;
/** A place must have been looked at this recently for a removal to go ahead ("Look again first" otherwise). */
export const FRESH_MS = DAY_MS;
/** After this long the app ASKS whether to empty a quarantine batch. It never empties by itself. */
export const QUARANTINE_ASK_DAYS = 30;
export const QUARANTINE_ASK_MS = QUARANTINE_ASK_DAYS * DAY_MS;
/** A plan older than this must be made again. */
export const CLEAN_PLAN_LIFETIME_MS = 30 * 60 * 1000;
/** Most files a phone plan fingerprints on the phone in one go (the rest next time: fingerprints are remembered). */
export const MAX_PHONE_FINGERPRINTS = 1500;
/** Most duplicate groups one laptop plan shows. */
export const MAX_DUPLICATE_GROUPS = 500;
/** Most files one phone plan lists. */
export const MAX_PHONE_PLAN_ROWS = 5000;

/** One copy that vouches for a file (what was checked, in the catalog, at plan time). */
export interface Voucher {
  placeId: string;
  placeLabel: string;
  placeKind: string;
  relPath: string;
  size: number;
  sha256: string | null;
  md5: string | null;
  /** The place of the Phone backup this copy stands for (Phone backup rule: every place needs a verified copy). */
  destinationId?: number;
}

/** A place of the Phone backup as the clean-up rule sees it (enabled places only). */
export interface CleanDestination {
  id: number;
  kind: 'drive' | 'google' | 'laptop';
  /** For the screen: "T7", "Seagate2TB", "Google", "Laptop folder". */
  label: string;
  placeId: string | null;
  /** Google: the accounts of the group. */
  accounts: string[];
  /** Laptop folder: the folder (absolute). */
  folder: string | null;
  /** Start rule: a drive copy counts only when it is in the current `Backups` layout (not `_old-versions`, not `_damaged`, not the old `BackupHub\Phone`). */
  backupsLayout?: boolean;
}

/** The pseudo place id of a laptop folder copy in a voucher: `folder:<destination id>`. Its `relPath` is the absolute path of the file. */
export const FOLDER_VOUCHER_PREFIX = 'folder:';
export const FOLDER_VOUCHER_KIND = 'folder';

export interface Bucket {
  files: number;
  bytes: number;
}

// ---- 5a Free up phone space ------------------------------------------------------------------------------------------

/** safe = T7 and cloud copy; waiting = T7 copy only; stale = a place must be looked at again first; unreadable = the phone gave no fingerprint. */
export type PhoneVerdict = 'safe' | 'waiting' | 'stale' | 'unreadable';

export interface PhoneCleanFile {
  index: number;
  /** Path on the phone, always below /sdcard. */
  path: string;
  folder: string;
  /** "2026-03" from the phone's modified time. */
  month: string;
  name: string;
  size: number;
  mtimeSec: number;
  sha256: string | null;
  verdict: PhoneVerdict;
  /** Plain words for the screen. */
  reason: string;
  /** The copies that vouch (T7 first, then cloud). Empty unless safe or waiting. */
  vouchers: Voucher[];
}

export interface StalePlace {
  placeId: string;
  label: string;
  /** The place's kind (drive, gdrive, onedrive): tells the screen which "look again" button to offer. */
  kind: string;
  why: string;
}

export interface PhoneCleanPlan {
  id: string;
  hash: string;
  createdAt: number;
  serial: string;
  model: string;
  /** Safe and waiting files only (the rest is counted). */
  files: PhoneCleanFile[];
  /** On the phone with no copy on a named drive at all. */
  onlyOnPhone: Bucket;
  safe: Bucket;
  waiting: Bucket;
  stale: Bucket;
  unreadable: Bucket;
  stalePlaces: StalePlace[];
  /** The places of the Phone backup that must each hold a verified copy before a file is safe to remove (empty: the old T7 + cloud rule). */
  requires?: string[];
  /** Files that still wait to be fingerprinted on the phone (run the plan again). */
  notFingerprinted: number;
  notes: string[];
}

export type PhoneCleanPlanResult = { ok: true; plan: PhoneCleanPlan } | { ok: false; message: string };

export interface CleanStartBase {
  planId: string;
  hash: string;
  /** Must be true: the person ticked the final "Remove N files (X GB)" confirm. */
  confirmed: boolean;
  /** What the person confirmed. Main works the numbers out again and refuses on any difference. */
  expectCount: number;
  expectBytes: number;
}

export interface PhoneCleanStartRequest extends CleanStartBase {
  /** `PhoneCleanFile.index` of every ticked file. */
  indexes: number[];
}

export type CleanStartResult = { ok: true; jobId: number } | { ok: false; message: string };

/** What the job `clean.phone` is given. */
export interface PhoneCleanJobParams {
  serial: string;
  model: string;
  /** The confirmed list for the guarded path (`main/danger`): the plan id and the hash of the list the person confirmed. */
  listId: string;
  listHash: string;
  files: { path: string; size: number; sha256: string; vouchers: Voucher[] }[];
}

export interface PutBackRequest {
  serial: string;
  /** `removal_log` ids to put back. */
  removalIds: number[];
  confirmed: boolean;
}

export interface PutBackJobParams {
  serial: string;
  removalIds: number[];
}

// ---- Shared: log, locks, undo ----------------------------------------------------------------------------------------

export interface RemovalView {
  id: number;
  kind: 'phone' | 'laptop';
  path: string;
  size: number;
  removedAt: number;
  undoneAt: number | null;
  emptiedAt: number | null;
  /** Names of the places that vouched ("T7, Google account 3"). */
  vouchedBy: string;
  /** Laptop: where it waits now. */
  quarantinePath: string | null;
  canUndo: boolean;
}

export interface LockView {
  id: number;
  placeId: string;
  placeLabel: string;
  relPath: string;
  lockedAt: number;
  expiresAt: number;
}

export interface CleanupOverview {
  /** Removals of the last 90 days, newest first (at most 300). */
  removals: RemovalView[];
  /** Locks that are still active. */
  locks: LockView[];
  quarantine: QuarantineBatch[];
}

/** Files moved to the quarantine on one day. */
export interface QuarantineBatch {
  /** "2026-11-03". */
  date: string;
  files: number;
  bytes: number;
  /** When the oldest of them was moved. */
  oldestAt: number;
  /** True once the app may ASK whether to empty it (30 days). */
  canAskToEmpty: boolean;
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

export interface EmptyQuarantineRequest {
  date: string;
  confirmed: boolean;
  expectCount: number;
  expectBytes: number;
}

export interface EmptyQuarantineResult {
  ok: boolean;
  message: string;
}

// ---- 5b Laptop duplicates ---------------------------------------------------------------------------------------------

export interface DuplicateMember {
  relPath: string;
  mtime: number | null;
  /** Name of the collection that holds it, if any. */
  collection: string | null;
  /** False when Backup Hub will never move it (protected or synced folder, or locked): it can only be the one kept. */
  removable: boolean;
  /** Why it cannot be moved. */
  why: string | null;
}

export interface DuplicateGroup {
  /** The SHA-256. */
  id: string;
  size: number;
  members: DuplicateMember[];
  /** Default copy to keep (relPath). */
  keep: string;
  /** Bytes freed when everything but `keep` is moved. */
  freeable: number;
}

export interface LaptopCleanPlan {
  id: string;
  hash: string;
  createdAt: number;
  groups: DuplicateGroup[];
  /** True when the plan stopped at the biggest groups. */
  more: boolean;
  total: Bucket;
  /** The laptop was not looked at in the last 24 hours. */
  stale: boolean;
  notes: string[];
}

export type LaptopCleanPlanResult = { ok: true; plan: LaptopCleanPlan } | { ok: false; message: string };

export interface LaptopCleanStartRequest extends CleanStartBase {
  /** One entry per ticked group: which copy to keep. */
  groups: { id: string; keep: string }[];
}

export interface LaptopCleanJobParams {
  /** The confirmed list for the guarded path (`main/danger`): the plan id and the hash of the list the person confirmed. */
  listId: string;
  listHash: string;
  files: { relPath: string; size: number; sha256: string; mtime: number | null; keep: string; keepSize: number; keepMtime: number | null }[];
}

// ---- Pure helpers shared with the screen ----------------------------------------------------------------------------

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The words of the final confirm button: "Remove 12 files (3.4 GB)". */
export function removeButtonText(count: number, bytes: number): string {
  const size = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6).toLocaleString('en-US')} MB`;
  return `Remove ${plural(count, 'file')} (${size})`;
}
