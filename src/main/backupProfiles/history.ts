import type { Db } from '../db';
import type { HistoryStaleReason } from '../../shared/backups';
import type { LedgerSummary, ProblemKind } from './ledgerImport';

/**
 * Bring in PhoneBackup history (R1.1): the three old history files and what is known about them. Pure helpers; the service
 * (backupProfileService.ts) does the work.
 */

/** The name PhoneBackup gave its history file, beside the dated folders of a backup. */
export const HISTORY_FILE = 'ledger.db';

/** The backups whose old history is brought in, by their key in PhoneBackup's settings, and the folders kept only on the other drive (Spare: the Seagate). */
export const HISTORY_BACKUPS: readonly { importKey: string; keptOnlyOnOtherDrive: readonly string[] }[] = [
  { importKey: 'poco', keptOnlyOnOtherDrive: [] },
  { importKey: 'onedrive', keptOnlyOnOtherDrive: [] },
  { importKey: 'ddrive', keptOnlyOnOtherDrive: ['Spare'] },
];

/** Where PhoneBackup's settings file is: only where BACKUPHUB_PHONEBACKUP_CONFIG says (a full path to config.json), else nowhere (null). */
export const phoneBackupConfigPath = (env: NodeJS.ProcessEnv = process.env): string | null => env['BACKUPHUB_PHONEBACKUP_CONFIG']?.trim() || null;

/** Why a row of the old history could not be matched to a file on the drive, in plain words. Only these decide "stale". */
export const STALE_WORDS: Partial<Record<ProblemKind, string>> = {
  not_in_index: "The file is not in Backup Hub's list of the drive (it was moved or removed, or the list is older than the backup).",
  size_differs: 'The file on the drive has a different size than the old history says.',
  checksum_differs: 'The file on the drive has a different checksum than the old history says.',
  outside_backup_folder: 'The old history points outside the backup folder.',
  no_backup_path: 'The old history has no file path for it.',
  no_size: 'The old history has no size for it.',
  ambiguous_case: 'Two files on the drive differ only in capital letters, so nothing was guessed.',
  index_changed: 'The file changed while the history was being read.',
};

const STALE_ORDER = Object.keys(STALE_WORDS) as ProblemKind[];

/** The rows that could not be matched, by reason, biggest first. Their total is rowsRead minus linked. */
export function staleReasons(summary: LedgerSummary): { stale: number; reasons: HistoryStaleReason[] } {
  const reasons: HistoryStaleReason[] = [];
  for (const kind of STALE_ORDER) {
    const p = summary.problems[kind];
    if (p && p.count > 0) reasons.push({ reason: STALE_WORDS[kind]!, count: p.count, examples: p.examples.slice(0, 3) });
  }
  reasons.sort((a, b) => b.count - a.count);
  return { stale: reasons.reduce((sum, r) => sum + r.count, 0), reasons };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const escapeRegExp = (s: string): string => s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');

/** "DDrive-17Jul26" with prefix "DDrive" is 17 Jul 2026 (local noon, epoch ms). Null for any other name. */
export function sessionDate(folderPrefix: string, folderName: string): number | null {
  const m = new RegExp('^' + escapeRegExp(folderPrefix) + '-(\\d{1,2})([A-Za-z]{3})(\\d{2})(?:[^A-Za-z0-9].*)?$', 'i').exec(folderName);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  const day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  return new Date(2000 + Number(m[3]), month, day, 12).getTime();
}

/** Sorts after every character that can appear in a file name. */
const AFTER_ALL = String.fromCharCode(0xffff);

/**
 * The newest dated folder of a backup on a drive, from the files Backup Hub knows below the backup folder root (forward slashes,
 * no drive letter). It hops from one dated folder to the next along the (place, path) index, so a backup of 100,000 files costs
 * about as many reads as it has dated folders. Null when there is none.
 */
export function newestSessionAt(db: Db, placeId: string, root: string, folderPrefix: string): number | null {
  const base = root === '' ? '' : root + '/';
  const next = db.prepare('SELECT rel_path FROM files WHERE place_id = ? AND rel_path > ? ORDER BY rel_path LIMIT 1').pluck();
  let cursor = base;
  let newest: number | null = null;
  for (let hops = 0; hops < 5000; hops += 1) {
    const rel = next.get(placeId, cursor) as string | undefined;
    if (rel === undefined || !rel.startsWith(base)) break;
    const folder = rel.slice(base.length).split('/')[0]!;
    const at = sessionDate(folderPrefix, folder);
    if (at !== null && (newest === null || at > newest)) newest = at;
    cursor = base + folder + '/' + AFTER_ALL;
  }
  return newest;
}
