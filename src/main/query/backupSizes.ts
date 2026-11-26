import type { Db } from '../db';
import type { BackupSize } from '../../shared/backups';
import { prefixUpperBound } from '../listing/skipRules';
import type { BackupSizeAsk } from './queryTypes';

/** Above every path the index can hold. */
const ABOVE_ALL = String.fromCharCode(0xffff);

/**
 * How many files and bytes each backup holds on its first drive: one range read per backup on the unique (place, path) index, over the rows
 * that are not gone. Read only; it runs on the query worker (a phone backup has 200,000 rows), never on the main thread.
 */
export function backupSizesOf(db: Db, asks: readonly BackupSizeAsk[]): BackupSize[] {
  const stmt = db.prepare('SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM files WHERE place_id = @place AND rel_path > @lo AND rel_path < @hi AND gone_at IS NULL');
  return asks.map((ask) => {
    const root = ask.root.replace(/^\/+|\/+$/g, '');
    const prefix = root === '' ? '' : root + '/';
    const row = stmt.get({ place: ask.placeId, lo: prefix, hi: prefix === '' ? ABOVE_ALL : prefixUpperBound(prefix) }) as { files: number; bytes: number };
    return { backupId: ask.backupId, files: row.files, bytes: row.bytes };
  });
}
