import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validSettingValue } from '../../shared/settings';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobService, type JobContext } from '../jobs/jobService';
import { APP_FOLDER, MY_DATA_FOLDER, OWN_FILES_FOLDER } from '../../shared/appFolders';
import { appFolder, dbCopiesFolder } from '../places/appFolders';
import { writeDriveCard } from '../places/driveCard';
import { PlaceService } from '../places/placeService';
import type { Volume } from '../places/volumes';
import { ProfileService } from '../profiles/profileService';
import { applyImport, buildExport, parseExport } from './exportImport';
import {
  dbCopyFileName,
  driveSettingsDir,
  KIND_SAVE_SETTINGS,
  listOwnFiles,
  newestSavedAt,
  saveIsDue,
  pruneOwnFiles,
  saveToDriveHandler,
  changeMarker,
  listSavedCopies,
  MIN_SAVE_INTERVAL_MS,
  saveToDriveRoot,
  savedMarker,
  settingsFileName,
} from './saveToDrive';
import { SettingsStore } from './settingsStore';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ID_A = '11111111-1111-4111-8111-111111111111';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-settings-test-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProfileService', () => {
  it('starts with the seeded You profile and creates, renames and lists', () => {
    const profiles = new ProfileService(db);
    expect(profiles.list().map((p) => p.name)).toEqual(['You']);
    const created = profiles.create('  Mom ');
    expect(created.ok && created.profiles.map((p) => p.name)).toEqual(['You', 'Mom']);
    expect(profiles.create('mom')).toMatchObject({ ok: false });
    expect(profiles.create('')).toMatchObject({ ok: false });
    const mom = profiles.list()[1]!;
    expect(profiles.rename(mom.id, 'Amma')).toMatchObject({ ok: true });
    expect(profiles.rename(mom.id, 'you')).toMatchObject({ ok: false });
    expect(profiles.rename(999, 'X')).toMatchObject({ ok: false });
    expect(profiles.list()[1]?.color).not.toBe(profiles.list()[0]?.color);
  });
});

