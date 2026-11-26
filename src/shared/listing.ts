/**
 * Listing types shared by main, preload and renderer. Pure data and pure functions only.
 */

/** The job kind that lists the files of one place. */
export const LIST_PLACE_JOB_KIND = 'list.place';

/**
 * The job that looks again at a laptop or drive (quick pass: only folders that changed). It runs the same code as
 * `list.place` with `quick` set, but is a quiet upkeep job: it shows on the Jobs screen only while it runs or when it
 * has something to say.
 */
export const LOOK_AGAIN_JOB_KIND = 'list.lookAgain';

/** Both kinds of listing job. */
export function isListingJobKind(kind: string): boolean {
  return kind === LIST_PLACE_JOB_KIND || kind === LOOK_AGAIN_JOB_KIND;
}

/** Parameters of a `list.place` job. */
export interface ListPlaceParams {
  placeId: string;
  /**
   * "Look again": a quick pass that skips folders whose modified time has not moved since they were last read. It still
   * marks files that are no longer there as gone (never deletes). Without it the whole place is listed.
   */
  quick?: boolean;
}

/** Where a place is in its listing: no job, a job waiting its turn, or a job walking the folders. */
export type ListingState = 'idle' | 'queued' | 'running' | 'paused';

/** What the file list holds for one place (rows that are not marked gone). */
export interface PlaceFileStats {
  files: number;
  totalBytes: number;
  /** OneDrive placeholders that are listed but not on this PC. */
  cloudOnly: number;
}

export type ListNowResult = { ok: true; jobId: number } | { ok: false; message: string };

export type AddRootResult =
  | { ok: true; root: string }
  | { ok: false; canceled: boolean; message: string };

export type RemoveRootResult = { ok: true; filesMarkedGone: number } | { ok: false; message: string };

/** The sentence the UI shows before a folder is taken off the list. */
export function removeRootConfirmation(root: string): string {
  return `Stop checking ${root}? Files already on the list there stay in Backup Hub's list but are marked as no longer seen. Nothing on your disk changes.`;
}
