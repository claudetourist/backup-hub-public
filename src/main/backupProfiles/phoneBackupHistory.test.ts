import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../rules/rulesStore';
import { BackupProfileService } from './backupProfileService';
import { newestSessionAt, sessionDate, staleReasons } from './history';
import { addIndexRows, addPlace, makeLedger, makeRig, sha, type Rig } from './fixtures.testutil';
import type { LedgerSummary } from './ledgerImport';

let rig: Rig;
let t7: string;
let configFile: string;
let service: BackupProfileService;

const CONFIG = JSON.stringify({
  profiles: {
    poco: { name: 'Poco F4', folder_prefix: 'Poco-F4', backup_root: 'F:\\MyData\\POCO', source: { type: 'adb' } },
    samsung_phone: { name: 'Mom Samsung', folder_prefix: 'Samsung-M31', backup_root: 'F:\\MyData\\SamsungM31', source: { type: 'adb' } },
    onedrive: { name: 'OneDrive Local Backup', folder_prefix: 'OneDrive', backup_root: 'F:\\MyData\\OneDriveBackup', source: { type: 'local', path: 'C:\\Users\\t\\OneDrive' } },
    ddrive: { name: 'DDrive Local Backup', folder_prefix: 'DDrive', backup_root: 'F:\\MyData\\DDriveBackup', source: { type: 'local', path: 'D:\\MyData' } },
    onedrive_imp: { name: 'OneDrive IMP Folder', folder_prefix: 'OneDrive-IMP', backup_root: 'F:\\MyData\\OneDriveBackup\\IMP', source: { type: 'local', path: 'C:\\Users\\t\\OneDrive\\IMP' } },
  },
});

const POCO = 'MyData/POCO/Poco-F4-17Jul26';
const DD = 'MyData/DDriveBackup/DDrive-29Jun26';
const OD = 'MyData/OneDriveBackup/OneDrive-26Oct26';
const win = (rel: string): string => 'F:\\' + rel.replaceAll('/', '\\');

function sourceLedgers(): void {
  makeLedger(path.join(t7, 'MyData', 'POCO', 'ledger.db'), [
    { file_size: 100, file_hash: sha(1), local_path: win(POCO + '/sdcard/DCIM/a.jpg'), original_phone_path: '/sdcard/DCIM/a.jpg', file_mtime: 10 },
    { file_size: 200, local_path: win(POCO + '/sdcard/DCIM/b.jpg'), original_phone_path: '/sdcard/DCIM/b.jpg', file_mtime: 11 },
    // Loose: PhoneBackup could not tell which phone file it came from.
    { file_size: 300, local_path: win(POCO + '/sdcard/loose.bin'), original_phone_path: null },
    // Stale: Backup Hub does not have it (an old session folder that is gone).
    { file_size: 400, local_path: win('MyData/POCO/Poco-F4-26Jun26/sdcard/old.jpg'), original_phone_path: '/sdcard/old.jpg' },
    // Stale: another size.
    { file_size: 500, local_path: win(POCO + '/sdcard/c.jpg'), original_phone_path: '/sdcard/c.jpg' },
  ]);
  makeLedger(path.join(t7, 'MyData', 'OneDriveBackup', 'ledger.db'), [{ file_size: 40, local_path: win(OD + '/n.txt'), original_phone_path: 'C:\\Users\\t\\OneDrive\\n.txt' }]);
  makeLedger(path.join(t7, 'MyData', 'DDriveBackup', 'ledger.db'), [
    { file_size: 10, local_path: win(DD + '/Spare/x.txt'), original_phone_path: 'D:\\MyData\\Spare\\x.txt' },
    { file_size: 11, local_path: win(DD + '/Spare/y.txt'), original_phone_path: 'D:\\MyData\\Spare\\y.txt' },
    { file_size: 20, local_path: win(DD + '/docs/z.txt'), original_phone_path: 'D:\\MyData\\docs\\z.txt' },
  ]);
}

