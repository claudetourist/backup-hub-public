/**
 * Old dated app data copies. The ONLY module that removes a folder tree from a drive in Backup Hub, and it removes only
 * `<drive's backups made by Backup Hub folder>\Laptop-AppData\<this laptop>\<YYYY-MM-DD[-n]>` folders that hold a `manifest.json` written by this laptop.
 *
 * Nothing is removed by itself: `listOldCopies` only reads (it makes the "Remove 3 old copies (1.2 GB)" item), and
 * `pruneOldCopies` runs only with the exact count and size the person was shown and an explicit confirm.
 */
import type { Dirent } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { APPDATA_MANIFEST } from '../../shared/plans';
import { assertWritable } from '../fsutil';
import { laptopFolder } from './snapshotJob';
import { ownRemove } from '../danger/ownFiles';

const DATED = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;

export interface OldCopies {
  /** Folder names (not paths), oldest first. */
  folders: string[];
  count: number;
  bytes: number;
}

function sortKey(name: string): [string, number] {
  const m = DATED.exec(name)!;
  return [m[1]!, m[2] ? Number(m[2]) : 1];
}

function folderBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(current, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) {
        try {
          total += fs.statSync(abs).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return total;
}

/** True when the folder holds a manifest that this laptop wrote (same device id). */
function isOurs(dir: string, deviceId: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, APPDATA_MANIFEST), 'utf8')) as { format?: unknown; device?: { id?: unknown } };
    return manifest.format === 'backuphub-appdata' && manifest.device?.id === deviceId;
  } catch {
    return false;
  }
}

/** Read only: the good dated copies of this laptop on the drive beyond the newest `keep`. */
export function listOldCopies(root: string, laptop: { id: string; name: string }, keep: number): OldCopies {
  const parent = laptopFolder(root, laptop.name);
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return { folders: [], count: 0, bytes: 0 };
  }
  const good = entries
    .filter((e) => e.isDirectory() && DATED.test(e.name) && isOurs(path.join(parent, e.name), laptop.id))
    .map((e) => e.name)
    .toSorted((a, b) => {
      const [da, na] = sortKey(a);
      const [db, nb] = sortKey(b);
      return da < db ? -1 : da > db ? 1 : na - nb;
    });
  const old = good.slice(0, Math.max(0, good.length - Math.max(1, keep)));
  return { folders: old, count: old.length, bytes: old.reduce((n, f) => n + folderBytes(path.join(parent, f)), 0) };
}

/** The dated good copies of this laptop (newest last), for the "last good copy" of a drive. */
export function goodCopies(root: string, laptop: { id: string; name: string }): string[] {
  const parent = laptopFolder(root, laptop.name);
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DATED.test(e.name) && isOurs(path.join(parent, e.name), laptop.id))
      .map((e) => e.name)
      .toSorted((a, b) => {
        const [da, na] = sortKey(a);
        const [db, nb] = sortKey(b);
        return da < db ? -1 : da > db ? 1 : na - nb;
      });
  } catch {
    return [];
  }
}

export type PruneOutcome = { ok: true; removed: number; bytes: number } | { ok: false; message: string };

/**
 * Removes the old copies. Refuses unless the person confirmed AND the count and size are still exactly what was shown.
 * Each folder is checked again right before it goes: name pattern, inside this laptop's folder, manifest of this laptop.
 */
export function pruneOldCopies(root: string, laptop: { id: string; name: string }, keep: number, expected: { count: number; bytes: number; confirmed: boolean }): PruneOutcome {
  if (!expected.confirmed) return { ok: false, message: 'Please confirm first. Nothing was removed.' };
  const now = listOldCopies(root, laptop, keep);
  if (now.count === 0) return { ok: false, message: 'There are no old copies to remove. Nothing was removed.' };
  if (now.count !== expected.count || now.bytes !== expected.bytes) return { ok: false, message: 'The old copies changed since you last checked. Look at the list again. Nothing was removed.' };
  const parent = laptopFolder(root, laptop.name);
  let removed = 0;
  for (const name of now.folders) {
    const dir = path.join(parent, name);
    if (!DATED.test(name) || path.dirname(dir) !== parent || !isOurs(dir, laptop.id)) continue;
    assertWritable(dir);
    ownRemove(dir, { recursive: true });
    removed += 1;
  }
  return { ok: true, removed, bytes: now.bytes };
}
