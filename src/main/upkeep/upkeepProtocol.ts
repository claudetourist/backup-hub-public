import type { UpkeepSummary } from './upkeepWork';

/** Messages between the main process and the upkeep process (plain data only). */

/** Main to the process. */
export type UpkeepCommand =
  /** Open the database file and begin. */
  | { type: 'start'; dbFile: string }
  /** Finish the chunk in hand, then close and exit (main sends this within a second of anything that ends the conditions). */
  | { type: 'stop' };

/** The process to main. */
export type UpkeepReport =
  | { type: 'finished'; summary: UpkeepSummary }
  /** Something failed; the process exits after sending it. Goes to the app log only. */
  | { type: 'failed'; message: string };
