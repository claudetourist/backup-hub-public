import { isRealFailure, parseJobError, type JobChangedEvent } from '../../shared/jobs';

/** Turn Windows toasts for jobs on or off. A real setting comes with F5; for now it is a constant. */
export const NOTIFICATIONS_ENABLED = true;

export interface Toast {
  title: string;
  body: string;
}

/** What to tell the user about a job event, or null for no toast: only failed (a real failure), finished with warnings, and needs you. Pure so it can be tested. */
export function toastFor(event: JobChangedEvent): Toast | null {
  if (event.reason !== 'state') return null;
  const { job } = event;
  switch (job.state) {
    case 'needs_you':
      return { title: `${job.title} needs you`, body: job.message ?? 'Open Jobs to answer.' };
    case 'done_warnings':
      return {
        title: `${job.title} finished with warnings`,
        body: job.warnings[0] ?? job.message ?? 'Open Jobs to see what to look at.',
      };
    case 'failed':
      // Stopped on purpose or interrupted by closing the app: no alarm.
      if (!isRealFailure(job)) return null;
      return { title: `${job.title} failed`, body: parseJobError(job.error).text || 'Open Jobs for details.' };
    default:
      // A clean success is one line in Activity and no toast ("quiet unless something is wrong").
      return null;
  }
}
