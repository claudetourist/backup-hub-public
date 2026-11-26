import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db';
import { rawFs as fs } from '../rawFs';
import { FolderIndex, nameOf, parentOf, type FolderRecord } from './folderIndex';
import { upsertFiles, type ListedFile } from './fileStore';
import { fsIdOf } from './fsId';
import { matchMoves } from './moveMatch';
import { isInsideOrSame, isSkippedEntry, prefixUpperBound, skipSet } from './skipRules';

export interface QuickWalkOptions {
  db: Db;
  placeId: string;
  /** The folder to look at, as a path on this PC. */
  root: string;
  /** The stored `rel_path` of an absolute path of this place. */
  relOf: (abs: string) => string;
  /** Folders never entered (the app's own data, OneDrive when looking at the laptop). */
  excludeDirs?: readonly string[];
  /** The skip list (folder names, any depth, any case). Empty for a backup drive. */
  skipFolders?: readonly string[];
  now?: () => number;
  signal?: AbortSignal;
  /** Called every so often; the job lets other work in and reports progress there. */
  tick?: (counts: QuickWalkCounts) => Promise<void> | void;
  /** Folders and rows are saved in groups of about this many rows. */
  saveEvery?: number;
  /** NTFS (the laptop, OneDrive): save each file's system id (silently, not a change) and recognise renamed or moved files at the end of a complete look. */
  trustFsId?: boolean;
}

export interface QuickWalkCounts {
  foldersRead: number;
  foldersSkipped: number;
  /** Files seen for the first time or that came back. */
  added: number;
  /** Files whose size or date changed. */
  changed: number;
  /** Files (and files below vanished folders) newly marked as no longer there. */
  gone: number;
}

export interface QuickWalkResult extends QuickWalkCounts {
  /** False when something other than access-denied went wrong, or the root is missing: the pass still saved what it could. */
  complete: boolean;
  rootMissing: boolean;
  deniedFolders: number;
  firstError: string | null;
  /** Files recognised as renamed or moved at the end of a complete look (the old row kept, with its new path). They are not counted as added or gone. */
  moved: number;
}

const DEFAULT_SAVE_EVERY = 1000;
const TICK_EVERY_FOLDERS = 200;

function isDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

interface Found {
  files: ListedFile[];
  /** Names of the sub-folders found. */
  dirs: string[];
  /** Rel paths of entries that could not be read (access denied): their old rows are left alone. */
  denied: Set<string>;
  /** False when an entry failed for a reason other than access-denied. */
  ok: boolean;
}

/**
 * "Look again" at one folder tree of a place, cheaply: a folder whose modified time is the one saved last time is not
 * read (only its known sub-folders are visited); a changed or unknown folder is read, compared with the ledger and brought
 * up to date: new and changed files saved, files that are no longer there marked as gone (never deleted), sub-folders that
 * are gone forgotten along with their files. Reads names, sizes and dates only; no file is opened.
 */
export async function quickWalk(options: QuickWalkOptions): Promise<QuickWalkResult> {
  return new QuickWalk(options).run();
}

class QuickWalk {
  private readonly db: Db;
  private readonly folders: FolderIndex;
  private readonly now: () => number;
  private readonly exclude: readonly string[];
  private readonly skipDirs: ReadonlySet<string>;
  private readonly saveEvery: number;
  private readonly counts: QuickWalkCounts = { foldersRead: 0, foldersSkipped: 0, added: 0, changed: 0, gone: 0 };
  private complete = true;
  private rootMissing = false;
  private deniedFolders = 0;
  private firstError: string | null = null;
  private pendingFiles: ListedFile[] = [];
  private pendingGone: string[] = [];
  private pendingGoneFolders: string[] = [];
  private pendingFolders: (FolderRecord & { parent: string })[] = [];
  /** Files that did not change but have no (or another) system id saved: the id is filled in silently. */
  private pendingIds: { rel: string; fsId: string }[] = [];
  private readonly startedAt: number;

  constructor(private readonly o: QuickWalkOptions) {
    this.db = o.db;
    this.folders = new FolderIndex(o.db);
    this.now = o.now ?? Date.now;
    this.exclude = o.excludeDirs ?? [];
    this.skipDirs = skipSet(o.skipFolders);
    this.saveEvery = o.saveEvery ?? DEFAULT_SAVE_EVERY;
    this.startedAt = this.now();
  }

  private problem(err: unknown): void {
    this.complete = false;
    const e = err as NodeJS.ErrnoException;
    this.firstError ??= `${e.code ?? 'error'}: ${e.message}`;
  }

