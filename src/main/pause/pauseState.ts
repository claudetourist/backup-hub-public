import { isPauseOn, normalizePause, pauseFromChoice, PAUSE_OFF, type PauseChoice, type PauseStatus } from '../../shared/pause';
import type { Db } from '../db';

/**
 * "Pause everything", kept by main. The state is one row in the `settings` table (so it survives a restart; it is not one of the
 * settings the window edits), a timed pause ends by itself, and every change is passed on to whoever listens: the job queue holds or
 * releases its jobs, the upkeep scheduler stops, the window shows the banner.
 */

export const PAUSE_SETTING_KEY = 'pauseEverything';

/** Where the state is kept. */
export interface PauseStore {
  read(): string | null;
  write(value: string): void;
}

/** The `settings` row, through the app's database. */
export function settingsRowPauseStore(db: Db): PauseStore {
  return {
    read: () => (db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(PAUSE_SETTING_KEY) as string | null | undefined) ?? null,
    write: (value) => void db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PAUSE_SETTING_KEY, value),
  };
}

export interface PauseStateOptions {
  store: PauseStore;
  now?: () => number;
  /** One-shot timer; returns its cancel function. Tests pass a fake. */
  schedule?: (run: () => void, ms: number) => () => void;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** setTimeout cannot wait longer than this (about 24.8 days). */
const MAX_TIMER_MS = 2_147_000_000;

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class PauseState {
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly listeners = new Set<(status: PauseStatus) => void>();
  private cancelTimer: (() => void) | null = null;
  private current: PauseStatus = PAUSE_OFF;

  constructor(private readonly o: PauseStateOptions) {
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? defaultSchedule;
  }

  /** Read the saved state and arm the timer of a timed pause. Call once when the services start. Listeners are not told (nothing changed). */
  start(): PauseStatus {
    let raw: unknown = null;
    try {
      const text = this.o.store.read();
      raw = text === null ? null : JSON.parse(text);
    } catch (err) {
      this.o.log?.warn('pause: the saved state could not be read; starting with it off', err);
    }
    this.current = normalizePause(raw, this.now());
    this.arm();
    return this.current;
  }

  /** The state now. A timed pause whose time has passed ends here (and listeners are told). */
  get(): PauseStatus {
    this.check();
    return this.current;
  }

  isOn(): boolean {
    return isPauseOn(this.get());
  }

  /** Ends a timed pause whose time has passed. The timer calls it; so does main after the computer wakes (timers may have slept). */
  check(): void {
    if (this.current.mode === 'until' && this.current.until <= this.now()) this.change(PAUSE_OFF);
  }

  set(choice: PauseChoice): PauseStatus {
    this.change(pauseFromChoice(choice, this.now()));
    return this.current;
  }

  onChanged(listener: (status: PauseStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.listeners.clear();
  }

  private change(next: PauseStatus): void {
    const same = next.mode === this.current.mode && (next.mode !== 'until' || (this.current.mode === 'until' && this.current.until === next.until));
    this.current = next;
    try {
      this.o.store.write(JSON.stringify(next));
    } catch (err) {
      this.o.log?.warn('pause: the state could not be saved; it is kept until the app closes', err);
    }
    this.arm();
    if (same) return;
    this.o.log?.info(`pause: ${next.mode === 'off' ? 'off' : next.mode === 'manual' ? 'on until you resume' : `on until ${new Date(next.until).toISOString()}`}`);
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        this.o.log?.warn('pause: a listener threw', err);
      }
    }
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.current.mode !== 'until') return;
    const wait = Math.min(Math.max(this.current.until - this.now(), 0) + 50, MAX_TIMER_MS);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.check();
      this.arm(); // a long pause is waited for in more than one timer; a timer that fired early waits again
    }, wait);
  }
}