describe('SettingsStore', () => {
  it('returns defaults, stores typed values and rejects bad ones', () => {
    const store = new SettingsStore(db);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.set('theme', 'dark')).toMatchObject({ ok: true });
    expect(store.set('notificationsEnabled', false)).toMatchObject({ ok: true });
    expect(store.set('snapshotToDrive', false)).toMatchObject({ ok: true });
    expect(store.get()).toEqual({ theme: 'dark', notificationsEnabled: false, snapshotToDrive: false, skipFolders: DEFAULT_SETTINGS.skipFolders, hashMegabytesPerSecond: 60, savedCopiesKeep: 7, autoRemoveOldCopies: false, googleKeepFreePercent: 25, recoveryToGoogle: false, recoveryGoogleAccount: null, writeProtectedDrives: [], duplicatesInUserFolders: false, appDataSources: DEFAULT_SETTINGS.appDataSources, driveReminderDays: 14, activePerson: 1 });
    // The person in focus: a person's id or null (Everyone), remembered.
    for (const bad of [0, -1, 1.5, '1', true]) expect(store.set('activePerson', bad)).toMatchObject({ ok: false });
    expect(store.set('activePerson', null)).toMatchObject({ ok: true });
    expect(store.get().activePerson).toBeNull();
    expect(store.set('activePerson', 1)).toMatchObject({ ok: true });
    // The old switches no longer exist.
    expect(store.set('autoListing', true)).toMatchObject({ ok: false });
    expect(store.set('refreshEveryHours', 6)).toMatchObject({ ok: false });
    // The skip list: default as in the plan, names only, no duplicates.
    expect(store.get().skipFolders).toEqual(['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '$RECYCLE.BIN', 'System Volume Information']);
    expect(store.set('skipFolders', ['dist', 'Dist', ' build '])).toMatchObject({ ok: true });
    expect(store.get().skipFolders).toEqual(['dist', 'build']);
    for (const bad of [['a/b'], [''], [3], 'node_modules', ['..']]) expect(store.set('skipFolders', bad)).toMatchObject({ ok: false });
    expect(store.set('skipFolders', [...DEFAULT_SETTINGS.skipFolders])).toMatchObject({ ok: true });
    // The Google free line: 20 to 50 percent, default 25.
    expect(store.get().googleKeepFreePercent).toBe(25);
    for (const bad of [19, 51, 25.5, '25', null]) expect(store.set('googleKeepFreePercent', bad)).toMatchObject({ ok: false });
    expect(store.set('googleKeepFreePercent', 20)).toMatchObject({ ok: true });
    expect(store.set('googleKeepFreePercent', 25)).toMatchObject({ ok: true });
    // Home's "not plugged in for N days" reminder: a whole number of days, 1 to 365, default 14.
    expect(store.get().driveReminderDays).toBe(14);
    for (const bad of [0, 366, 14.5, '14', null]) expect(store.set('driveReminderDays', bad)).toMatchObject({ ok: false });
    expect(store.set('driveReminderDays', 30)).toMatchObject({ ok: true });
    expect(store.get().driveReminderDays).toBe(30);
    expect(store.set('driveReminderDays', 14)).toMatchObject({ ok: true });
    // Saved copies: nothing is removed by default; the number kept is a whole number from 3 to 30.
    expect(DEFAULT_SETTINGS).toMatchObject({ savedCopiesKeep: 7, autoRemoveOldCopies: false });
    for (const bad of [2, 31, 7.5, '7', null, Number.NaN]) expect(store.set('savedCopiesKeep', bad)).toMatchObject({ ok: false });
    expect(store.set('savedCopiesKeep', 3)).toMatchObject({ ok: true });
    expect(store.set('savedCopiesKeep', 30)).toMatchObject({ ok: true });
    expect(store.set('autoRemoveOldCopies', 'yes')).toMatchObject({ ok: false });
    expect(store.set('autoRemoveOldCopies', true)).toMatchObject({ ok: true });
    expect(store.get()).toMatchObject({ savedCopiesKeep: 30, autoRemoveOldCopies: true });
    expect(store.set('theme', 'purple')).toMatchObject({ ok: false });
    expect(store.set('notificationsEnabled', 'yes')).toMatchObject({ ok: false });
    expect(store.set('nope', true)).toMatchObject({ ok: false });
    expect(store.set(5, true)).toMatchObject({ ok: false });
    expect(store.get().theme).toBe('dark');
  });

  it('survives garbage in the table and tells listeners', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', '{bad'), ('snapshotToDrive', '\"maybe\"'), ('unrelated', '1')").run();
    const store = new SettingsStore(db);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const seen: string[] = [];
    store.onChanged((s) => seen.push(s.theme));
    store.set('theme', 'light');
    expect(seen).toEqual(['light']);
  });
});

describe('the Google recovery copy settings', () => {
  it('are off and empty until the person chooses', () => {
    const store = new SettingsStore(db);
    expect(store.get().recoveryToGoogle).toBe(false);
    expect(store.get().recoveryGoogleAccount).toBeNull();
    expect(store.set('recoveryToGoogle', 'yes').ok).toBe(false);
    expect(store.set('recoveryGoogleAccount', 5).ok).toBe(false);
    expect(store.set('recoveryGoogleAccount', 'gdrive-1').ok).toBe(true);
    expect(store.set('recoveryGoogleAccount', null).ok).toBe(true);
  });

  it('are never switched on by an imported settings file', () => {
    const store = new SettingsStore(db);
    store.set('recoveryToGoogle', true);
    store.set('recoveryGoogleAccount', 'gdrive-1');
    const text = JSON.stringify(buildExport(db, store, '0.1.0'));
    const other = fs.mkdtempSync(path.join(dir, 'other-'));
    const opened = initDatabase(other, silent);
    if (!opened.ok) throw new Error('no db');
    try {
      const store2 = new SettingsStore(opened.db);
      const parsed = parseExport(text);
      if (!parsed.ok) throw new Error('did not parse');
      applyImport(opened.db, store2, parsed.data, 5);
      expect(store2.get().recoveryToGoogle).toBe(false);
      expect(store2.get().recoveryGoogleAccount).toBeNull();
    } finally {
      closeDatabase(opened.db, silent);
    }
  });
});