  async run(): Promise<QuickWalkResult> {
    const stack: string[] = [this.o.root];
    let first = true;
    let sinceTick = 0;
    while (stack.length > 0) {
      if (this.o.signal?.aborted) throw new Error('The check was stopped');
      const abs = stack.pop()!;
      await this.visit(abs, first, stack);
      first = false;
      sinceTick += 1;
      if (this.pendingSize() >= this.saveEvery) this.save();
      if (sinceTick >= TICK_EVERY_FOLDERS) {
        sinceTick = 0;
        this.save();
        await this.o.tick?.({ ...this.counts });
      }
    }
    this.save();
    // A look that did not finish recognises nothing (like it marks nothing gone): the files are then handled as before.
    let moved = 0;
    if (this.o.trustFsId === true && this.complete && !this.rootMissing) {
      moved = (await matchMoves(this.db, { placeId: this.o.placeId, runStart: this.startedAt, now: this.now(), pause: () => new Promise((resolve) => setTimeout(resolve, 15)) })).moved;
      this.counts.added = Math.max(0, this.counts.added - moved);
      this.counts.gone = Math.max(0, this.counts.gone - moved);
    }
    return { ...this.counts, complete: this.complete, rootMissing: this.rootMissing, deniedFolders: this.deniedFolders, firstError: this.firstError, moved };
  }

  private pendingSize(): number {
    return this.pendingFiles.length + this.pendingGone.length + this.pendingFolders.length + this.pendingIds.length;
  }

  /** Write everything gathered so far in ONE transaction, so a folder is never saved without its files. */
  private save(): void {
    if (this.pendingSize() + this.pendingGoneFolders.length === 0) return;
    const at = this.now();
    // IMMEDIATE: wait for other writers at BEGIN instead of failing with SQLITE_BUSY_SNAPSHOT midway.
    this.db.transaction(() => {
      if (this.pendingFiles.length > 0) upsertFiles(this.db, this.o.placeId, this.pendingFiles, at, true);
      const gone = this.db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND rel_path = ? AND gone_at IS NULL');
      for (const rel of this.pendingGone) gone.run(at, this.o.placeId, rel);
      if (this.pendingIds.length > 0) {
        const fill = this.db.prepare('UPDATE files SET fs_id = ? WHERE place_id = ? AND rel_path = ? AND fs_id IS NOT ?');
        for (const f of this.pendingIds) fill.run(f.fsId, this.o.placeId, f.rel, f.fsId);
      }
      for (const rel of this.pendingGoneFolders) {
        this.counts.gone += this.markBelowGone(rel, at);
        this.folders.forget(this.o.placeId, rel);
      }
      if (this.pendingFolders.length > 0) this.folders.record(this.o.placeId, this.pendingFolders, at);
    }).immediate();
    this.pendingFiles = [];
    this.pendingGone = [];
    this.pendingGoneFolders = [];
    this.pendingFolders = [];
    this.pendingIds = [];
  }

  private markBelowGone(relFolder: string, at: number): number {
    const prefix = relFolder === '' ? '' : `${relFolder}/`;
    if (prefix === '') return this.db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND gone_at IS NULL').run(at, this.o.placeId).changes;
    return this.db
      .prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND gone_at IS NULL AND rel_path >= ? AND rel_path < ?')
      .run(at, this.o.placeId, prefix, prefixUpperBound(prefix)).changes;
  }

