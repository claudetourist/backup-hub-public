/**
 * The list a finished run leaves on the drive (R1.2: the drive's lists folder, then the backup's name, then `<run date>.csv`): path on the drive, real name on the
 * phone, size, date, checksum. So a drive still makes sense when the index is lost. Pure.
 */
import { finishSync, STEP_ITEMS, type Steps } from '../sliceWork';

export interface ListRow {
  destRel: string;
  phonePath: string;
  size: number;
  mtimeMs: number | null;
  sha256: string | null;
}

export const LIST_HEADER = ['Path on the drive', 'Real name on the phone', 'Size in bytes', 'Date (UTC)', 'SHA-256'];
/** The list of a folder backup: the second column is the file's place in the folder that was backed up. */
export const FOLDER_LIST_HEADER = ['Path on the drive', 'Original path', 'Size in bytes', 'Date (UTC)', 'SHA-256'];
/** A byte-order mark, so a spreadsheet reads the names as UTF-8. */
const BOM = String.fromCodePoint(0xfeff);

/** One field: always quoted, quotes doubled, new lines kept inside the quotes (a hostile name cannot break a row). */
export function csvField(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function listCsv(rows: readonly ListRow[]): string {
  return finishSync(listCsvSteps(rows));
}

/** `listCsv` in slices (60,000 rows took about a second in one go; see sliceWork.ts). The text is the same. */
export function* listCsvSteps(rows: readonly ListRow[], header: readonly string[] = LIST_HEADER): Steps<string> {
  const lines = [header.map(csvField).join(',')];
  for (const [i, r] of rows.entries()) {
    const date = r.mtimeMs === null ? '' : new Date(r.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
    lines.push([r.destRel, r.phonePath, r.size, date, r.sha256 ?? ''].map(csvField).join(','));
    if (i % STEP_ITEMS === STEP_ITEMS - 1) yield;
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-23" in the laptop's local date. */
export const runDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