function indexRows(spareGone: boolean): void {
  addIndexRows(rig.db, [
    { place: 't7', rel: POCO + '/sdcard/DCIM/a.jpg', size: 100, sha: sha(1) },
    { place: 't7', rel: POCO + '/sdcard/DCIM/b.jpg', size: 200 },
    { place: 't7', rel: POCO + '/sdcard/loose.bin', size: 300 },
    { place: 't7', rel: POCO + '/sdcard/c.jpg', size: 501 },
    { place: 't7', rel: 'MyData/POCO/Poco-F4-06Jul26/sdcard/zzz.jpg', size: 1 },
    { place: 't7', rel: OD + '/n.txt', size: 40 },
    { place: 't7', rel: DD + '/Spare/x.txt', size: 10, gone: spareGone ? 999 : null },
    { place: 't7', rel: DD + '/Spare/y.txt', size: 11, gone: spareGone ? 999 : null },
    { place: 't7', rel: DD + '/docs/z.txt', size: 20 },
    { place: 'lap', rel: 'D:/MyData/docs/z.txt', size: 20 },
    { place: 'od1', rel: 'n.txt', size: 40 },
  ]);
}

const dump = (): unknown => ({
  files: rig.db.prepare('SELECT * FROM files ORDER BY id').all(),
  places: rig.db.prepare('SELECT * FROM places ORDER BY id').all(),
  profiles: rig.db.prepare('SELECT * FROM backup_profiles ORDER BY id').all(),
  destinations: rig.db.prepare('SELECT * FROM backup_destinations ORDER BY id').all(),
  exclusions: rig.db.prepare('SELECT * FROM backup_exclusions ORDER BY source_path').all(),
  // What each run counted (problems_json) belongs to the latest run; everything else must not change on a repeat.
  imports: rig.db.prepare('SELECT id, backup_profile_id, ledger_path, ledger_sha256, imported_at, rows FROM ledger_imports ORDER BY id').all(),
});
const t7Files = (): string[] => fs.readdirSync(t7, { recursive: true, encoding: 'utf8' }).toSorted();
const hashOf = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 't7', 'drive', 'T7');
  addPlace(rig.db, 'lap', 'laptop', 'Laptop');
  addPlace(rig.db, 'od1', 'onedrive', 'OneDrive', { userFolder: 'C:\\Users\\t\\OneDrive' });
  t7 = path.join(rig.dir, 'drive-t7');
  for (const f of ['POCO', 'OneDriveBackup', 'DDriveBackup']) fs.mkdirSync(path.join(t7, 'MyData', f), { recursive: true });
  configFile = path.join(rig.dir, 'config.json');
  fs.writeFileSync(configFile, CONFIG);
  sourceLedgers();
  service = new BackupProfileService({
    db: rig.db,
    connectedDrives: () => [{ placeId: 't7', root: t7, label: 'T7' }],
    phoneBackupConfig: () => configFile,
    uuid: () => 'phone-place-1',
    now: () => 5000,
  });
});
afterEach(() => rig.close());

