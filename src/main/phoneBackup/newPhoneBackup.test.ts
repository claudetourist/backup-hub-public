import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_FOLDER } from '../../shared/appFolders';
import type { PhoneDevice } from '../../shared/phone';
import { PHONE_LOOK_JOB_KIND, type CreatePhoneBackupRequest, type NewBackupFolder } from '../../shared/phoneBackup';
import type { PhoneBackupAdb } from '../adb/adbPort';
import { DEFAULT_FILTERS, parseFilters } from '../backupProfiles/filters';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { FakeBackupAdb, FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { loadDestinations } from '../look/lookStore';
import { realBackupDrive } from './backupDrive';
import { planPhoneBackup } from './planJob';
import { PhoneBackupService, type PhoneBackupJobs } from './phoneBackupService';
import type { PhoneBackupDeps } from './phoneBackupTypes';

/** "Make a new backup for this phone": database only; every refusal changes nothing; the drive is a temp folder that is only ever read. */
const SAM: PhoneDevice = { serial: 'sam-serial', model: 'Redmi Note 12', state: 'device' };
type DriveNow = NonNullable<PhoneBackupDeps['connectedDrives']> extends () => Promise<infer R> ? R : never;

let rig: Rig;
let store: BackupProfileStore;
let t7Root: string;
let seagateRoot: string;
let devices: PhoneDevice[] | 'missing';
let drives: DriveNow;
let running: boolean;
let protectedLine: string | null;
let service: PhoneBackupService;

const mkdir = (...parts: string[]): void => {
  fs.mkdirSync(path.join(t7Root, ...parts), { recursive: true });
};
const tree = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).toSorted();
const counts = (): Record<string, number> =>
  Object.fromEntries(['backup_profiles', 'backup_destinations', 'places'].map((t) => [t, rig.db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number]));
const request = (folder: NewBackupFolder, over: Partial<CreatePhoneBackupRequest> = {}): CreatePhoneBackupRequest => ({ serial: SAM.serial, name: "Sam's phone", placeId: 'drive-t7', folder, ...over });

function makeService(adb: PhoneBackupAdb, extra: Partial<PhoneBackupDeps> = {}): PhoneBackupService {
  const jobs: PhoneBackupJobs = {
    create: () => 1,
    list: () => (running ? [{ kind: PHONE_LOOK_JOB_KIND, state: 'running' } as never] : []),
  };
  const silent = { info: () => undefined, warn: () => undefined };
  return new PhoneBackupService({ db: rig.db, adb, log: silent, driveFor: async () => null, connectedDrives: async () => drives, writeProtected: () => protectedLine, ...extra }, jobs);
}

beforeEach(() => {
  rig = makeRig();
  store = new BackupProfileStore(rig.db);
  t7Root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-newphone-t7-'));
  seagateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-newphone-sea-'));
  mkdir('MyData', 'HJ');
  mkdir('MyData', 'Sam phone');
  mkdir('MyData', 'POCO');
  mkdir('MyData', APP_FOLDER);
  fs.writeFileSync(path.join(t7Root, 'MyData', 'notes.txt'), 'a file, not a folder');
  const insertPlace = rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'drive', ?, '{}', 1)");
  insertPlace.run('drive-t7', 'T7');
  insertPlace.run('drive-sea', 'Seagate');
  // The Poco backup already uses MyData/POCO on the T7.
  const poco = store.create({ name: 'Poco F4', sourceKind: 'phone', folderPrefix: 'POCO', importKey: 'poco' });
  if (!poco.ok) throw new Error(poco.message);
  store.addDestination({ profileId: poco.id, placeId: 'drive-t7', root: 'MyData/POCO', role: 'primary' });
  devices = [SAM];
  running = false;
  protectedLine = null;
  drives = [
    { placeId: 'drive-t7', label: 'T7', root: t7Root, unreadable: false, blocked: null },
    { placeId: 'drive-sea', label: 'Seagate', root: seagateRoot, unreadable: true, blocked: null },
  ];
  const adb = {
    devices: async () => {
      if (devices === 'missing') throw new Error('adb is not installed');
      return devices;
    },
    killServer: async () => undefined,
  } as unknown as PhoneBackupAdb;
  service = makeService(adb);
});
afterEach(() => {
  rig.close();
  fs.rmSync(t7Root, { recursive: true, force: true });
  fs.rmSync(seagateRoot, { recursive: true, force: true });
});

