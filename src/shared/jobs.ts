/**
 * Job types shared by main, preload and renderer. Pure data and pure functions only (no Electron,
 * no Node), so the renderer can import it too.
 */

/** The only six job states (PLAN section 6). */
export type JobState = 'queued' | 'running' | 'needs_you' | 'done' | 'done_warnings' | 'failed';

export const JOB_STATES: readonly JobState[] = ['queued', 'running', 'needs_you', 'done', 'done_warnings', 'failed'];

export const FINISHED_STATES: readonly JobState[] = ['done', 'done_warnings', 'failed'];

export function isFinished(state: JobState): boolean {
  return FINISHED_STATES.includes(state);
}

/**
 * What kind of end a failed job had. It is stored in front of the plain error text as "[code] text" (the jobs table
 * has no column for it, and its states are fixed), and the mapper in jobExplain.ts reads it back.
 */
export type JobErrorCode =
  | 'stopped-by-you'
  | 'stopped-by-app'
  | 'interrupted'
  | 'refused'
  | 'network'
  | 'google'
  | 'disk-full'
  | 'access'
  | 'drive-gone'
  | 'busy'
  | 'unexpected'
  | 'failed';

const ERROR_CODES: ReadonlySet<string> = new Set(['stopped-by-you', 'stopped-by-app', 'interrupted', 'refused', 'network', 'google', 'disk-full', 'access', 'drive-gone', 'busy', 'unexpected', 'failed']);

/** The text stored as a job's error: "[code] plain words". */
export function withErrorCode(code: JobErrorCode, text: string): string {
  return `[${code}] ${text}`;
}

/** Splits a stored error into its code (null for text without one) and the plain words. */
export function parseJobError(error: string | null): { code: JobErrorCode | null; text: string } {
  if (error === null) return { code: null, text: '' };
  const match = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(error);
  if (match && ERROR_CODES.has(match[1]!)) return { code: match[1] as JobErrorCode, text: match[2]! };
  return { code: null, text: error };
}

/** Stored as the message of a job that was still waiting in the queue (never started) when the app closed. Like an interrupted one, it starts only when the person presses Continue. */
export const NOT_STARTED_MESSAGE = 'Was waiting to start when the app closed';
/** Stored as the error when the person pressed Stop. "By you" is only ever written for a click in the window. */
export const CANCELLED_MESSAGE = withErrorCode('stopped-by-you', 'Stopped by you');
/** Stored when Backup Hub itself stopped a job, with the reason (for example "it was using the drive you ejected"). */
export function stoppedByApp(reason: string): string {
  return withErrorCode('stopped-by-app', `Stopped by Backup Hub: ${reason}`);
}
/** Text stored when the app closed while a job could not be resumed. */
export const INTERRUPTED_MESSAGE = withErrorCode('interrupted', 'Interrupted when the app closed');
/** Stored as the message of an interrupted job the person dismissed: it is seen, and Continue is no longer offered. The checkpoint is kept. */
export const DISMISSED_MESSAGE = 'Dismissed';
/**
 * Job kinds the app runs by itself for upkeep. The Jobs screen and Home hide them while they are quietly done.
 * 'files.classify' is no longer created (the sorting is done by the upkeep process, which is not a job); it stays here so old history rows stay quiet.
 */
export const SYSTEM_JOB_KINDS: readonly string[] = ['settings.saveToDrive', 'db.snapshot', 'db.integrityCheck', 'files.classify', 'list.lookAgain'];

/** True for the app's own upkeep jobs (settings copy, database snapshot and check, sorting files by kind). */
export function isSystemJob(kind: string): boolean {
  return SYSTEM_JOB_KINDS.includes(kind);
}

/** Status line of a job the user paused. */
export const PAUSED_MESSAGE = 'Paused. Nothing is lost; choose Resume to continue.';
/** Shown while a running job winds down to its safe point after Pause (it finishes the file it is on, saves its place, then holds). */
export const PAUSING_MESSAGE = 'Pausing: saving your place…';
/** Shown once a paused job is held with its place saved: closing the app now loses nothing. */
export const PAUSED_SAFE_MESSAGE = 'Paused — safe to close the app';
/** What the window says about a paused job: "Pausing: saving your place…" until it is at its safe point, then "Paused — safe to close the app"; null when it is not paused. */
export function pauseWords(job: Pick<JobRecord, 'paused'> & { pausing?: boolean | undefined }): string | null {
  if (!job.paused) return null;
  return job.pausing === true ? PAUSING_MESSAGE : PAUSED_SAFE_MESSAGE;
}

