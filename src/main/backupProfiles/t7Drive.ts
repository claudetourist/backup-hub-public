import fs from 'node:fs';
import path from 'node:path';
import { T7_NAME } from '../../shared/start';

/** A named drive that is plugged in: its place (= its identity card), the label the person gave it, and its root such as "F:\\" right now. */
export interface PluggedDrive {
  placeId: string;
  root: string;
  label?: string | undefined;
}

export type T7Result = { ok: true; drive: { placeId: string; root: string; label: string } } | { ok: false; message: string };

/** A file below a drive root, given in the store's form ("MyData/POCO/ledger.db"). */
export const absOn = (root: string, rel: string): string => path.join(root, ...rel.split('/').filter((s) => s !== ''));

/**
 * The T7, for the seed and the history import: the plugged-in named drive whose NAME is "T7" (the name lives on its identity card;
 * the same rule as everywhere else, see shared/start.ts). The drive letter never decides. It must also hold the file
 * `requiredRel` (the Poco's old history file), else nothing is done: a drive named T7 without PhoneBackup's files is not the drive
 * the old settings were about.
 */
export function findT7(drives: readonly PluggedDrive[], requiredRel: string, exists: (file: string) => boolean = fs.existsSync): T7Result {
  const named = drives.filter((d) => (d.label ?? '').trim().toLowerCase() === T7_NAME.toLowerCase());
  if (named.length === 0) return { ok: false, message: 'The T7 drive is not plugged in. Plug it in and try again. Nothing was changed.' };
  if (named.length > 1) return { ok: false, message: 'More than one plugged-in drive is named T7. Unplug the extra one and try again. Nothing was changed.' };
  const drive = named[0]!;
  if (!exists(absOn(drive.root, requiredRel))) {
    return { ok: false, message: 'The T7 is plugged in, but PhoneBackup\'s history of the Poco is not on it (the POCO folder of MyData). Nothing was changed.' };
  }
  return { ok: true, drive: { placeId: drive.placeId, root: drive.root, label: drive.label ?? T7_NAME } };
}
