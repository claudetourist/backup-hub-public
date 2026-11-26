import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupProfileService } from './backupProfileService';
import { phoneRelOf, driveRelOf } from './ledgerImport';
import { addIndexRows, addPlace, makeLedger, makeRig, sha, type Rig } from './fixtures.testutil';

let rig: Rig;
let service: BackupProfileService;
beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 't7', 'drive', 'T7');
  addPlace(rig.db, 'lap', 'laptop', 'Laptop');
  service = new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root: 'F:\\' }], uuid: () => 'phone-place-1', now: () => 5000 });
});
afterEach(() => rig.close());

const FIXED = 'id, place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at';
const fixedColumns = (): unknown[] => rig.db.prepare(`SELECT ${FIXED} FROM files WHERE place_id IN ('t7', 'lap', 'od1') ORDER BY id`).all();
const dump = (): unknown => ({
  files: rig.db.prepare('SELECT * FROM files ORDER BY id').all(),
  places: rig.db.prepare('SELECT * FROM places ORDER BY id').all(),
  exclusions: rig.db.prepare('SELECT * FROM backup_exclusions ORDER BY source_path').all(),
  imports: rig.db.prepare('SELECT * FROM ledger_imports').all(),
});
const newCols = (rel: string): Record<string, unknown> =>
  rig.db.prepare('SELECT origin_file_id, expected_sha256, verified_how, verified_at, gone_reason, backup_run_id FROM files WHERE place_id = ? AND rel_path = ?').get('t7', rel) as Record<string, unknown>;

function makeProfile(name: string, kind: 'phone' | 'folder', root: string, sourceRoot = ''): number {
  const made = service.store.create({ name, sourceKind: kind, sourceRoot, folderPrefix: name.replace(/\s/g, '-') });
  if (!made.ok) throw new Error(made.message);
  const dest = service.store.addDestination({ profileId: made.id, placeId: 't7', root });
  if (!dest.ok) throw new Error(dest.message);
  return made.id;
}

const S = 'MyData/POCO/Poco-F4-31Mar25';
const L = 'F:\\MyData\\POCO\\Poco-F4-31Mar25';

describe('path forms', () => {
  it('drop the drive letter and keep the rest; phone paths lose the leading slash', () => {
    expect(driveRelOf('F:\\MyData\\POCO\\a.jpg')).toBe('MyData/POCO/a.jpg');
    expect(driveRelOf('\\\\nas\\share\\a')).toBeNull();
    expect(phoneRelOf('/sdcard/DCIM/a.jpg')).toBe('sdcard/DCIM/a.jpg');
    expect(phoneRelOf('/sdcard/../x')).toBeNull();
    expect(phoneRelOf('/')).toBeNull();
  });
});

