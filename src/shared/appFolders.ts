/**
 * THE one place that spells the folder names Backup Hub uses on a backup drive (and on the laptop's volumes for the clean-up
 * quarantine). A static test checks that no other file spells them. Pure data and pure functions only (no node imports), so the
 * window can use the same words as main. Main builds real paths with `main/places/appFolders.ts`.
 *
 * Everything the app makes on a drive lives under ONE folder inside the drive's MyData folder:
 *
 *   <drive>\MyData\Backup Hub - made by the app\
 *      Backups made by Backup Hub\      backup content the app itself creates (not one of the user's own backup folders)
 *      App's own files\                 the app's working files; never listed, never copied, never searched
 *         <card folder>\                the drive's ID card (drive.json), tmp, set-aside
 *         Database safety copies\       the app's own database / settings copies and the laptop app data copies
 *         Quarantine\                   the laptop clean-up quarantine
 *
 * Older drives still have the card folder at the drive root. It is read (never written) until the drive is moved to the layout above.
 */

export const MY_DATA_FOLDER = 'MyData';
export const APP_FOLDER = 'Backup Hub - made by the app';
export const BACKUPS_FOLDER = 'Backups made by Backup Hub';
export const OWN_FILES_FOLDER = "App's own files";
export const DB_COPIES_FOLDER = 'Database safety copies';
export const QUARANTINE_FOLDER = 'Quarantine';

/** The card folder: inside the app's own files on a drive in the current layout, at the drive root in the old one. */
export const CARD_FOLDER = '.backuphub';
export const CARD_FILE = 'drive.json';
export const DRIVE_TMP_FOLDER = 'tmp';
export const SET_ASIDE_FOLDER = 'set-aside';
export const LISTS_FOLDER = 'lists';

/** Old layout names (drives that have not been moved yet). Read and recognised, never written. */
export const LEGACY_CARD_FOLDER = CARD_FOLDER;
export const LEGACY_QUARANTINE_FOLDER = 'BackupHub-quarantine';

/** Folder names from the drive root, for building paths and rel paths. */
export const APP_FOLDER_PARTS: readonly string[] = [MY_DATA_FOLDER, APP_FOLDER];
export const BACKUPS_PARTS: readonly string[] = [...APP_FOLDER_PARTS, BACKUPS_FOLDER];
/** The Google Keep notes copies (R2.8): a flat folder inside the app's backups folder (nothing loose in MyData). */
export const KEEP_SYNC_FOLDER = 'keep-sync';
export const KEEP_SYNC_PARTS: readonly string[] = [...BACKUPS_PARTS, KEEP_SYNC_FOLDER];
export const OWN_FILES_PARTS: readonly string[] = [...APP_FOLDER_PARTS, OWN_FILES_FOLDER];
export const CARD_PARTS: readonly string[] = [...OWN_FILES_PARTS, CARD_FOLDER];
export const DRIVE_TMP_PARTS: readonly string[] = [...CARD_PARTS, DRIVE_TMP_FOLDER];
export const SET_ASIDE_PARTS: readonly string[] = [...CARD_PARTS, SET_ASIDE_FOLDER];
export const LISTS_PARTS: readonly string[] = [...CARD_PARTS, LISTS_FOLDER];
export const DB_COPIES_PARTS: readonly string[] = [...OWN_FILES_PARTS, DB_COPIES_FOLDER];
export const QUARANTINE_PARTS: readonly string[] = [...OWN_FILES_PARTS, QUARANTINE_FOLDER];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** True for the folder "App's own files" (its name, and the app folder as its parent's name). Case ignored. */
export function isOwnFilesFolder(parentName: string, name: string): boolean {
  return same(name, OWN_FILES_FOLDER) && same(parentName, APP_FOLDER);
}

/** True when a folder entry must never be listed: the app's own files, or the card folder of an old-layout drive. */
export function isAppOwnedEntry(parentName: string, name: string): boolean {
  return same(name, LEGACY_CARD_FOLDER) || isOwnFilesFolder(parentName, name);
}

/** True when any part of the path is the card folder (card, tmp, set-aside): new layout or old. Either slash. */
export function isInsideCardFolder(p: string): boolean {
  return p.split(/[\\/]+/).some((s) => same(s, CARD_FOLDER));
}

/** True when any part of the path is the app's own files folder (new layout) or the card folder (old layout). Either slash. */
export function isInsideAppOwnFiles(p: string): boolean {
  const parts = p.split(/[\\/]+/);
  for (let i = 0; i < parts.length; i += 1) {
    if (same(parts[i]!, LEGACY_CARD_FOLDER)) return true;
    if (i > 0 && isOwnFilesFolder(parts[i - 1]!, parts[i]!)) return true;
  }
  return false;
}

/** Places in words for the screens: from the drive root, with backslashes. */
const words = (parts: readonly string[]): string => parts.join('\\');
export const QUARANTINE_WORDS = words(QUARANTINE_PARTS);
export const DB_COPIES_WORDS = words(DB_COPIES_PARTS);
export const BACKUPS_WORDS = words(BACKUPS_PARTS);
export const OWN_FILES_WORDS = words(OWN_FILES_PARTS);
export const CARD_WORDS = words([...CARD_PARTS, CARD_FILE]);