/** Status line of a job that "Pause everything" paused; the app lets go of exactly these when the pause ends. */
export const PAUSED_ALL_MESSAGE = 'Paused with everything. It continues when you resume.';
/** Status line of a resumed job waiting for the one heavy slot. */
export const WAITING_TURN_MESSAGE = 'Waiting for another job to finish';
/** Event text written when the laptop sleeps while a job is running. */
export const SLEPT_MESSAGE = 'Paused while the laptop slept';

export type JobEventLevel = 'debug' | 'info' | 'warn' | 'error';

/** What speed is measured in: bytes per second when the job knows byte totals, else items. */
export interface JobSpeed {
  unit: 'bytes' | 'items';
  perSecond: number;
  /** Items (files) per second, measured next to the bytes; null when not known. Many small files: this is the number that matters. */
  itemsPerSecond?: number | null;
}

/** A job as a place shows it: enough to offer Pause, Resume and Stop. */
export interface PlaceJobRef {
  id: number;
  paused: boolean;
}

/** A job as the renderer sees it. Timestamps are epoch ms. */
export interface JobRecord {
  id: number;
  kind: string;
  title: string;
  state: JobState;
  progressDone: number;
  progressTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Latest status line, or the question while the job needs you. */
  message: string | null;
  warnings: string[];
  /** Plain-language reason a job failed. Technical detail is in the job's events. */
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** True when a checkpoint exists, so the job can continue after a restart. */
  hasCheckpoint: boolean;
  /** Live only (running jobs): measured over the last few seconds, otherwise null. */
  speed: JobSpeed | null;
  /** Live only: whole seconds left at the current speed, otherwise null. */
  etaSeconds: number | null;
  /** True while the user has paused the job (its state stays queued; it waits for Resume). */
  paused: boolean;
  /** Live only: true from Pause until the running job has reached its safe point (finished its file, saved its place). Then `paused` alone means "safe to close the app". Missing = false. */
  pausing?: boolean;
  /** While needs_you: answers to offer as buttons (empty = a single "Continue" answer). */
  choices: string[];
  /** The newest job that retried this one (null when none). A retried failure is settled: its result is the retry's. */
  retriedBy?: number | null;
  /** Live only: milliseconds this job spent paused (or waiting for its turn after a pause) since it started; the time left is worked out from the rest. Missing = none. */
  pausedMs?: number;
  /** Whose job it is (the owner of the backup, phone or Google account it works on); null when it is shared (a drive, the laptop) or not known. Missing in old rows. */
  personId?: number | null;
  /** The backups this job works on (a second-copy job over all backups names each one); absent when it is not a backup's job or in old rows. The Backups pages show a job on every backup it names. */
  backupIds?: number[];
  /** Plain line: who started it and why ("Started by itself: T7 was plugged in, last copy 8 days ago"). Null for older jobs. */
  startedBy?: string | null;
}

export interface JobEvent {
  id: number;
  jobId: number;
  at: number;
  level: JobEventLevel;
  text: string;
}

export interface JobListFilter {
  /** Only these states. Omit for all. */
  states?: JobState[];
  /** Newest first, default 200, max 1000. */
  limit?: number;
}

export type JobChangeReason = 'created' | 'state' | 'progress' | 'log';

/** One event per state or progress change. Progress and log events are throttled to 4/s per job. */
export interface JobChangedEvent {
  reason: JobChangeReason;
  job: JobRecord;
}

/** Options for the dev-only demo job. */
export interface DemoJobOptions {
  steps?: number;
  stepMs?: number;
  /** ok = count to the end; warn = finish with a warning; fail = throw halfway; ask = needs_you halfway. */
  mode?: 'ok' | 'warn' | 'fail' | 'ask';
  heavy?: boolean;
  /** Report byte progress (bytes per step) so speed shows MB/s. */
  bytesPerStep?: number;
}

/** A job that was stopped on purpose, by you or by Backup Hub (with a reason): it ends as failed with a stop code. */
export function isCancelled(job: Pick<JobRecord, 'state' | 'error'>): boolean {
  const code = job.state === 'failed' ? parseJobError(job.error).code : null;
  return code === 'stopped-by-you' || code === 'stopped-by-app';
}

