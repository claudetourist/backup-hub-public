/**
 * What is left of the collection types after the Collections screen went (R0.1b): the root of a collection (used by the
 * "Back up now" plan) and the off-site rule. Pure data and pure functions only.
 * A copy in a Google Drive account or in OneDrive is "off-site": it is a cloud copy, away from the house.
 */

/** Place kinds whose copies are away from the house. */
const OFFSITE_KINDS: ReadonlySet<string> = new Set(['gdrive', 'onedrive']);

export function isOffsiteKind(kind: string): boolean {
  return OFFSITE_KINDS.has(kind);
}

/** A place and a folder in it ('' = the whole place). Forward slashes, no trailing slash, as listed. */
export interface CollectionRoot {
  placeId: string;
  relPath: string;
}
