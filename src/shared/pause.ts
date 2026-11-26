/**
 * "Pause everything": one switch that holds all of Backup Hub's work. Pure data and pure functions (no Electron, no Node), so main,
 * the window and the tests use the same rules. While it is on, running jobs stop at their next safe point, queued jobs wait, and the
 * quiet upkeep of the database stops. Watching (which drives are plugged in) goes on, because it only reads.
 */

/** off, until a time (epoch ms; it ends by itself), or until the person resumes. */
export type PauseStatus = { mode: 'off' } | { mode: 'until'; until: number } | { mode: 'manual' };

/** What the person can choose. */
export type PauseChoice = 'hour' | 'tomorrow' | 'manual' | 'off';

export const PAUSE_CHOICES: readonly { id: Exclude<PauseChoice, 'off'>; label: string }[] = [
  { id: 'hour', label: '1 hour' },
  { id: 'tomorrow', label: 'Until tomorrow' },
  { id: 'manual', label: 'Until I resume' },
];

export const PAUSE_OFF: PauseStatus = { mode: 'off' };

const HOUR_MS = 3_600_000;
/** "Until tomorrow" ends at this hour (local time) the next morning. */
export const TOMORROW_HOUR = 8;

/** The state a choice makes, counted from `now` (epoch ms). */
export function pauseFromChoice(choice: PauseChoice, now: number): PauseStatus {
  switch (choice) {
    case 'hour':
      return { mode: 'until', until: now + HOUR_MS };
    case 'tomorrow': {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(TOMORROW_HOUR, 0, 0, 0);
      return { mode: 'until', until: next.getTime() };
    }
    case 'manual':
      return { mode: 'manual' };
    default:
      return PAUSE_OFF;
  }
}

/** A stored or received value as a state: anything unreadable is "off"; a timed pause whose time has passed is "off" too. */
export function normalizePause(value: unknown, now: number): PauseStatus {
  if (typeof value !== 'object' || value === null) return PAUSE_OFF;
  const v = value as { mode?: unknown; until?: unknown };
  if (v.mode === 'manual') return { mode: 'manual' };
  if (v.mode === 'until' && typeof v.until === 'number' && Number.isFinite(v.until) && v.until > now) return { mode: 'until', until: v.until };
  return PAUSE_OFF;
}

export function isPauseOn(state: PauseStatus): boolean {
  return state.mode !== 'off';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const p2 = (n: number): string => String(n).padStart(2, '0');

/** "14:30", "tomorrow 08:00" or "25 Nov 08:00": the time a timed pause ends, as the banner says it. */
export function formatPauseEnd(until: number, now: number): string {
  const end = new Date(until);
  const clock = `${p2(end.getHours())}:${p2(end.getMinutes())}`;
  const today = new Date(now);
  if (end.toDateString() === today.toDateString()) return clock;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (end.toDateString() === tomorrow.toDateString()) return `tomorrow ${clock}`;
  return `${end.getDate()} ${MONTHS[end.getMonth()]} ${clock}`;
}

/** The sentence of the banner, or null while nothing is paused. */
export function pauseBanner(state: PauseStatus, now: number): string | null {
  if (state.mode === 'off') return null;
  if (state.mode === 'manual') return 'Everything is paused until you resume';
  return `Everything is paused until ${formatPauseEnd(state.until, now)}`;
}
