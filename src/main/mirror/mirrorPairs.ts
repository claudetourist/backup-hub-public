/** Which backups have a second drive, as the pairs the plan, the run and the counts use. Read only. */
import type { Db } from '../db';
import { loadDestinations } from '../look/lookStore';
import type { MirrorPair } from './mirrorTypes';

/**
 * The pair of one backup: its first drive (lowest position) and its second (the next one), both switched on. Null when the backup has fewer than two
 * drives. The second drive always uses the first drive's relative folder (that is how it is made), but the roots are kept apart so a changed one still works.
 */
export function pairOf(db: Db, backupId: number): MirrorPair | null {
  const dests = loadDestinations(db, backupId);
  const first = dests[0];
  const second = dests[1];
  if (!first || !second || first.placeId === second.placeId) return null;
  const profile = db.prepare('SELECT name FROM backup_profiles WHERE id = ? AND enabled = 1').get(backupId) as { name: string } | undefined;
  if (!profile) return null;
  const label = db.prepare('SELECT label FROM places WHERE id = ?').pluck();
  return {
    backupId,
    backupName: profile.name,
    srcPlaceId: first.placeId,
    srcRoot: first.root.replace(/^\/+|\/+$/g, ''),
    dstPlaceId: second.placeId,
    dstRoot: second.root.replace(/^\/+|\/+$/g, ''),
    srcLabel: (label.get(first.placeId) as string | undefined) ?? 'the first drive',
    dstLabel: (label.get(second.placeId) as string | undefined) ?? 'the second drive',
  };
}

/** Every switched-on backup that has a second drive, in the order of the Backups list. */
export function allPairs(db: Db): MirrorPair[] {
  const ids = db.prepare('SELECT id FROM backup_profiles WHERE enabled = 1 ORDER BY id').pluck().all() as number[];
  const out: MirrorPair[] = [];
  for (const id of ids) {
    const p = pairOf(db, id);
    if (p) out.push(p);
  }
  return out;
}
