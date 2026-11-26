import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createBeforeQuit } from '../quitFlow';
import { buildShutdownSteps, createShutdown, SHUTDOWN_LIMIT_MS, type AppShutdownParts, type ShutdownStep } from './shutdown';
import {
  createGoneDecider,
  disposeWithWindow,
  installChildGoneTrigger,
  installProcessTriggers,
  installRendererGone,
  installSessionEnd,
  isKnownHarmless,
  WindowListeners,
  type AppGoneLike,
  type WindowLike,
} from './triggers';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Lets every pending promise step run (the clock is fake; this is a real, immediate turn of the event loop). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock the test drives: schedule() records timers, advance() fires the ones that are due. */
function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  return {
    schedule: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return () => void timers.delete(id);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, t] of timers) {
        if (t.at <= now) {
          timers.delete(id);
          t.run();
        }
      }
      await flush();
    },
    pending: () => timers.size,
  };
}

function recorder() {
  const calls: string[] = [];
  const parts: AppShutdownParts = {
    stopTimers: () => void calls.push('timers'),
    pauseJobs: async () => void calls.push('jobs'),
    stopUpkeepProcess: () => void calls.push('upkeep'),
    closeServices: () => void calls.push('services'),
    terminateWorkers: async () => void calls.push('workers'),
    releaseAdb: async () => void calls.push('adb'),
    endChildren: () => void calls.push('children'),
    closeDatabase: () => void calls.push('database'),
  };
  return { calls, parts };
}

function routine(steps: readonly ShutdownStep[], clock = fakeClock()) {
  const exits: number[] = [];
  const shutdown = createShutdown({ steps, exit: (code) => void exits.push(code), log: quiet, schedule: clock.schedule });
  return { shutdown, exits, clock };
}

describe('the shutdown routine', () => {
  it('runs every step once, in the safe order, database last', async () => {
    const { calls, parts } = recorder();
    const { shutdown, exits } = routine(buildShutdownSteps(parts));
    await shutdown.run('test');
    expect(calls).toEqual(['timers', 'jobs', 'upkeep', 'services', 'workers', 'adb', 'children', 'database']);
    expect(shutdown.finished).toBe(true);
    expect(exits).toEqual([]); // a normal quit: the caller asks Electron to quit again
  });

  it('is idempotent: a second trigger (even while it runs) starts nothing new and returns the same promise', async () => {
    const { calls, parts } = recorder();
    const { shutdown } = routine(buildShutdownSteps(parts));
    const first = shutdown.run('quit');
    const second = shutdown.run('SIGINT');
    expect(second).toBe(first);
    await first;
    await shutdown.run('late');
    expect(calls.filter((c) => c === 'database')).toHaveLength(1);
    expect(calls.filter((c) => c === 'timers')).toHaveLength(1);
  });

  it('a step that throws or rejects does not stop the steps after it', async () => {
    const { calls, parts } = recorder();
    parts.pauseJobs = () => Promise.reject(new Error('jobs'));
    parts.terminateWorkers = () => {
      throw new Error('workers');
    };
    const { shutdown } = routine(buildShutdownSteps(parts));
    await shutdown.run('test');
    expect(calls).toEqual(['timers', 'upkeep', 'services', 'adb', 'children', 'database']);
  });

  it('a step that hangs is abandoned after its own limit and the rest still run', async () => {
    const { calls, parts } = recorder();
    parts.releaseAdb = () => new Promise(() => undefined);
    const clock = fakeClock();
    const { shutdown } = routine(buildShutdownSteps(parts), clock);
    void shutdown.run('test');
    await flush();
    expect(calls).toEqual(['timers', 'jobs', 'upkeep', 'services', 'workers']);
    await clock.advance(1200);
    expect(calls.slice(-2)).toEqual(['children', 'database']);
    expect(shutdown.finished).toBe(true);
  });

  it('the hard limit ends the app after 5 s even if a step never returns', async () => {
    const hang: ShutdownStep = { name: 'stuck', run: () => new Promise(() => undefined) };
    const after: ShutdownStep = { name: 'after', run: () => void order.push('after') };
    const order: string[] = [];
    const clock = fakeClock();
    const { shutdown, exits } = routine([hang, after], clock);
    const done = shutdown.run('quit');
    await clock.advance(SHUTDOWN_LIMIT_MS - 1);
    expect(exits).toEqual([]);
    await clock.advance(1);
    await done;
    expect(exits).toEqual([0]);
    expect(order).toEqual([]); // nothing runs after the limit
    expect(SHUTDOWN_LIMIT_MS).toBe(5000);
  });

  it('a crash trigger ends the app (with its code) after the steps, once', async () => {
    const { parts, calls } = recorder();
    const { shutdown, exits } = routine(buildShutdownSteps(parts));
    await shutdown.run('uncaughtException', { exitCode: 1 });
    await shutdown.run('unhandledRejection', { exitCode: 1 });
    expect(calls.at(-1)).toBe('database');
    expect(exits).toEqual([1]);
  });

  it('a crash while a normal quit is already shutting down still ends the app afterwards', async () => {
    const release: { go: () => void } = { go: () => undefined };
    const gate = new Promise<void>((resolve) => (release.go = resolve));
    const { shutdown, exits } = routine([{ name: 'slow', run: () => gate }]);
    const first = shutdown.run('quit');
    void shutdown.run('uncaughtException', { exitCode: 1 });
    expect(exits).toEqual([]);
    release.go();
    await first;
    expect(exits).toEqual([1]);
  });

  it('the hard-limit timer is cancelled when the steps finish in time', async () => {
    const clock = fakeClock();
    const { shutdown } = routine([{ name: 'quick', run: () => undefined }], clock);
    await shutdown.run('quit');
    expect(clock.pending()).toBe(0);
  });
});

