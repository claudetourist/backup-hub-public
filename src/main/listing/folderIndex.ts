import type { Db } from '../db';
import { prefixUpperBound } from './skipRules';

/** The `parent` of a place's top folder (a drive's whole-drive root is ''): nothing asks for its children by this name. */
export const NO_PARENT = '*';

export interface FolderRecord {
  relPath: string;
  mtime: number;
}

/** The folder a rel path sits in ("D:/a/b" gives "D:/a"; a name with no slash gives ''). */
export function parentOf(relPath: string): string {
  if (relPath === '') return NO_PARENT;
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

/** The last part of a rel path. */
export function nameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/**
 * The folders a listing walked and their modified time when their files were read (table `scan_folders`).
 * A quick "look again" skips a folder whose modified time has not moved: adding, removing or renaming a file or a
 * sub-folder always moves it. Editing a file in place does not, which the daily full listing and the live watcher cover.
 */
export class FolderIndex {
  constructor(private readonly db: Db) {}

  /** Save (or refresh) folders, in the caller's transaction or its own. */
  record(placeId: string, folders: readonly (FolderRecord & { parent: string })[], seenAt: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO scan_folders (place_id, rel_path, parent, mtime, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (place_id, rel_path) DO UPDATE SET parent = excluded.parent, mtime = excluded.mtime, seen_at = excluded.seen_at`,
    );
    this.db.transaction(() => {
      for (const f of folders) stmt.run(placeId, f.relPath, f.parent, f.mtime, seenAt);
    })();
  }

  get(placeId: string, relPath: string): FolderRecord | undefined {
    const row = this.db.prepare('SELECT rel_path, mtime FROM scan_folders WHERE place_id = ? AND rel_path = ?').get(placeId, relPath) as { rel_path: string; mtime: number } | undefined;
    return row ? { relPath: row.rel_path, mtime: row.mtime } : undefined;
  }

  /** The known folders directly inside `parent`. (INDEXED BY: left alone the planner walks the whole place for every folder.) */
  children(placeId: string, parent: string): FolderRecord[] {
    const rows = this.db.prepare('SELECT rel_path, mtime FROM scan_folders INDEXED BY idx_scan_folders_parent WHERE place_id = ? AND parent = ? AND rel_path <> parent').all(placeId, parent) as { rel_path: string; mtime: number }[];
    return rows.map((r) => ({ relPath: r.rel_path, mtime: r.mtime }));
  }

  /** Forget a folder and everything known below it (the folder itself is gone). */
  forget(placeId: string, relPath: string): void {
    const prefix = relPath === '' ? '' : `${relPath}/`;
    this.db.prepare('DELETE FROM scan_folders WHERE place_id = ? AND rel_path = ?').run(placeId, relPath);
    if (prefix === '') this.db.prepare('DELETE FROM scan_folders WHERE place_id = ?').run(placeId);
    else this.db.prepare('DELETE FROM scan_folders WHERE place_id = ? AND rel_path >= ? AND rel_path < ?').run(placeId, prefix, prefixUpperBound(prefix));
  }

  /** After a full walk of `relRoot`: forget folders under it that the walk did not see (they are gone). */
  forgetUnseen(placeId: string, relRoot: string, seenBefore: number): number {
    const prefix = relRoot === '' ? '' : `${relRoot}/`;
    if (prefix === '') return this.db.prepare('DELETE FROM scan_folders WHERE place_id = ? AND seen_at < ?').run(placeId, seenBefore).changes;
    return this.db
      .prepare('DELETE FROM scan_folders WHERE place_id = ? AND seen_at < ? AND (rel_path = ? OR (rel_path >= ? AND rel_path < ?))')
      .run(placeId, seenBefore, relRoot, prefix, prefixUpperBound(prefix)).changes;
  }

  count(placeId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM scan_folders WHERE place_id = ?').get(placeId) as { n: number }).n;
  }
}
