/**
 * The ONLY place Backup Hub is allowed to change a phone, and only with four fixed commands:
 *   `stat -c %s '<file>'` (read; several in one line), the remove (one file, or a batch that checks each file's size right before its own `rm`; commands built in `danger/adbRm.ts`; no -r, no -f, no wildcard), `adb push` (one file, never over an existing one)
 *   and the gallery refresh (`am broadcast MEDIA_SCANNER_SCAN_FILE` for a path that was just removed; it only asks the phone's gallery to look again).
 * Every path must pass `isRemovablePhonePath` (below a folder of /sdcard, no quote, no control character, no ..).
 * Tests use a fake over a temporary folder; the real adb is never run by tests.
 */
import type { AdbPort } from '../adb/adbPort';
import { AdbClient, runAdb } from '../adb/adbPort';
import { parseRemoveMany, removeArgs, removeManyCommand, type RemoveManyItem, type RemoveManyStatus } from '../danger/adbRm';
import { isRemovablePhonePath } from './safety';

export interface AdbCleanPort extends AdbPort {
  /** Size of a file on the phone, or null when the file is not there. Throws when the phone cannot answer. */
  statSize(serial: string, remotePath: string, signal?: AbortSignal): Promise<number | null>;
  /** Removes exactly one file. ONLY `danger/index.ts` may call this (a static test checks); everything else asks the guarded path. */
  remove(serial: string, remotePath: string, signal?: AbortSignal): Promise<void>;
  /** Sizes of several files with ONE call (null: not there). Throws when the phone cannot answer. */
  statSizes?(serial: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<(number | null)[]>;
  /** Removes several files with ONE call, each only if its size is exactly the planned one right then. ONLY `danger/index.ts` may call this (a static test checks). */
  removeMany?(serial: string, items: readonly RemoveManyItem[], signal?: AbortSignal): Promise<RemoveManyStatus[]>;
  /** Copies one file from this PC to a path on the phone that does not exist yet. */
  push(serial: string, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>;
}

const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
const SCAN_BATCH = 20;

/** The shell lines that ask the phone's gallery to look at these paths again (up to 20 broadcasts per line). */
export function scanMediaCommands(remotePaths: readonly string[]): string[] {
  for (const p of remotePaths) if (!isRemovablePhonePath(p)) throw new Error('Not a safe phone path.');
  const lines: string[] = [];
  for (let i = 0; i < remotePaths.length; i += SCAN_BATCH) {
    lines.push(
      remotePaths
        .slice(i, i + SCAN_BATCH)
        .map((p) => `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file://${p.split('/').map(encodeURIComponent).join('/')}'`)
        .join('; '),
    );
  }
  return lines;
}

/** The one shell line that reads a file's size. */
export function statSizeCommand(remotePath: string): string {
  if (!isRemovablePhonePath(remotePath)) throw new Error('Not a safe phone path.');
  return `stat -c %s '${remotePath}'`;
}

/** The one shell line that reads the sizes of several files (one word per file: the size, or X when it is not there). */
export function statSizesCommand(remotePaths: readonly string[]): string {
  if (remotePaths.length === 0) throw new Error('No files to look at.');
  for (const p of remotePaths) if (!isRemovablePhonePath(p)) throw new Error('Not a safe phone path.');
  return remotePaths.map((p) => `stat -c %s '${p}' 2>/dev/null || echo X`).join('; ');
}

/** One size (or null: not there) per file asked, in order. Throws when the phone's words do not match the files asked. */
export function parseSizes(count: number, stdout: string): (number | null)[] {
  const words = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (words.length !== count) throw new Error(`The phone gave ${words.length} answers for ${count} files.`);
  return words.map((w) => (/^\d+$/.test(w) ? Number(w) : null));
}

export function parseSize(text: string): number | null {
  const m = /^(\d+)\s*$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

export class AdbCleanClient extends AdbClient implements AdbCleanPort {
  async statSize(serial: string, remotePath: string, signal?: AbortSignal): Promise<number | null> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    try {
      return parseSize(await runAdb(this.adbPath(), ['-s', serial, 'shell', statSizeCommand(remotePath)], 60_000, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      if (/no such file/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  async remove(serial: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    await runAdb(this.adbPath(), removeArgs(serial, remotePath), 60_000, signal);
  }

  async statSizes(serial: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<(number | null)[]> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    return parseSizes(remotePaths.length, await runAdb(this.adbPath(), ['-s', serial, 'shell', statSizesCommand(remotePaths)], 120_000, signal));
  }

  async removeMany(serial: string, items: readonly RemoveManyItem[], signal?: AbortSignal): Promise<RemoveManyStatus[]> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    return parseRemoveMany(items.length, await runAdb(this.adbPath(), ['-s', serial, 'shell', removeManyCommand(items)], 120_000, signal));
  }

  /** Asks the phone's gallery to look at these (removed) paths again so it keeps no empty pictures. Best effort. */
  async scanMedia(serial: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    for (const line of scanMediaCommands(remotePaths)) await runAdb(this.adbPath(), ['-s', serial, 'shell', line], 120_000, signal);
  }

  async push(serial: string, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
    if (!isRemovablePhonePath(remotePath)) throw new Error('Not a safe phone path.');
    await runAdb(this.adbPath(), ['-s', serial, 'push', localPath, remotePath], 3_600_000, signal);
  }
}
