import fs from 'node:fs';
import path from 'node:path';
import type { AddRootResult, RemoveRootResult } from '../../shared/listing';
import type { Db } from '../db';
import { markFolderGone } from './fileStore';
import type { KnownFolder } from './knownFolders';
import { folderPrefix, isInsideOrSame, pathKey, toSlashes } from './skipRules';

/** An extra folder the laptop lists first, when it exists: only what BACKUPHUB_FIRST_FOLDER names (nothing by default). */
export const defaultDataFolder = (env: NodeJS.ProcessEnv = process.env): string | null => env['BACKUPHUB_FIRST_FOLDER']?.trim() || null;

export interface RootServiceDeps {
  db: Db;
  now?: () => number;
  /** Reads the Documents, Desktop, Pictures and Videos folders from the registry. */
  readKnownFolders: () => Promise<KnownFolder[]>;
  /** OneDrive folders on this PC (never listed as part of the laptop). */
  oneDriveFolders: () => string[];
  /** Folders of the app itself (data and logs), which are never listed. */
  appFolders: () => string[];
  isDirectory?: (p: string) => boolean;
  /** Resolves the real spelling of a path (Windows case). */
  realPath?: (p: string) => string;
  /** True while a listing job for the place is waiting or running. */
  isListing: (placeId: string) => boolean;
  /** Tests pass null (or a temp folder) so no real folder is ever looked at. */
  defaultDataFolder?: string | null;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** Upper-case drive letter, no trailing separator (except for a drive root). */
export function normalizeRoot(p: string): string {
  let out = path.resolve(p);
  if (/^[a-z]:/.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
  if (out.length > 3) out = out.replace(/[\\/]+$/, '');
  return out;
}

/**
 * The folders each place lists. Laptop roots are absolute paths. Roots of named drives and OneDrive
 * are relative, and '' means the whole place. Nothing here writes to disk, only to `place_roots`.
 */
export class RootService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly isDirectory: (p: string) => boolean;
  private readonly realPath: (p: string) => string;

  constructor(private readonly deps: RootServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.isDirectory =
      deps.isDirectory ??
      ((p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    this.realPath =
      deps.realPath ??
      ((p) => {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return p;
        }
      });
  }

  list(placeId: string): string[] {
    return (this.db.prepare('SELECT root FROM place_roots WHERE place_id = ? ORDER BY root').all(placeId) as { root: string }[]).map((r) => r.root);
  }

  private insert(placeId: string, root: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO place_roots (place_id, root, created_at) VALUES (?, ?, ?)').run(placeId, root, this.now()).changes > 0;
  }

  private markSeeded(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, '1');
  }

  /**
   * Fill in the default roots once per place (a later removal is not undone). Drives and OneDrive get
   * the whole place (''); the laptop gets BACKUPHUB_FIRST_FOLDER when set and present, plus each known folder that is
   * not inside OneDrive.
   */
  async ensureDefaults(place: { id: string; kind: string }): Promise<string[]> {
    const seededKey = `roots.seeded.${place.id}`;
    const seeded = this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(seededKey) !== undefined;
    if (!seeded) {
      if (place.kind === 'drive' || place.kind === 'onedrive') {
        this.insert(place.id, '');
        this.markSeeded(seededKey);
      } else if (place.kind === 'laptop') {
        let known: KnownFolder[] = [];
        let readOk = true;
        try {
          known = await this.deps.readKnownFolders();
        } catch (err) {
          readOk = false;
          this.deps.log?.warn('listing: could not read the known folders:', err);
        }
        const candidates: string[] = [];
        const data = this.deps.defaultDataFolder === undefined ? defaultDataFolder() : this.deps.defaultDataFolder;
        if (data && this.isDirectory(data)) candidates.push(data);
        for (const k of known) if (this.isDirectory(k.path)) candidates.push(k.path);
        const oneDrive = this.deps.oneDriveFolders();
        for (const c of candidates) {
          const root = normalizeRoot(c);
          if (oneDrive.some((o) => isInsideOrSame(root, o))) continue;
          if (this.list(place.id).some((r) => isInsideOrSame(root, r) || isInsideOrSame(r, root))) continue;
          this.insert(place.id, root);
        }
        // If the registry could not be read, try again next time instead of settling for the first folder alone.
        if (readOk) this.markSeeded(seededKey);
      }
    }
    return this.list(place.id);
  }

  /** Add a folder to the laptop's list. Refuses (with a plain reason) anything inside OneDrive or inside/around another root. */
  addLaptopRoot(placeId: string, raw: unknown): AddRootResult {
    const row = this.db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined;
    if (!row) return { ok: false, canceled: false, message: 'That place no longer exists.' };
    if (row.kind !== 'laptop') return { ok: false, canceled: false, message: 'Only the laptop has folders you choose. Drives and OneDrive are checked whole.' };
    if (typeof raw !== 'string' || raw.trim() === '' || !path.isAbsolute(raw.trim())) {
      return { ok: false, canceled: false, message: 'Please pick a folder on this computer.' };
    }
    const picked = raw.trim();
    if (!this.isDirectory(picked)) return { ok: false, canceled: false, message: 'That folder could not be found.' };
    const root = normalizeRoot(this.realPath(picked));
    const oneDrive = this.deps.oneDriveFolders().find((o) => isInsideOrSame(root, o));
    if (oneDrive) {
      return { ok: false, canceled: false, message: 'That folder is inside OneDrive. OneDrive is checked as its own place, so it is not added to the laptop.' };
    }
    if (this.deps.appFolders().some((a) => isInsideOrSame(root, a) || isInsideOrSame(a, root))) {
      return { ok: false, canceled: false, message: "That folder holds Backup Hub's own data, which is never checked." };
    }
    for (const existing of this.list(placeId)) {
      if (pathKey(existing) === pathKey(root)) return { ok: false, canceled: false, message: 'That folder is already on the list.' };
      if (isInsideOrSame(root, existing)) {
        return { ok: false, canceled: false, message: `That folder is inside ${existing}, which is already on the list.` };
      }
      if (isInsideOrSame(existing, root)) {
        return { ok: false, canceled: false, message: `That folder contains ${existing}, which is already on the list. Take that one off the list first.` };
      }
    }
    this.insert(placeId, root);
    this.deps.log?.info(`listing: folder added to the laptop list: ${root}`);
    return { ok: true, root };
  }

  /**
   * Take a folder off the laptop's list. Needs `confirmed: true`. The listed files under it are
   * marked gone (never deleted).
   */
  removeLaptopRoot(placeId: string, root: unknown, confirmed: unknown): RemoveRootResult {
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was changed.' };
    if (typeof root !== 'string') return { ok: false, message: 'That folder is not on the list.' };
    const row = this.db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined;
    if (!row || row.kind !== 'laptop') return { ok: false, message: 'Only the laptop has folders you choose.' };
    if (this.deps.isListing(placeId)) return { ok: false, message: 'The laptop is being checked right now. Try again when it has finished.' };
    if (!this.list(placeId).includes(root)) return { ok: false, message: 'That folder is not on the list.' };
    let gone = 0;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM place_roots WHERE place_id = ? AND root = ?').run(placeId, root);
      gone = markFolderGone(this.db, placeId, folderPrefix(toSlashes(root)), this.now());
    })();
    this.deps.log?.info(`listing: folder taken off the laptop list: ${root} (${gone} files marked as no longer seen)`);
    return { ok: true, filesMarkedGone: gone };
  }
}
