import os from 'node:os';
import { powerMonitor, utilityProcess } from 'electron';
import type { JobService } from '../jobs/jobService';
import type { PauseState } from '../pause/pauseState';
import type { UpkeepChild } from './upkeepScheduler';
import { UpkeepScheduler } from './upkeepScheduler';
import type { UpkeepCommand, UpkeepReport } from './upkeepProtocol';

/**
 * The Electron side of upkeep: starts the utility process (upkeepProcess.js, built next to main.js), lowers its OS priority, and feeds
 * the scheduler the real idle time and power source. All the rules live in upkeepScheduler.ts (tested without Electron); this file is only glue.
 */

export interface ElectronUpkeepOptions {
  /** Absolute path of the built upkeepProcess.js. */
  scriptPath: string;
  /** The database file; the process opens it with its own connection. */
  dbFile: string;
  jobs: JobService;
  pause: PauseState;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

/** One utility process as an UpkeepChild. */
export function forkUpkeepProcess(scriptPath: string): UpkeepChild {
  const proc = utilityProcess.fork(scriptPath, [], { serviceName: 'Backup Hub upkeep', stdio: 'ignore' });
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    postMessage: (command: UpkeepCommand) => proc.postMessage(command),
    kill: () => void proc.kill(),
    onSpawn: (listener) => {
      proc.once('spawn', () => {
        if (proc.pid !== undefined) listener(proc.pid);
      });
    },
    onMessage: (listener) => {
      proc.on('message', (message: unknown) => {
        if (typeof message === 'object' && message !== null && ['finished', 'failed'].includes((message as { type?: string }).type ?? '')) listener(message as UpkeepReport);
      });
    },
    onExit: (listener) => {
      proc.once('exit', (code) => listener(code));
    },
  };
}

/** Builds the scheduler with the real clock, idle time and power source. Call `start()` on it after the first paint (never in a bench run). */
export function createUpkeepScheduler(o: ElectronUpkeepOptions): UpkeepScheduler {
  return new UpkeepScheduler({
    now: Date.now,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onBattery: () => powerMonitor.isOnBatteryPower(),
    jobsBusy: () => o.jobs.hasPendingWork(),
    paused: () => o.pause.isOn(),
    spawn: () => forkUpkeepProcess(o.scriptPath),
    dbFile: o.dbFile,
    lowerPriority: (pid) => os.setPriority(pid, os.constants.priority.PRIORITY_LOW),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    log: o.log,
  });
}
