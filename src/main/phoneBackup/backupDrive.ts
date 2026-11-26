/**
 * The drive side of a phone backup, as one small interface so the run can be tested against unkind fake drives. The real one uses the S1
 * pieces (temp folder under the drive's own files, flush, cache-free read, link that cannot replace); the run never touches a file itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertWritable } from '../fsutil';
import { freeBytesOfAsync } from '../localCopy/freeSpace';
import { realDriveOps, settleLeftover, tempPathFor, type CopyIo, type DriveOps } from '../localCopy/verifiedCopy';
import { listsFolder } from '../places/appFolders';

export type SettleResult = 'none' | 'settled' | 'cleared' | 'unexpected';

export interface BackupDrive {
  ops: DriveOps;
  /** Path of a file given relative to the drive root ("MyData/POCO/x/a.jpg"). */
  finalPath(rel: string): string;
  tmpPath(final: string): string;
  /** Makes the folder of the final name (never removes or changes anything there). */
  ensureDir(final: string): Promise<void>;
  /** A temp name of an earlier, cut-off copy of this final name: finished (same file as the final and expected) or cleared. */
  settle(final: string, isExpected: () => Promise<boolean>): Promise<SettleResult>;
  freeBytes(): Promise<number | null>;
  /** Writes a NEW list file under the drive's lists folder (never replaces: a taken name gets -2, -3). Returns where it went. */
  writeList(relName: string, text: string): Promise<string>;
}

/** Windows long path form for a path of 248 characters or more (the drive has long paths on; the prefix makes it work for every call). */
export function longPath(p: string): string {
  if (process.platform !== 'win32' || p.startsWith('\\\\?\\') || p.length < 248) return p;
  return '\\\\?\\' + path.resolve(p);
}

export function realBackupDrive(root: string, options: { tmpDir?: string; io?: CopyIo } = {}): BackupDrive {
  const finalPath = (rel: string): string => longPath(path.join(root, ...rel.split('/').filter((s) => s !== '')));
  return {
    ops: realDriveOps(options.io),
    finalPath,
    tmpPath: (final) => tempPathFor(final, options.tmpDir),
    async ensureDir(final) {
      assertWritable(final);
      await fs.promises.mkdir(path.dirname(final), { recursive: true });
      // `adb pull` writes straight to the temp name: its folder must be there.
      const tmp = tempPathFor(final, options.tmpDir);
      assertWritable(tmp);
      await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
    },
    settle: (final, isExpected) => settleLeftover(final, { ...(options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }), ...(options.io === undefined ? {} : { io: options.io }), isExpected }),
    freeBytes: () => freeBytesOfAsync(root),
    async writeList(relName, text) {
      const parts = relName.split('/').filter((s) => s !== '');
      const dir = path.join(listsFolder(root), ...parts.slice(0, -1));
      const file = parts[parts.length - 1]!;
      const dot = file.lastIndexOf('.');
      assertWritable(path.join(dir, file));
      await fs.promises.mkdir(dir, { recursive: true });
      for (let n = 1; n < 1000; n += 1) {
        const name = n === 1 ? file : `${file.slice(0, dot)}-${n}${file.slice(dot)}`;
        const full = path.join(dir, name);
        try {
          await fs.promises.writeFile(full, text, { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        const handle = await fs.promises.open(full, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        return full;
      }
      throw new Error('Too many lists with the same name.');
    },
  };
}
