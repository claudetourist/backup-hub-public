/** What a running job shows: how much, speed, time left. Pure. */
import type { JobRecord } from '../../shared/jobs';
import { formatBytes, formatCount, plural } from '../lib/format';

export interface ProgressInput {
  doneBytes?: number;
  totalBytes?: number;
  doneFiles?: number;
  totalFiles?: number;
  /** Bytes per second right now, or null when not known yet. */
  bytesPerSecond?: number | null;
  /** Files per second right now, or null when not known yet. With `bytesPerSecond` the speed line shows both. */
  filesPerSecond?: number | null;
  /**
   * Seconds since the job started. When given (with file counts), the time left counts files as well as bytes (see `secondsLeft`); a job
   * that does not pass it keeps the bytes-at-the-current-speed estimate.
   */
  elapsedSeconds?: number;
  /** A job counted in files only (a check reads files, it does not move bytes): its speed is the files a second. */
  filesOnly?: boolean;
}

/** One file costs about as much time as this many bytes (a small file on a phone: a fixed 0.4 s or so, however small). */
export const BYTES_PER_FILE_OF_WORK = 10_000_000;
/** No time left is shown before this many files are done and this many seconds have passed: the first files say nothing. */
export const ESTIMATE_MIN_FILES = 20;
export const ESTIMATE_MIN_SECONDS = 15;

/**
 * Active seconds since `startedAtMs`, as the prop of the panel: the time the job was paused (`pausedMs`, kept by main) does not count, or a
 * job paused for an hour would work out an hour of slow going and promise a time left that is far too long. Nothing when the job has not
 * started (then the old estimate is used).
 */
export const elapsedProps = (startedAtMs: number | null | undefined, nowMs: number, pausedMs: number | null | undefined = 0): { elapsedSeconds?: number } =>
  startedAtMs == null ? {} : { elapsedSeconds: Math.max(0, (nowMs - startedAtMs - Math.max(0, pausedMs ?? 0)) / 1000) };

/**
 * 0 to 100, or null when the total is not known (the bar then shows that it is working). Bytes when the byte total is known, else files:
 * the same choice and the same sum as `progressPercent` in shared/jobs.ts, which the header bar of a backup page and the sidebar use, so a job
 * shows one percentage everywhere.
 */
export function percentDone(input: ProgressInput): number | null {
  const { doneBytes, totalBytes, doneFiles, totalFiles } = input;
  if (totalBytes !== undefined && totalBytes > 0 && doneBytes !== undefined) return Math.min(100, Math.max(0, (doneBytes * 100) / totalBytes));
  if (totalFiles !== undefined && totalFiles > 0 && doneFiles !== undefined) return Math.min(100, Math.max(0, (doneFiles * 100) / totalFiles));
  return null;
}

/** The percentage as written on screen: whole, rounded down (a job is never shown as 100% before it is done). Every place uses this one. */
export const wholePercent = (percent: number): number => Math.floor(percent);

/**
 * What a job record gives the progress panel: bytes (with the files as text next to them) when the job reports a byte total, else files only.
 * With bytes known the bar, the percentage and the speed are in bytes, exactly like the header bar of the backup page.
 */
export function progressInputOf(job: Pick<JobRecord, 'bytesDone' | 'bytesTotal' | 'progressDone' | 'progressTotal' | 'speed' | 'startedAt' | 'pausedMs'>, nowMs: number): ProgressInput {
  const files = { doneFiles: job.progressDone, totalFiles: job.progressTotal };
  const clock = elapsedProps(job.startedAt, nowMs, job.pausedMs);
  if (job.bytesTotal > 0) {
    return { ...files, doneBytes: job.bytesDone, totalBytes: job.bytesTotal, bytesPerSecond: job.speed?.unit === 'bytes' ? job.speed.perSecond : null, filesPerSecond: job.speed?.unit === 'bytes' ? (job.speed.itemsPerSecond ?? null) : null, ...clock };
  }
  return { ...files, filesPerSecond: job.speed?.unit === 'items' ? job.speed.perSecond : null, filesOnly: true, ...clock };
}