describe('export and import', () => {
  it('exports profiles, places and settings and never touches secrets or vault keys', () => {
    db.prepare("INSERT INTO secrets (name, ciphertext, nonce, created_at) VALUES ('google:SECRETNAME', x'DEADBEEFCAFE', x'00', 1)").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('vault.v1', 'KEYMATERIAL-XYZ')").run();
    const store = new SettingsStore(db);
    store.set('theme', 'light');
    const exported = buildExport(db, store, '0.1.0', new Date('2026-10-30T10:00:00Z'));
    const text = JSON.stringify(exported);
    expect(text).not.toContain('SECRETNAME');
    expect(text).not.toContain('KEYMATERIAL');
    expect(text.toLowerCase()).not.toContain('deadbeef');
    expect(Object.keys(exported).toSorted()).toEqual(['appVersion', 'exportedAt', 'format', 'places', 'profiles', 'settings', 'version']);
    expect(exported.profiles).toEqual([{ name: 'You', color: '#0b6b5c' }]);
    expect(exported.settings.theme).toBe('light');
  });

  it('round-trips into a fresh database, adding only', () => {
    const store = new SettingsStore(db);
    const profiles = new ProfileService(db);
    profiles.create('Mom');
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, status, created_at) VALUES (?, 2, 'drive', 'T7', '{\"serial\":\"AAAA0001\"}', 'E:', 'connected', 1)").run(ID_A);
    store.set('theme', 'dark');
    store.set('snapshotToDrive', false);
    store.set('savedCopiesKeep', 12);
    store.set('autoRemoveOldCopies', true);
    const text = JSON.stringify(buildExport(db, store, '0.1.0'));

    const other = fs.mkdtempSync(path.join(dir, 'other-'));
    const opened = initDatabase(other, silent);
    if (!opened.ok) throw new Error('no db');
    const db2 = opened.db;
    try {
      const store2 = new SettingsStore(db2);
      const parsed = parseExport(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const summary = applyImport(db2, store2, parsed.data, 5);
      expect(summary).toEqual({ settingsApplied: 10, profilesAdded: 1, placesAdded: 1, placesSkipped: 0 });
      expect(store2.get()).toMatchObject({ theme: 'dark', snapshotToDrive: false, savedCopiesKeep: 12, autoRemoveOldCopies: true });
      expect(new ProfileService(db2).list().map((p) => p.name)).toEqual(['You', 'Mom']);
      const place = db2.prepare('SELECT p.label, p.status, pr.name AS profile FROM places p JOIN profiles pr ON pr.id = p.profile_id WHERE p.id = ?').get(ID_A);
      expect(place).toEqual({ label: 'T7', status: 'unknown', profile: 'Mom' });

      // Importing again changes nothing and removes nothing.
      db2.prepare("UPDATE places SET label = 'Renamed' WHERE id = ?").run(ID_A);
      const again = applyImport(db2, store2, parsed.data, 6);
      expect(again).toMatchObject({ profilesAdded: 0, placesAdded: 0, placesSkipped: 1 });
      expect((db2.prepare('SELECT label FROM places WHERE id = ?').get(ID_A) as { label: string }).label).toBe('Renamed');
    } finally {
      closeDatabase(db2, silent);
    }
  });

  it('rejects files that are not settings files and ignores bad entries', () => {
    expect(parseExport('not json')).toMatchObject({ ok: false });
    expect(parseExport('[]')).toMatchObject({ ok: false });
    expect(parseExport(JSON.stringify({ format: 'something-else', version: 1 }))).toMatchObject({ ok: false });
    expect(parseExport(JSON.stringify({ format: 'backuphub-settings', version: 99 }))).toMatchObject({ ok: false, message: expect.stringContaining('newer') });
    expect(parseExport('x'.repeat(3 * 1024 * 1024))).toMatchObject({ ok: false });
    const parsed = parseExport(
      JSON.stringify({
        format: 'backuphub-settings',
        version: 1,
        settings: { theme: 'neon', notificationsEnabled: false, secret: 'x' },
        profiles: [{ name: '' }, { name: 'Wife', color: 'nope' }, 5],
        places: [{ id: 'a', kind: 'toaster', label: 'x', profile: 'You' }, { id: 'b', kind: 'phone', label: 'Poco', profile: 'You' }],
      }),
    );
    expect(parsed.ok && parsed.data.settings).toEqual({ notificationsEnabled: false });
    expect(parsed.ok && parsed.data.profiles.map((p) => p.name)).toEqual(['Wife']);
    expect(parsed.ok && parsed.data.places.map((p) => p.id)).toEqual(['b']);
  });
});

