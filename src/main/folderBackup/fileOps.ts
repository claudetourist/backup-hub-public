/** A file of a folder as the copy needs it: lstat facts and the unbuffered read (shared by the real folder and the keep-sync one). */
import path from 'node:path';
import { rawFs as fs } from '../rawFs';
import { hashUnbuffered } from '../localCopy/directRead';
import { longPath } from '../phoneBackup/backupDrive';
import type { FolderSource } from './folderTypes';

export const absIn = (root: string, rel: string): string => longPath(path.join(root, ...rel.split('/').filter((s) => s !== '')));

export function fileOps(abs: (rel: string) => Promise<string | null>): Pick<FolderSource, 'stat' | 'readFile'> {
  return {
    async stat(rel) {
      const file = await abs(rel);
      if (file === null) return null;
      try {
        const st = await fs.promises.lstat(file);
        return st.isFile() ? { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) } : null;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      }
    },
    async readFile(rel, onBlock, yieldNow) {
      const file = await abs(rel);
      if (file === null) throw Object.assign(new Error('ENOENT: the file is not there'), { code: 'ENOENT' });
      const hash = await hashUnbuffered(file, { yieldNow, onBlock });
      return { sha256: hash.sha256, bytes: hash.bytes };
    },
  };
}