describe('the choices of the form', () => {
  it('suggests the phone model and offers only the drives that may be picked, with the folders that may be picked; reads only', async () => {
    const before = tree(t7Root);
    const choices = await service.newBackupChoices(SAM.serial);
    // The Seagate cannot be read properly: not offered. POCO is used by a backup, the app's own folder and the file are no choice.
    expect(choices).toEqual({ ok: true, suggestedName: 'Redmi Note 12', drives: [{ placeId: 'drive-t7', label: 'T7', folders: ['HJ', 'Sam phone'] }] });
    expect(tree(t7Root)).toEqual(before);
  });

  it('a drive with an open question or a read-only drive is not offered; no drive plugged in gives an empty list', async () => {
    drives = [{ placeId: 'drive-t7', label: 'T7', root: t7Root, unreadable: false, blocked: 'This drive has another serial number.' }];
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ ok: true, drives: [] });
    drives = [{ placeId: 'drive-t7', label: 'T7', root: t7Root, unreadable: false, blocked: null }];
    protectedLine = 'T7 is read-only.';
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ ok: true, drives: [] });
    protectedLine = null;
    drives = [];
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ ok: true, drives: [] });
  });

  it('folders around or inside the folder of another backup (also a switched-off one) are left out', async () => {
    const other = store.create({ name: 'Old HJ', sourceKind: 'folder', sourceRoot: 'C:\\HJ', folderPrefix: 'HJ', enabled: false });
    if (!other.ok) throw new Error(other.message);
    store.addDestination({ profileId: other.id, placeId: 'drive-t7', root: 'MyData/hj/Deep', role: 'primary' });
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ drives: [{ folders: ['Sam phone'] }] });
  });

  it('a phone that is not there, not allowed, or already has a backup gets no form', async () => {
    expect(await service.newBackupChoices('nope')).toMatchObject({ ok: false, message: expect.stringContaining('not plugged in') });
    devices = [{ ...SAM, state: 'unauthorized' }];
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ ok: false, message: expect.stringContaining('tap Allow') });
    devices = [SAM];
    store.create({ name: 'Taken', sourceKind: 'phone', folderPrefix: 'Taken', phoneSerial: SAM.serial, enabled: false });
    expect(await service.newBackupChoices(SAM.serial)).toMatchObject({ ok: false, message: expect.stringContaining('already has its own backup') });
  });
});

