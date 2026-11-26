import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, runMigrations } from '../db';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DEFAULT_FILTERS, FILTER_KEYS, mergeFilters } from './filters';
import { profileDraftsFromConfig, saveDrafts } from './importConfig';
import { BackupProfileStore } from './profileStore';
import { BackupProfileService } from './backupProfileService';
import { addIndexRows, addPlace, makeRig, type Rig } from './fixtures.testutil';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.close());

/** PhoneBackup's real config.json (the profiles, with its tab character and loose spacing; the mail settings are left out). */
const TAB = '\t';
const CONFIG = String.raw`{
  "profiles": {
    "poco": {
      "name": "Poco F4",
      "folder_prefix": "Poco-F4",
      "backup_root": "F:\\MyData\\POCO",
      "source": {
        "type": "adb"
      },
      "filters": {
        "protected_paths": [
          "/sdcard/DCIM/",
          "/sdcard/Pictures/",
          "/sdcard/Photos/",
          "/sdcard/Movies/",
          "/sdcard/Music/",
          "/sdcard/Audiobooks/",
          "/sdcard/Alarms/",
          "/sdcard/Ringtones/",
          "/sdcard/Notifications/",
          "/sdcard/Podcasts/",
          "/sdcard/Subtitles/",
          "/sdcard/Download/",
          "/sdcard/Downloads/",
          "/sdcard/Documents/",
          "/sdcard/Recordings/",
          "/sdcard/MIUI/sound_recorder/",
          "/sdcard/IMP/",
          "/sdcard/MIUI/backup/AllBackup/",
          "/sdcard/WhatsApp/",
          "/sdcard/Telegram/"
        ],
        "media_allowlist": ["com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "com.telegram.messenger", "com.openai.chatgpt", "org.thoughtcrime.securesms", "com.instagram.android", "com.snapchat.android", "com.facebook.orca", "com.viber.voip"],
        "data_allowlist": ["com.android.soundrecorder", "com.miui.soundrecorder", "com.google.android.dialer", "com.miui.notes"],
        "skip_fragments": ["/.thumbnails/", "/.cache/", "/cache/", "/.trash/", "/.Thumbs/", "/.StickerThumbs/", "/.Links/", "/.Wamo/", "/.wamocache/", "/.Shared/", "/WhatsApp Bug Report Attachments/", "/WhatsApp AI Editor Cache/", "/MIUI/BugReportCache/", "/MIUI/debug_log/"],
        "skip_extensions": [".nomedia", ".bizprofile", ".thumb", ".tmp"],
        "known_wa_dotdirs": [".statuses"]
      }
    },
${TAB}"samsung_phone": {
      "name": "Mom Samsung",
      "folder_prefix": "Samsung-M31",
      "backup_root": "F:\\MyData\\SamsungM31",
      "source": {
        "type": "adb"
      }
    },
    "onedrive": {
      "name": "OneDrive Local Backup",
      "folder_prefix": "OneDrive",
      "backup_root": "F:\\MyData\\OneDriveBackup",
      "source": {
        "type": "local",
        "path": "C:\\Users\\user\\OneDrive"
      },
      "filters": {
        "skip_fragments": ["/.git/", "/node_modules/", "/.vs/", "/__pycache__/", "/venv/", "/.venv/", "/ledger.db"],
        "skip_extensions": [".tmp", ".lnk", ".pyc", ".pyo", ".pyd", ".prev", ".conflict"]
      }
    },
    "ddrive": {
      "name": "DDrive Local Backup",
      "folder_prefix": "DDrive",
      "backup_root": "F:\\MyData\\DDriveBackup",
      "source": {
        "type": "local",
        "path": "D:\\MyData"
      },
      "filters": {
        "skip_fragments": ["/__pycache__/", "/node_modules/", "/.git/", "/venv/", "/.venv/", "/ledger.db"],
        "skip_extensions": [".tmp", ".lnk", ".pyc", ".pyo", ".pyd", ".prev", ".conflict"]
      }
    },
    "onedrive_imp": {
      "name": "OneDrive IMP Folder",
      "folder_prefix": "OneDrive-IMP",
      "backup_root": "F:\\MyData\\OneDriveBackup\\IMP",
      "source": {
        "type": "local",
        "path": "C:\\Users\\user\\OneDrive\\IMP"
      },
      "filters": {
        "skip_fragments": ["/__pycache__/", "/node_modules/", "/.git/", "/venv/", "/.venv/", "/ledger.db"],
        "skip_extensions": [".tmp", ".lnk", ".pyc", ".pyo", ".pyd", ".prev", ".conflict"]
      }
    },
    "local_to_gdrive": {
      "name": "Local to Google Drive",
      "folder_prefix": "LocalBackup",
      "backup_root": "skip",
      "source": {
        "type": "local",
        "path": "C:\\Users\\user\\Documents"
      },
      "destination": {
        "type": "cloud",
        "remote": "gdrive1:",
        "path": "/Backups"
      },
      "filters": {
        "skip_extensions": [".tmp", ".lnk"]
      }
    }
  },
  "default_profile": "poco",
  "adb_path": "C:\\Users\\user\\Downloads\\platform-tools-latest-windows\\platform-tools\\adb.exe",
  "_nas_example": {
    "_comment": "NAS/SMB backup",
    "name": "NAS Backup",
    "folder_prefix": "NAS",
    "backup_root": "F:\\MyData\\NASBackup",
    "source": { "type": "adb" }
  }
}`;

