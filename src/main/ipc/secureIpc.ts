import type { IpcMain } from 'electron';
import { busy as appBusy, type BusyTracker } from '../busyTracker';
import { SCHEMAS, type ArgsOf, type FireAndForgetChannel, type InvokeChannel } from './schemas';

/**
 * The ONLY place that registers ipcMain handlers (a static test keeps it so). Every call is checked in this order before any
 * handler runs: (1) the sender is the main window's own page, in its top frame, at the app's own address; (2) the arguments
 * match the channel's zod schema. A failure throws a plain "Invalid request" or "Untrusted sender"; the detail goes to the
 * log (field names and error kinds only, never the values: they may be passphrases).
 */

/** The parts of an Electron IPC event that are looked at (so tests can pass plain fakes). */
export interface SenderEvent {
  sender: unknown;
  senderFrame?: { url: string; parent: unknown } | null | undefined;
}

export interface WindowLike {
  isDestroyed(): boolean;
  webContents: unknown;
}

export interface SecureIpcLog {
  warn(...args: unknown[]): void;
}

/** True only for the main window's own web contents, its top frame, at an address the app owns. */
export function isTrustedSender(event: SenderEvent, win: WindowLike | null, isAppUrl: (url: string) => boolean): boolean {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isAppUrl(frame.url);
}

export interface SecureIpcOptions {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>;
  getWindow: () => WindowLike | null;
  isAppUrl: (url: string) => boolean;
  log: SecureIpcLog;
  /** Where each call's main-thread time is noted (default: the app's tracker). */
  busy?: BusyTracker;
  /** A call holding the main thread at least this long is logged as slow (default 200 ms). */
  slowMs?: number;
}

export interface SecureIpc {
  /** Request/response channel. The handler gets the checked arguments. */
  handle<C extends InvokeChannel>(channel: C, handler: (...args: ArgsOf<C>) => unknown): void;
  /** Fire-and-forget channel: a bad call is logged and ignored. */
  on<C extends FireAndForgetChannel>(channel: C, handler: (...args: ArgsOf<C>) => void): void;
}

type Issue = { path: PropertyKey[]; code: string };
type ArgsSchema = { safeParse(value: unknown): { success: boolean; data?: unknown[]; error?: { issues: readonly Issue[] } } };

function describeIssues(issues: readonly Issue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(arguments)'}: ${issue.code}`)
    .join('; ');
}

export function createSecureIpc(options: SecureIpcOptions): SecureIpc {
  const { ipcMain, getWindow, isAppUrl, log } = options;
  const tracker = options.busy ?? appBusy;
  const slowMs = options.slowMs ?? 200;

  /** Runs a handler, noting how long it held the main thread; a slow one is logged by name. */
  const timed = (channel: string, run: () => unknown): unknown => {
    const mark = tracker.begin(channel);
    let result: unknown;
    try {
      result = run();
    } catch (err) {
      mark.finished();
      throw err;
    } finally {
      const ms = mark.syncDone();
      if (ms >= slowMs) log.warn(`[slow] ipc ${channel} held the main thread for ${Math.round(ms)} ms`);
    }
    if (result instanceof Promise) return result.finally(() => mark.finished());
    mark.finished();
    return result;
  };
  const registered = new Set<string>();

  const claim = (channel: string): void => {
    if (registered.has(channel)) throw new Error(`IPC channel registered twice: ${channel}`);
    registered.add(channel);
  };

  /** The checked arguments, or why the call was refused (already logged). */
  const check = (channel: string, event: SenderEvent, args: unknown[]): { args: unknown[] } | { refused: 'sender' | 'invalid' } => {
    if (!isTrustedSender(event, getWindow(), isAppUrl)) {
      log.warn(`ipc ${channel}: refused, the sender is not the app window (frame address: ${event.senderFrame?.url ?? 'none'})`);
      return { refused: 'sender' };
    }
    const parsed = (SCHEMAS as Record<string, ArgsSchema>)[channel]?.safeParse(args);
    if (!parsed) {
      log.warn(`ipc ${channel}: refused, no schema`);
      return { refused: 'invalid' };
    }
    if (!parsed.success) {
      log.warn(`ipc ${channel}: invalid request (${describeIssues(parsed.error?.issues ?? [])})`);
      return { refused: 'invalid' };
    }
    return { args: parsed.data ?? [] };
  };

  return {
    handle(channel, handler) {
      claim(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        const checked = check(channel, event as SenderEvent, args);
        if ('refused' in checked) throw new Error(checked.refused === 'sender' ? 'Untrusted sender' : 'Invalid request');
        return timed(channel, () => (handler as (...a: unknown[]) => unknown)(...checked.args));
      });
    },
    on(channel, handler) {
      claim(channel);
      ipcMain.on(channel, (event, ...args: unknown[]) => {
        const checked = check(channel, event as SenderEvent, args);
        if ('refused' in checked) return;
        try {
          timed(channel, () => (handler as (...a: unknown[]) => void)(...checked.args));
        } catch (err) {
          log.warn(`ipc ${channel}: handler failed`, err);
        }
      });
    },
  };
}
