import type { CollectionRoot } from '../../shared/collections';

/**
 * What is left of the collection counts after the Collections screen went (R0.1b): the one rule the "Back up now" plan
 * (localCopy/localPlanner.ts) still uses to find the files of a collection root. Collection coverage, protection by kind and
 * the Home insights are gone.
 */

/** The files under a root: its path itself, or anything below "path/" ('/' is followed by '0' in ASCII, so that is the end of the range). */
export function rootCondition(root: CollectionRoot): { sql: string; params: (string | number)[] } {
  if (root.relPath === '') return { sql: '(place_id = ?)', params: [root.placeId] };
  return {
    sql: '(place_id = ? AND ((rel_path >= ? AND rel_path < ?) OR rel_path = ?))',
    params: [root.placeId, `${root.relPath}/`, `${root.relPath}0`, root.relPath],
  };
}
