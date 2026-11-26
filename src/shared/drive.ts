/**
 * Google Drive refresh types shared by main, preload and renderer. Pure data and pure functions only.
 */

import type { PlaceJobRef } from './jobs';
import type { ListingState } from './listing';

/** The job that looks at Google Drive (read only) and updates the catalog of one or more accounts. */
export const DRIVE_REFRESH_JOB_KIND = 'drive.refresh';

/** A refresh warning that starts with this says files vanished from Google Drive and no other place holds a copy. Home turns it into an alert. */
export const LOST_LAST_COPY_PREFIX = 'Last copy gone: ';

export interface DriveRefreshParams {
  placeIds: string[];
}

/** What Sources shows about the refresh of one Google account. */
export interface DriveRefreshView {
  state: ListingState;
  /** What a running refresh says about itself ("Refreshing Mum: 12,000 items"), else null. */
  detail: string | null;
  /** The refresh job of this account, for Pause, Resume and Stop; null when none. */
  job: PlaceJobRef | null;
  /** True while the browser sign-in for this account is open. */
  signingIn: boolean;
}

export type DriveRefreshResult =
  | { ok: true; jobId: number; started: number; skipped: number; note: string | null }
  | { ok: false; message: string };

export type DriveSignInResult = { ok: true; message: string } | { ok: false; message: string };
