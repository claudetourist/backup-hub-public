import type { FileKind } from '../../shared/fileKinds';

/**
 * "Show in Search": a screen leaves a starting filter here and opens Search, which reads it once when it opens.
 * It is plain module state because the app has no router.
 */
export interface SearchSeed {
  /** The place to look in; '' = every place. */
  placeId: string;
  /** Folder words for the "In folder" box. */
  folder: string;
  /** Only this kind of file (Home: "Camera videos"). */
  kind?: FileKind;
  /** Only files that no other place holds. Without it the seed means "fewer than 2 other copies" (the old Collections screen). */
  onlyOnePlace?: boolean;
  /** Only files with no fingerprint yet (Home: "N new or changed files need a quick check" > See which). */
  unfingerprinted?: boolean;
}

let pending: SearchSeed | null = null;

export function setSearchSeed(seed: SearchSeed): void {
  pending = seed;
}

/** Read without clearing (React may call an initializer twice); Search clears it in an effect. */
export function peekSearchSeed(): SearchSeed | null {
  return pending;
}

export function clearSearchSeed(): void {
  pending = null;
}