describe('making the backup', () => {
  it('a new folder: the rows are made as specified, nothing is written to the drive, and the phone then shows as a phone with a backup', async () => {
    const before = tree(t7Root);
    const done = await service.createForPhone(request({ kind: 'new' }));
    expect(done).toEqual({ ok: true, backupId: expect.any(Number), message: "Sam's phone is set up. Its backups go to T7\\MyData\\Sam's phone." });
    if (!done.ok) return;
    expect(tree(t7Root)).toEqual(before); // not even the folder
    const profile = store.get(done.backupId)!;
    expect(profile).toMatchObject({ name: "Sam's phone", sourceKind: 'phone', phoneSerial: SAM.serial, folderPrefix: 'Sam-s-phone', enabled: true, importKey: null, changeRule: 'size_and_date', personId: store.defaultPersonId() });
    expect(profile.filters).toEqual(parseFilters(JSON.stringify(DEFAULT_FILTERS)));
    expect(loadDestinations(rig.db, done.backupId)).toEqual([{ id: expect.any(Number), placeId: 'drive-t7', root: "MyData/Sam's phone", position: 1 }]);
    expect(store.destinations(done.backupId)[0]).toMatchObject({ role: 'primary', enabled: true });
    const identity = JSON.parse(rig.db.prepare('SELECT identity_json FROM places WHERE id = ?').pluck().get(profile.sourcePlaceId) as string) as Record<string, unknown>;
    expect(identity).toMatchObject({ serial: SAM.serial, model: 'Redmi Note 12' });
    const status = await service.connected();
    expect(status.newPhones).toEqual([]);
    expect(status.phones).toMatchObject([{ backupId: done.backupId, backupName: "Sam's phone", serial: SAM.serial, phoneName: 'Redmi Note 12' }]);
  });

  it('a folder already on the drive: stored with the spelling on the drive, whatever the case typed', async () => {
    const done = await service.createForPhone(request({ kind: 'existing', name: 'sam PHONE' }, { name: 'Sam' }));
    if (!done.ok) throw new Error(done.message);
    expect(done.message).toBe('Sam is set up. Its backups go to T7\\MyData\\Sam phone.');
    expect(loadDestinations(rig.db, done.backupId)[0]).toMatchObject({ root: 'MyData/Sam phone' });
    expect(store.get(done.backupId)!.folderPrefix).toBe('Sam');
  });

  it('a second backup for the same phone is refused', async () => {
    expect((await service.createForPhone(request({ kind: 'new' }))).ok).toBe(true);
    const before = counts();
    expect(await service.createForPhone(request({ kind: 'new' }, { name: 'Another' }))).toMatchObject({ ok: false, message: expect.stringContaining('already has its own backup') });
    expect(counts()).toEqual(before);
  });

  it('a backup that went wrong half way leaves nothing behind (a drive the database does not know)', async () => {
    drives = [{ placeId: 'ghost', label: 'Ghost', root: t7Root, unreadable: false, blocked: null }];
    const before = counts();
    expect(await service.createForPhone(request({ kind: 'new' }, { placeId: 'ghost' }))).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was changed') });
    expect(counts()).toEqual(before);
  });

  const refused: [string, () => void, Partial<CreatePhoneBackupRequest>, NewBackupFolder, string][] = [
    ['an unknown phone', () => undefined, { serial: 'nope' }, { kind: 'new' }, 'not plugged in'],
    ['a phone that has not allowed this computer', () => { devices = [{ ...SAM, state: 'unauthorized' }]; }, {}, { kind: 'new' }, 'tap Allow'],
    ['adb that is missing', () => { devices = 'missing'; }, {}, { kind: 'new' }, 'adb'],
    ['a phone of a switched-off backup', () => { store.create({ name: 'Off', sourceKind: 'phone', folderPrefix: 'Off', phoneSerial: SAM.serial, enabled: false }); }, {}, { kind: 'new' }, 'already has its own backup'],
    ['a phone backup that is waiting or running', () => { running = true; }, {}, { kind: 'new' }, 'already waiting or running'],
    ['an empty name', () => undefined, { name: '   ' }, { kind: 'new' }, 'type a name'],
    ['a name of 41 characters', () => undefined, { name: 'x'.repeat(41) }, { kind: 'new' }, 'under 41'],
    ['a name that is taken (any case)', () => undefined, { name: 'poco F4' }, { kind: 'new' }, 'already a backup called'],
    ['a drive that is not plugged in', () => undefined, { placeId: 'drive-gone' }, { kind: 'new' }, 'not plugged in'],
    ['a drive whose card cannot be read', () => undefined, { placeId: 'drive-sea' }, { kind: 'new' }, 'cannot be read properly'],
    ['a drive with an open question', () => { drives[0]!.blocked = 'This drive has another serial number.'; }, {}, { kind: 'new' }, 'another serial number'],
    ['a read-only drive', () => { protectedLine = 'T7 is read-only.'; }, {}, { kind: 'new' }, 'read-only'],
    ['a new folder that is already on the drive (any case)', () => undefined, { name: 'hj' }, { kind: 'new' }, 'already on T7'],
    ['a name that makes no folder name', () => undefined, { name: '...' }, { kind: 'new' }, 'cannot be used as a folder name'],
    ['a new folder under the name of the app folder', () => undefined, { name: APP_FOLDER }, { kind: 'new' }, 'kept for Backup Hub'],
    ['a new folder where another backup already goes (not made yet)', () => { store.addDestination({ profileId: store.list()[0]!.id, placeId: 'drive-t7', root: 'MyData/Ghost', role: 'copy' }); }, { name: 'Ghost' }, { kind: 'new' }, 'Another backup already saves'],
    ['a folder that is not on the drive', () => undefined, {}, { kind: 'existing', name: 'Nowhere' }, 'There is no folder called Nowhere'],
    ['a file instead of a folder', () => undefined, {}, { kind: 'existing', name: 'notes.txt' }, 'is not a folder'],
    ['the folder of the app', () => undefined, {}, { kind: 'existing', name: APP_FOLDER }, 'kept for Backup Hub'],
    ['the folder of another backup', () => undefined, {}, { kind: 'existing', name: 'poco' }, 'Another backup already saves'],
    ['a folder that holds the folder of another backup', () => { store.addDestination({ profileId: store.list()[0]!.id, placeId: 'drive-t7', root: 'MyData/HJ/Deep', role: 'copy' }); }, {}, { kind: 'existing', name: 'HJ' }, 'Another backup already saves'],
    ['a folder inside the folder of another backup', () => { store.addDestination({ profileId: store.list()[0]!.id, placeId: 'drive-t7', root: 'MyData', role: 'copy' }); }, {}, { kind: 'existing', name: 'HJ' }, 'Another backup already saves'],
  ];
  it.each(refused)('refuses %s and changes nothing', async (_what, arrange, over, folder, words) => {
    arrange();
    const before = counts();
    const files = tree(t7Root);
    const answer = await service.createForPhone(request(folder, over));
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(words);
    expect(answer.message.endsWith('Nothing was changed.')).toBe(true);
    expect(counts()).toEqual(before);
    expect(tree(t7Root)).toEqual(files);
  });

  it('a bad request is refused', async () => {
    for (const bad of [null, {}, { ...request({ kind: 'new' }), serial: '' }, { ...request({ kind: 'new' }), folder: { kind: 'other' } }]) {
      expect((await service.createForPhone(bad as never)).ok).toBe(false);
    }
  });
});

