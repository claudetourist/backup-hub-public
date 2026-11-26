/** What a backup is of, for the coloured icon beside its name: a phone, a folder on this laptop, a cloud folder (OneDrive ...) or a folder on another drive. */
export type BackupKind = 'phone' | 'laptop' | 'cloud' | 'drive';

/** Which category colour (the --cat-* tokens) each kind uses. */
export const BACKUP_KIND_CATEGORY: Readonly<Record<BackupKind, 'phone' | 'laptop' | 'onedrive' | 'drive'>> = {
  phone: 'phone',
  laptop: 'laptop',
  cloud: 'onedrive',
  drive: 'drive',
};

export const BACKUP_KIND_LABEL: Readonly<Record<BackupKind, string>> = {
  phone: 'Phone',
  laptop: 'This computer',
  cloud: 'Cloud folder',
  drive: 'Drive',
};

const CLOUD_FOLDER = /onedrive|google drive|dropbox|icloud/i;
const OTHER_DRIVE = /^[a-z]:[\\/]/i;

/** The kind of a backup row, from what it backs up ("Phone" or the folder path). */
export function backupKindOf(row: { kind: 'phone' | 'folder'; from: string }): BackupKind {
  if (row.kind === 'phone') return 'phone';
  if (CLOUD_FOLDER.test(row.from)) return 'cloud';
  if (OTHER_DRIVE.test(row.from) && !/^c:/i.test(row.from)) return 'drive';
  return 'laptop';
}
