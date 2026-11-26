import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobService } from '../jobs/jobService';
import { ProfileService } from './profileService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;
let people: ProfileService;
let store: BackupProfileStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-people-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  people = new ProfileService(db);
  store = new BackupProfileStore(db);
  for (const [id, kind, label] of [
    ['laptop', 'laptop', 'STUDY-PC'],
    ['t7', 'drive', 'T7'],
  ] as const) db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string): number {
  const made = people.create(name);
  if (!made.ok) throw new Error(made.message);
  return made.profiles.find((p) => p.name === name)!.id;
}
function addPhoneBackup(name: string, personId: number): { backupId: number; placeId: string } {
  const made = store.create({ name, sourceKind: 'phone', phoneSerial: name + '-serial', folderPrefix: name.replace(/\W+/g, '-'), personId });
  if (!made.ok) throw new Error(made.message);
  const placeId = store.ensurePhonePlace(made.id)!;
  const dest = store.addDestination({ profileId: made.id, placeId: 't7', root: 'MyData/' + name, role: 'primary' });
  if (!dest.ok) throw new Error(dest.message);
  return { backupId: made.id, placeId };
}
const place = (id: string): { profile_id: number } => db.prepare('SELECT profile_id FROM places WHERE id = ?').get(id) as { profile_id: number };
const backupOwner = (id: number): number => db.prepare('SELECT person_id FROM backup_profiles WHERE id = ?').pluck().get(id) as number;

describe('people: list, add, rename', () => {
  it('lists You first, counts what each person owns, and picks colours from the palette', () => {
    const sam = addPerson('Sam');
    addPhoneBackup('Sam phone', sam);
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('g1', ?, 'gdrive', 'sam@example.com', 'connected', 1)").run(sam);
    const list = people.list();
    expect(list.map((p) => p.name)).toEqual(['You', 'Sam']);
    expect(list[0]).toMatchObject({ isFirst: true, backups: 0, phones: 0, accounts: 0 });
    expect(list[1]).toMatchObject({ isFirst: false, backups: 1, phones: 1, accounts: 1 });
    expect(list[1]!.color).not.toBe(list[0]!.color);
  });

  it('adds a person with a palette colour, and refuses a colour outside it, a clash of names, and an empty name', () => {
    expect(people.create('Mom', '#E74796')).toMatchObject({ ok: true });
    expect(people.list()[1]!.color).toBe('#e74796');
    expect(people.create('Aunt', '#123456')).toMatchObject({ ok: false, message: 'Please pick one of the colours shown.' });
    expect(people.create('mom')).toMatchObject({ ok: false, message: 'There is already someone called mom.' });
    expect(people.create('  ')).toMatchObject({ ok: false });
    expect(people.list()).toHaveLength(2);
    const mom = people.list()[1]!;
    expect(people.rename(mom.id, 'Amma')).toMatchObject({ ok: true });
    expect(people.rename(mom.id, 'you')).toMatchObject({ ok: false });
    expect(people.rename(999, 'X')).toMatchObject({ ok: false });
  });
});

