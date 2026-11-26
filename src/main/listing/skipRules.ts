import path from 'node:path';
import { isAppOwnedEntry, LEGACY_CARD_FOLDER } from '../../shared/appFolders';

/**
 * Names never listed, whatever their folder (compared without regard to case). The card folder of an old-layout drive is among them;
 * the app's own files folder of the new layout is skipped by place (`isSkippedEntry`), never by name alone. The app's "Backups made
 * by Backup Hub" folder is NOT skipped: those are real backups and are listed and searched.
 */
export const SKIP_NAMES: ReadonlySet<string> = new Set(['$recycle.bin', 'system volume information', LEGACY_CARD_FOLDER, 'desktop.ini', 'thumbs.db', 'laptop-appdata']);

export function isSkippedName(name: string): boolean {
  return SKIP_NAMES.has(name.toLowerCase());
}

/** True when the entry `name` found in the folder `parentDir` is never listed: a skipped name, or the app's own files folder (in the app's folder). */
export function isSkippedEntry(parentDir: string, name: string): boolean {
  return isSkippedName(name) || isAppOwnedEntry(path.basename(parentDir), name);
}

/** The skip list as a lower-case set, for fast checks. */
export function skipSet(names: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((names ?? []).map((n) => n.toLowerCase()));
}

/** OneDrive's own locked marker at its root: a dot plus a GUID (".849C9593-D756-4E56-8D6E-42412F2A707B"). Not the user's file. */
const ONEDRIVE_MARKER = /^.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOneDriveMarkerName(name: string): boolean {
  return ONEDRIVE_MARKER.test(name);
}

/** True for a stored rel_path of a OneDrive file that is such a marker (a root-level name, no folder). */
export function isOneDriveMarkerRelPath(relPath: string): boolean {
  return !relPath.includes('/') && isOneDriveMarkerName(relPath);
}

const WINDOWS = process.platform === 'win32';

/** A comparable form of a path: absolute, no trailing separator, lower case on Windows. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return WINDOWS ? trimmed.toLowerCase() : trimmed;
}

/** True when `child` is `parent` or lies inside it. */
export function isInsideOrSame(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/** Absolute path to the rel_path form used for the laptop: forward slashes ("D:/MyData/a.jpg"). */
export function toSlashes(p: string): string {
  return p.split(path.sep).join('/');
}

/** The prefix every path under a folder shares in rel_path form: ends with "/". */
export function folderPrefix(relFolder: string): string {
  return relFolder === '' ? '' : relFolder.replace(/\/+$/, '') + '/';
}

/** Smallest string above every path that starts with `prefix` (which ends with "/"): "/" becomes "0". */
export function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + '0';
}
