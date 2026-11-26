/**
 * Fingerprint types shared by main, preload and renderer. Pure data and pure functions only.
 * A "fingerprint" is the SHA-256 and MD5 of a file's content: it is how Backup Hub knows two files
 * are the same without comparing names.
 */

import type { PlaceJobRef } from './jobs';

/** The job that fingerprints the files of one place (or of every connected local place). */
export const HASH_FILES_JOB_KIND = 'hash.files';

/** Parameters of a `hash.files` job. Without a place, every connected local place is worked through. */
export interface HashFilesParams {
  placeId?: string;
}

/** Where a place is in its fingerprinting: no job, waiting its turn, reading files, or held back. */
export type HashingState = 'idle' | 'queued' | 'running' | 'paused';

/**
 * How many other places hold each file's content, counted over the live rows of one place.
 * A "copy" is a different place with the same content (same SHA-256 for local places; same MD5 and
 * size for Google Drive, whose catalog has no SHA-256). A cloud-only OneDrive file cannot be
 * compared until it is on this PC, so it is counted on its own instead of as "no copy".
 */
export interface PlaceCoverage {
  /** Fingerprinted files with no copy in any other place. */
  none: CoverageBucket;
  /** Fingerprinted files with a copy in exactly one other place. */
  one: CoverageBucket;
  /** Fingerprinted files with copies in two or more other places. */
  twoPlus: CoverageBucket;
  /** Not fingerprinted yet (and not cloud-only): copies are unknown. */
  notFingerprinted: CoverageBucket;
  /** OneDrive placeholders that are not on this PC: copies are unknown until they are downloaded. */
  cloudOnly: CoverageBucket;
  /**
   * Empty files (size 0). Not counted in any bucket above: a file with nothing in it is never "unprotected" and an empty file is
   * never matched as a copy of another empty file. Only the number of them is shown.
   */
  empty: CoverageBucket;
}

export interface CoverageBucket {
  files: number;
  bytes: number;
}

/** One other place and path that holds the same content as a file. */
export interface FileCopy {
  fileId: number;
  placeId: string;
  placeLabel: string;
  placeKind: string;
  relPath: string;
  size: number | null;
  /** How the match was made. */
  match: 'sha256' | 'md5+size';
  /** True for an OneDrive placeholder that has a fingerprint from earlier but is not on this PC now. */
  cloudOnly: boolean;
}

/** What Sources shows about fingerprints for one place. */
export interface PlaceFingerprint {
  /** Live files that can be fingerprinted (not cloud-only) and how many have been. */
  fileCount: number;
  fingerprintedFiles: number;
  totalBytes: number;
  fingerprintedBytes: number;
  /** Files that could not be read; "Try again" puts them back in the queue. */
  failedFiles: number;
  state: HashingState;
  /** Bytes per second while reading, else null. */
  speedBytesPerSec: number | null;
  /** Files per second while reading, else null. */
  speedFilesPerSec: number | null;
  /** The fingerprint job that covers this place (for Pause, Resume and Stop), else null. */
  job: PlaceJobRef | null;
  /** The first reason a file could not be read, with how many files failed (for the Try again tooltip); null when none failed. */
  failedReason: string | null;
  /** Plain status line from the job (for example why it is paused), else null. */
  detail: string | null;
  /** Null while the counts are being worked out. */
  coverage: PlaceCoverage | null;
  /** When the coverage numbers were counted (epoch ms); null until the first count. They are recounted in the background. */
  countedAt: number | null;
}

export type FingerprintNowResult = { ok: true; jobId: number } | { ok: false; message: string };

export type RetryFailedResult = { ok: true; requeued: number; jobId: number | null } | { ok: false; message: string };

/** The setting values the speed limit may take (MB per second). */
/** MB per second choices; 0 is "No limit" (the cap logic treats 0 as no limit). */
export const HASH_SPEED_CHOICES: readonly number[] = [30, 60, 120, 250, 0];
export const HASH_NO_LIMIT = 0;
export const DEFAULT_HASH_MB_PER_SEC = 60;
export const MIN_HASH_MB_PER_SEC = 1;
export const MAX_HASH_MB_PER_SEC = 1000;

/** On battery power below this charge, fingerprinting waits. */
export const BATTERY_PAUSE_PERCENT = 30;
