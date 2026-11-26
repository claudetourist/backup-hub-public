import type { Shutdown } from './shutdown';

/**
 * What starts the shutdown routine, written against small interfaces so each trigger is tested with a fake. main.ts passes the real
 * `process`, `app` and window. Nothing here knows about Electron.
 */

export interface Log {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---- errors that must not end the app -----------------------------------------------------------

const HARMLESS_CODES = new Set([
  'EPIPE', // a helper's input closed before we finished writing
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_IPC_CHANNEL_CLOSED',
  'ABORT_ERR',
]);

/**
 * Errors that are an everyday part of talking to a helper, a network or a window that just closed. They are logged and the app goes on.
 * Everything else that nobody caught ends the app the tidy way (the shutdown routine), because the app's state may no longer be sound.
 */
export function isKnownHarmless(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string' && HARMLESS_CODES.has(e.code)) return true;
  if (e.name === 'AbortError' || e.name === 'JobAborted') return true;
  return typeof e.message === 'string' && /^Object has been destroyed$/.test(e.message);
}

// ---- process-level triggers ---------------------------------------------------------------------

/** The bits of Node's `process` used here. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

/** uncaughtException, unhandledRejection and the terminal signals. Returns a function that removes them again. */
export function installProcessTriggers(options: { proc: ProcessLike; shutdown: Shutdown; log: Log; isHarmless?: (err: unknown) => boolean }): () => void {
  const { proc, shutdown, log } = options;
  const harmless = options.isHarmless ?? isKnownHarmless;
  const handlers: [string, (...args: unknown[]) => void][] = [
    [
      'uncaughtException',
      (err) => {
        if (harmless(err)) {
          log.warn('[uncaughtException, harmless]', err);
          return;
        }
        log.error('[uncaughtException]', err);
        void shutdown.run('uncaughtException', { exitCode: 1 });
      },
    ],
    [
      'unhandledRejection',
      (reason) => {
        if (harmless(reason)) {
          log.warn('[unhandledRejection, harmless]', reason);
          return;
        }
        log.error('[unhandledRejection]', reason);
        void shutdown.run('unhandledRejection', { exitCode: 1 });
      },
    ],
    ...SIGNALS.map((signal): [string, (...args: unknown[]) => void] => [signal, () => void shutdown.run(signal, { exitCode: 0 })]),
  ];
  for (const [event, listener] of handlers) proc.on(event, listener);
  return () => {
    for (const [event, listener] of handlers) proc.removeListener(event, listener);
  };
}

// ---- a renderer or GPU process that is gone -----------------------------------------------------

export type GoneDecision = 'ignore' | 'reload' | 'shutdown';

/** Crashes inside this window count together. */
export const GONE_WINDOW_MS = 60_000;
/** This many crashes inside the window mean the app cannot carry on. */
export const GONE_MAX_CRASHES = 3;

/**
 * What to do when the window's page process or the GPU process ends. A clean exit needs nothing. A start that failed outright, or an
 * integrity failure, cannot be fixed by trying again: shut down. Other endings: the page is loaded again (a GPU process restarts by
 * itself), but the third crash within a minute ends the app the tidy way instead of looping.
 */
export function createGoneDecider(now: () => number = Date.now): (kind: 'renderer' | 'gpu', reason: string) => GoneDecision {
  const crashes: Record<'renderer' | 'gpu', number[]> = { renderer: [], gpu: [] };
  return (kind, reason) => {
    if (reason === 'clean-exit') return 'ignore';
    if (reason === 'launch-failed' || reason === 'integrity-failure') return 'shutdown';
    const at = now();
    const recent = crashes[kind].filter((t) => at - t < GONE_WINDOW_MS);
    recent.push(at);
    crashes[kind] = recent;
    if (recent.length >= GONE_MAX_CRASHES) return 'shutdown';
    return kind === 'renderer' ? 'reload' : 'ignore';
  };
}

/** The bits of Electron's `app` used here. */
export interface AppGoneLike {
  on(event: 'child-process-gone', listener: (event: unknown, details: { type: string; reason: string; name?: string }) => void): unknown;
}

/** child-process-gone for the GPU process (other kinds are logged only: the utility process for upkeep ends on its own and is handled by the scheduler). */
export function installChildGoneTrigger(options: { app: AppGoneLike; shutdown: Shutdown; log: Log; decide: ReturnType<typeof createGoneDecider> }): void {
  const { app, shutdown, log, decide } = options;
  app.on('child-process-gone', (_event, details) => {
    log.warn('[child process gone]', details);
    if (details.type !== 'GPU') return;
    if (decide('gpu', details.reason) === 'shutdown') void shutdown.run('gpu process gone', { exitCode: 1 });
  });
}

// ---- listeners that belong to one window --------------------------------------------------------

/** A listener with any arguments (an Electron event's own signature); the caller's function keeps its real types. */
// oxlint-disable-next-line typescript/no-explicit-any
type Listener = (...args: any[]) => void;

export interface EmitterLike {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

/** Records every listener added for one window, so all of them can be removed when the window closes (none outlives its window). */
export class WindowListeners {
  private readonly added: { emitter: EmitterLike; event: string; listener: Listener }[] = [];

  on(emitter: EmitterLike, event: string, listener: Listener): void {
    emitter.on(event, listener);
    this.added.push({ emitter, event, listener });
  }

  get size(): number {
    return this.added.length;
  }

  disposeAll(): void {
    for (const { emitter, event, listener } of this.added.splice(0)) {
      try {
        emitter.removeListener(event, listener);
      } catch {
        // the emitter is already destroyed: its listeners went with it
      }
    }
  }
}

/** A window-like object: BrowserWindow. */
export interface WindowLike extends EmitterLike {
  once(event: 'closed', listener: () => void): unknown;
  webContents: EmitterLike;
}

/** Removes everything `listeners` holds when the window closes. */
export function disposeWithWindow(win: Pick<WindowLike, 'once'>, listeners: WindowListeners): void {
  win.once('closed', () => listeners.disposeAll());
}

/**
 * Windows log-off and shut-down. Electron does NOT emit before-quit then, only these two window events (Windows only). Both start the
 * routine and end the app after it: Windows allows only a few seconds, and the routine already has its own 5 s limit.
 * (query-session-end could still be vetoed by another program; then the app has ended needlessly, which is safe: it was shut down in order.)
 */
export function installSessionEnd(win: EmitterLike, shutdown: Shutdown, listeners: WindowListeners): void {
  listeners.on(win, 'query-session-end', () => void shutdown.run('query-session-end', { exitCode: 0 }));
  listeners.on(win, 'session-end', () => void shutdown.run('session-end', { exitCode: 0 }));
}

/** The page process of a window ended: reload it, ignore it, or shut down (see createGoneDecider). */
export function installRendererGone(options: { win: WindowLike; listeners: WindowListeners; decide: ReturnType<typeof createGoneDecider>; reload: () => void; shutdown: Shutdown; log: Log }): void {
  const { win, listeners, decide, reload, shutdown, log } = options;
  listeners.on(win.webContents, 'render-process-gone', (_event: unknown, details: { reason: string }) => {
    log.error('[renderer process gone]', details);
    const decision = decide('renderer', details.reason);
    if (decision === 'reload') reload();
    else if (decision === 'shutdown') void shutdown.run('renderer process gone', { exitCode: 1 });
  });
}