/**
 * Seconds left, or null when it cannot be told yet.
 * With `elapsedSeconds` and file counts: work = files + bytes / 10 MB (a file costs about as much as 10 MB), time left = elapsed / work
 * done x work left, shown only after `ESTIMATE_MIN_FILES` files and `ESTIMATE_MIN_SECONDS` seconds. (Bytes alone said "17 h 50 min" for a copy of many small
 * files that took 3 hours: the phone costs about 0.4 s per file whatever its size.) Without them: bytes left at the current speed, as before.
 */
export function secondsLeft(input: ProgressInput): number | null {
  const { doneBytes, totalBytes, doneFiles, totalFiles, elapsedSeconds, bytesPerSecond } = input;
  if (elapsedSeconds !== undefined && doneFiles !== undefined && totalFiles !== undefined) {
    if (doneFiles < ESTIMATE_MIN_FILES || elapsedSeconds < ESTIMATE_MIN_SECONDS) return null;
    const useBytes = doneBytes !== undefined && totalBytes !== undefined;
    const done = doneFiles + (useBytes ? doneBytes / BYTES_PER_FILE_OF_WORK : 0);
    const total = totalFiles + (useBytes ? totalBytes / BYTES_PER_FILE_OF_WORK : 0);
    if (done <= 0) return null;
    return Math.max(0, Math.ceil((elapsedSeconds / done) * Math.max(0, total - done)));
  }
  if (totalBytes === undefined || doneBytes === undefined || !bytesPerSecond || bytesPerSecond <= 0) return null;
  return Math.max(0, Math.ceil((totalBytes - doneBytes) / bytesPerSecond));
}

/** 45 -> "about 45 seconds left"; 600 -> "about 10 minutes left"; 5400 -> "about 1 h 30 min left". */
export function timeLeftText(seconds: number | null): string {
  if (seconds === null) return 'Working out the time left';
  if (seconds < 5) return 'Almost done';
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} ${plural(minutes, 'minute', 'minutes')} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h left` : `about ${hours} h ${rest} min left`;
}

export function speedText(bytesPerSecond: number | null | undefined): string {
  return bytesPerSecond && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : 'Speed not known yet';
}

/** Files a second in words: "3 files a second", "1 file a second", "0.5 files a second". */
export function filesPerSecondText(filesPerSecond: number): string {
  const n = filesPerSecond >= 2 ? Math.round(filesPerSecond) : Math.round(filesPerSecond * 10) / 10;
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'} a second`;
}

/** The speed line: "3 files a second, 12 MB/s" when both are known, else the bytes speed alone (as before). */
export function speedLine(input: Pick<ProgressInput, 'bytesPerSecond' | 'filesPerSecond' | 'filesOnly'>): string {
  const { bytesPerSecond, filesPerSecond, filesOnly } = input;
  if (bytesPerSecond && bytesPerSecond > 0 && filesPerSecond && filesPerSecond > 0) return `${filesPerSecondText(filesPerSecond)}, ${formatBytes(bytesPerSecond)}/s`;
  if (filesOnly && filesPerSecond && filesPerSecond > 0) return filesPerSecondText(filesPerSecond);
  return speedText(bytesPerSecond);
}

/** "12.4 of 46.5 GB" or, with no byte totals, "312 of 1,240 files". */
export function amountText(input: ProgressInput): string {
  const { doneBytes, totalBytes, doneFiles, totalFiles } = input;
  if (totalBytes !== undefined && totalBytes > 0 && doneBytes !== undefined) return `${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}`;
  if (totalFiles !== undefined && doneFiles !== undefined) return `${formatCount(doneFiles)} of ${formatCount(totalFiles)} ${plural(totalFiles, 'file', 'files')}`;
  return 'Working';
}

/** "247 of 419 files" as plain text next to a bar that counts bytes (null when the bar counts files, which already say it, or the files are not known). */
export function filesAlongside(input: ProgressInput): string | null {
  const { totalBytes, doneBytes, doneFiles, totalFiles } = input;
  if (!(totalBytes !== undefined && totalBytes > 0 && doneBytes !== undefined)) return null;
  if (totalFiles === undefined || totalFiles <= 0 || doneFiles === undefined) return null;
  return `${formatCount(doneFiles)} of ${formatCount(totalFiles)} ${plural(totalFiles, 'file', 'files')}`;
}