describe('Bring in PhoneBackup history: what will be read', () => {
  it('lists the three history files and the backups to make, and writes nothing anywhere', () => {
    indexRows(true);
    const before = dump();
    const filesBefore = t7Files();
    const plan = service.historyPlan();
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.driveLabel).toBe('T7');
    expect(plan.files.map((f) => [f.backup, f.found, f.bytes > 0, f.lastBroughtInAt])).toEqual([['Poco F4', true, true, null], ['OneDrive Local Backup', true, true, null], ['DDrive Local Backup', true, true, null]]);
    expect(plan.files[0]!.path).toBe(path.join(t7, 'MyData', 'POCO', 'ledger.db'));
    expect(plan.newBackups).toEqual(['Poco F4', 'Mom Samsung', 'OneDrive Local Backup', 'DDrive Local Backup', 'OneDrive IMP Folder (switched off)']);
    expect(plan.stop).toBeNull();
    expect(dump()).toEqual(before);
    expect(t7Files()).toEqual(filesBefore);
  });

  it('says so when the T7 is not plugged in, or the settings file is missing', () => {
    expect(new BackupProfileService({ db: rig.db, connectedDrives: () => [], phoneBackupConfig: () => configFile }).historyPlan()).toMatchObject({ ok: false });
    expect(new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root: t7, label: 'T7' }], phoneBackupConfig: () => path.join(rig.dir, 'none.json') }).historyPlan()).toMatchObject({ ok: false });
    expect(new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root: t7, label: 'T7' }] }).historyPlan()).toMatchObject({ ok: false });
  });

  it('stops, and offers nothing to bring in, when a history file has unsaved changes beside it (the .lock file is ignored)', async () => {
    indexRows(true);
    fs.writeFileSync(path.join(t7, 'MyData', 'OneDriveBackup', 'ledger.db.lock'), '1234');
    const ok = service.historyPlan();
    expect(ok).toMatchObject({ ok: true, stop: null });
    fs.writeFileSync(path.join(t7, 'MyData', 'OneDriveBackup', 'ledger.db-journal'), 'half a change');
    const plan = service.historyPlan();
    expect(plan).toMatchObject({ ok: true, stop: expect.stringContaining('OneDriveBackup') as string });
    const before = dump();
    const r = await service.bringInHistory();
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('Close PhoneBackup') as string });
    // Nothing was made, not even the backups.
    expect(dump()).toEqual(before);
    expect(rig.db.prepare('SELECT count(*) FROM backup_profiles').pluck().get()).toBe(0);
    // A -wal that is not empty stops it too; an empty one does not.
    fs.rmSync(path.join(t7, 'MyData', 'OneDriveBackup', 'ledger.db-journal'));
    fs.writeFileSync(path.join(t7, 'MyData', 'POCO', 'ledger.db-wal'), '');
    expect(service.historyPlan()).toMatchObject({ ok: true, stop: null });
    fs.writeFileSync(path.join(t7, 'MyData', 'POCO', 'ledger.db-wal'), 'x');
    expect(service.historyPlan()).toMatchObject({ ok: true, stop: expect.stringContaining('POCO') as string });
  });
});

