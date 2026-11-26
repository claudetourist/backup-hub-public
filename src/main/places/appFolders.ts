/**
 * Real paths of the folders Backup Hub uses on a drive, built from the names in `shared/appFolders.ts` (the only file that spells
 * them). Every other file in main asks this module. These are only names; nothing here touches the disk.
 *
 * Layout (see the shared file): everything the app makes on a drive is under `<drive>\MyData\<app folder>\`. Drives that have not been
 * moved yet keep their card folder at the drive root: `legacyCardFile` names it so it can be READ; nothing writes there.
 */
import path from 'node:path';
import {
  APP_FOLDER_PARTS,
  BACKUPS_PARTS,
  CARD_FILE,
  CARD_PARTS,
  DB_COPIES_PARTS,
  DRIVE_TMP_PARTS,
  LEGACY_CARD_FOLDER,
  LISTS_PARTS,
  OWN_FILES_PARTS,
  QUARANTINE_PARTS,
  SET_ASIDE_PARTS,
} from '../../shared/appFolders';

const under = (root: string, parts: readonly string[]): string => path.join(root, ...parts);

/** `<root>\MyData\<app folder>`: the one folder for everything the app makes on a drive. */
export const appFolder = (root: string): string => under(root, APP_FOLDER_PARTS);
/** Backup content the app itself creates (listed, searched, copied like any backup). */
export const backupsFolder = (root: string): string => under(root, BACKUPS_PARTS);
/** The app's working files (never listed, never copied). */
export const ownFilesFolder = (root: string): string => under(root, OWN_FILES_PARTS);
/** The drive's ID card folder (new layout). */
export const cardFolder = (root: string): string => under(root, CARD_PARTS);
export const cardFile = (root: string): string => path.join(cardFolder(root), CARD_FILE);
/** The card of an old-layout drive, at the drive root. READ ONLY: nothing is ever written there. */
export const legacyCardFile = (root: string): string => path.join(root, LEGACY_CARD_FOLDER, CARD_FILE);
export const driveTmpFolder = (root: string): string => under(root, DRIVE_TMP_PARTS);
export const setAsideFolder = (root: string): string => under(root, SET_ASIDE_PARTS);
export const listsFolder = (root: string): string => under(root, LISTS_PARTS);
/** The app's own database / settings copies (and the laptop app data copies below it). */
export const dbCopiesFolder = (root: string): string => under(root, DB_COPIES_PARTS);
/** The laptop clean-up quarantine on a volume. */
export const quarantineFolder = (root: string): string => under(root, QUARANTINE_PARTS);