/**
 * True when a system job is only noise: it finished without trouble (done) or was stopped. A system job that is
 * failed, running, waiting, needs you or done with warnings stays visible, and so does every other job.
 */
export function isQuietSystemJob(job: Pick<JobRecord, 'kind' | 'state' | 'error'>): boolean {
  return isSystemJob(job.kind) && (job.state === 'done' || isCancelled(job));
}

/**
 * An interrupted job (the app closed while it ran, or while it still waited in the queue) that kept a checkpoint (or never started) and that nobody has dismissed or started again: the person
 * can Continue it. Nothing continues by itself.
 */
export function isContinuable(job: Pick<JobRecord, 'state' | 'error'> & Partial<Pick<JobRecord, 'hasCheckpoint' | 'message' | 'retriedBy'>>): boolean {
  return job.state === 'failed' && parseJobError(job.error).code === 'interrupted' && (job.hasCheckpoint === true || job.message === NOT_STARTED_MESSAGE) && job.message !== DISMISSED_MESSAGE && job.retriedBy == null;
}

/** A job that really failed: state failed, and not stopped on purpose (by you or the app) and not interrupted by the app closing. */
export function isRealFailure(job: Pick<JobRecord, 'state' | 'error'>): boolean {
  if (job.state !== 'failed') return false;
  const { code } = parseJobError(job.error);
  return code !== 'stopped-by-you' && code !== 'stopped-by-app' && code !== 'interrupted';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rail badge: jobs that need you now, jobs that really failed in the last 24 hours (a stop or an interruption is not a failure) and interrupted jobs waiting for Continue or Dismiss. */
export function attentionCount(jobs: readonly (Pick<JobRecord, 'state' | 'finishedAt' | 'error'> & Partial<Pick<JobRecord, 'hasCheckpoint' | 'message' | 'retriedBy'>>)[], now: number): number {
  let count = 0;
  for (const job of jobs) {
    if (job.state === 'needs_you' || isContinuable(job)) count += 1;
    else if (isRealFailure(job) && job.finishedAt !== null && now - job.finishedAt <= DAY_MS) count += 1;
  }
  return count;
}

// ---- Speed and time left -------------------------------------------------------------------

/** One reading of cumulative progress: `done` is bytes (or items) finished at time `at` (ms). */
export interface RateSample {
  at: number;
  done: number;
}

export const SPEED_WINDOW_MS = 10_000;
/** A speed from less than this much elapsed time is too noisy to show. */
export const SPEED_MIN_SPAN_MS = 1_000;

/**
 * Units per second over a sliding window ending at `now`: oldest sample inside the window versus
 * the newest. Null when there are fewer than two samples, they span under a second, or nothing
 * moved. Samples must be in time order.
 */
export function computeSpeed(samples: readonly RateSample[], now: number, windowMs: number = SPEED_WINDOW_MS): number | null {
  const inWindow = samples.filter((s) => s.at >= now - windowMs && s.at <= now);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!first || !last) return null;
  const span = last.at - first.at;
  if (span < SPEED_MIN_SPAN_MS) return null;
  const moved = last.done - first.done;
  if (moved <= 0) return null;
  return (moved / span) * 1000;
}

/** Whole seconds left, or null if unknown (no total, no speed, or already finished). */
export function computeEtaSeconds(done: number, total: number, perSecond: number | null): number | null {
  if (perSecond === null || perSecond <= 0 || total <= 0 || done >= total) return null;
  return Math.ceil((total - done) / perSecond);
}

/** Bytes win when the job reports byte totals; otherwise items. Null when the job has no totals. */
export function pickMeasure(job: Pick<JobRecord, 'bytesDone' | 'bytesTotal' | 'progressDone' | 'progressTotal'>): {
  unit: 'bytes' | 'items';
  done: number;
  total: number;
} | null {
  if (job.bytesTotal > 0) return { unit: 'bytes', done: job.bytesDone, total: job.bytesTotal };
  if (job.progressTotal > 0) return { unit: 'items', done: job.progressDone, total: job.progressTotal };
  return null;
}

/** 0..100 or null when the amount of work is unknown. */
export function progressPercent(job: Pick<JobRecord, 'bytesDone' | 'bytesTotal' | 'progressDone' | 'progressTotal'>): number | null {
  const measure = pickMeasure(job);
  if (!measure) return null;
  return Math.max(0, Math.min(100, (measure.done * 100) / measure.total));
}
