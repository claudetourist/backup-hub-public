/**
 * The rule for taking files off the phone (Simple plan): a phone file may be removed only when a verified copy is on the T7 AND on
 * the Seagate AND in Google, and the drive copies are in the current `Backups` layout (not in `_old-versions`). The drives are
 * found by NAME. A drive that is missing from the list gives a place without a copy, so nothing is safe.
 */
import type { Db } from '../db/connection';
import type { CleanDestination } from '../../shared/cleanup';
import { SEAGATE_NAME, T7_NAME } from '../../shared/start';

export function phoneCleanDestinations(db: Db): CleanDestination[] {
  const driveId = (name: string): string | null => (db.prepare("SELECT id FROM places WHERE kind = 'drive' AND label = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").pluck().get(name) as string | undefined) ?? null;
  const accounts = db.prepare("SELECT id FROM places WHERE kind = 'gdrive' ORDER BY id").pluck().all() as string[];
  return [
    { id: 1, kind: 'drive', label: T7_NAME, placeId: driveId(T7_NAME), accounts: [], folder: null, backupsLayout: true },
    { id: 2, kind: 'drive', label: SEAGATE_NAME, placeId: driveId(SEAGATE_NAME), accounts: [], folder: null, backupsLayout: true },
    { id: 3, kind: 'google', label: 'Google', placeId: null, accounts, folder: null },
  ];
}
