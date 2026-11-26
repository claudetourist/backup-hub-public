import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMAS } from '../ipc/schemas';
import { IPC } from '../../shared/ipc';
import { BackupProfileService } from './backupProfileService';
import { addIndexRows, addPlace, makeRig, type Rig } from './fixtures.testutil';

let rig: Rig;
let service: BackupProfileService;
beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 't7', 'drive', 'T7');
  service = new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root: 'F:\\', label: 'T7' }] });
});
afterEach(() => rig.close());

function backup(name: string, enabled: boolean): number {
  const made = service.store.create({ name, sourceKind: 'folder', sourceRoot: 'C:\\Users\\t\\' + name, folderPrefix: name.replace(/ /g, '-'), enabled });
  if (!made.ok) throw new Error('could not make the backup');
  service.store.addDestination({ profileId: made.id, placeId: 't7', root: 'MyData/' + name.replace(/ /g, '') });
  return made.id;
}

/** Every table's row count, so "nothing was deleted" is checked on the whole database. */
function counts(): Record<string, number> {
  const tables = rig.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
  return Object.fromEntries(tables.map((t) => [t, rig.db.prepare('SELECT count(*) FROM "' + t + '"').pluck().get() as number]));
}

describe('Remove from list (archive a backup)', () => {
  it('takes a switched-off backup off the list, deletes nothing anywhere, and Put back undoes it', () => {
    const keep = backup('OneDrive Local Backup', true);
    const imp = backup('OneDrive IMP Folder', false);
    addIndexRows(rig.db, [
      { place: 't7', rel: 'MyData/OneDriveIMPFolder/a.txt', size: 5 },
      { place: 't7', rel: 'MyData/OneDriveIMPFolder/b.txt', size: 6 },
    ]);
    rig.db.prepare("INSERT INTO ledger_imports (backup_profile_id, ledger_path, ledger_sha256, imported_at, rows) VALUES (?, 'x', 'abc', 1, 10)").run(imp);
    rig.db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, started_at, state) VALUES (?, 't7', 1, 'done')").run(imp);
    const before = counts();

    expect(service.archive(imp, false).ok).toBe(false);
    expect(service.overview().backups.map((b) => b.id)).toEqual([keep, imp]);

    const done = service.archive(imp, true);
    expect(done).toEqual({ ok: true, message: expect.stringContaining('Nothing on any drive was deleted') });
    const view = service.overview();
    expect(view.backups.map((b) => b.id)).toEqual([keep]);
    expect(view.removed).toEqual([{ id: imp, name: 'OneDrive IMP Folder', personId: expect.any(Number), from: 'C:\\Users\\t\\OneDrive IMP Folder', removedAt: expect.any(Number) }]);
    // The same row counts in every table: no file row, run, import, folder or choice was deleted.
    expect(counts()).toEqual(before);

    expect(service.unarchive(imp).ok).toBe(true);
    const back = service.overview();
    expect(back.backups.map((b) => [b.id, b.enabled])).toEqual([[keep, true], [imp, false]]);
    expect(back.removed).toEqual([]);
    expect(counts()).toEqual(before);
  });

  it('refuses a backup that is switched on, and one that does not exist', () => {
    const on = backup('Poco F4', true);
    expect(service.archive(on, true)).toEqual({ ok: false, message: 'Only a backup that is switched off can be removed from the list.' });
    expect(service.overview().backups.map((b) => b.id)).toEqual([on]);
    expect(service.archive(999, true).ok).toBe(false);
    expect(service.unarchive(999).ok).toBe(false);
  });

  it('the calls are checked: a backup id and the confirmation, nothing else', () => {
    expect(SCHEMAS[IPC.backupsArchive]!.safeParse([5, true]).success).toBe(true);
    expect(SCHEMAS[IPC.backupsArchive]!.safeParse([5]).success).toBe(false);
    expect(SCHEMAS[IPC.backupsArchive]!.safeParse(['5', true]).success).toBe(false);
    expect(SCHEMAS[IPC.backupsUnarchive]!.safeParse([5]).success).toBe(true);
    expect(SCHEMAS[IPC.backupsUnarchive]!.safeParse([5, 6]).success).toBe(false);
  });
});
