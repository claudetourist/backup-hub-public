import { explainJob, type ExplainContext, type JobExplanation } from '../../shared/jobExplain';
import { isRealFailure, isQuietSystemJob, parseJobError, pauseWords, progressPercent, type JobRecord, type JobSpeed, type JobState } from '../../shared/jobs';
import type { Tone } from '../components/status';
import { wholePercent } from '../components/progressModel';
import { formatBytes, plural } from '../lib/format';

/** Pure helpers behind the Jobs screen, the Home "Recent jobs" panel and the rail badge. */

export type JobFilterId = 'all' | 'running' | 'needs_you' | 'failed' | 'finished';

export interface JobFilterDef {
  id: JobFilterId;
  label: string;
  matches: (job: JobRecord) => boolean;
}

/** The quick filter chips of the Activity screen. A job you stopped, or that the app closing interrupted, is Finished, not Failed. */
export const JOB_FILTERS: readonly JobFilterDef[] = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'running', label: 'Running', matches: (job) => job.state === 'running' || job.state === 'queued' },
  { id: 'needs_you', label: 'Needs you', matches: (job) => job.state === 'needs_you' },
  { id: 'failed', label: 'Failed', matches: (job) => isRealFailure(job) },
  { id: 'finished', label: 'Finished', matches: (job) => job.state === 'done' || job.state === 'done_warnings' || (job.state === 'failed' && !isRealFailure(job)) },
];

export function filterJobs(jobs: readonly JobRecord[], filter: JobFilterId): JobRecord[] {
  const def = JOB_FILTERS.find((f) => f.id === filter);
  return def ? jobs.filter(def.matches) : [...jobs];
}

export function countByFilter(jobs: readonly JobRecord[]): Record<JobFilterId, number> {
  const counts = {} as Record<JobFilterId, number>;
  for (const def of JOB_FILTERS) counts[def.id] = jobs.filter(def.matches).length;
  return counts;
}

/** The Activity screen shows the last 7 days (and anything running or waiting); older work sits behind "Show older". */
export const RECENT_DAYS = 7;

/** Jobs from the last 7 days or still going, and the older ones. Order is kept. */
export function splitRecent(jobs: readonly JobRecord[], now: number): { recent: JobRecord[]; older: JobRecord[] } {
  const cutoff = now - RECENT_DAYS * 86_400_000;
  const recent: JobRecord[] = [];
  const older: JobRecord[] = [];
  for (const job of jobs) {
    const live = job.state === 'queued' || job.state === 'running' || job.state === 'needs_you';
    (live || (job.finishedAt ?? job.startedAt ?? job.createdAt) >= cutoff ? recent : older).push(job);
  }
  return { recent, older };
}

/** The newest run of the same kind that finished after this job (done or with warnings), for the "a newer one finished" rule. */
export function explainContext(job: JobRecord, jobs: readonly JobRecord[]): ExplainContext {
  let newest: JobRecord | null = null;
  for (const other of jobs) {
    if (other.kind !== job.kind || other.id <= job.id || (other.state !== 'done' && other.state !== 'done_warnings')) continue;
    if (newest === null || other.id > newest.id) newest = other;
  }
  return { newerFinished: newest ? { id: newest.id, finishedAt: newest.finishedAt } : null };
}

/** What the Activity screen says about one job (the shared mapper plus this list's context). */
export function explainInList(job: JobRecord, jobs: readonly JobRecord[]): JobExplanation {
  return explainJob(job, job.state === 'failed' ? explainContext(job, jobs) : {});
}

/**
 * The jobs the Jobs screen and Home list: the app's own upkeep jobs are left out while they are quietly done or stopped
 * (see isQuietSystemJob), unless `showSystem` is on.
 */
export function visibleJobs(jobs: readonly JobRecord[], showSystem: boolean): JobRecord[] {
  return showSystem ? [...jobs] : jobs.filter((job) => !isQuietSystemJob(job));
}

/** True when any of these rows is running or waiting (or needs you), so Progress, Speed and Time left have something to say. */
export function showLiveColumns(rows: readonly Pick<JobRecord, 'state'>[]): boolean {
  return rows.some((job) => job.state === 'queued' || job.state === 'running' || job.state === 'needs_you');
}

export const MAX_JOBS_KEPT = 300;

/** Apply one pushed job to the list: replace by id or add; newest id first. */
export function mergeJob(jobs: readonly JobRecord[], job: JobRecord): JobRecord[] {
  const index = jobs.findIndex((j) => j.id === job.id);
  if (index >= 0) {
    const next = [...jobs];
    next[index] = job;
    return next;
  }
  return [job, ...jobs].toSorted((a, b) => b.id - a.id).slice(0, MAX_JOBS_KEPT);
}

/**
 * Replace the list with a fresh one from main, keeping any job that was pushed meanwhile and is
 * not in the fresh list (it was created after the list was read).
 */
export function mergeFresh(fresh: readonly JobRecord[], pushed: readonly JobRecord[]): JobRecord[] {
  const known = new Set(fresh.map((j) => j.id));
  const extra = pushed.filter((j) => !known.has(j.id));
  return [...extra, ...fresh].toSorted((a, b) => b.id - a.id).slice(0, MAX_JOBS_KEPT);
}

/** Which job to show details for when the user has not picked one: needs you, then failed, running, newest. */
export function defaultSelection(jobs: readonly JobRecord[]): number | null {
  const pick = (state: JobState) => jobs.find((j) => j.state === state);
  return (pick('needs_you') ?? pick('failed') ?? pick('running') ?? jobs[0])?.id ?? null;
}

// ---- Formatting ----------------------------------------------------------------------------

