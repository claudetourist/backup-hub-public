import { plural } from './lib/format';
import type { StartupStatus } from '../shared/startup';

/** What Home (and every screen) says while the data is not ready. Pure: the words and the bar for one start-up status. */
export interface StartupView {
  title: string;
  /** One or two plain sentences. */
  detail: string;
  /** 0 to 100, or null when nobody can honestly say how far it is (the bar then just shows it is working). */
  percent: number | null;
  /** "42 seconds so far", or '' when the phase just started. */
  progressText: string;
}

/** How long a guess of the wait is said to be: "a few seconds", "about a minute", "about 3 minutes". */
export function waitText(ms: number): string {
  if (ms < 15_000) return 'a few seconds';
  if (ms < 45_000) return 'about half a minute';
  if (ms < 90_000) return 'about a minute';
  const minutes = Math.round(ms / 60_000);
  return `about ${minutes} ${plural(minutes, 'minute', 'minutes')}`;
}

/** 42000 -> "42 seconds"; 65000 -> "1 minute 5 seconds". */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} ${plural(total, 'second', 'seconds')}`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} ${plural(minutes, 'minute', 'minutes')} ${seconds} ${plural(seconds, 'second', 'seconds')}`;
}

/** The bar never says "done" before the work is: it stops at 95 until the window gets the data. */
const BAR_CEILING = 95;

export function startupView(status: StartupStatus | null): StartupView {
  if (status === null || status.phase === 'opening') {
    return { title: 'Opening your data…', detail: '', percent: null, progressText: '' };
  }
  const progressText = status.elapsedMs >= 1000 ? `${elapsedText(status.elapsedMs)} so far` : '';
  if (status.phase === 'updating') {
    return {
      title: 'Updating your data',
      detail: 'Backup Hub is getting your data ready for this version. This happens once and can take a minute or two. Your files are not touched.',
      percent: null,
      progressText,
    };
  }
  const estimate = status.estimateMs;
  const late = estimate !== null && status.elapsedMs > estimate * 1.25;
  return {
    title: 'Checking your data',
    detail:
      (estimate === null ? 'This can take a minute. ' : `This can take ${waitText(estimate)}. `) +
      'Backup Hub makes sure your data is in good shape before it opens, because it was not closed properly last time or has not been checked for a week. Nothing is being changed.' +
      (late ? ' A big collection can take a little longer. It is still working.' : ''),
    percent: estimate === null ? null : Math.min(BAR_CEILING, Math.max(0, (status.elapsedMs / estimate) * 100)),
    progressText,
  };
}