describe('the new backup is a backup like the others', () => {
  it('a plan can be made for it (look, compare, a folder on the drive) and it goes to the folder that was chosen', async () => {
    const w = new World(rig, { seed: 5 });
    try {
      rig.db.prepare('UPDATE backup_profiles SET phone_serial = NULL WHERE id = ?').run(w.profileId); // the fake phone is "new" now
      w.tick(60);
      for (let i = 0; i < 3; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `photo ${i} ${'z'.repeat(i * 50)}`);
      const adb = new FakeBackupAdb(w.phone, w.shell);
      const deps: PhoneBackupDeps = {
        db: rig.db,
        adb,
        log: { info: () => undefined, warn: () => undefined },
        now: () => w.nowMs,
        driveFor: async (placeId) => (placeId === 'drive-t7' ? { drive: realBackupDrive(t7Root), label: 'T7' } : null),
        connectedDrives: async () => drives,
      };
      const made = await makeService(adb, { now: () => w.nowMs, driveFor: deps.driveFor }).createForPhone({ serial: w.phone.serial, name: 'Fake Sam', placeId: 'drive-t7', folder: { kind: 'existing', name: 'Sam phone' } });
      if (!made.ok) throw new Error(made.message);
      const before = tree(t7Root);
      const outcome = await planPhoneBackup(deps, { backupId: made.backupId }, new FakeCtx());
      expect(outcome.result.ok).toBe(true);
      if (!outcome.result.ok) return;
      expect(outcome.result.plan.totals.files).toBe(3);
      expect(outcome.result.plan.driveLabel).toBe('T7');
      expect(outcome.result.plan.folderWords).toContain('MyData\\Sam phone\\Fake-Sam-');
      expect(tree(t7Root)).toEqual(before); // looking and planning write nothing to the drive
    } finally {
      w.dispose();
    }
  });
});
