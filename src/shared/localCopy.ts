/**
 * "Back up now" to a plugged-in drive (the T7): types shared by main and preload. Pure data and
 * pure functions only.
 *
 * The plan is computed in main (read only), shown, and started only after the person ticks the box. The job gets the
 * plan main itself computed (found again by id and checked against its hash), never a plan sent back by the window.
 */

/** The job that adds verified copies of a collection's files to a plugged-in named drive. */
export const COPY_TO_LOCAL_JOB_KIND = 'copy.toLocal';

/** A plan holds at most this many files; the rest is planned in the next run (a copy is a delta, so run it again). */
export const MAX_LOCAL_PLAN_FILES = 5000;
/** A plan older than this must be made again (the drive may have changed). */
export const LOCAL_PLAN_LIFETIME_MS = 30 * 60 * 1000;
/** Space kept free on the drive after the copy. */
export const LOCAL_MIN_FREE_BYTES = 200 * 1_000_000;
/** Rough copy speed (write plus read back to check) used for the time estimate. */
export const LOCAL_ESTIMATE_BYTES_PER_SECOND = 40_000_000;
/** Ending of the temporary file; a file only gets its real name after it was checked. */
export const PART_SUFFIX = '.bhpart';

/** A named drive that is plugged in and can take copies. */
export interface LocalTarget {
  placeId: string;
  label: string;
  freeBytes: number | null;
  /** The plain line to show when the drive is protected (nothing may be written to it); null otherwise. Buttons that would write to it are disabled. */
  readOnly: string | null;
}

/** One file that will be copied, whole, to the drive. */
export interface LocalPlanFile {
  index: number;
  /** Name the file gets on the drive. */
  name: string;
  /** Folder on the drive from its root, with "/" (it starts with the app's backups folder, then the collection: see `shared/appFolders.ts`). */
  folder: string;
  sourcePlaceId: string;
  sourcePlaceLabel: string;
  /** Catalog path of the source (rel_path). */
  sourceRel: string;
  /** Path for the screen. */
  sourceShown: string;
  size: number;
  /** The source's modified time in the catalog; the job refuses a file that changed since. */
  mtime: number | null;
  /** The MD5 the catalog holds for this content (a copy counts only when it matches after copying). */
  md5: string;
}

export interface LocalPlanSkipped {
  name: string;
  shown: string;
  size: number;
  reason: string;
}

export interface LocalCopyPlan {
  id: string;
  /** SHA-256 over what the job will do. The job starts only if main finds the same hash again. */
  hash: string;
  createdAt: number;
  collectionId: number;
  collectionName: string;
  /** The drive's place id. Empty when the copy goes to a laptop folder (`targetFolder`). */
  targetPlaceId: string;
  targetLabel: string;
  /** A folder on this laptop (absolute) that takes the copy instead of a drive (phone backup only). */
  targetFolder?: string;
  files: LocalPlanFile[];
  /** Files that will not be copied, with the reason in plain words. */
  doesNotFit: LocalPlanSkipped[];
  /** Contents of the collection the drive already holds (the delta: nothing to do for them). */
  alreadyThere: { files: number; bytes: number };
  /** Free space on the drive before the copy and after it; null when it cannot be read. */
  freeBefore: number | null;
  freeAfter: number | null;
  notes: string[];
  totalFiles: number;
  totalBytes: number;
  estimatedSeconds: number;
}

export type LocalPlanResult = { ok: true; plan: LocalCopyPlan } | { ok: false; message: string };

export interface LocalCopyStartRequest {
  planId: string;
  hash: string;
  /** Must be true: the person ticked "I checked this list". */
  confirmed: boolean;
}

export type LocalCopyStartResult = { ok: true; jobId: number } | { ok: false; message: string };

/** What the job is given (a copy of the plan main computed). */
export interface LocalCopyJobParams {
  plan: LocalCopyPlan;
}

/** What can happen to one file. */
export type LocalOutcome = 'copied' | 'already' | 'changed' | 'missing' | 'exists' | 'no_space' | 'mismatch' | 'failed' | 'skipped_protected';

export interface LocalReport {
  copied: number;
  copiedBytes: number;
  already: number;
  skipped: number;
  failed: number;
}