describe('saving to a named drive (temp folders only)', () => {
  const d = (s: string) => new Date(`2026-10-${s}`);

  it('pruning keeps the newest 7 of its own files and leaves everything else alone', () => {
    const target = dbCopiesFolder(dir);
    fs.mkdirSync(target, { recursive: true });
    for (let day = 1; day <= 10; day += 1) {
      const at = new Date(2026, 9, day, 8, 0, 0);
      fs.writeFileSync(path.join(target, settingsFileName(at)), '{}');
      fs.writeFileSync(path.join(target, dbCopyFileName(at)), 'db');
    }
    const foreign = ['notes.txt', 'backuphub-settings-latest.json', 'backuphub-db-20261001-080000.db.tmp', 'backuphub-20261001-080000.db'];
    for (const name of foreign) fs.writeFileSync(path.join(target, name), 'mine');
    const removed = pruneOwnFiles(target);
    expect(removed).toHaveLength(6);
    expect(listOwnFiles(target, /^backuphub-settings-/)).toHaveLength(8); // 7 ours + the near-miss "latest"
    expect(fs.existsSync(path.join(target, settingsFileName(new Date(2026, 9, 3, 8, 0, 0))))).toBe(false);
    expect(fs.existsSync(path.join(target, settingsFileName(new Date(2026, 9, 4, 8, 0, 0))))).toBe(true);
    for (const name of foreign) expect(fs.existsSync(path.join(target, name))).toBe(true);
    expect(newestSavedAt(target)?.getDate()).toBe(10);
  });

  it('says a save is due only when a connected drive has no save from the last 6 hours and something changed', () => {
    const root = path.join(dir, 'drive-due');
    fs.mkdirSync(driveSettingsDir(root), { recursive: true });
    const at = new Date(2026, 9, 10, 8, 0, 0);
    expect(saveIsDue([], at)).toBe(false); // no drive connected: nothing to save to
    expect(saveIsDue([root], at)).toBe(true); // nothing saved yet
    fs.writeFileSync(path.join(driveSettingsDir(root), settingsFileName(at)), '{}');
    expect(MIN_SAVE_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(saveIsDue([root], new Date(2026, 9, 10, 8, 30, 0))).toBe(false);
    expect(saveIsDue([root], new Date(2026, 9, 10, 9, 0, 1))).toBe(false); // an hour is not enough any more
    expect(saveIsDue([root], new Date(2026, 9, 10, 13, 59, 0))).toBe(false);
    expect(saveIsDue([root], new Date(2026, 9, 10, 14, 0, 1))).toBe(true);
    expect(saveIsDue([root], new Date(2026, 9, 10, 20, 0, 0), () => false)).toBe(false); // old enough, but nothing changed
    expect(saveIsDue([root], new Date(2026, 9, 10, 20, 0, 0), () => true)).toBe(true);
    const other = path.join(dir, 'drive-empty');
    expect(saveIsDue([root, other], new Date(2026, 9, 10, 8, 30, 0), () => false)).toBe(true); // never saved: due whatever changed
  });

  it('removes nothing after a save by default, and prunes (newest N of each kind) only when automatic removal is on', async () => {
    const root = path.join(dir, 'drive-prune');
    const target = driveSettingsDir(root);
    fs.mkdirSync(target, { recursive: true });
    for (let day = 1; day <= 9; day += 1) {
      const at = new Date(2026, 9, day, 8, 0, 0);
      fs.writeFileSync(path.join(target, settingsFileName(at)), '{}');
      fs.writeFileSync(path.join(target, dbCopyFileName(at)), 'db');
    }
    const store = new SettingsStore(db);
    const before = fs.readdirSync(target).length;
    const kept = await saveToDriveRoot(db, store, '0.1.0', root, d('30T10:00:00'));
    expect(kept.pruned).toEqual([]);
    expect(fs.readdirSync(target)).toHaveLength(before + 2);
    const pruned = await saveToDriveRoot(db, store, '0.1.0', root, d('30T11:00:00'), { autoRemove: true, keep: 4 });
    expect(pruned.pruned).toHaveLength(2 * (before / 2 + 2 - 4));
    expect(listOwnFiles(target, /^backuphub-settings-/)).toHaveLength(4);
    expect(listOwnFiles(target, /^backuphub-db-/)).toHaveLength(4);
  });

  it('lists the saved copies of each drive (read only): kind, time from the name, size, and how many exceed the keep number', async () => {
    const root = path.join(dir, 'drive-list');
    const target = driveSettingsDir(root);
    fs.mkdirSync(target, { recursive: true });
    for (let day = 1; day <= 5; day += 1) {
      const at = new Date(2026, 9, day, 8, 30, 15);
      fs.writeFileSync(path.join(target, settingsFileName(at)), '{}');
      fs.writeFileSync(path.join(target, dbCopyFileName(at)), 'db-bytes');
    }
    const foreign = ['notes.txt', 'backuphub-settings-latest.json', 'backuphub-db-20261001-080000.db.tmp'];
    for (const name of foreign) fs.writeFileSync(path.join(target, name), 'mine');
    const before = fs.readdirSync(target).toSorted();
    const overview = await listSavedCopies([{ placeId: 'p1', label: 'T7', root }, { placeId: 'p2', label: 'Empty', root: path.join(dir, 'nowhere') }], 3);
    expect(overview.keep).toBe(3);
    expect(overview.drives.map((x) => [x.label, x.copies.length, x.exceeding])).toEqual([['T7', 10, 4], ['Empty', 0, 0]]);
    const first = overview.drives[0]!.copies[0]!;
    expect(first).toEqual({ name: dbCopyFileName(new Date(2026, 9, 5, 8, 30, 15)), kind: 'database', savedAt: new Date(2026, 9, 5, 8, 30, 15).getTime(), bytes: 8 });
    expect(overview.drives[0]!.copies.find((c) => c.kind === 'settings')).toMatchObject({ bytes: 2 });
    expect(fs.readdirSync(target).toSorted()).toEqual(before); // nothing changed
  });

  it('the change marker moves with settings, places, collections and finished listing jobs, not with a job that only saves', () => {
    const store = new SettingsStore(db);
    const m0 = changeMarker(db, store);
    expect(changeMarker(db, store)).toBe(m0);
    store.set('theme', 'dark');
    const m1 = changeMarker(db, store);
    expect(m1).not.toBe(m0);
    db.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, 'Photos', 'important')").run();
    const m2 = changeMarker(db, store);
    expect(m2).not.toBe(m1);
    db.prepare("INSERT INTO jobs (kind, title, state, created_at, finished_at) VALUES ('settings.saveToDrive', 'Save', 'done', 1, 2)").run();
    expect(changeMarker(db, store)).toBe(m2);
    db.prepare("INSERT INTO jobs (kind, title, state, created_at, finished_at) VALUES ('list.place', 'List', 'done', 1, 2)").run();
    expect(changeMarker(db, store)).not.toBe(m2);
  });

  it("writes a settings file and a database copy only into the drive's database safety copies folder (inside the app folder)", async () => {
    const root = path.join(dir, 'drive');
    fs.mkdirSync(root);
    const store = new SettingsStore(db);
    const result = await saveToDriveRoot(db, store, '0.1.0', root, d('30T10:00:00'));
    expect(fs.readdirSync(root)).toEqual([MY_DATA_FOLDER]);
    expect(fs.readdirSync(path.join(root, MY_DATA_FOLDER))).toEqual([APP_FOLDER]);
    expect(driveSettingsDir(root)).toBe(dbCopiesFolder(root));
    expect(fs.readdirSync(driveSettingsDir(root)).toSorted()).toEqual(result.written.toSorted());
    const copy = path.join(driveSettingsDir(root), result.written.find((n) => n.endsWith('.db'))!);
    expect(fs.statSync(copy).size).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(driveSettingsDir(root), result.written.find((n) => n.endsWith('.json'))!), 'utf8')).format).toBe('backuphub-settings');
  });

  describe('job handler', () => {
    let roots: string;
    let volumes: Volume[];
    let places: PlaceService;
    let settings: SettingsStore;
    const vol = (letter: string, serial: string): Volume => ({
      letter,
      label: '',
      fileSystem: 'NTFS',
      capacity: 1e12,
      free: 5e11,
      driveType: 2,
      serial,
    });
    const rootOf = (letter: string) => path.join(roots, letter.replace(':', ''));
    const ctx = (params: unknown = {}) => {
      const warnings: string[] = [];
      const context = {
        jobId: 1,
        params,
        resume: null,
        signal: new AbortController().signal,
        progress: () => {},
        log: () => {},
        warn: (t: string) => warnings.push(t),
        needsYou: () => Promise.resolve('continue'),
        checkpoint: () => {},
        yield: () => Promise.resolve(),
      } as unknown as JobContext;
      return { context, warnings };
    };

    beforeEach(async () => {
      roots = path.join(dir, 'roots');
      fs.mkdirSync(path.join(roots, 'E'), { recursive: true });
      fs.mkdirSync(path.join(roots, 'F'), { recursive: true });
      volumes = [vol('E:', 'AAAA0001')];
      settings = new SettingsStore(db);
      places = new PlaceService({
        db,
        dataDir: dir,
        hostname: 'PC',
        appVersion: '0.1.0',
        systemDrive: 'C:',
        listVolumes: () => Promise.resolve(volumes),
        rootOf,
        log: silent,
      });
      places.init();
      await places.refresh();
    });

    const handler = (now = () => d('30T10:00:00')) => saveToDriveHandler({ db, settings, places, appVersion: '0.1.0', log: silent, now });

    it('does nothing when no named drive is connected (an unnamed drive is never written to)', async () => {
      const { context } = ctx();
      expect(await handler().run(context)).toMatch(/No named backup drive/);
      expect(fs.readdirSync(rootOf('E:'))).toEqual([]);
    });

    it('a drive the person protected (here T7) is never written to; the job says so and queues nothing to do', async () => {
      settings.set('writeProtectedDrives', ['T7']);
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'T7', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      expect(places.connectedDrives()).toHaveLength(1);
      const before = fs.readdirSync(rootOf('E:')).toSorted();
      const { context } = ctx({ force: true });
      await expect(handler().run(context)).resolves.toBe('T7 is read-only (protected), so nothing is written to it.');
      expect(fs.readdirSync(rootOf('E:')).toSorted()).toEqual(before);
    });

    it('saves to a named drive, then skips it when saved within 6 hours, unless forced', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      expect(places.connectedDrives()).toHaveLength(1);
      const h = handler();
      expect(await h.run(ctx().context)).toMatch(/Saved settings and a database copy to 1 drive/);
      expect(fs.readdirSync(rootOf('E:'))).toEqual([MY_DATA_FOLDER]);
      expect(fs.readdirSync(appFolder(rootOf('E:')))).toEqual([OWN_FILES_FOLDER]);
      expect(fs.readdirSync(driveSettingsDir(rootOf('E:')))).toHaveLength(2);
      expect(await h.run(ctx().context)).toMatch(/already has a recent copy/);
      expect(fs.readdirSync(driveSettingsDir(rootOf('E:')))).toHaveLength(2);
      expect(await handler(() => d('30T10:00:05')).run(ctx({ force: true }).context)).toMatch(/Saved/);
      expect(fs.readdirSync(driveSettingsDir(rootOf('E:')))).toHaveLength(4);
    });

    it('after 6 hours it saves again only if something changed; Save now always saves; nothing is removed by default', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      const copies = () => fs.readdirSync(driveSettingsDir(rootOf('E:'))).length;
      expect(await handler(() => d('30T10:00:00')).run(ctx().context)).toMatch(/Saved/);
      expect(savedMarker(db, ID_A)).toBe(changeMarker(db, settings));
      expect(copies()).toBe(2);
      // 7 hours later, nothing changed: no new copy.
      expect(await handler(() => d('30T17:00:00')).run(ctx().context)).toMatch(/nothing has changed/);
      expect(copies()).toBe(2);
      // Still inside 6 hours: no copy, even after a change.
      settings.set('theme', 'dark');
      expect(await handler(() => d('30T15:59:00')).run(ctx().context)).toMatch(/already has a recent copy/);
      expect(copies()).toBe(2);
      // 7 hours later and a setting changed: saved.
      expect(await handler(() => d('30T17:00:00')).run(ctx().context)).toMatch(/Saved/);
      expect(copies()).toBe(4);
      // Save now saves although nothing changed and it is recent; and many copies are never removed on their own.
      for (let i = 1; i <= 10; i += 1) expect(await handler(() => d(`30T17:00:${String(i).padStart(2, '0')}`)).run(ctx({ force: true }).context)).toMatch(/Saved/);
      expect(copies()).toBe(24);
    });

    it('removes old copies only when automatic removal is on, keeping the newest N of each kind', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      settings.set('autoRemoveOldCopies', true);
      settings.set('savedCopiesKeep', 3);
      for (let i = 1; i <= 6; i += 1) await handler(() => d(`30T10:00:0${i}`)).run(ctx({ force: true }).context);
      const names = fs.readdirSync(driveSettingsDir(rootOf('E:')));
      expect(names.filter((n) => n.startsWith('backuphub-settings-'))).toHaveLength(3);
      expect(names.filter((n) => n.startsWith('backuphub-db-'))).toHaveLength(3);
    });

    it('respects the snapshotToDrive switch, but Save now (force) overrides it', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      settings.set('snapshotToDrive', false);
      expect(await handler().run(ctx().context)).toMatch(/switched off/);
      expect(fs.existsSync(dbCopiesFolder(rootOf('E:')))).toBe(false);
      expect(await handler().run(ctx({ force: true }).context)).toMatch(/Saved/);
    });

    it('re-checks the card first: a different drive in the same letter is not written to', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      const h = saveToDriveHandler({
        db,
        settings,
        places,
        appVersion: '0.1.0',
        log: silent,
        readCard: () => Promise.resolve({ status: 'ok', card: { id: '22222222-2222-4222-8222-222222222222', name: 'Other', createdAt: '', appVersion: '' } }),
      });
      const { context, warnings } = ctx();
      // The safety check working is not a failure: the job ends with a warning and a plain skip line, and writes nothing.
      await expect(h.run(context)).resolves.toMatch(/^Skipped Backup: not the named drive, nothing was written/);
      expect(warnings[0]).toMatch(/^Skipped Backup: .*is not the named Backup any more, so nothing was written/);
      expect(fs.existsSync(dbCopiesFolder(rootOf('E:')))).toBe(false);
    });

    it('runs as a light job through JobService and is registered under its kind', async () => {
      writeDriveCard(rootOf('E:'), { id: ID_A, name: 'Backup', createdAt: '', appVersion: '0.1.0' });
      await places.refresh();
      const jobs = new JobService({ db, log: silent });
      jobs.register(handler());
      jobs.start();
      const id = jobs.create(KIND_SAVE_SETTINGS, 'Save settings', {});
      await new Promise((r) => setTimeout(r, 400));
      jobs.shutdown();
      expect(jobs.get(id)?.state).toBe('done');
      expect(fs.readdirSync(driveSettingsDir(rootOf('E:')))).toHaveLength(2);
    });
  });
});

describe('duplicatesInUserFolders', () => {
  it('is off by default, takes only a boolean, and a settings file cannot switch it on', () => {
    expect(DEFAULT_SETTINGS.duplicatesInUserFolders).toBe(false);
    expect(validSettingValue('duplicatesInUserFolders', true)).toBe(true);
    expect(validSettingValue('duplicatesInUserFolders', 'yes')).toBeUndefined();
    const parsed = parseExport(JSON.stringify({ format: 'backuphub-settings', version: 1, exportedAt: '', appVersion: '1', settings: { duplicatesInUserFolders: true, theme: 'dark' }, profiles: [], places: [] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.settings.theme).toBe('dark');
      expect(parsed.data.settings.duplicatesInUserFolders).toBeUndefined();
    }
  });
});
