/**
 * Google Keep notes (keep-sync), R2.8. keep-sync saves snapshots of ALL the person's notes, unencrypted, under %LOCALAPPDATA%\\keep-sync\\data\\backups.
 * PRIVACY, by construction: this module and the engine only ever know names, sizes, dates and checksums of these files. Nothing opens one except the
 * copy's own read stream (folderSource.ts `fileOps`, which hashes while it hands each block on); nothing parses, previews, indexes or logs what is
 * inside. The files get no rows in the file list (so no Files search, no "Why?"): this source lists them in memory.
 *
 * Sources (read only, never changed or deleted): `snapshots\\` (files "keep-YYYYMMDD-HHMMSS.jsonl.gz") and, when it exists, the other folders of
 * `backups\\` (timestamped folders that hold keep.txt). The copy is a flat, add-only mirror: a file is copied when no file of that name is on the drive.
 */
import path from 'node:path';
import { rawFs as fs } from '../rawFs';
import type { FolderSource, SourceEntry, SourceLookResult } from './folderTypes';
import { fileOps } from './fileOps';

const SNAPSHOTS = 'snapshots';

export interface KeepSyncPaths {
  /** %LOCALAPPDATA%\\keep-sync\\data\\backups */
  backups: string;
  snapshots: string;
}

/** Where keep-sync keeps its files. The folder comes from the environment (never a typed-in user name); null when it is not set. */
export function keepSyncPaths(localAppData: string | undefined = process.env['LOCALAPPDATA']): KeepSyncPaths | null {
  if (localAppData === undefined || localAppData.trim() === '') return null;
  const backups = path.join(localAppData, 'keep-sync', 'data', 'backups');
  return { backups, snapshots: path.join(backups, SNAPSHOTS) };
}

export async function keepSyncAvailable(localAppData?: string): Promise<boolean> {
  const p = keepSyncPaths(localAppData);
  if (p === null) return false;
  try {
    return (await fs.promises.stat(p.snapshots)).isDirectory();
  } catch {
    return false;
  }
}

interface Walked {
  entries: SourceEntry[];
  complete: boolean;
  firstError: string | null;
}

/** Names, sizes and dates of the files below `dir` (never opened). `skipTop`: a folder name directly below `dir` that is left to the other source. */
async function walk(dir: string, prefix: string, skipTop: string | null, signal: AbortSignal, out: Walked, isTop = true): Promise<void> {
  let names: import('node:fs').Dirent[];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    out.complete = false;
    out.firstError ??= `${(err as NodeJS.ErrnoException).code ?? 'error'}: a folder could not be read`;
    return;
  }
  for (const e of names) {
    if (signal.aborted) throw new Error('The look was stopped');
    if (isTop && skipTop !== null && e.isDirectory() && e.name.toLowerCase() === skipTop) continue;
    const abs = path.join(dir, e.name);
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      await walk(abs, rel, null, signal, out, false);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = await fs.promises.lstat(abs);
      out.entries.push({ rel, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), rowId: null, sha256: null, cloudOnly: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      out.complete = false;
      out.firstError ??= `${(err as NodeJS.ErrnoException).code ?? 'error'}: a file could not be read`;
    }
  }
}

export function keepSyncSource(localAppData?: string): { ok: true; source: FolderSource } | { ok: false; message: string } {
  const paths = keepSyncPaths(localAppData);
  if (paths === null) return { ok: false, message: 'Backup Hub cannot tell where keep-sync keeps its files on this computer.' };
  const { snapshots, backups } = paths;
  const place = async (rel: string): Promise<string | null> => {
    for (const base of [snapshots, backups]) {
      const abs = path.join(base, ...rel.split('/').filter((s) => s !== ''));
      try {
        await fs.promises.lstat(abs);
        return abs;
      } catch {
        // the next source
      }
    }
    return null;
  };
  const source: FolderSource = {
    words: 'the keep-sync snapshots',
    placeId: null,
    relBase: '',
    cloudAware: false,
    async look({ signal, progress }): Promise<SourceLookResult> {
      progress('Looking at the keep-sync snapshots. Nothing is copied or opened.');
      try {
        if (!(await fs.promises.stat(snapshots)).isDirectory()) return { complete: false, rootMissing: true, message: null };
      } catch {
        return { complete: false, rootMissing: true, message: null };
      }
      const found: Walked = { entries: [], complete: true, firstError: null };
      await walk(snapshots, '', null, signal, found);
      // The timestamped folders of keep.txt, when they exist: everything in backups\ except the snapshots folder.
      const second: Walked = { entries: [], complete: true, firstError: null };
      let hasSecond = true;
      try {
        await fs.promises.stat(backups);
      } catch {
        hasSecond = false;
      }
      if (hasSecond) await walk(backups, '', SNAPSHOTS, signal, second);
      const seen = new Set(found.entries.map((e) => e.rel.toLowerCase()));
      const entries = [...found.entries, ...second.entries.filter((e) => e.rel.includes('/') && !seen.has(e.rel.toLowerCase()))].toSorted((a, b) => (a.rel < b.rel ? -1 : 1));
      return { complete: found.complete && second.complete, rootMissing: false, message: found.firstError ?? second.firstError, entries };
    },
    ...fileOps(place),
    async cloudStates(rels) {
      return new Map(rels.map((r) => [r, 'local' as const]));
    },
  };
  return { ok: true, source };
}
