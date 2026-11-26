/**
 * The shell lines that remove a file from a phone. They live here, inside `danger`, so a static test can prove nothing else builds
 * an `rm`: no flags at all, so a folder is refused by the phone; the path must pass `isRemovablePhonePath`.
 * Only `danger/index.ts` may call the phone's remove methods (see `AdbCleanPort.remove` and `AdbCleanClient.removeMany`).
 */
import { isRemovablePhonePath } from '../cleanup/safety';

/** The adb arguments that remove one file from the phone with this serial. */
export function removeArgs(serial: string, remotePath: string): string[] {
  return ['-s', serial, 'shell', removeCommand(remotePath)];
}

export function removeCommand(remotePath: string): string {
  if (!isRemovablePhonePath(remotePath)) throw new Error('Not a safe phone path.');
  return `rm '${remotePath}'`;
}

/** What the phone said about one file of a batch remove. */
export type RemoveManyStatus = 'removed' | 'still' | 'changed' | 'missing' | 'failed';

export interface RemoveManyItem {
  path: string;
  /** The size the file must have on the phone right now, or it is left alone. */
  size: number;
}

/**
 * ONE shell line for a batch: for each file, in this order, the phone looks at the file's size and ONLY when it is exactly the planned one removes it
 * (the check and the remove sit back to back in the same call), then looks whether it is gone. One word per file comes back, in the order asked:
 * GONE, STILL (the remove ran but the file is there), FAIL (the phone refused), MISSING (not there), CHANGED (another size: left alone).
 */
export function removeManyCommand(items: readonly RemoveManyItem[]): string {
  if (items.length === 0) throw new Error('No files to remove.');
  for (const i of items) {
    if (!isRemovablePhonePath(i.path)) throw new Error('Not a safe phone path.');
    if (!Number.isSafeInteger(i.size) || i.size <= 0) throw new Error('A file to remove needs its planned size.');
  }
  return items
    .map(
      (i) =>
        `case $(stat -c %s '${i.path}' 2>/dev/null) in ${i.size}) if rm '${i.path}' 2>/dev/null; then if [ -e '${i.path}' ]; then echo STILL; else echo GONE; fi; else echo FAIL; fi;; '') echo MISSING;; *) echo CHANGED;; esac`,
    )
    .join('; ');
}

const WORD: Record<string, RemoveManyStatus> = { GONE: 'removed', STILL: 'still', FAIL: 'failed', MISSING: 'missing', CHANGED: 'changed' };

/** One status per file asked, in order. Throws when the phone's words do not match the files asked (the caller then looks at the phone before saying anything). */
export function parseRemoveMany(count: number, stdout: string): RemoveManyStatus[] {
  const words = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (words.length !== count) throw new Error(`The phone gave ${words.length} answers for ${count} files.`);
  return words.map((w) => {
    const s = WORD[w];
    if (s === undefined) throw new Error('The phone gave an answer that is not understood.');
    return s;
  });
}
