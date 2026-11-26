import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPaths } from '../dataDir';
import { assertWritable } from '../fsutil';

/**
 * Crash dumps stay on this computer: nothing is ever uploaded (no server, no URL). They go in a "crashes" folder inside the app's logs
 * folder, so they are found next to the log and removed with it. Started before the app is ready, as Electron asks.
 */

export interface CrashReporterLike {
  start(options: { uploadToServer: false; compress: true }): void;
}
export interface PathSetterLike {
  setPath(name: 'crashDumps', value: string): void;
}

/** Sets the folder, then starts the reporter in its local-only form. A folder that cannot be made falls back to Electron's own default folder (still local). */
export function startCrashDumps(options: { app: PathSetterLike; crashReporter: CrashReporterLike; dir: string | null; log?: { warn(...args: unknown[]): void } }): void {
  const { app, crashReporter, dir, log } = options;
  if (dir !== null) {
    try {
      assertWritable(dir); // T7 write ban: a protected drive never gets a folder from us
      fs.mkdirSync(dir, { recursive: true });
      app.setPath('crashDumps', dir);
    } catch (err) {
      log?.warn('crash dumps: could not use the logs folder, the default local folder is used', err);
    }
  }
  crashReporter.start({ uploadToServer: false, compress: true });
}

/**
 * The folder for the dumps, worked out the same way start() works out the logs folder but without any window or dialog: a bench run uses its
 * temp folder, a dev run needs BACKUPHUB_DATA_DIR (otherwise Electron's default local folder is used and the real folders are not touched),
 * a packaged run uses the configured logs folder. Null = leave Electron's default.
 */
export function crashDumpsDir(input: { isPackaged: boolean; benchDataDir: string | null; envDataDir: string | undefined; appDataDir: string; forbiddenRoots: readonly string[] }): string | null {
  if (input.benchDataDir) return path.join(input.benchDataDir, 'logs', 'crashes');
  if (!input.isPackaged) return input.envDataDir ? path.join(input.envDataDir, 'logs', 'crashes') : null;
  try {
    return path.join(resolveDataPaths({ appDataDir: input.appDataDir, forbiddenRoots: input.forbiddenRoots }).logsDir, 'crashes');
  } catch {
    return null;
  }
}
