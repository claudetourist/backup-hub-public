/**
 * What the start-up is doing while the data is not ready, as the window shows it on Home (and every other screen).
 * 'checking' = the safety check of the database file (only when there is a reason to doubt the file: a crash, or no full
 * check for a week); 'updating' = the data is being brought up to this version of the app; 'opening' = anything else.
 */
export type StartupPhase = 'opening' | 'checking' | 'updating';

export interface StartupStatus {
  phase: StartupPhase;
  /** How long this phase has been running (ms). */
  elapsedMs: number;
  /** A guess of how long the phase takes (ms), or null when there is no honest guess (then the bar just moves). */
  estimateMs: number | null;
}

/**
 * quick_check read the real 1.5 GB database in about 40 s: roughly 35 MB a second. The guess uses a slower rate so that a
 * slow disk is not shown as "almost done" for long.
 */
export const CHECK_BYTES_PER_SECOND = 30 * 1024 * 1024;

/** A guess of how long the start-up safety check of a database file of this size takes (ms). */
export function estimateCheckMs(bytes: number): number {
  return Math.max(2000, Math.round((bytes / CHECK_BYTES_PER_SECOND) * 1000));
}