/** 8.4 MB/s or 12 items/s. */
export function formatSpeed(speed: JobSpeed | null): string {
  if (!speed || !Number.isFinite(speed.perSecond) || speed.perSecond <= 0) return '';
  if (speed.unit === 'bytes') {
    const items = speed.itemsPerSecond ?? 0;
    const itemsText = items > 0 ? ` · ${items >= 10 ? Math.round(items) : items.toFixed(1)} items/s` : '';
    return `${formatBytes(speed.perSecond)}/s${itemsText}`;
  }
  const n = speed.perSecond;
  const text = n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, '');
  return `${text} ${n === 1 ? 'item' : 'items'}/s`;
}

/** 45 -> "45 s left", 200 -> "4 min left", 5400 -> "1 h 30 min left". */
export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h left` : `${h} h ${String(m).padStart(2, '0')} min left`;
}

/** How long a job took: "12 s", "3 min 05 s", "2 h 10 min". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m} min ${String(s).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

function dayNumber(d: Date): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

/** "10:42" today, "Yesterday 10:42", else "29 Oct 10:42" (local time). Empty for null. */
export function formatWhen(ms: number | null, now: number): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = dayNumber(new Date(now)) - dayNumber(d);
  if (diff === 0) return time;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/** "Today 14:05", "Yesterday 14:05", "31 Oct 14:05", "31 Oct 2025 14:05" for another year. Empty for null. */
export function formatDateTime(ms: number | null, now: number): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = dayNumber(new Date(now)) - dayNumber(d);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${time}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "Saturday 31 October 2026, 14:05:07", for a tooltip. Empty for null. */
export function formatFullDateTime(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}, ${formatClock(ms)}`;
}

/** How long a job took ("2 min 10 s"); for one still going, how long so far. Empty when it has not started. */
export function formatDuration(job: Pick<JobRecord, 'startedAt' | 'finishedAt'>, now: number): string {
  if (job.startedAt === null) return '';
  const ms = Math.max(0, (job.finishedAt ?? now) - job.startedAt);
  return ms < 1000 ? 'Under 1 s' : formatElapsed(ms);
}

/** The state in plain words, with the tone of its pill: "Stopped by you" and "Interrupted" are not "Failed". */
export function jobStatus(job: Pick<JobRecord, 'state' | 'paused' | 'error'> & { retriedBy?: number | null; pausing?: boolean }): { label: string; tone: Tone } {
  switch (job.state) {
    case 'queued':
      return job.paused ? { label: job.pausing === true ? 'Pausing' : 'Paused', tone: 'amber' } : { label: 'Waiting', tone: 'neutral' };
    case 'running':
      return { label: 'Running', tone: 'info' };
    case 'needs_you':
      return { label: 'Needs you', tone: 'warn' };
    case 'done':
      return { label: 'Done', tone: 'ok' };
    case 'done_warnings':
      return { label: 'Done with warnings', tone: 'amber' };
    case 'failed':
    default: {
      const { code } = parseJobError(job.error);
      // Only an interrupted job (the app closed) is replaced by its retry; a job that really failed keeps saying Failed.
      if (job.retriedBy != null && code === 'interrupted') return { label: 'Retried', tone: 'neutral' };
      if (code === 'stopped-by-you') return { label: 'Stopped by you', tone: 'neutral' };
      if (code === 'stopped-by-app') return { label: 'Stopped by Backup Hub', tone: 'amber' };
      if (code === 'interrupted') return { label: 'Interrupted', tone: 'amber' };
      if (code === 'refused') return { label: 'Not started', tone: 'amber' };
      return { label: 'Failed', tone: 'crit' };
    }
  }
}

/** The one line a row shows: what it is doing, or what happened, in plain words (with the percentage while it runs). */
export function jobRowLine(job: JobRecord, jobs: readonly JobRecord[]): string {
  const line = explainInList(job, jobs).headline;
  const percent = job.state === 'running' ? progressPercent(job) : null;
  return percent === null ? line : `${line} · ${wholePercent(percent)}%`;
}

/** Stable React keys for a list of strings that may repeat: "text", "text#2", ... */
export function keyedLines(lines: readonly string[]): { key: string; text: string }[] {
  const seen = new Map<string, number>();
  return lines.map((text) => {
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return { key: n === 1 ? text : `${text}#${n}`, text };
  });
}

/** 10:42:07 (local time, for log lines). */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "12 of 60", "420 MB of 25.2 GB", or "" when the job has no totals. */
export function formatProgressText(job: JobRecord): string {
  if (job.bytesTotal > 0) return `${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)}`;
  if (job.progressTotal > 0) return `${job.progressDone} of ${job.progressTotal}`;
  return '';
}

/** One plain line under a job's title. */
export function jobDetail(job: JobRecord, now: number): string {
  switch (job.state) {
    case 'queued':
      return job.paused ? (pauseWords(job) ?? 'Paused') : (job.message ?? 'Waiting for its turn');
    case 'running':
      return job.message ?? 'Working';
    case 'needs_you':
      return job.message ?? 'Waiting for your answer';
    case 'done':
      return job.message ?? 'Finished';
    case 'done_warnings': {
      const n = job.warnings.length;
      const base = job.message ?? 'Finished';
      return n > 0 ? `${base} · ${n} ${plural(n, 'warning', 'warnings')}` : base;
    }
    case 'failed':
      return parseJobError(job.error).text || 'Stopped';
    default:
      return formatWhen(job.finishedAt, now);
  }
}

/** Home "Recent jobs" line: the detail plus when it ended (or started). */
export function recentJobDetail(job: JobRecord, now: number): string {
  const detail = jobDetail(job, now);
  const when = formatWhen(job.finishedAt ?? job.startedAt ?? job.createdAt, now);
  return when ? `${detail} · ${when}` : detail;
}
