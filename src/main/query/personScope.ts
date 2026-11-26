import type { Db } from '../db/connection';

/**
 * Whose files are whose (read only; runs in the query worker on its own connection). A person's files are:
 * - everything on a phone or a Google account that belongs to them (places.profile_id), and
 * - everything under the folder each of their backups saves to (the backup's destination place + its root folder).
 * Drives, the laptop and OneDrive are shared: only the folders of the person's backups count there.
 *
 * The answer is a handful of ranges: a whole place, or the rows of one place whose path starts with "root/". A prefix is written as the
 * range [root + "/", root + "0") ("0" is the character after "/"), so SQLite walks the (place_id, rel_path) index and never the whole
 * table, and nothing in a path (a "%" or "_") needs escaping.
 */
export interface PersonRange {
  placeId: string;
  /** Rows with rel_path >= from and < to. Null = the whole place. */
  from: string | null;
  to: string | null;
}

/** Folder roots are stored with forward slashes and no end slash ("MyData/POCO"); a root of "" means the whole place. */
export function rootRange(placeId: string, root: string): PersonRange {
  const clean = root.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (clean === '') return { placeId, from: null, to: null };
  return { placeId, from: clean + '/', to: clean + '0' };
}

export function personRanges(db: Db, personId: number): PersonRange[] {
  const out: PersonRange[] = [];
  const own = db.prepare("SELECT id FROM places WHERE profile_id = ? AND kind IN ('phone', 'gdrive')").pluck().all(personId) as string[];
  for (const id of own) out.push({ placeId: id, from: null, to: null });
  const dests = db
    .prepare(
      `SELECT d.place_id AS placeId, d.root AS root
         FROM backup_destinations d JOIN backup_profiles b ON b.id = d.backup_profile_id
        WHERE b.person_id = ?`,
    )
    .all(personId) as { placeId: string; root: string }[];
  const seen = new Set(own);
  for (const d of dests) {
    if (seen.has(d.placeId)) continue;
    out.push(rootRange(d.placeId, d.root));
  }
  // A place taken whole makes its folder ranges redundant.
  const whole = new Set(out.filter((r) => r.from === null).map((r) => r.placeId));
  const unique = new Map<string, PersonRange>();
  for (const r of out) {
    if (r.from !== null && whole.has(r.placeId)) continue;
    unique.set(`${r.placeId}|${r.from ?? ''}`, r);
  }
  return [...unique.values()];
}

/** The SQL condition on `files f` for a person's files, with its parameters. A person with nothing gets a condition that matches no row. */
export function personWhere(ranges: readonly PersonRange[], a: string = 'f'): { sql: string; params: string[] } {
  if (ranges.length === 0) return { sql: '0', params: [] };
  const params: string[] = [];
  const parts = ranges.map((r) => {
    if (r.from === null || r.to === null) {
      params.push(r.placeId);
      return `${a}.place_id = ?`;
    }
    params.push(r.placeId, r.from, r.to);
    return `(${a}.place_id = ? AND ${a}.rel_path >= ? AND ${a}.rel_path < ?)`;
  });
  return { sql: `(${parts.join(' OR ')})`, params };
}
