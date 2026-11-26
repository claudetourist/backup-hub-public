import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhoneDevice } from '../../shared/phone';
import { ALLOW_PHONE_HINT } from '../../shared/phoneBackup';
import type { PhoneBackupAdb } from '../adb/adbPort';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { closeDatabase, initDatabase, type Db } from '../db';
import { PhoneBackupService } from './phoneBackupService';

/** Which phone belongs to which phone backup: the status lists the unlinked phone, linking only on a click, and the refusals. */
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const POCO: PhoneDevice = { serial: 'SERIAL0001', model: '22021211RI', state: 'device' };

describe('linking a phone to its phone backup', () => {
  let dir: string;
  let db: Db;
  let store: BackupProfileStore;
  let devices: PhoneDevice[] | 'missing';
  let service: PhoneBackupService;
  let pocoId: number;

  const serialOf = (id: number): string | null => store.get(id)!.phoneSerial;
  const placeIdentity = (placeId: string): Record<string, unknown> => JSON.parse(db.prepare('SELECT identity_json FROM places WHERE id = ?').pluck().get(placeId) as string) as Record<string, unknown>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-phonelink-test-'));
    fs.mkdirSync(path.join(dir, 'data'));
    const opened = initDatabase(path.join(dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    store = new BackupProfileStore(db);
    const made = store.create({ name: 'Poco F4', sourceKind: 'phone', folderPrefix: 'Poco-F4', importKey: 'poco' });
    if (!made.ok) throw new Error(made.message);
    pocoId = made.id;
    devices = [POCO];
    const adb = {
      devices: async () => {
        if (devices === 'missing') throw new Error('adb is not installed');
        return devices;
      },
      killServer: async () => undefined,
    } as unknown as PhoneBackupAdb;
    service = new PhoneBackupService({ db, adb, log: silent, driveFor: async () => null }, { create: () => 1, list: () => [] });
  });
  afterEach(() => {
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the status lists a plugged-in phone that belongs to no backup, and the phone backups without a phone; nothing is linked by itself', async () => {
    const status = await service.connected();
    expect(status.phones).toEqual([]);
    expect(status.newPhones).toEqual([{ serial: 'SERIAL0001', phoneName: '22021211RI', ready: true, hint: null }]);
    expect(status.backupsWithoutPhone).toEqual([{ backupId: pocoId, backupName: 'Poco F4' }]);
    expect(serialOf(pocoId)).toBeNull();
  });

  it('a phone that has not allowed this computer is listed with the hint, and is not linkable', async () => {
    devices = [{ serial: 'abc123', model: 'abc123', state: 'unauthorized' }];
    const status = await service.connected();
    expect(status.newPhones).toEqual([{ serial: 'abc123', phoneName: 'a phone', ready: false, hint: ALLOW_PHONE_HINT }]);
    expect(await service.linkPhone(pocoId, 'abc123')).toMatchObject({ ok: false, message: expect.stringContaining('tap Allow') });
    expect(serialOf(pocoId)).toBeNull();
  });

  it('a phone that is switched off, or an off backup, is not asked about', async () => {
    devices = [{ serial: 'zzz', model: 'x', state: 'offline' }];
    expect((await service.connected()).newPhones).toEqual([]);
    store.update(pocoId, { enabled: false });
    expect((await service.connected()).backupsWithoutPhone).toEqual([]);
  });

  it('link sets the serial, writes serial and model into the phone place, and the phone then shows as the backup\'s phone', async () => {
    const placeId = store.ensurePhonePlace(pocoId)!;
    expect(await service.linkPhone(pocoId, 'SERIAL0001')).toEqual({ ok: true, message: '22021211RI is now the phone for Poco F4.' });
    expect(serialOf(pocoId)).toBe('SERIAL0001');
    expect(placeIdentity(placeId)).toMatchObject({ serial: 'SERIAL0001', model: '22021211RI', importKey: 'poco' });
    const status = await service.connected();
    expect(status.newPhones).toEqual([]);
    expect(status.backupsWithoutPhone).toEqual([]);
    expect(status.phones).toMatchObject([{ backupId: pocoId, backupName: 'Poco F4', serial: 'SERIAL0001', phoneName: '22021211RI' }]);
  });

  it('link works for a backup that has no phone place yet', async () => {
    expect(store.get(pocoId)!.sourcePlaceId).toBeNull();
    expect((await service.linkPhone(pocoId, 'SERIAL0001')).ok).toBe(true);
    expect(serialOf(pocoId)).toBe('SERIAL0001');
  });

  it('a second backup cannot take a serial that already belongs to another backup', async () => {
    const other = store.create({ name: 'Samsung', sourceKind: 'phone', folderPrefix: 'Samsung' });
    if (!other.ok) throw new Error(other.message);
    expect((await service.linkPhone(pocoId, 'SERIAL0001')).ok).toBe(true);
    const refused = await service.linkPhone(other.id, 'SERIAL0001');
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('already has its own backup') });
    expect(serialOf(other.id)).toBeNull();
    expect(serialOf(pocoId)).toBe('SERIAL0001');
  });

  it('a serial adb does not report is refused, and so is a missing adb', async () => {
    expect(await service.linkPhone(pocoId, 'not-plugged-in')).toMatchObject({ ok: false, message: expect.stringContaining('not plugged in') });
    devices = 'missing';
    expect(await service.linkPhone(pocoId, 'SERIAL0001')).toMatchObject({ ok: false });
    expect(serialOf(pocoId)).toBeNull();
  });

  it('a backup of a folder, an unknown backup and a bad request are refused', async () => {
    const folder = store.create({ name: 'OneDrive', sourceKind: 'folder', sourceRoot: 'C:\\OneDrive', folderPrefix: 'OneDrive' });
    if (!folder.ok) throw new Error(folder.message);
    expect(await service.linkPhone(folder.id, 'SERIAL0001')).toMatchObject({ ok: false, message: expect.stringContaining('not a phone backup') });
    expect(serialOf(folder.id)).toBeNull();
    expect(await service.linkPhone(9999, 'SERIAL0001')).toMatchObject({ ok: false });
    expect(await service.linkPhone('1', 'SERIAL0001')).toMatchObject({ ok: false });
    expect(await service.linkPhone(pocoId, '')).toMatchObject({ ok: false });
  });

  it('a backup that already has another phone must use Change phone first', async () => {
    expect((await service.linkPhone(pocoId, 'SERIAL0001')).ok).toBe(true);
    devices = [POCO, { serial: 'second', model: 'Other', state: 'device' }];
    expect(await service.linkPhone(pocoId, 'second')).toMatchObject({ ok: false, message: expect.stringContaining('Change phone') });
    expect(serialOf(pocoId)).toBe('SERIAL0001');
  });

  it('Change phone clears the serial (only when confirmed) and takes it out of the phone place', async () => {
    const placeId = store.ensurePhonePlace(pocoId)!;
    await service.linkPhone(pocoId, 'SERIAL0001');
    expect(service.unlinkPhone(pocoId, false)).toMatchObject({ ok: false });
    expect(serialOf(pocoId)).toBe('SERIAL0001');
    expect(service.unlinkPhone(pocoId, true).ok).toBe(true);
    expect(serialOf(pocoId)).toBeNull();
    const identity = placeIdentity(placeId);
    expect(identity).not.toHaveProperty('serial');
    expect(identity).not.toHaveProperty('model');
    expect(identity).toMatchObject({ importKey: 'poco' });
    expect((await service.connected()).backupsWithoutPhone).toHaveLength(1);
  });

  it('two screens asking at once share one adb question, so one answer cannot cut the other short', async () => {
    let calls = 0;
    let kills = 0;
    const slow = {
      devices: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return [POCO];
      },
      killServer: async () => {
        kills += 1;
      },
    } as unknown as PhoneBackupAdb;
    const seen: string[][] = [];
    const shared = new PhoneBackupService({ db, adb: slow, log: silent, driveFor: async () => null, phonesSeen: (s) => seen.push([...s]) }, { create: () => 1, list: () => [] });
    const [a, b, c] = await Promise.all([shared.connected(), shared.connected(), shared.pluggedSerials()]);
    expect(calls).toBe(1);
    expect(kills).toBe(0);
    expect(a.newPhones).toHaveLength(1);
    expect(b.newPhones).toHaveLength(1);
    expect(c).toEqual(['SERIAL0001']);
    expect(seen).toEqual([['SERIAL0001']]);
    await shared.connected();
    expect(calls).toBe(2);
  });
});