describe('migration 0020', () => {
  it('adds the columns and tables to a database that already has files rows, and changes nothing that was there', () => {
    const file = path.join(rig.dir, 'old.db');
    const db = openDatabase(file);
    try {
      expect(MIGRATIONS[19]?.name).toBe('backup_profiles');
      runMigrations(db, MIGRATIONS.slice(0, 19));
      addPlace(db, 'p1', 'drive', 'T7');
      const ins = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at) VALUES ('p1', ?, ?, 5, ?, ?, 1000, 2000, ?)");
      ins.run('MyData/a.jpg', 10, 'abc', 'm', null);
      ins.run('MyData/b.jpg', 20, null, null, 99);
      const before = db.prepare('SELECT * FROM files ORDER BY id').all();
      expect(runMigrations(db)).toMatchObject({ from: 19, to: MIGRATIONS.length });
      const after = db.prepare('SELECT * FROM files ORDER BY id').all() as Record<string, unknown>[];
      expect(after).toHaveLength(2);
      for (const [i, row] of after.entries()) {
        const old = before[i] as Record<string, unknown>;
        for (const [k, v] of Object.entries(old)) expect(row[k], k).toEqual(v);
        for (const k of ['origin_file_id', 'backup_run_id', 'expected_sha256', 'verified_at', 'verified_how', 'gone_reason', 'archive_file_id', 'archive_member']) expect(row[k], k).toBeNull();
      }
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      for (const t of ['backup_profiles', 'backup_destinations', 'backup_runs', 'backup_exclusions', 'file_problems', 'ledger_imports']) expect(tables).toContain(t);
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((t) => t.name);
      expect(indexes).toContain('idx_files_origin');
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_files_origin'").pluck().get()).toMatch(/WHERE origin_file_id IS NOT NULL/);
      db.prepare("INSERT INTO ledger_imports (ledger_path, ledger_sha256, imported_at, rows) VALUES ('a', 'x', 1, 1)").run();
      expect(() => db.prepare("INSERT INTO ledger_imports (ledger_path, ledger_sha256, imported_at, rows) VALUES ('b', 'x', 1, 1)").run()).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('stays fast on a big files table (no rewrite)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-mig20-'));
    const db = openDatabase(path.join(dir, 'big.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 19));
      addPlace(db, 'p1', 'drive', 'T7');
      const ins = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES ('p1', ?, 1, 1, 1, 1)");
      db.transaction(() => {
        for (let i = 0; i < 300_000; i += 1) ins.run(`d${i % 500}/f${i}.bin`);
      })();
      const t0 = Date.now();
      runMigrations(db);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(300_000);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('filters', () => {
  it('merge like get_filters: a key the profile has replaces the default as a whole, a missing key takes the default', () => {
    expect(mergeFilters(undefined)).toEqual(DEFAULT_FILTERS);
    const m = mergeFilters({ skip_extensions: [], skip_fragments: ['/x/'], other: ['ignored'] });
    expect(m.skip_extensions).toEqual([]);
    expect(m.skip_fragments).toEqual(['/x/']);
    expect(m.protected_paths).toEqual(DEFAULT_FILTERS.protected_paths);
    expect(Object.keys(m)).toEqual([...FILTER_KEYS]);
    // A bad value does not break a backup.
    expect(mergeFilters({ skip_extensions: 'nope' }).skip_extensions).toEqual(DEFAULT_FILTERS.skip_extensions);
  });
});

describe('profile store', () => {
  it('creates, reads, edits and removes profiles, backup folders and exclusions', () => {
    addPlace(rig.db, 't7', 'drive', 'T7');
    const store = new BackupProfileStore(rig.db, () => 1234);
    const made = store.create({ name: 'Poco F4', sourceKind: 'phone', folderPrefix: 'Poco-F4', phoneSerial: ' ABC123 ', filters: { skip_extensions: ['.x'] } });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const p = store.get(made.id)!;
    expect(p).toMatchObject({ name: 'Poco F4', personId: 1, sourceKind: 'phone', changeRule: 'size_and_date', phoneSerial: 'ABC123', enabled: true, createdAt: 1234, importKey: null });
    expect(p.filters.skip_extensions).toEqual(['.x']);
    expect(p.filters.known_wa_dotdirs).toEqual(['.statuses']);
    expect(store.create({ name: 'poco f4', sourceKind: 'phone', folderPrefix: 'X' })).toMatchObject({ ok: false });
    expect(store.create({ name: 'Other phone', sourceKind: 'phone', folderPrefix: 'X', phoneSerial: 'ABC123' })).toMatchObject({ ok: false });
    expect(store.create({ name: 'No folder', sourceKind: 'folder', folderPrefix: 'F' })).toMatchObject({ ok: false });
    const folder = store.create({ name: 'Docs', sourceKind: 'folder', sourceRoot: 'C:\\Docs\\', folderPrefix: 'Docs' });
    expect(folder.ok && store.get(folder.id)).toMatchObject({ changeRule: 'size_or_date', sourceRoot: 'C:\\Docs' });

    expect(store.update(made.id, { name: 'Poco', filters: { skip_extensions: ['.y'] }, enabled: false })).toEqual({ ok: true });
    expect(store.get(made.id)).toMatchObject({ name: 'Poco', enabled: false });
    expect(store.get(made.id)!.filters.skip_extensions).toEqual(['.y']);
    expect(store.update(made.id, { name: 'Docs' })).toMatchObject({ ok: false });
    expect(store.update(999, { name: 'x' })).toMatchObject({ ok: false });

    const d = store.addDestination({ profileId: made.id, placeId: 't7', root: 'F:\\MyData\\POCO' });
    expect(d).toMatchObject({ ok: false });
    const d2 = store.addDestination({ profileId: made.id, placeId: 't7', root: '\\MyData\\POCO\\' });
    expect(d2.ok).toBe(true);
    if (!d2.ok) return;
    expect(store.destinations(made.id)).toMatchObject([{ placeId: 't7', root: 'MyData/POCO', role: 'primary', enabled: true }]);
    expect(store.addDestination({ profileId: made.id, placeId: 't7', root: 'mydata/poco' })).toMatchObject({ ok: false });
    expect(store.addDestination({ profileId: made.id, placeId: 't7', root: '../x' })).toMatchObject({ ok: false });
    expect(store.addDestination({ profileId: made.id, placeId: 'nope', root: 'x' })).toMatchObject({ ok: false });
    expect(store.updateDestination(d2.id, { root: 'Other/Folder', enabled: false })).toEqual({ ok: true });
    expect(store.destination(d2.id)).toMatchObject({ root: 'Other/Folder', enabled: false });

    expect(store.addExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true, added: true });
    expect(store.addExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true, added: false });
    expect(store.exclusions(made.id)).toMatchObject([{ sourcePath: '/sdcard/a.jpg' }]);
    expect(store.removeExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true });
    expect(store.removeExclusion(made.id, '/sdcard/a.jpg')).toMatchObject({ ok: false });
    expect(store.removeDestination(d2.id)).toEqual({ ok: true });
  });

  it('removing deletes a profile that was never used and only switches off one with history; file rows are never touched', () => {
    addPlace(rig.db, 't7', 'drive', 'T7');
    addIndexRows(rig.db, [{ place: 't7', rel: 'a', size: 1 }]);
    const store = new BackupProfileStore(rig.db);
    const a = store.create({ name: 'A', sourceKind: 'phone', folderPrefix: 'A' });
    const b = store.create({ name: 'B', sourceKind: 'phone', folderPrefix: 'B' });
    if (!a.ok || !b.ok) throw new Error('create');
    store.addDestination({ profileId: a.id, placeId: 't7', root: 'x' });
    store.addExclusion(a.id, '/sdcard/z');
    rig.db.prepare("INSERT INTO ledger_imports (backup_profile_id, ledger_path, ledger_sha256, imported_at, rows) VALUES (?, 'p', 's', 1, 0)").run(b.id);
    expect(store.remove(a.id)).toEqual({ ok: true, how: 'deleted' });
    expect(store.get(a.id)).toBeNull();
    expect(rig.db.prepare('SELECT count(*) FROM backup_destinations').pluck().get()).toBe(0);
    expect(store.remove(b.id)).toEqual({ ok: true, how: 'disabled' });
    expect(store.get(b.id)?.enabled).toBe(false);
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(1);
  });

  it('makes one phone place per phone backup and reuses it', () => {
    const store = new BackupProfileStore(rig.db, () => 5, () => 'phone-1');
    const made = store.create({ name: 'Poco F4', sourceKind: 'phone', folderPrefix: 'P', importKey: 'poco' });
    if (!made.ok) throw new Error('create');
    expect(store.ensurePhonePlace(made.id)).toBe('phone-1');
    store.update(made.id, { phoneSerial: 'SER1' });
    expect(store.ensurePhonePlace(made.id)).toBe('phone-1');
    expect(rig.db.prepare("SELECT count(*) FROM places WHERE kind = 'phone'").pluck().get()).toBe(1);
    expect(JSON.parse(rig.db.prepare('SELECT identity_json FROM places WHERE id = ?').pluck().get('phone-1') as string)).toMatchObject({ importKey: 'poco', serial: 'SER1' });
    expect(store.get(made.id)?.sourcePlaceId).toBe('phone-1');
    const folder = store.create({ name: 'F', sourceKind: 'folder', sourceRoot: 'C:\\F', folderPrefix: 'F' });
    expect(folder.ok && store.ensurePhonePlace(folder.id)).toBeNull();
  });
});

describe('PhoneBackup config.json import', () => {
  it('turns the five real profiles into drafts and skips the cloud one, "skip" roots and "_" keys', () => {
    const r = profileDraftsFromConfig(CONFIG);
    if (!r.ok) throw new Error(r.message);
    expect(r.drafts.map((d) => d.importKey)).toEqual(['poco', 'samsung_phone', 'onedrive', 'ddrive', 'onedrive_imp']);
    expect(r.skipped.map((s) => s.key)).toEqual(['local_to_gdrive']);
    const by = Object.fromEntries(r.drafts.map((d) => [d.importKey, d]));
    expect(by['poco']).toMatchObject({ name: 'Poco F4', folderPrefix: 'Poco-F4', backupRoot: 'F:\\MyData\\POCO', sourceKind: 'phone', sourceRoot: '', changeRule: 'size_and_date' });
    expect(by['poco']!.filters).toEqual(DEFAULT_FILTERS);
    expect(by['samsung_phone']).toMatchObject({ name: 'Mom Samsung', folderPrefix: 'Samsung-M31', backupRoot: 'F:\\MyData\\SamsungM31', changeRule: 'size_and_date' });
    expect(by['samsung_phone']!.filters).toEqual(DEFAULT_FILTERS);
    expect(by['onedrive']).toMatchObject({ sourceKind: 'folder', sourceRoot: 'C:\\Users\\user\\OneDrive', changeRule: 'size_or_date' });
    expect(by['onedrive']!.filters.skip_fragments).toContain('/node_modules/');
    expect(by['onedrive']!.filters.skip_extensions).toEqual(['.tmp', '.lnk', '.pyc', '.pyo', '.pyd', '.prev', '.conflict']);
    expect(by['onedrive']!.filters.protected_paths).toEqual(DEFAULT_FILTERS.protected_paths);
    expect(by['ddrive']).toMatchObject({ sourceRoot: 'D:\\MyData', folderPrefix: 'DDrive' });
    expect(by['onedrive_imp']).toMatchObject({ folderPrefix: 'OneDrive-IMP', backupRoot: 'F:\\MyData\\OneDriveBackup\\IMP', sourceRoot: 'C:\\Users\\user\\OneDrive\\IMP' });
  });

  it('reads loose files: a byte order mark and trailing commas; refuses text that is not a settings file', () => {
    const loose = '\ufeff{ "profiles": { "_example": { "name": "E", "folder_prefix": "E", "backup_root": "E:\\\\Y", "source": { "type": "adb" } }, "a": { "name": "A", "folder_prefix": "A", "backup_root": "E:\\\\X", "source": { "type": "adb", }, }, }, }';
    const r = profileDraftsFromConfig(loose);
    expect(r.ok && r.drafts.map((d) => d.importKey)).toEqual(['a']);
    expect(r.ok && r.skipped.map((d) => d.key)).toEqual(['_example']);
    expect(profileDraftsFromConfig('not json')).toMatchObject({ ok: false });
    expect(profileDraftsFromConfig('{"x": 1}')).toMatchObject({ ok: false });
  });

  /** A "T7" with PhoneBackup's old history of the Poco on it, in a temp folder (so its root has no drive letter F:). */
  function makeT7(withHistory = true): string {
    const root = path.join(rig.dir, 't7');
    fs.mkdirSync(path.join(root, 'MyData', 'POCO'), { recursive: true });
    if (withHistory) fs.writeFileSync(path.join(root, 'MyData', 'POCO', 'ledger.db'), 'x');
    return root;
  }

  it('saves the profiles with the backup folder on the T7 found by its name (never by the letter in the old settings), and a second seed changes nothing', () => {
    addPlace(rig.db, 't7', 'drive', 'T7');
    const root = makeT7();
    const service = new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root, label: 'T7' }] });
    const first = service.seedFromConfig(CONFIG);
    if (!first.ok) throw new Error(first.message);
    expect(first.report.created.map((c) => [c.importKey, c.destination, c.enabled])).toEqual([
      ['poco', 'saved', true], ['samsung_phone', 'saved', true], ['onedrive', 'saved', true], ['ddrive', 'saved', true], ['onedrive_imp', 'saved', false],
    ]);
    expect(first.report.noDestination).toEqual([]);
    const dump = (): unknown => ({
      profiles: rig.db.prepare('SELECT * FROM backup_profiles ORDER BY id').all(),
      destinations: rig.db.prepare('SELECT * FROM backup_destinations ORDER BY id').all(),
      places: rig.db.prepare('SELECT * FROM places ORDER BY id').all(),
    });
    const before = dump();
    const roots = (rig.db.prepare('SELECT root FROM backup_destinations ORDER BY id').all() as { root: string }[]).map((r) => r.root);
    expect(roots).toEqual(['MyData/POCO', 'MyData/SamsungM31', 'MyData/OneDriveBackup', 'MyData/DDriveBackup', 'MyData/OneDriveBackup/IMP']);
    expect(rig.db.prepare('SELECT DISTINCT place_id FROM backup_destinations').pluck().all()).toEqual(['t7']);
    expect(JSON.stringify(before)).not.toMatch(/F:/);
    expect(rig.db.prepare("SELECT enabled FROM backup_profiles WHERE import_key = 'onedrive_imp'").pluck().get()).toBe(0);
    expect(rig.db.prepare("SELECT count(*) FROM backup_profiles WHERE enabled = 1").pluck().get()).toBe(4);
    const second = service.seedFromConfig(CONFIG);
    if (!second.ok) throw new Error(second.message);
    expect(second.report.created).toEqual([]);
    expect(second.report.alreadyThere).toEqual(['poco', 'samsung_phone', 'onedrive', 'ddrive', 'onedrive_imp']);
    expect(dump()).toEqual(before);
    const view = service.list();
    expect(view).toHaveLength(5);
    expect(view[0]).toMatchObject({ profile: { name: 'Poco F4', importKey: 'poco' }, destinations: [{ placeId: 't7', root: 'MyData/POCO' }], exclusionCount: 0, imports: [] });
  });

  it('refuses, and writes nothing, unless the T7 is plugged in and holds the Poco history file', () => {
    addPlace(rig.db, 't7', 'drive', 'T7');
    addPlace(rig.db, 'sea', 'drive', 'Seagate2TB');
    const root = makeT7(false);
    const withHistory = path.join(rig.dir, 'seagate');
    fs.mkdirSync(path.join(withHistory, 'MyData', 'POCO'), { recursive: true });
    fs.writeFileSync(path.join(withHistory, 'MyData', 'POCO', 'ledger.db'), 'x');
    const count = (): unknown => rig.db.prepare('SELECT (SELECT count(*) FROM backup_profiles) AS p, (SELECT count(*) FROM backup_destinations) AS d').get();
    const before = count();
    // No drive at all.
    expect(new BackupProfileService({ db: rig.db, connectedDrives: () => [] }).seedFromConfig(CONFIG)).toMatchObject({ ok: false, message: expect.stringContaining('T7') as string });
    // The T7 has no history file; the Seagate has one but is not the T7 (a drive letter or a copy never decides).
    const service = new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root, label: 'T7' }, { placeId: 'sea', root: withHistory, label: 'Seagate2TB' }] });
    expect(service.seedFromConfig(CONFIG)).toMatchObject({ ok: false, message: expect.stringContaining('history') as string });
    // Two drives with the name T7: not guessed.
    const two = new BackupProfileService({ db: rig.db, connectedDrives: () => [{ placeId: 't7', root, label: 'T7' }, { placeId: 'sea', root: withHistory, label: 't7' }] });
    expect(two.seedFromConfig(CONFIG)).toMatchObject({ ok: false });
    expect(count()).toEqual(before);
  });

  it('saves the profile without a backup folder, and says so, when the drive cannot be found', () => {
    const r = profileDraftsFromConfig(CONFIG);
    if (!r.ok) throw new Error(r.message);
    const store = new BackupProfileStore(rig.db);
    const report = saveDrafts(store, r.drafts.filter((d) => d.importKey === 'poco'), null);
    expect(report.created).toMatchObject([{ importKey: 'poco', destination: 'none' }]);
    expect(report.noDestination).toMatchObject([{ importKey: 'poco', backupRoot: 'F:\\MyData\\POCO' }]);
    expect(rig.db.prepare('SELECT count(*) FROM backup_destinations').pluck().get()).toBe(0);
    expect(store.getByImportKey('poco')).not.toBeNull();
    // Run again with the drive found: the profile is left alone (the person may have edited it).
    addPlace(rig.db, 't7', 'drive', 'T7');
    expect(saveDrafts(store, r.drafts.filter((d) => d.importKey === 'poco'), { placeId: 't7' }).alreadyThere).toEqual(['poco']);
  });

  it('gives no backup folder to a backup that the old settings put on another drive letter than the first one', () => {
    const odd = CONFIG.replace('F:\\\\MyData\\\\SamsungM31', 'G:\\\\MyData\\\\SamsungM31');
    const r = profileDraftsFromConfig(odd);
    if (!r.ok) throw new Error(r.message);
    addPlace(rig.db, 't7', 'drive', 'T7');
    const report = saveDrafts(new BackupProfileStore(rig.db), r.drafts, { placeId: 't7' });
    expect(report.noDestination.map((n) => n.importKey)).toEqual(['samsung_phone']);
    expect(rig.db.prepare('SELECT count(*) FROM backup_destinations').pluck().get()).toBe(4);
  });
});
