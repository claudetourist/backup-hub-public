import fs from 'node:fs';
import type { Db } from '../db/connection';
import { absolutePathFor } from '../hashing/paths';

export type BaseOf = (placeId: string) => Promise<string | null>;

/** The path on this PC of a catalog file of a named drive (null when the drive is not plugged in or the path cannot be trusted). */
export async function driveFilePath(db: Db, baseOf: BaseOf, placeId: string, relPath: string): Promise<string | null> {
  const kind = (db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined)?.kind;
  if (kind !== 'drive') return null;
  const base = await baseOf(placeId);
  if (base === null || base === '') return null;
  return absolutePathFor('drive', base, relPath);
}

/** Size on disk of a named-drive catalog file, null when the file (or the drive) is not there. */
export function diskSizeFor(db: Db, baseOf: BaseOf): (placeId: string, relPath: string) => Promise<number | null> {
  return async (placeId, relPath) => {
    const p = await driveFilePath(db, baseOf, placeId, relPath);
    if (p === null) return null;
    try {
      const st = fs.statSync(p);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  };
}
