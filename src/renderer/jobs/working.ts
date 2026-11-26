import { progressPercent, type JobRecord } from '../../shared/jobs';

export interface WorkingSummary {
  /** Jobs running or waiting for their turn (a paused job is not working). */
  count: number;
  /** What is happening now, in plain words ("Make a cloud copy: Uploading x.jpg"). */
  text: string;
  /** 0..100 of the job shown, or null when its size is not known. */
  percent: number | null;
}

/** The one line for the working indicator in the sidebar, or null when nothing is running or waiting. */
export function workingSummary(jobs: readonly JobRecord[]): WorkingSummary | null {
  const running = jobs.filter((j) => j.state === 'running');
  const waiting = jobs.filter((j) => j.state === 'queued' && !j.paused);
  const count = running.length + waiting.length;
  if (count === 0) return null;
  const shown = running[0] ?? waiting[0]!;
  const what = shown.message && shown.state === 'running' ? `${shown.title}: ${shown.message}` : shown.title;
  const more = count > 1 ? ` (and ${count - 1} more)` : '';
  return { count, text: `${what}${more}`, percent: shown.state === 'running' ? progressPercent(shown) : null };
}
