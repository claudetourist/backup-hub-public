/**
 * What is left of the Start run's shared words (R0.1b): the drives by name, the Backups layout rule that the phone clean-up
 * safety rule uses, and the free-space line for Google accounts. Pure data and pure
 * functions only.
 *
 * Words: "T7" and "Seagate2TB" are found by NAME (their card), never by drive letter.
 */

/** The drives, by name. */
export const T7_NAME = 'T7';
export const SEAGATE_NAME = 'Seagate2TB';

/** Folders on the drives (layout of the plan). */
const BACKUPS_ROOT = 'Backups';
const OLD_VERSIONS_FOLDER = '_old-versions';
const DAMAGED_FOLDER = '_damaged';

/**
 * True for a file in the CURRENT backup layout: below `Backups\`, but not in `_old-versions` (the user can clean those from the
 * T7) and not a half copy. Only such a copy counts when Backup Hub decides that a phone file may be removed from the phone.
 */
export function isCurrentBackupRel(relPath: string): boolean {
  const p = relPath.split('\\').join('/').toLowerCase();
  if (!p.startsWith(`${BACKUPS_ROOT.toLowerCase()}/`)) return false;
  if (p.startsWith(`${BACKUPS_ROOT.toLowerCase()}/${OLD_VERSIONS_FOLDER}/`)) return false;
  if (p.startsWith(`${BACKUPS_ROOT.toLowerCase()}/${DAMAGED_FOLDER}/`)) return false;
  return !p.endsWith('.bhpart') && !p.endsWith('.bhpart.tmp');
}

/** Every Google account keeps at least this share of its space free. A setting, 20 to 50. */
export const DEFAULT_KEEP_FREE_PERCENT = 25;
export const MIN_KEEP_FREE_PERCENT = 20;
export const MAX_KEEP_FREE_PERCENT = 50;

/** The most an account may be filled to: its space times (1 - keepFree/100), rounded down. */
export function lineBytes(limitBytes: number, keepFreePercent: number): number {
  return Math.floor(limitBytes * (1 - keepFreePercent / 100));
}

/** What an account can still take before it crosses the line: max(0, quota * (1 - percent/100) - used). */
export function canStillTake(limitBytes: number, usedBytes: number, keepFreePercent: number): number {
  return Math.max(0, lineBytes(limitBytes, keepFreePercent) - usedBytes);
}
