/** Pure status vocabulary: job states, copy counts and tones. No React, so it is unit-testable. */

import { JOB_STATES, type JobState } from '../../shared/jobs';

/** The only six job states (PLAN section 6); defined in shared/jobs.ts so main and renderer agree. */
export { JOB_STATES, type JobState };

/** Tones map to the --status-* token families (plus neutral). */
export type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'amber' | 'info';

export const TONES: readonly Tone[] = ['neutral', 'ok', 'warn', 'crit', 'amber', 'info'];

const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_you: 'Needs you',
  done: 'Done',
  done_warnings: 'Done with warnings',
  failed: 'Failed',
};

const JOB_STATE_TONES: Record<JobState, Tone> = {
  queued: 'neutral',
  running: 'info',
  needs_you: 'warn',
  done: 'ok',
  done_warnings: 'amber',
  failed: 'crit',
};

export function jobStateLabel(state: JobState): string {
  return JOB_STATE_LABELS[state];
}

export function jobStateTone(state: JobState): Tone {
  return JOB_STATE_TONES[state];
}

/** Copy counts the user sees: how many verified backups a file has beyond its original. */
export function copyCountLabel(backups: number): string {
  if (!Number.isFinite(backups) || backups <= 0) return 'No backup';
  return backups === 1 ? '1 backup' : `${backups} backups`;
}

export function copyCountTone(backups: number): Tone {
  if (!Number.isFinite(backups) || backups <= 0) return 'crit';
  return backups < 2 ? 'warn' : 'ok';
}
