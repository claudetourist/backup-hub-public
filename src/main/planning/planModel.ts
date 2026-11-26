/**
 * Pure rules for the "Back up now" plan: which local copy to read (laptop first, then a named drive) and where a file sits below the root
 * that holds it. No database, no files, no network.
 */
import type { CollectionRoot } from '../../shared/collections';

/** Local places a file can be read from, best first: the laptop, then a named drive. */
export const SOURCE_KINDS: readonly string[] = ['laptop', 'drive'];

export function sourceRank(kind: string): number {
  const i = SOURCE_KINDS.indexOf(kind);
  return i === -1 ? SOURCE_KINDS.length : i;
}

/** The path of a file below the root that holds it ("D:/MyData/Reunion" + "D:/MyData/Reunion/final/a.mp4" = "final/a.mp4"). */
export function belowRoot(root: CollectionRoot, relPath: string): string | null {
  if (root.relPath === '') return relPath;
  return relPath.startsWith(`${root.relPath}/`) ? relPath.slice(root.relPath.length + 1) : null;
}

/** The longest root of the file's own place that holds it, else null. */
export function rootOf(roots: readonly CollectionRoot[], placeId: string, relPath: string): CollectionRoot | null {
  let best: CollectionRoot | null = null;
  for (const r of roots) {
    if (r.placeId !== placeId || belowRoot(r, relPath) === null) continue;
    if (best === null || r.relPath.length > best.relPath.length) best = r;
  }
  return best;
}