describe('who a backup or a device belongs to', () => {
  it('gives a backup to someone else and takes its phone along; the toast sentence is plain', () => {
    const sam = addPerson('Sam');
    const { backupId, placeId } = addPhoneBackup('Sam phone', 1);
    expect(people.setBackupOwner(backupId, sam)).toEqual({ ok: true, message: 'Sam phone now belongs to Sam.' });
    expect(backupOwner(backupId)).toBe(sam);
    expect(place(placeId).profile_id).toBe(sam);
    // The drive and its folder are not touched: only the database changed.
    expect(db.prepare('SELECT root FROM backup_destinations WHERE backup_profile_id = ?').pluck().get(backupId)).toBe('MyData/Sam phone');
  });

  it('gives a phone to someone else and its backups go with it; a Google account too; drives are shared', () => {
    const mom = addPerson('Mom');
    const { backupId, placeId } = addPhoneBackup('Mom phone', 1);
    expect(people.setPlaceOwner(placeId, mom)).toEqual({ ok: true, message: 'Mom phone now belongs to Mom.' });
    expect(backupOwner(backupId)).toBe(mom);
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('g1', 1, 'gdrive', 'a@example.com', 'connected', 1)").run();
    expect(people.setPlaceOwner('g1', mom)).toMatchObject({ ok: true });
    expect(place('g1').profile_id).toBe(mom);
    expect(people.setPlaceOwner('t7', mom)).toEqual({ ok: false, message: 'T7 is shared by everyone. Nothing was changed.' });
    expect(people.setPlaceOwner('laptop', mom)).toMatchObject({ ok: false });
    expect(place('t7').profile_id).toBe(1);
  });

  it('refuses a person or a thing that is gone, a bad request, and a backup name the person already has; nothing changes', () => {
    const sam = addPerson('Sam');
    const mine = addPhoneBackup('Poco', 1);
    store.create({ name: 'Poco', sourceKind: 'folder', sourceRoot: 'C:\\x', folderPrefix: 'x', personId: sam });
    expect(people.setBackupOwner(mine.backupId, 99)).toMatchObject({ ok: false, message: expect.stringContaining('no longer exists') });
    expect(people.setBackupOwner(999, sam)).toMatchObject({ ok: false });
    expect(people.setBackupOwner('6', sam)).toMatchObject({ ok: false });
    expect(people.setBackupOwner(mine.backupId, sam)).toEqual({ ok: false, message: 'Sam already has a backup called Poco. Nothing was changed.' });
    expect(people.setPlaceOwner(mine.placeId, sam)).toMatchObject({ ok: false });
    expect(backupOwner(mine.backupId)).toBe(1);
    expect(place(mine.placeId).profile_id).toBe(1);
    expect(people.setPlaceOwner('nope', sam)).toMatchObject({ ok: false });
    expect(people.setPlaceOwner(5, sam)).toMatchObject({ ok: false });
  });
});

describe('removing a person', () => {
  it('needs a real confirmation, and never removes You', () => {
    expect(people.delete(1, false)).toMatchObject({ ok: false, message: expect.stringContaining('confirm') });
    expect(people.delete(1, 'true')).toMatchObject({ ok: false });
    expect(people.delete(1, true)).toMatchObject({ ok: false, message: expect.stringContaining('cannot be removed') });
    expect(people.list()).toHaveLength(1);
  });

  it('says what a person still has, in plain words, and removes them once they have nothing', () => {
    const sam = addPerson('Sam');
    const { backupId } = addPhoneBackup('Sam phone', sam);
    expect(people.delete(sam, true)).toEqual({ ok: false, message: 'Sam still has 1 backup and 1 phone. Give them to someone else first.' });
    expect(people.list()).toHaveLength(2);
    expect(people.setBackupOwner(backupId, 1)).toMatchObject({ ok: true });
    const done = people.delete(sam, true);
    expect(done.ok && done.profiles.map((p) => p.name)).toEqual(['You']);
    expect(people.delete(sam, true)).toMatchObject({ ok: false });
  });

  it('counts a Google account as something a person still has', () => {
    const mom = addPerson('Mom');
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('g1', ?, 'gdrive', 'a@example.com', 'connected', 1)").run(mom);
    expect(people.delete(mom, true)).toEqual({ ok: false, message: 'Mom still has 1 Google account. Give it to someone else first.' });
  });
});

describe('whose job it is', () => {
  it('jobs carry the owner of the backup, phone or account they work on; shared jobs have none', () => {
    const sam = addPerson('Sam');
    const { backupId, placeId } = addPhoneBackup('Sam phone', sam);
    const jobs = new JobService({ db, log: silent } as never);
    jobs.setOwnerResolver((_kind, params) => {
      const p = params as { backupId?: number; placeId?: string };
      if (typeof p.backupId === 'number') return (db.prepare('SELECT person_id FROM backup_profiles WHERE id = ?').pluck().get(p.backupId) as number | undefined) ?? null;
      if (typeof p.placeId === 'string') return (db.prepare("SELECT profile_id FROM places WHERE id = ? AND kind IN ('phone', 'gdrive')").pluck().get(p.placeId) as number | undefined) ?? null;
      return null;
    });
    const a = jobs.create('phone.backup', 'Back up', { backupId });
    const b = jobs.create('list.place', 'Check phone', { placeId });
    const c = jobs.create('list.place', 'Check T7', { placeId: 't7' });
    expect(jobs.get(a)?.personId).toBe(sam);
    expect(jobs.get(b)?.personId).toBe(sam);
    expect(jobs.get(c)?.personId).toBeNull();
    expect(jobs.list().map((j) => j.personId)).toEqual([null, sam, sam]);
  });
});
