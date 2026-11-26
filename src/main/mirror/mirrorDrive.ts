/**
 * A real drive as one side of a mirror (R1.3): the backup drive's safe-copy pieces (backupDrive.ts) plus look again at a folder (the listing's quick
 * look, on its worker thread when the app runs), a cache-free read that hands every block on (directRead.ts: the source is read once, hashed while it is
 * written), and a writer for the temp name. Nothing here replaces, removes or renames anything of the person's.
 */
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { rawFs as fs } from '../rawFs';
import type { Db } from '../db';
import { hashUnbuffered } from '../localCopy/directRead';
import type { CopyIo } from '../localCopy/verifiedCopy';
import { inlineQuickWalkRunner, type QuickWalkRunner } from '../listing/quickWalkRunner';
import { assertWritable } from '../fsutil';
import { realBackupDrive } from '../phoneBackup/backupDrive';
import type { MirrorDrive, TempWriter } from './mirrorTypes';

export interface RealMirrorDriveOptions {
  db: Db;
  placeId: string;
  label: string;
  /** The drive's root on this PC ("G:\\"). */
  root: string;
  quickRunner?: QuickWalkRunner | undefined;
  io?: CopyIo;
  tmpDir?: string;
}

export function realMirrorDrive(o: RealMirrorDriveOptions): MirrorDrive {
  const base = realBackupDrive(o.root, { ...(o.io ? { io: o.io } : {}), ...(o.tmpDir ? { tmpDir: o.tmpDir } : {}) });
  const runner = o.quickRunner ?? inlineQuickWalkRunner(o.db);
  return {
    ...base,
    placeId: o.placeId,
    label: o.label,
    async look(folderRel, { signal, progress }) {
      const abs = path.join(o.root, ...folderRel.split('/').filter((s) => s !== ''));
      const result = await runner.run(
        { placeId: o.placeId, root: abs, rel: { kind: 'under', base: o.root }, excludeDirs: [], skipFolders: [] },
        { signal, tick: (c) => progress(`Looking at ${o.label}: ${(c.foldersRead + c.foldersSkipped).toLocaleString('en-US')} folders`) },
      );
      return { complete: result.complete, rootMissing: result.rootMissing, message: result.complete ? null : (result.firstError ?? 'The list of files could not be read completely.') };
    },
    async readFile(rel, onBlock, yieldNow) {
      const hash = await hashUnbuffered(base.finalPath(rel), { yieldNow, onBlock });
      return { sha256: hash.sha256, bytes: hash.bytes };
    },
    async openTemp(tmp): Promise<TempWriter> {
      // The temp name is on the second drive: the write guard (a read-only or unknown drive) is asked before anything is created.
      assertWritable(tmp);
      const handle: FileHandle = await fs.promises.open(tmp, 'wx');
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await handle.close();
      };
      return {
        write: async (block) => {
          await handle.write(block, 0, block.length);
        },
        async finish(mtimeMs) {
          await handle.sync();
          await close();
          const seconds = mtimeMs / 1000;
          assertWritable(tmp);
          await fs.promises.utimes(tmp, seconds, seconds);
        },
        abort: close,
      };
    },
  };
}
