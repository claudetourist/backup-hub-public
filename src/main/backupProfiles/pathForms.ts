/**
 * Path spellings for backup profiles. Stored paths use forward slashes and no drive letter (`rel_path` form); Windows paths in an old
 * history file (`F:\MyData\POCO\x.jpg`) are turned into that form here. Letters are never stored for a drive: a drive is found by its card.
 */

/** "F:\MyData\POCO\x" -> { letter: "F:", rel: "MyData/POCO/x" }. Null for a path that is not on a lettered drive (UNC, relative). */
export function splitDrivePath(windowsPath: string): { letter: string; rel: string } | null {
  const m = /^([A-Za-z]:)[\\/]*(.*)$/.exec(windowsPath.trim());
  if (!m) return null;
  const rel = m[2]!.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return { letter: m[1]!.toUpperCase(), rel };
}

/** A folder below a drive as the store keeps it: forward slashes, no leading or trailing slash. Null when it could leave the drive. */
export function cleanRoot(root: string): string | null {
  const rel = root.trim().replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel === '') return '';
  if (/^[A-Za-z]:/.test(rel)) return null;
  if (rel.split('/').some((s) => s === '.' || s === '..' || s === '')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(rel)) return null;
  return rel;
}

/** Whole-path comparison key: forward slashes, no trailing slash, lower case (Windows paths do not care about case). */
export function pathKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** True when `candidateKey` is `folderKey` itself or lies below it (both made with `pathKey`; '' is every path). */
export function isUnder(candidateKey: string, folderKey: string): boolean {
  return folderKey === '' || candidateKey === folderKey || candidateKey.startsWith(`${folderKey}/`);
}
