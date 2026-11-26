import type { CardRead, DriveCard } from './driveCard';
import { DRIVE_TYPE_FIXED, DRIVE_TYPE_REMOVABLE, type Volume } from './volumes';

/** What we remember about a drive place, for matching a volume without a card. */
export interface KnownDrive {
  placeId: string;
  label: string;
  serial: string | null;
}

export type VolumeMatch =
  | { kind: 'card'; volume: Volume; card: DriveCard }
  /** The volume has a card, but another connected volume already claimed the same id. */
  | { kind: 'duplicate'; volume: Volume; card: DriveCard }
  /** An ID card exists but cannot be read or understood: never overwrite it. */
  | { kind: 'invalid-card'; volume: Volume; reason: string }
  /** Cards at the new and the old place name different drives: needs the person's decision; nothing is written to the drive. `card` is the new place's. */
  | { kind: 'card-conflict'; volume: Volume; card: DriveCard; oldCard: DriveCard }
  /**
   * The drive could not be read (an error, or no answer in time) and its serial number is that of exactly one known drive: it is that
   * drive, plugged in, with a problem. It is not "gone" and not usable.
   */
  | { kind: 'unreadable'; volume: Volume; reason: string; placeId: string; label: string }
  /** No card; the serial number matches exactly one known drive. */
  | { kind: 'serial'; volume: Volume; placeId: string; label: string }
  | { kind: 'none'; volume: Volume };

/** Smaller volumes (recovery and boot partitions that happen to have a letter) are not offered as drives. */
export const MIN_DRIVE_BYTES = 1_000_000_000;

const NO_LETTERS: ReadonlySet<string> = new Set();

/** Volumes the app looks at: a letter, a file system, a removable or fixed disk. */
export function isCandidate(volume: Volume, systemDrive: string, laptopLetters: ReadonlySet<string> = NO_LETTERS): boolean {
  if (!volume.letter || volume.letter === systemDrive.toUpperCase()) return false;
  // Partitions on the same physical disk as Windows (D: and E: on this laptop) belong to the laptop place.
  if (laptopLetters.has(volume.letter)) return false;
  if (volume.driveType !== DRIVE_TYPE_REMOVABLE && volume.driveType !== DRIVE_TYPE_FIXED) return false;
  // An empty card reader has no file system or size.
  return volume.fileSystem !== null && (volume.capacity ?? 0) >= MIN_DRIVE_BYTES;
}

/**
 * Decide, for each candidate volume, which drive it is. The card id is the identity; the serial
 * number is only a fallback for a volume with NO card, and only when it matches exactly one known
 * drive that is not already claimed by a card elsewhere. `cards` is keyed by drive letter.
 */
export function matchVolumes(
  volumes: readonly Volume[],
  cards: ReadonlyMap<string, CardRead>,
  known: readonly KnownDrive[],
  systemDrive: string,
  laptopLetters: ReadonlySet<string> = NO_LETTERS,
): VolumeMatch[] {
  const claimed = new Set<string>();
  const results: VolumeMatch[] = [];
  const withoutCard: Volume[] = [];
  const unreadable: { volume: Volume; reason: string }[] = [];
  for (const volume of volumes.filter((v) => isCandidate(v, systemDrive, laptopLetters))) {
    const read = cards.get(volume.letter ?? '') ?? { status: 'none' };
    if (read.status === 'ok') {
      if (claimed.has(read.card.id)) results.push({ kind: 'duplicate', volume, card: read.card });
      else {
        claimed.add(read.card.id);
        results.push({ kind: 'card', volume, card: read.card });
      }
    } else if (read.status === 'invalid') {
      results.push({ kind: 'invalid-card', volume, reason: read.reason });
    } else if (read.status === 'unreadable') {
      unreadable.push({ volume, reason: read.reason });
    } else if (read.status === 'conflict') {
      results.push({ kind: 'card-conflict', volume, card: read.card, oldCard: read.oldCard });
    } else {
      withoutCard.push(volume);
    }
  }
  for (const volume of withoutCard) {
    const serialMatches = volume.serial
      ? known.filter((k) => k.serial === volume.serial && !claimed.has(k.placeId))
      : [];
    const only = serialMatches.length === 1 ? serialMatches[0] : undefined;
    if (only) {
      claimed.add(only.placeId);
      results.push({ kind: 'serial', volume, placeId: only.placeId, label: only.label });
    } else results.push({ kind: 'none', volume });
  }
  // A drive that did not read: if its serial is a known drive's, it is that drive with a problem; else it is an unreadable card as before.
  for (const { volume, reason } of unreadable) {
    const serialMatches = volume.serial ? known.filter((k) => k.serial === volume.serial && !claimed.has(k.placeId)) : [];
    const only = serialMatches.length === 1 ? serialMatches[0] : undefined;
    if (only) {
      claimed.add(only.placeId);
      results.push({ kind: 'unreadable', volume, reason, placeId: only.placeId, label: only.label });
    } else results.push({ kind: 'invalid-card', volume, reason });
  }
  return results;
}
