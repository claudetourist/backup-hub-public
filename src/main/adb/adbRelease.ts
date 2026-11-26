/**
 * Letting go of the phone. Windows refuses to eject a phone while the adb server is running, so Backup Hub stops it with
 * `adb kill-server` (and nothing else) whenever phone work ends and when the app closes. Only when adb.exe exists.
 */
import type { AdbPort } from './adbPort';

export type ReleaseOutcome = 'released' | 'skipped' | 'timeout';

/** Stops the adb server if adb.exe is there. Never throws. */
export async function releaseAdb(adb: Pick<AdbPort, 'available' | 'killServer'>): Promise<ReleaseOutcome> {
  try {
    if (!adb.available()) return 'skipped';
    await adb.killServer();
    return 'released';
  } catch {
    return 'released'; // nothing was running
  }
}

/** The same, but gives up waiting after `ms` so that closing the app is never held up. */
export async function releaseWithin(adb: Pick<AdbPort, 'available' | 'killServer'>, ms: number): Promise<ReleaseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReleaseOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([releaseAdb(adb), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** How long closing the app waits for the release at most. */
export const QUIT_RELEASE_MS = 3000;
