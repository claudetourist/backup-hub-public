/**
 * "Make a new backup for this phone": the pure rules for the folder name, the dated-folder prefix and the name, shared by main (which
 * enforces them) and the window (which shows the folder name live while the person types). Plain functions only; nothing here
 * touches a disk.
 */
import { MY_DATA_FOLDER } from './appFolders';

export const NEW_BACKUP_NAME_MAX = 40;
/** The longest folder name made from a backup name. */
export const FOLDER_NAME_MAX = 60;
/** The longest prefix of the dated folders ("Sam-phone-23Nov26"). */
export const FOLDER_PREFIX_MAX = 24;
export const FOLDER_PREFIX_FALLBACK = 'Phone';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const NOT_ALLOWED = /[\x00-\x1f\x7f:*?"<>|/\\]/g;

const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * The name of a folder on a Windows drive made from a backup name. Characters Windows does not allow are dropped, dots and spaces at
 * the end are dropped, a reserved name (CON, NUL, COM1 ...) gets "-backup" after its first part. Null when nothing usable is left
 * (empty, or only dots).
 */
export function safeFolderName(name: string): string | null {
  let text = name.replace(NOT_ALLOWED, '').replace(/\s+/g, ' ').trim();
  text = cut(text, FOLDER_NAME_MAX).replace(/[. ]+$/, '').replace(/^ +/, '');
  if (text === '' || /^\.+$/.test(text)) return null;
  const dot = text.indexOf('.');
  const base = (dot === -1 ? text : text.slice(0, dot)).trimEnd();
  if (RESERVED.test(base)) text = base + '-backup' + (dot === -1 ? '' : text.slice(dot));
  return text;
}

/** The prefix of the dated folders: letters and digits kept, every other run becomes one "-", at most 24 characters, else "Phone". */
export function folderPrefixFor(name: string): string {
  const parts = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const joined = cut(parts.join('-'), FOLDER_PREFIX_MAX).replace(/^-+|-+$/g, '');
  return joined === '' ? FOLDER_PREFIX_FALLBACK : joined;
}

/** The folder of a backup below the drive as the store keeps it ("MyData/Sam phone"): forward slashes, no drive letter. */
export const folderRootOf = (folder: string): string => MY_DATA_FOLDER + '/' + folder;