describe('the quit flow uses the same routine', () => {
  it('before-quit and window-all-closed (which asks to quit) run the routine once, then the quit goes through', async () => {
    const { parts, calls } = recorder();
    const { shutdown } = routine(buildShutdownSteps(parts));
    let again = 0;
    const quit = createBeforeQuit({ shutdown, quitAgain: () => { again += 1; quit({ preventDefault: () => { throw new Error('held after done'); } }); } });
    let prevented = 0;
    quit({ preventDefault: () => void (prevented += 1) });
    quit({ preventDefault: () => void (prevented += 1) });
    await flush();
    expect(prevented).toBe(2);
    expect(again).toBe(1);
    expect(calls.filter((c) => c === 'database')).toHaveLength(1);
  });
});

/** A routine that only records which reason started it. */
function spyShutdown() {
  const runs: { reason: string; exitCode?: number }[] = [];
  const shutdown = { run: (reason: string, options?: { exitCode?: number }) => { runs.push({ reason, ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}) }); return Promise.resolve(); }, started: false, finished: false };
  return { runs, shutdown };
}

describe('every trigger reaches the routine', () => {
  it('uncaughtException and unhandledRejection: logged, then shutdown (exit code 1)', () => {
    const proc = new EventEmitter();
    const { runs, shutdown } = spyShutdown();
    const logged: string[] = [];
    installProcessTriggers({ proc, shutdown, log: { ...quiet, error: (...a: unknown[]) => void logged.push(String(a[0])) } });
    proc.emit('uncaughtException', new Error('boom'));
    proc.emit('unhandledRejection', new Error('nobody caught this'));
    expect(runs).toEqual([{ reason: 'uncaughtException', exitCode: 1 }, { reason: 'unhandledRejection', exitCode: 1 }]);
    expect(logged).toEqual(['[uncaughtException]', '[unhandledRejection]']);
  });

  it('known-harmless errors are logged and the app goes on', () => {
    const proc = new EventEmitter();
    const { runs, shutdown } = spyShutdown();
    installProcessTriggers({ proc, shutdown, log: quiet });
    for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_IPC_CHANNEL_CLOSED']) proc.emit('uncaughtException', Object.assign(new Error('x'), { code }));
    proc.emit('unhandledRejection', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    proc.emit('uncaughtException', new TypeError('Object has been destroyed'));
    expect(runs).toEqual([]);
    expect(isKnownHarmless(new Error('plain'))).toBe(false);
    expect(isKnownHarmless('a string')).toBe(false);
    expect(isKnownHarmless(null)).toBe(false);
    expect(isKnownHarmless(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK'])('%s: shutdown, then exit 0', (signal) => {
    const proc = new EventEmitter();
    const { runs, shutdown } = spyShutdown();
    installProcessTriggers({ proc, shutdown, log: quiet });
    proc.emit(signal);
    expect(runs).toEqual([{ reason: signal, exitCode: 0 }]);
  });

  it('the handlers can be removed again', () => {
    const proc = new EventEmitter();
    const { shutdown } = spyShutdown();
    const remove = installProcessTriggers({ proc, shutdown, log: quiet });
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    remove();
    for (const event of ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'SIGBREAK']) expect(proc.listenerCount(event)).toBe(0);
  });

  it('Windows log-off and shut-down: both window events run the routine and end the app', () => {
    const win = new EventEmitter();
    const { runs, shutdown } = spyShutdown();
    const listeners = new WindowListeners();
    installSessionEnd(win, shutdown, listeners);
    win.emit('query-session-end', { preventDefault: () => undefined });
    win.emit('session-end');
    expect(runs).toEqual([{ reason: 'query-session-end', exitCode: 0 }, { reason: 'session-end', exitCode: 0 }]);
  });

  it('a GPU process that is gone for good (or fails to launch) shuts down; a single GPU crash does not; other child kinds are ignored', () => {
    const app = new EventEmitter() as EventEmitter & AppGoneLike;
    const { runs, shutdown } = spyShutdown();
    installChildGoneTrigger({ app, shutdown, log: quiet, decide: createGoneDecider(() => 0) });
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
    expect(runs).toEqual([]);
    app.emit('child-process-gone', {}, { type: 'Utility', reason: 'launch-failed' });
    expect(runs).toEqual([]);
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed' });
    expect(runs).toEqual([{ reason: 'gpu process gone', exitCode: 1 }]);
  });

  it('three GPU crashes inside a minute shut down; spread out they do not', () => {
    let t = 0;
    const decide = createGoneDecider(() => t);
    expect(decide('gpu', 'crashed')).toBe('ignore');
    t += 61_000;
    expect(decide('gpu', 'crashed')).toBe('ignore');
    t += 1000;
    expect(decide('gpu', 'oom')).toBe('ignore');
    t += 1000;
    expect(decide('gpu', 'crashed')).toBe('shutdown');
    expect(decide('gpu', 'clean-exit')).toBe('ignore');
  });

  it('a renderer that is gone: reloaded, but shut down when it cannot start or keeps crashing', () => {
    const webContents = new EventEmitter();
    const win = Object.assign(new EventEmitter(), { webContents }) as unknown as WindowLike;
    const { runs, shutdown } = spyShutdown();
    let reloads = 0;
    const listeners = new WindowListeners();
    installRendererGone({ win, listeners, decide: createGoneDecider(() => 0), reload: () => void (reloads += 1), shutdown, log: quiet });
    webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    expect([reloads, runs.length]).toEqual([0, 0]);
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    webContents.emit('render-process-gone', {}, { reason: 'oom' });
    expect([reloads, runs.length]).toEqual([2, 0]);
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(runs).toEqual([{ reason: 'renderer process gone', exitCode: 1 }]);
    const other = new EventEmitter();
    const win2 = Object.assign(new EventEmitter(), { webContents: other }) as unknown as WindowLike;
    const spy2 = spyShutdown();
    installRendererGone({ win: win2, listeners, decide: createGoneDecider(() => 0), reload: () => undefined, shutdown: spy2.shutdown, log: quiet });
    other.emit('render-process-gone', {}, { reason: 'launch-failed' });
    expect(spy2.runs).toEqual([{ reason: 'renderer process gone', exitCode: 1 }]);
  });
});

describe('listeners that belong to a window', () => {
  it('are all removed when the window closes', () => {
    const webContents = new EventEmitter();
    const win = Object.assign(new EventEmitter(), { webContents });
    const { shutdown } = spyShutdown();
    const listeners = new WindowListeners();
    disposeWithWindow(win, listeners);
    installSessionEnd(win, shutdown, listeners);
    installRendererGone({ win: win as unknown as WindowLike, listeners, decide: createGoneDecider(), reload: () => undefined, shutdown, log: quiet });
    listeners.on(webContents, 'console-message', () => undefined);
    listeners.on(webContents, 'preload-error', () => undefined);
    expect(listeners.size).toBe(5);
    expect(win.listenerCount('session-end') + win.listenerCount('query-session-end') + webContents.listenerCount('render-process-gone') + webContents.listenerCount('console-message')).toBe(4);
    win.emit('closed');
    expect(listeners.size).toBe(0);
    expect(win.listenerCount('session-end')).toBe(0);
    expect(win.listenerCount('query-session-end')).toBe(0);
    expect(webContents.listenerCount('render-process-gone')).toBe(0);
    expect(webContents.listenerCount('console-message')).toBe(0);
    expect(webContents.listenerCount('preload-error')).toBe(0);
  });

  it('a window opened and closed many times leaves nothing behind', () => {
    const { shutdown } = spyShutdown();
    const shared = new EventEmitter();
    for (let i = 0; i < 50; i += 1) {
      const win = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
      const listeners = new WindowListeners();
      disposeWithWindow(win, listeners);
      installSessionEnd(win, shutdown, listeners);
      listeners.on(shared, 'powerchange', () => undefined);
      win.emit('closed');
    }
    expect(shared.listenerCount('powerchange')).toBe(0);
  });
});