describe('Bring in PhoneBackup history: the run', () => {
  it('makes the backups on the T7 (OneDrive IMP switched off), brings in the three history files read only, and reports the counts', async () => {
    indexRows(true);
    const ledgers = ['POCO', 'OneDriveBackup', 'DDriveBackup'].map((f) => path.join(t7, 'MyData', f, 'ledger.db'));
    const hashes = ledgers.map(hashOf);
    const filesBefore = t7Files();
    const r = await service.bringInHistory();
    if (!r.ok) throw new Error(r.message);
    // The old files are exactly as they were, and nothing was created beside them.
    expect(ledgers.map(hashOf)).toEqual(hashes);
    expect(t7Files()).toEqual(filesBefore);
    expect(r.made).toEqual(['Poco F4', 'Mom Samsung', 'OneDrive Local Backup', 'DDrive Local Backup', 'OneDrive IMP Folder']);
    expect(rig.db.prepare("SELECT enabled FROM backup_profiles WHERE import_key = 'onedrive_imp'").pluck().get()).toBe(0);
    expect(rig.db.prepare('SELECT DISTINCT place_id FROM backup_destinations').pluck().all()).toEqual(['t7']);
    const [poco, od, dd] = r.lines;
    expect(poco).toMatchObject({ backup: 'Poco F4', ok: true, rowsIn: 5, linked: 3, loose: 1, stale: 2 });
    expect(poco!.staleReasons.map((x) => x.count)).toEqual([1, 1]);
    expect(poco!.staleReasons.map((x) => x.reason).join(' ')).toMatch(/not in Backup Hub's list/);
    expect(poco!.staleReasons.map((x) => x.reason).join(' ')).toMatch(/different size/);
    expect(od).toMatchObject({ rowsIn: 1, linked: 1, stale: 0 });
    expect(dd).toMatchObject({ rowsIn: 3, linked: 3, loose: 0, stale: 0 });
    expect(r.totals).toEqual({ rowsIn: 9, linked: 7, loose: 1, stale: 2 });
    for (const line of r.lines) expect(line.rowsIn - line.linked).toBe(line.stale);
    expect(r.spare).toEqual({ inHistory: 2, marked: 2, stillShown: 0 });
    // Imported copies are not verified: how is 'imported', and Spare says where it is kept.
    expect(rig.db.prepare("SELECT verified_how FROM files WHERE rel_path = ?").pluck().get(POCO + '/sdcard/DCIM/a.jpg')).toBe('imported');
    expect(rig.db.prepare("SELECT gone_reason FROM files WHERE rel_path = ?").pluck().get(DD + '/Spare/x.txt')).toBe('kept_only_on_other_drive');
    expect(rig.db.prepare("SELECT gone_reason FROM files WHERE rel_path = ?").pluck().get(DD + '/docs/z.txt')).toBeNull();
    expect(rig.db.prepare('SELECT count(*) FROM ledger_imports').pluck().get()).toBe(3);
  });

  it('is repeatable: a second run adds nothing twice, and a run after PhoneBackup added rows adds only the new rows', async () => {
    indexRows(true);
    const first = await service.bringInHistory();
    if (!first.ok) throw new Error(first.message);
    const afterFirst = dump();
    const filesAfterFirst = rig.db.prepare('SELECT count(*) FROM files').pluck().get();

    const second = await service.bringInHistory();
    if (!second.ok) throw new Error(second.message);
    expect(second.made).toEqual([]);
    expect(second.alreadyThere).toHaveLength(5);
    expect(second.totals).toEqual(first.totals);
    expect(dump()).toEqual(afterFirst);

    // PhoneBackup runs again (a new row in the POCO history) and Backup Hub has seen the new file.
    const pocoLedger = path.join(t7, 'MyData', 'POCO', 'ledger.db');
    const ledger = new Database(pocoLedger);
    ledger.prepare('INSERT INTO ledger (filename, file_size, local_path, original_phone_path, file_mtime) VALUES (?, ?, ?, ?, ?)').run('d.jpg', 600, win(POCO + '/sdcard/DCIM/d.jpg'), '/sdcard/DCIM/d.jpg', 12);
    ledger.close();
    addIndexRows(rig.db, [{ place: 't7', rel: POCO + '/sdcard/DCIM/d.jpg', size: 600 }]);
    const phoneRows = rig.db.prepare("SELECT count(*) FROM files WHERE place_id = 'phone-place-1'").pluck().get() as number;
    const filesBeforeThird = rig.db.prepare('SELECT count(*) FROM files').pluck().get() as number;
    const third = await service.bringInHistory();
    if (!third.ok) throw new Error(third.message);
    expect(third.lines[0]).toMatchObject({ rowsIn: 6, linked: 4, stale: 2 });
    // One new source row for the phone and nothing else was added to the file list.
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = 'phone-place-1'").pluck().get()).toBe(phoneRows + 1);
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(filesBeforeThird + 1);
    expect(filesBeforeThird).toBe(filesAfterFirst as number + 1);
    expect(rig.db.prepare('SELECT count(*) FROM backup_profiles').pluck().get()).toBe(5);
    expect(rig.db.prepare('SELECT count(*) FROM backup_destinations').pluck().get()).toBe(5);
    // Nothing that was linked before changed.
    const before = (afterFirst as { files: { id: number }[] }).files;
    const now = rig.db.prepare('SELECT * FROM files ORDER BY id').all() as { id: number }[];
    expect(now.slice(0, before.length)).toEqual(before);
    // No duplicate rows for the same place and path.
    expect(rig.db.prepare('SELECT count(*) FROM (SELECT place_id, rel_path FROM files GROUP BY place_id, rel_path HAVING count(*) > 1)').pluck().get()).toBe(0);
    expect(newCols(POCO + '/sdcard/DCIM/d.jpg')).toMatchObject({ verified_how: 'imported' });
  });

  it('marks Spare as kept only on the Seagate once the T7 list shows it gone, and says so while the list is old', async () => {
    indexRows(false);
    const early = await service.bringInHistory();
    if (!early.ok) throw new Error(early.message);
    expect(early.spare).toEqual({ inHistory: 2, marked: 0, stillShown: 2 });
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE gone_reason = 'kept_only_on_other_drive'").pluck().get()).toBe(0);
    // A fresh look at the T7 finds Spare gone; bringing in again picks it up (the old file did not change).
    rig.db.prepare("UPDATE files SET gone_at = 999 WHERE rel_path LIKE '%/Spare/%'").run();
    const late = await service.bringInHistory();
    if (!late.ok) throw new Error(late.message);
    expect(late.spare).toEqual({ inHistory: 2, marked: 2, stillShown: 0 });
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE gone_reason = 'kept_only_on_other_drive'").pluck().get()).toBe(2);
    const again = await service.bringInHistory();
    if (!again.ok) throw new Error(again.message);
    expect(again.spare).toEqual({ inHistory: 2, marked: 2, stillShown: 0 });
  });

  it('does one run at a time, and keeps going when one history file is missing', async () => {
    indexRows(true);
    fs.rmSync(path.join(t7, 'MyData', 'OneDriveBackup', 'ledger.db'));
    const [a, b] = await Promise.all([service.bringInHistory(), service.bringInHistory()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const done = [a, b].find((x) => x.ok);
    if (!done?.ok) throw new Error('none ran');
    expect(done.lines.map((l) => [l.backup, l.ok])).toEqual([['Poco F4', true], ['OneDrive Local Backup', false], ['DDrive Local Backup', true]]);
    expect(done.lines[1]!.message).toContain('no history file');
  });
});

describe('Backups list', () => {
  it('shows name, what is backed up, the drive, the last backup date from the history, and on or off', async () => {
    indexRows(true);
    expect(service.overview()).toEqual({ backups: [], removed: [], historyBroughtInAt: null });
    await service.bringInHistory();
    const view = service.overview();
    expect(view.historyBroughtInAt).toBe(5000);
    expect(view.backups.map((b) => [b.name, b.kind, b.from, b.driveLabel, b.folder, b.driveConnected, b.enabled])).toEqual([
      ['Poco F4', 'phone', 'Phone', 'T7', 'MyData/POCO', true, true],
      ['Mom Samsung', 'phone', 'Phone', 'T7', 'MyData/SamsungM31', true, true],
      ['OneDrive Local Backup', 'folder', 'C:\\Users\\t\\OneDrive', 'T7', 'MyData/OneDriveBackup', true, true],
      ['DDrive Local Backup', 'folder', 'D:\\MyData', 'T7', 'MyData/DDriveBackup', true, true],
      ['OneDrive IMP Folder', 'folder', 'C:\\Users\\t\\OneDrive\\IMP', 'T7', 'MyData/OneDriveBackup/IMP', true, false],
    ]);
    const day = (y: number, m: number, d: number): number => new Date(y, m, d, 12).getTime();
    // Poco: the newest dated folder is 17 Jul 2026 (06 Jul is older); Samsung has none; OneDrive 26 Oct; DDrive 29 Jun; IMP none.
    expect(view.backups.map((b) => b.lastBackupAt)).toEqual([day(2026, 6, 17), null, day(2026, 9, 26), day(2026, 5, 29), null]);
  });
});

describe('Backups list: the Exclusions count', () => {
  it('is the real number of "never back up" choices of each phone backup (always-include ones and other backups\' choices are not counted)', async () => {
    indexRows(true);
    await service.bringInHistory();
    const [poco, samsung, oneDrive] = service.overview().backups;
    expect(service.overview().backups.map((b) => b.choices)).toEqual([0, 0, 0, 0, 0]);
    const rules = new RulesStore(rig.db);
    rules.add(poco!.id, { scope: 'file', pattern: '/sdcard/DCIM/a.jpg', choice: 'leave_out' });
    rules.add(poco!.id, { scope: 'folder', pattern: '/sdcard/Download', choice: 'include' });
    rules.add(samsung!.id, { scope: 'pattern', pattern: '*.tmp', choice: 'leave_out' });
    rules.add(samsung!.id, { scope: 'folder', pattern: '/sdcard/Movies', choice: 'leave_out' });
    expect(service.overview().backups.map((b) => b.choices)).toEqual([1, 2, 0, 0, 0]);
    expect(oneDrive!.kind).toBe('folder');
    rules.remove(rules.list(poco!.id).find((r) => r.choice === 'leave_out')!.id);
    expect(service.overview().backups.map((b) => b.choices)).toEqual([0, 2, 0, 0, 0]);
  });
});

describe('Backups list: did the last run fail', () => {
  it('is true only when the newest run of a backup failed', async () => {
    indexRows(true);
    await service.bringInHistory();
    const [poco, samsung, oneDrive] = service.overview().backups;
    const run = (id: number, startedAt: number, state: string): void => {
      rig.db.prepare('INSERT INTO backup_runs (backup_profile_id, destination_place_id, folder, started_at, ended_at, state) VALUES (?, ?, ?, ?, ?, ?)').run(id, 't7', 'x', startedAt, startedAt + 1, state);
    };
    run(poco!.id, 100, 'failed');
    run(samsung!.id, 100, 'failed');
    run(samsung!.id, 200, 'done');
    run(oneDrive!.id, 100, 'done');
    expect(service.overview().backups.map((b) => b.lastRunFailed)).toEqual([true, false, false, false, false]);
  });
});

describe('history helpers', () => {
  it('reads the date in a dated folder name, and nothing else', () => {
    expect(sessionDate('Poco-F4', 'Poco-F4-17Jul26')).toBe(new Date(2026, 6, 17, 12).getTime());
    expect(sessionDate('OneDrive', 'OneDrive-IMP-05Nov26')).toBeNull();
    expect(sessionDate('OneDrive-IMP', 'OneDrive-IMP-05Nov26')).toBe(new Date(2026, 10, 5, 12).getTime());
    expect(sessionDate('DDrive', 'DDrive-5Jan27 (2)')).toBe(new Date(2027, 0, 5, 12).getTime());
    expect(sessionDate('DDrive', 'DDrive-99Foo26')).toBeNull();
    expect(sessionDate('Poco', 'inventory_29Jun26.html')).toBeNull();
  });

  it('finds the newest dated folder by hopping from folder to folder', () => {
    addIndexRows(rig.db, [
      { place: 't7', rel: 'MyData/X/X-01Jan26/a/1', size: 1 },
      { place: 't7', rel: 'MyData/X/X-01Jan26/a/2', size: 1 },
      { place: 't7', rel: 'MyData/X/X-01Jan26-b/a/2', size: 1 },
      { place: 't7', rel: 'MyData/X/X-09Mar26/z', size: 1 },
      { place: 't7', rel: 'MyData/X/X-10Feb26/z', size: 1 },
      { place: 't7', rel: 'MyData/X/readme.txt', size: 1 },
      { place: 't7', rel: 'MyData/Xylophone/X-01Dec26/z', size: 1 },
    ]);
    expect(newestSessionAt(rig.db, 't7', 'MyData/X', 'X')).toBe(new Date(2026, 2, 9, 12).getTime());
    expect(newestSessionAt(rig.db, 't7', 'MyData/Nothing', 'X')).toBeNull();
  });

  it('adds the reasons up to the rows that were not matched', () => {
    const summary = { problems: { not_in_index: { count: 3, examples: ['a', 'b', 'c', 'd'] }, size_differs: { count: 5, examples: ['e'] }, source_not_in_index: { count: 9, examples: ['f'] } } } as unknown as LedgerSummary;
    const r = staleReasons(summary);
    expect(r.stale).toBe(8);
    expect(r.reasons.map((x) => x.count)).toEqual([5, 3]);
    expect(r.reasons[1]!.examples).toEqual(['a', 'b', 'c']);
  });
});

function newCols(rel: string): Record<string, unknown> {
  return rig.db.prepare('SELECT origin_file_id, expected_sha256, verified_how, gone_reason FROM files WHERE place_id = ? AND rel_path = ?').get('t7', rel) as Record<string, unknown>;
}