  private async visit(abs: string, isRoot: boolean, stack: string[]): Promise<void> {
    const rel = this.o.relOf(abs);
    let st: BigIntStats;
    try {
      st = await fs.promises.lstat(abs, { bigint: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (isRoot) {
          this.rootMissing = true;
          this.complete = false;
          this.firstError ??= `ENOENT: ${abs} was not found`;
        } else this.vanished(rel);
      } else if (isDenied(err)) this.deniedFolders += 1;
      else this.problem(err);
      return;
    }
    if (!st.isDirectory()) {
      // Replaced by a file or a link: its folder is gone; the parent (changed too) lists whatever took its place.
      if (isRoot) {
        this.rootMissing = true;
        this.complete = false;
      } else this.vanished(rel);
      return;
    }
    const mtime = Number(st.mtimeMs);
    const known = this.folders.get(this.o.placeId, rel);
    if (known && known.mtime === mtime) {
      this.counts.foldersSkipped += 1;
      for (const child of this.folders.children(this.o.placeId, rel)) {
        // A known folder that is on the skip list now: its files in the list are marked gone (nothing is deleted).
        if (this.skipDirs.has(nameOf(child.relPath).toLowerCase())) this.vanished(child.relPath);
        else stack.push(path.join(abs, nameOf(child.relPath)));
      }
      return;
    }
    await this.read(abs, rel, mtime, stack);
  }

  private vanished(rel: string): void {
    this.pendingGoneFolders.push(rel);
  }

  /** Read one folder, compare it with the ledger and queue the differences. */
  private async read(abs: string, rel: string, mtime: number, stack: string[]): Promise<void> {
    let found: Found;
    try {
      found = await this.readEntries(abs, rel);
    } catch (err) {
      if (isDenied(err)) this.deniedFolders += 1;
      else if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.vanished(rel);
      else this.problem(err);
      return;
    }
    this.counts.foldersRead += 1;
    const prefix = rel === '' ? '' : `${rel}/`;
    const existing = this.existingFiles(prefix);
    const seen = new Set<string>();
    for (const f of found.files) {
      seen.add(f.relPath);
      const old = existing.get(f.relPath);
      if (!old) this.counts.added += 1;
      else if (old.goneAt !== null) this.counts.added += 1;
      else if (old.size !== f.size || old.mtime !== f.mtimeMs) this.counts.changed += 1;
      else {
        if (f.fsId != null && old.fsId !== f.fsId) this.pendingIds.push({ rel: f.relPath, fsId: f.fsId });
        continue;
      }
      this.pendingFiles.push(f);
    }
    for (const [relPath, old] of existing) {
      if (seen.has(relPath) || old.goneAt !== null || found.denied.has(relPath)) continue;
      this.pendingGone.push(relPath);
      this.counts.gone += 1;
    }
    const dirRels = new Set(found.dirs.map((d) => `${prefix}${d}`));
    for (const child of this.folders.children(this.o.placeId, rel)) {
      if (!dirRels.has(child.relPath) && !found.denied.has(child.relPath)) this.vanished(child.relPath);
    }
    for (const d of found.dirs) stack.push(path.join(abs, d));
    if (found.ok) this.pendingFolders.push({ relPath: rel, parent: parentOf(rel), mtime });
    else this.complete = false;
  }

  /** The live and gone files directly in a folder (not those in sub-folders). */
  private existingFiles(prefix: string): Map<string, { size: number | null; mtime: number | null; goneAt: number | null; fsId: string | null }> {
    const rows = (
      prefix === ''
        ? this.db.prepare("SELECT rel_path, size, mtime, gone_at, fs_id FROM files WHERE place_id = ? AND instr(rel_path, '/') = 0").all(this.o.placeId)
        : this.db
            .prepare("SELECT rel_path, size, mtime, gone_at, fs_id FROM files WHERE place_id = ? AND rel_path >= ? AND rel_path < ? AND instr(substr(rel_path, ?), '/') = 0")
            .all(this.o.placeId, prefix, prefixUpperBound(prefix), prefix.length + 1)
    ) as { rel_path: string; size: number | null; mtime: number | null; gone_at: number | null; fs_id: string | null }[];
    return new Map(rows.map((r) => [r.rel_path, { size: r.size, mtime: r.mtime, goneAt: r.gone_at, fsId: r.fs_id }]));
  }

  private async readEntries(abs: string, rel: string): Promise<Found> {
    const found: Found = { files: [], dirs: [], denied: new Set(), ok: true };
    const handle = await fs.promises.opendir(abs);
    const prefix = rel === '' ? '' : `${rel}/`;
    try {
      for await (const entry of handle) {
        if (this.o.signal?.aborted) throw new Error('The check was stopped');
        if (isSkippedEntry(abs, entry.name)) continue;
        const child = path.join(abs, entry.name);
        let st: BigIntStats;
        try {
          st = await fs.promises.lstat(child, { bigint: true });
        } catch (err) {
          if (isDenied(err)) found.denied.add(`${prefix}${entry.name}`);
          else if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.problem(err);
            found.ok = false;
          }
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (this.exclude.some((x) => isInsideOrSame(child, x)) || this.skipDirs.has(entry.name.toLowerCase())) continue;
          found.dirs.push(entry.name);
        } else if (st.isFile()) {
          found.files.push({ relPath: `${prefix}${entry.name}`, size: Number(st.size), mtimeMs: Number(st.mtimeMs), cloudOnly: false, fsId: this.o.trustFsId === true ? fsIdOf(st) : null });
        }
      }
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    return found;
  }
}
