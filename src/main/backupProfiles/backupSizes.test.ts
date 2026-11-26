import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { backupSizesOf } from '../query/backupSizes';
import { BackupProfileService } from './backupProfileService';
import { addIndexRows, addPlace, makeRig, type Rig } from './fixtures.testutil';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 't7', 'drive', 'T7');
});
afterEach(() => rig.close());

type SizesInWorker = (asks: { backupId: number; placeId: string; root: string }[]) => Promise<{ backupId: number; files: number; bytes: number }[] | null>;
const service = (sizesInWorker?: SizesInWorker): BackupProfileService =>
  new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root: 'F:\\', label: 'T7' }], ...(sizesInWorker ? { sizesInWorker } : {}) });

function backup(s: BackupProfileService, name: string, root: string, kind: 'phone' | 'folder' = 'folder'): number {
  const made = s.store.create({ name, sourceKind: kind, ...(kind === 'folder' ? { sourceRoot: 'C:\\Users\\t\\' + name } : {}), folderPrefix: name.replace(/ /g, '-') });
  if (!made.ok) throw new Error('could not make the backup');
  s.store.addDestination({ profileId: made.id, placeId: 't7', root });
  return made.id;
}

describe('how big each backup is (read from the file list)', () => {
  it('counts the files under the backup folder only, not a folder with a similar name, and not a gone file', () => {
    addIndexRows(rig.db, [
      { place: 't7', rel: 'MyData/POCO/a.jpg', size: 100 },
      { place: 't7', rel: 'MyData/POCO/x/b.jpg', size: 50 },
      { place: 't7', rel: 'MyData/POCO/gone.jpg', size: 999, gone: 5 },
      { place: 't7', rel: 'MyData/POCO2/c.jpg', size: 7 },
      { place: 't7', rel: 'MyData/OTHER/d.jpg', size: 7 },
    ]);
    expect(backupSizesOf(rig.db, [{ backupId: 1, placeId: 't7', root: 'MyData/POCO' }, { backupId: 2, placeId: 't7', root: 'MyData/NOTHING' }])).toEqual([
      { backupId: 1, files: 2, bytes: 150 },
      { backupId: 2, files: 0, bytes: 0 },
    ]);
  });

  it('is asked for every backup with its first drive folder, and says so plainly when the worker is not there', async () => {
    const asked: unknown[] = [];
    const s = service(async (asks) => {
      asked.push(asks);
      return asks.map((a) => ({ backupId: a.backupId, files: 3, bytes: 30 }));
    });
    const one = backup(s, 'Poco F4', 'MyData/POCO', 'phone');
    const two = backup(s, 'OneDrive Local Backup', 'MyData/OneDriveBackup');
    expect(await s.sizes()).toEqual({ ok: true, sizes: [{ backupId: one, files: 3, bytes: 30 }, { backupId: two, files: 3, bytes: 30 }] });
    expect(asked).toEqual([[{ backupId: one, placeId: 't7', root: 'MyData/POCO' }, { backupId: two, placeId: 't7', root: 'MyData/OneDriveBackup' }]]);
    expect((await service().sizes()).ok).toBe(false);
    expect((await service(async () => null).sizes()).ok).toBe(false);
  });

  it('marks a backup that came from the old tool (its history was brought in), and no other', () => {
    const s = service();
    const old = backup(s, 'Poco F4', 'MyData/POCO', 'phone');
    const fresh = backup(s, 'Sam phone', 'MyData/Sam', 'phone');
    rig.db.prepare("INSERT INTO ledger_imports (backup_profile_id, ledger_path, ledger_sha256, imported_at, rows) VALUES (?, 'F:\\\\MyData\\\\POCO\\\\ledger.db', 'abc', 1, 10)").run(old);
    const rows = s.overview().backups;
    expect(rows.find((r) => r.id === old)!.fromOldTool).toBe(true);
    expect(rows.find((r) => r.id === fresh)!.fromOldTool).toBe(false);
  });
});

describe('main thread: the list of backups does not wait for the sizes', () => {
  it('overview() on a catalog of 200,000 rows and the call that asks for the sizes both return within 250 ms (the counting is the worker query)', async () => {
    insertFakeRows(rig.db, 't7', 'MyData/POCO/Poco-F4-24Nov26', 200_000, { fingerprinted: false });
    let released: (() => void) | null = null;
    const s = service(() => new Promise((resolve) => { released = () => resolve([{ backupId: 1, files: 200_000, bytes: 1 }]); }));
    backup(s, 'Poco F4', 'MyData/POCO', 'phone');
    let t = performance.now();
    s.overview();
    const overviewMs = performance.now() - t;
    t = performance.now();
    const pending = s.sizes();
    const askMs = performance.now() - t;
    expect(overviewMs).toBeLessThan(250);
    expect(askMs).toBeLessThan(250);
    released!();
    expect((await pending).ok).toBe(true);
    // The worker's own query, on the same 200,000 rows, for the record.
    t = performance.now();
    const [size] = backupSizesOf(rig.db, [{ backupId: 1, placeId: 't7', root: 'MyData/POCO' }]);
    console.log('backupSizes worker query on 200,000 rows:', Math.round(performance.now() - t), 'ms', size);
    expect(size!.files).toBe(200_000);
  }, 60_000);
});
