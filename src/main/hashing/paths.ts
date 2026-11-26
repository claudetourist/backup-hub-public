import path from 'node:path';

/**
 * Turn a stored rel_path back into the path on this PC, or null when it cannot be trusted.
 * - laptop: rel_path IS the absolute path with forward slashes ("D:/MyData/a.jpg").
 * - named drive / OneDrive: `base` (current drive root / OneDrive folder) plus rel_path.
 * A rel_path with ".." or "." segments is refused, so a bad row can never point outside its place.
 */
export function absolutePathFor(kind: 'laptop' | 'drive' | 'onedrive', base: string, relPath: string): string | null {
  const segments = relPath.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;
  if (kind === 'laptop') {
    if (!/^[A-Za-z]:\//.test(relPath)) return null;
    return path.normalize(relPath);
  }
  if (relPath === '' || base === '') return null;
  if (segments.some((s) => s === '')) return null;
  const joined = path.join(base, ...segments);
  const root = path.resolve(base);
  return joined.startsWith(root) ? joined : null;
}