describe('ledger import, phone backup', () => {
  function setup(): { ledger: string; id: number } {
    const id = makeProfile('Poco F4', 'phone', 'MyData/POCO');
    addIndexRows(rig.db, [
      { place: 't7', rel: `${S}/DCIM/a.jpg`, size: 100, sha: sha(1), md5: 'md', mtime: 11 },
      { place: 't7', rel: `${S}/DCIM/b.jpg`, size: 200 },
      { place: 't7', rel: `${S}/DCIM/c.jpg`, size: 300, sha: sha(3) },
      { place: 't7', rel: `${S}/DCIM/d.jpg`, size: 400, sha: sha(4) },
      { place: 't7', rel: `${S}/DCIM/Old/e.jpg`, size: 50, gone: 777 },
      { place: 't7', rel: `${S}/DCIM/f.jpg`, size: 60, gone: 888 },
      { place: 't7', rel: `${S}/DCIM/g.jpg`, size: 70, sha: sha(7) },
      { place: 't7', rel: `${S}/DCIM/h.jpg`, size: 80, sha: sha(8), expected: sha(8), verifiedHow: 'read_both' },
      { place: 't7', rel: `${S}/DCIM/untouched.jpg`, size: 5, sha: sha(5) },
    ]);
    const ledger = path.join(rig.dir, 'ledger.db');
    makeLedger(
      ledger,
      [
        { file_size: 100, file_hash: sha(1), local_path: `${L}\\DCIM\\a.jpg`, original_phone_path: '/sdcard/DCIM/a.jpg', file_mtime: 1700000000 },
        { file_size: 200, file_hash: null, local_path: `${L}\\DCIM\\B.JPG`, original_phone_path: '/sdcard/DCIM/b.jpg', file_mtime: 1700000001 },
        { file_size: 301, local_path: `${L}\\DCIM\\c.jpg`, original_phone_path: '/sdcard/DCIM/c.jpg' },
        { file_size: 400, file_hash: sha(9), local_path: `${L}\\DCIM\\d.jpg`, original_phone_path: '/sdcard/DCIM/d.jpg' },
        { file_size: 50, local_path: `${L}\\DCIM\\Old\\e.jpg`, original_phone_path: '/sdcard/DCIM/Old/e.jpg' },
        { file_size: 60, local_path: `${L}\\DCIM\\f.jpg`, original_phone_path: '/sdcard/DCIM/f.jpg' },
        { file_size: 70, local_path: `${L}\\DCIM\\g.jpg`, cloud_account: 'acct', cloud_path: '/Backups/g.jpg' },
        { file_size: 80, file_hash: sha(8), local_path: `${L}\\DCIM\\h.jpg`, original_phone_path: '/sdcard/DCIM/h.jpg' },
        { file_size: 90, local_path: `${L}\\DCIM\\zz.jpg`, original_phone_path: '/sdcard/DCIM/zz.jpg' },
        { file_size: 10, local_path: 'F:\\Other\\x.jpg' },
        { file_size: 11, local_path: null, original_phone_path: '/sdcard/DCIM/nopath.jpg' },
        { file_size: null, local_path: `${L}\\DCIM\\nosize.jpg` },
      ],
      { excluded: [{ path: '/sdcard/DCIM/secret.jpg', addedAt: '2026-06-26 10:00:00' }, { path: '/sdcard/Download/x.zip', addedAt: 'garbage' }] },
    );
    return { ledger, id };
  }

  it('links what the index has, counts every problem, makes the phone source rows, and changes no old column', async () => {
    const { ledger, id } = setup();
    const before = fixedColumns();
    const ledgerBytes = fs.readFileSync(ledger);
    const ledgerTime = fs.statSync(ledger).mtimeMs;
    const dirFiles = fs.readdirSync(rig.dir).toSorted();

    const result = await service.importLedger({ profileId: id, ledgerPath: ledger, keptOnlyOnOtherDrive: ['DCIM/Old'] });
    if (!result.ok || result.alreadyImported) throw new Error(JSON.stringify(result));
    const s = result.summary;
    expect(s).toMatchObject({ rowsRead: 12, linked: 6, originLinked: 5, sourceRowsCreated: 9, sourceRowsReused: 0, looseRows: 3, cloudRows: 1, goneRows: 2, goneReasonSet: 1, exclusionsCopied: 2 });
    expect(Object.fromEntries(Object.entries(s.problems).map(([k, v]) => [k, v?.count]))).toEqual({
      size_differs: 1,
      checksum_differs: 1,
      not_in_index: 1,
      outside_backup_folder: 1,
      no_backup_path: 1,
      no_size: 1,
    });
    expect(s.problems.not_in_index?.examples).toEqual([`${L}\\DCIM\\zz.jpg`]);

    // Nothing old moved.
    expect(fixedColumns()).toEqual(before);
    // The old file is untouched and nothing was created beside it.
    expect(fs.readFileSync(ledger).equals(ledgerBytes)).toBe(true);
    expect(fs.statSync(ledger).mtimeMs).toBe(ledgerTime);
    expect(fs.readdirSync(rig.dir).toSorted()).toEqual(dirFiles);

    // New columns of the rows found.
    const phone = rig.db.prepare("SELECT id, profile_id, kind, label, identity_json, status FROM places WHERE kind = 'phone'").all() as { id: string; kind: string; label: string }[];
    expect(phone).toMatchObject([{ id: 'phone-place-1', kind: 'phone', label: 'Poco F4' }]);
    const source = (rel: string): { id: number; size: number; mtime: number | null; sha256: string | null; gone_at: number | null } =>
      rig.db.prepare("SELECT id, size, mtime, sha256, gone_at FROM files WHERE place_id = 'phone-place-1' AND rel_path = ?").get(rel) as never;
    expect(source('sdcard/DCIM/a.jpg')).toMatchObject({ size: 100, mtime: 1_700_000_000_000, sha256: null, gone_at: null });
    expect(source('sdcard/DCIM/c.jpg')).toMatchObject({ size: 301, mtime: null });
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = 'phone-place-1'").pluck().get()).toBe(9);
    expect(newCols(`${S}/DCIM/a.jpg`)).toEqual({ origin_file_id: source('sdcard/DCIM/a.jpg').id, expected_sha256: sha(1), verified_how: 'imported', verified_at: null, gone_reason: null, backup_run_id: null });
    // Found by name without regard to case; no checksum to copy.
    expect(newCols(`${S}/DCIM/b.jpg`)).toMatchObject({ origin_file_id: source('sdcard/DCIM/b.jpg').id, expected_sha256: null, verified_how: 'imported' });
    // Size differs / checksum differs: nothing linked at all.
    for (const rel of ['c', 'd']) expect(newCols(`${S}/DCIM/${rel}.jpg`)).toEqual({ origin_file_id: null, expected_sha256: null, verified_how: null, verified_at: null, gone_reason: null, backup_run_id: null });
    // Gone rows: the reason only under the caller's folder.
    expect(newCols(`${S}/DCIM/Old/e.jpg`)).toMatchObject({ gone_reason: 'kept_only_on_other_drive', verified_how: 'imported' });
    expect(newCols(`${S}/DCIM/f.jpg`)).toMatchObject({ gone_reason: null, verified_how: 'imported' });
    // Loose row: linked on the backup side, no source row.
    expect(newCols(`${S}/DCIM/g.jpg`)).toMatchObject({ origin_file_id: null, expected_sha256: sha(7), verified_how: 'imported' });
    // A better verification that was already there stays.
    expect(newCols(`${S}/DCIM/h.jpg`)).toMatchObject({ expected_sha256: sha(8), verified_how: 'read_both' });
    expect(newCols(`${S}/DCIM/untouched.jpg`)).toMatchObject({ origin_file_id: null, expected_sha256: null, verified_how: null });

    // Exclusions, kept with their time.
    expect(rig.db.prepare('SELECT source_path, added_at FROM backup_exclusions WHERE backup_profile_id = ? ORDER BY source_path').all(id)).toEqual([
      { source_path: '/sdcard/DCIM/secret.jpg', added_at: Date.parse('2026-06-26T10:00:00Z') },
      { source_path: '/sdcard/Download/x.zip', added_at: 5000 },
    ]);
    // Stored summary.
    const row = rig.db.prepare('SELECT * FROM ledger_imports').get() as { rows: number; problems_json: string; backup_profile_id: number };
    expect(row).toMatchObject({ rows: 12, backup_profile_id: id });
    expect(JSON.parse(row.problems_json)).toMatchObject({ rowsRead: 12, linked: 6, problems: { not_in_index: { count: 1 } } });
    expect(service.list()[0]!.imports).toMatchObject([{ rows: 12 }]);
  });

  it('a second import of the same file does nothing; force runs it again without making anything twice', async () => {
    const { ledger, id } = setup();
    const first = await service.importLedger({ profileId: id, ledgerPath: ledger });
    expect(first).toMatchObject({ ok: true, alreadyImported: false });
    const after = dump();
    const again = await service.importLedger({ profileId: id, ledgerPath: ledger });
    expect(again).toMatchObject({ ok: true, alreadyImported: true });
    expect(dump()).toEqual(after);
    // A copy of the same bytes elsewhere is the same file.
    const copy = path.join(rig.dir, 'copy-of-ledger.db');
    fs.copyFileSync(ledger, copy);
    expect(await service.importLedger({ profileId: id, ledgerPath: copy })).toMatchObject({ ok: true, alreadyImported: true });

    const forced = await service.importLedger({ profileId: id, ledgerPath: ledger, force: true });
    if (!forced.ok || forced.alreadyImported) throw new Error('forced');
    expect(forced.summary).toMatchObject({ sourceRowsCreated: 0, sourceRowsReused: 9, linked: 6, exclusionsCopied: 0 });
    expect(rig.db.prepare('SELECT count(*) FROM ledger_imports').pluck().get()).toBe(1);
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = 'phone-place-1'").pluck().get()).toBe(9);
    const f = dump() as { files: unknown[] };
    expect(f.files).toEqual((after as { files: unknown[] }).files);
  });

  it('reads an old ledger without file_mtime, cloud columns or excluded_paths', async () => {
    const id = makeProfile('Old phone', 'phone', 'MyData/POCO');
    addIndexRows(rig.db, [{ place: 't7', rel: `${S}/a.jpg`, size: 100, sha: sha(1) }]);
    const ledger = path.join(rig.dir, 'old-ledger.db');
    makeLedger(ledger, [{ file_size: 100, local_path: `${L}\\a.jpg`, original_phone_path: '/sdcard/a.jpg' }], { withMtime: false, withCloud: false, excluded: null });
    const r = await service.importLedger({ profileId: id, ledgerPath: ledger });
    if (!r.ok || r.alreadyImported) throw new Error(JSON.stringify(r));
    expect(r.summary).toMatchObject({ rowsRead: 1, linked: 1, originLinked: 1, cloudRows: 0, exclusionsCopied: 0, sourceRowsCreated: 1 });
    expect(rig.db.prepare("SELECT mtime FROM files WHERE rel_path = 'sdcard/a.jpg'").pluck().get()).toBeNull();
  });

  it('refuses what it cannot use, and writes nothing', async () => {
    const id = makeProfile('Poco F4', 'phone', 'MyData/POCO');
    const bad = path.join(rig.dir, 'not-a-ledger.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(bad);
    db.exec('CREATE TABLE other (x INTEGER)');
    db.close();
    const before = dump();
    expect(await service.importLedger({ profileId: id, ledgerPath: bad })).toMatchObject({ ok: false });
    expect(await service.importLedger({ profileId: id, ledgerPath: path.join(rig.dir, 'missing.db') })).toMatchObject({ ok: false });
    expect(await service.importLedger({ profileId: 999, ledgerPath: bad })).toMatchObject({ ok: false });
    const noDestination = service.store.create({ name: 'No folder', sourceKind: 'phone', folderPrefix: 'N' });
    if (!noDestination.ok) throw new Error('create');
    expect(await service.importLedger({ profileId: noDestination.id, ledgerPath: bad })).toMatchObject({ ok: false, message: expect.stringContaining('no backup folder') as string });
    expect(rig.db.prepare('SELECT count(*) FROM ledger_imports').pluck().get()).toBe(0);
    expect((dump() as { files: unknown[] }).files).toEqual((before as { files: unknown[] }).files);
  });
});

describe('ledger import, folder backups', () => {
  it('links to the existing source rows only (laptop and OneDrive), creates none, and marks Spare files as kept on the other drive', async () => {
    const id = makeProfile('DDrive Local Backup', 'folder', 'MyData/DDriveBackup', 'D:\\MyData');
    const odId = makeProfile('OneDrive IMP Folder', 'folder', 'MyData/OneDriveBackup/IMP', 'C:\\Users\\t\\OneDrive\\IMP');
    const gone = 'MyData/DDriveBackup/DDrive-05Nov26/MyData/Spare/x.txt';
    addIndexRows(rig.db, [
      { place: 't7', rel: gone, size: 10, gone: 999 },
      { place: 't7', rel: 'MyData/DDriveBackup/DDrive-05Nov26/MyData/docs/y.txt', size: 20 },
      { place: 't7', rel: 'MyData/DDriveBackup/DDrive-05Nov26/MyData/docs/new.txt', size: 30 },
      { place: 't7', rel: 'MyData/DDriveBackup/DDrive-05Nov26/MyData/docs/stray.txt', size: 31 },
      { place: 't7', rel: 'MyData/OneDriveBackup/IMP/OneDrive-IMP-05Nov26/n.txt', size: 40 },
      { place: 'lap', rel: 'D:/MyData/docs/y.txt', size: 20, sha: sha(2) },
      { place: 'lap', rel: 'D:/MyData/docs/other.txt', size: 1 },
    ]);
    addPlace(rig.db, 'od1', 'onedrive', 'OneDrive', { userFolder: 'C:\\Users\\t\\OneDrive' });
    addIndexRows(rig.db, [{ place: 'od1', rel: 'IMP/n.txt', size: 40 }]);
    const lapRows = rig.db.prepare("SELECT count(*) FROM files WHERE place_id IN ('lap', 'od1')").pluck().get();
    const before = fixedColumns();

    const ledger = path.join(rig.dir, 'dd.db');
    makeLedger(ledger, [
      { file_size: 10, local_path: 'F:\\MyData\\DDriveBackup\\DDrive-05Nov26\\MyData\\Spare\\x.txt', original_phone_path: 'D:\\MyData\\Spare\\x.txt' },
      { file_size: 20, local_path: 'F:\\MyData\\DDriveBackup\\DDrive-05Nov26\\MyData\\docs\\y.txt', original_phone_path: 'd:\\mydata\\Docs\\Y.txt' },
      { file_size: 30, local_path: 'F:\\MyData\\DDriveBackup\\DDrive-05Nov26\\MyData\\docs\\new.txt', original_phone_path: 'D:\\MyData\\docs\\new.txt' },
      { file_size: 31, local_path: 'F:\\MyData\\DDriveBackup\\DDrive-05Nov26\\MyData\\docs\\stray.txt', original_phone_path: 'E:\\Else\\stray.txt' },
    ]);
    const r = await service.importLedger({ profileId: id, ledgerPath: ledger, keptOnlyOnOtherDrive: ['MyData/Spare'] });
    if (!r.ok || r.alreadyImported) throw new Error(JSON.stringify(r));
    expect(r.summary).toMatchObject({ rowsRead: 4, linked: 4, originLinked: 1, sourceRowsCreated: 0, goneRows: 1, goneReasonSet: 1 });
    expect(Object.fromEntries(Object.entries(r.summary.problems).map(([k, v]) => [k, v?.count]))).toEqual({ source_not_in_index: 2, source_outside_profile_folder: 1 });
    const linked = newCols('MyData/DDriveBackup/DDrive-05Nov26/MyData/docs/y.txt');
    expect(linked.origin_file_id).toBe(rig.db.prepare("SELECT id FROM files WHERE place_id = 'lap' AND rel_path = 'D:/MyData/docs/y.txt'").pluck().get());
    expect(newCols(gone)).toMatchObject({ gone_reason: 'kept_only_on_other_drive', origin_file_id: null });
    expect(newCols('MyData/DDriveBackup/DDrive-05Nov26/MyData/docs/new.txt').origin_file_id).toBeNull();
    // The laptop's own rows were not touched and none were made.
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id IN ('lap', 'od1')").pluck().get()).toBe(lapRows);
    expect(rig.db.prepare("SELECT count(*) FROM places WHERE kind = 'phone'").pluck().get()).toBe(0);
    expect(fixedColumns()).toEqual(before);

    // OneDrive: the source folder is found below the OneDrive place's folder.
    const ledger2 = path.join(rig.dir, 'od.db');
    makeLedger(ledger2, [{ file_size: 40, local_path: 'F:\\MyData\\OneDriveBackup\\IMP\\OneDrive-IMP-05Nov26\\n.txt', original_phone_path: 'C:\\Users\\t\\OneDrive\\IMP\\N.txt' }]);
    const r2 = await service.importLedger({ profileId: odId, ledgerPath: ledger2 });
    if (!r2.ok || r2.alreadyImported) throw new Error(JSON.stringify(r2));
    expect(r2.summary).toMatchObject({ linked: 1, originLinked: 1 });
    expect(newCols('MyData/OneDriveBackup/IMP/OneDrive-IMP-05Nov26/n.txt').origin_file_id).toBe(rig.db.prepare("SELECT id FROM files WHERE place_id = 'od1'").pluck().get());
  });

  it('counts rows whose source folder is in no place', async () => {
    const id = makeProfile('Share', 'folder', 'MyData/Share', '\\\\nas\\share');
    addIndexRows(rig.db, [{ place: 't7', rel: 'MyData/Share/S-01/a.txt', size: 1 }]);
    const ledger = path.join(rig.dir, 'share.db');
    makeLedger(ledger, [{ file_size: 1, local_path: 'F:\\MyData\\Share\\S-01\\a.txt', original_phone_path: '\\\\nas\\share\\a.txt' }]);
    const r = await service.importLedger({ profileId: id, ledgerPath: ledger });
    if (!r.ok || r.alreadyImported) throw new Error('import');
    expect(r.summary).toMatchObject({ linked: 1, originLinked: 0 });
    expect(r.summary.problems.no_source_place?.count).toBe(1);
  });
});

describe('ledger import, big', () => {
  // The speed limit is hard only when benchmarking (BACKUPHUB_BENCH=1, as in query.test.ts); under a loaded machine the normal run
  // only checks that the import finishes, in chunks, with the right numbers.
  it('imports 125,000 rows in chunks with turns for the event loop (and in well under a minute when benchmarking)', async () => {
    const id = makeProfile('DDrive Big', 'phone', 'MyData/DDriveBackup');
    const N = 125_000;
    const ins = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at) VALUES ('t7', ?, ?, 7, ?, 1, 2)");
    rig.db.transaction(() => {
      for (let i = 0; i < N - 1000; i += 1) ins.run(`MyData/DDriveBackup/DDrive-01Jan26/d${i % 300}/file${i}.bin`, i + 1, sha(i + 1));
    })();
    const ledger = path.join(rig.dir, 'big.db');
    const rows = Array.from({ length: N }, (_, i) => ({ file_size: i + 1, file_hash: sha(i + 1), local_path: `F:\\MyData\\DDriveBackup\\DDrive-01Jan26\\d${i % 300}\\file${i}.bin`, original_phone_path: `/sdcard/d${i % 300}/file${i}.bin`, file_mtime: 1_700_000_000 + i }));
    makeLedger(ledger, rows);
    let turns = 0;
    const timed = new BackupProfileService({
      db: rig.db,
      connectedDrives: () => [],
      uuid: () => 'big-phone',
      yieldNow: () => {
        turns += 1;
        return new Promise((resolve) => setImmediate(resolve));
      },
    });
    const t0 = Date.now();
    const r = await timed.importLedger({ profileId: id, ledgerPath: ledger });
    const took = Date.now() - t0;
    if (!r.ok || r.alreadyImported) throw new Error(JSON.stringify(r));
    expect(r.summary).toMatchObject({ rowsRead: N, linked: N - 1000, sourceRowsCreated: N });
    expect(r.summary.problems.not_in_index?.count).toBe(1000);
    expect(r.summary.problems.not_in_index?.examples).toHaveLength(20);
    expect(turns).toBeGreaterThan(N / 3000);
    expect(took).toBeLessThan(process.env['BACKUPHUB_BENCH'] === '1' ? 40_000 : 280_000);
  }, 300_000);
});
