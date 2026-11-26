import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MY_DATA_FOLDER } from '../../shared/appFolders';
import { closeDatabase, initDatabase, type Db } from '../db';
import { detectOneDrive, oneDriveEnvFolders, parseOneDriveRegistry, type OneDriveAccount } from '../listing/oneDrive';
import { expandEnv, parseKnownFolders } from '../listing/knownFolders';
import { DISK_COMMAND, parseDiskLetters, systemDiskOf, type DiskLetter } from './disks';
import { isCandidate, matchVolumes } from './matching';
import { PlaceService } from './placeService';
import type { Volume } from './volumes';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

// Shapes captured from this laptop with Get-Partition / Get-Disk (2026-10-30), reduced to the fields we use.
const ONE_ARRAY = '[{"DriveLetter":"E","DiskNumber":0,"BusType":"SATA"},{"DriveLetter":"C","DiskNumber":0,"BusType":"SATA"},{"DriveLetter":"D","DiskNumber":0,"BusType":"SATA"},{"DriveLetter":"F","DiskNumber":1,"BusType":"USB"}]';
const ONE_OBJECT = '{"DriveLetter":"C","DiskNumber":0,"BusType":"NVMe"}';

describe('parseDiskLetters', () => {
  it('parses an array', () => {
    expect(parseDiskLetters(ONE_ARRAY)).toEqual([
      { letter: 'E:', diskNumber: 0, busType: 'SATA' },
      { letter: 'C:', diskNumber: 0, busType: 'SATA' },
      { letter: 'D:', diskNumber: 0, busType: 'SATA' },
      { letter: 'F:', diskNumber: 1, busType: 'USB' },
    ]);
  });

  it('parses the single-object form PowerShell prints for one partition', () => {
    expect(parseDiskLetters(ONE_OBJECT)).toEqual([{ letter: 'C:', diskNumber: 0, busType: 'NVMe' }]);
  });

  it('accepts empty output and a BOM', () => {
    expect(parseDiskLetters('')).toEqual([]);
    expect(parseDiskLetters('  \r\n')).toEqual([]);
    expect(parseDiskLetters(`\uFEFF${ONE_OBJECT}`)).toHaveLength(1);
  });

  it('is forgiving about odd entries and duplicates, and strict about non-JSON', () => {
    const odd = parseDiskLetters('[1, null, {"DriveLetter":null,"DiskNumber":0}, {"DriveLetter":"g:","DiskNumber":"2","BusType":""}, {"DriveLetter":"G","DiskNumber":3}, {"DriveLetter":72,"DiskNumber":1}]');
    expect(odd).toEqual([
      { letter: 'G:', diskNumber: 2, busType: null },
      { letter: 'H:', diskNumber: 1, busType: null },
    ]);
    expect(() => parseDiskLetters('not json')).toThrow(/not readable JSON/);
  });

  it('asks for letters, disk numbers and bus types in one read-only call', () => {
    expect(DISK_COMMAND).toContain('Get-Partition');
    expect(DISK_COMMAND).toContain('Get-Disk');
    expect(DISK_COMMAND).not.toMatch(/Set-|Remove-|New-|Format-|Clear-/);
  });
});

describe('systemDiskOf', () => {
  const letters = parseDiskLetters(ONE_ARRAY);
  it('returns every letter on the same physical disk as the system drive', () => {
    expect(systemDiskOf(letters, 'C:')).toEqual({ diskNumber: 0, busType: 'SATA', letters: ['C:', 'D:', 'E:'] });
    expect(systemDiskOf(letters, 'c:')?.letters).toEqual(['C:', 'D:', 'E:']);
  });
  it('knows nothing when the system drive is not in the list (nothing is guessed)', () => {
    expect(systemDiskOf(letters, 'Z:')).toBeNull();
    expect(systemDiskOf([], 'C:')).toBeNull();
  });
});

function vol(letter: string | null, overrides: Partial<Volume> = {}): Volume {
  return { letter, label: '', fileSystem: 'NTFS', capacity: 1_000_000_000_000, free: 400_000_000_000, driveType: 3, serial: null, ...overrides };
}

describe('matching with laptop letters', () => {
  it('never offers a volume on the system disk, even a "fixed disk" like D:', () => {
    const volumes = [vol('C:'), vol('D:'), vol('E:', { driveType: 2 })];
    const laptop = new Set(['C:', 'D:']);
    expect(isCandidate(volumes[1]!, 'C:', laptop)).toBe(false);
    expect(isCandidate(volumes[1]!, 'C:')).toBe(true);
    const matches = matchVolumes(volumes, new Map(), [], 'C:', laptop);
    expect(matches.map((m) => m.volume.letter)).toEqual(['E:']);
  });
});

describe('PlaceService: laptop volumes and OneDrive', () => {
  let dir: string;
  let db: Db;
  let volumes: Volume[];
  let disks: DiskLetter[];
  let diskCalls: number;
  let diskFails: boolean;
  let oneDrive: OneDriveAccount | null;
  let oneDriveFails: boolean;
  let oneDriveCalls: number;
  let nowMs: number;
  let service: PlaceService;
  let ids: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-disks-test-'));
    fs.mkdirSync(path.join(dir, 'data'));
    for (const l of ['C', 'D', 'E']) fs.mkdirSync(path.join(dir, 'roots', l), { recursive: true });
    const opened = initDatabase(path.join(dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    volumes = [vol('C:'), vol('D:'), vol('E:', { driveType: 2, serial: 'AAAA0001' })];
    disks = parseDiskLetters('[{"DriveLetter":"C","DiskNumber":0,"BusType":"SATA"},{"DriveLetter":"D","DiskNumber":0,"BusType":"SATA"},{"DriveLetter":"E","DiskNumber":1,"BusType":"USB"}]');
    diskCalls = 0;
    diskFails = false;
    oneDrive = { cid: 'cid-111', userFolder: 'C:\\Users\\someone\\OneDrive', email: 'someone@example.invalid' };
    oneDriveFails = false;
    oneDriveCalls = 0;
    nowMs = 1_800_000_000_000;
    ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    service = new PlaceService({
      db,
      dataDir: path.join(dir, 'data'),
      hostname: 'STUDY-PC',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: async () => volumes,
      listDisks: async () => {
        diskCalls += 1;
        if (diskFails) throw new Error('Get-Partition failed');
        return disks;
      },
      detectOneDrive: async () => {
        oneDriveCalls += 1;
        if (oneDriveFails) throw new Error('registry unreadable');
        return oneDrive;
      },
      rootOf: (letter) => path.join(dir, 'roots', letter.replace(':', '')),
      now: () => nowMs,
      uuid: () => ids.shift() ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      log: silent,
    });
    service.init();
  });
  afterEach(() => {
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const oneDrivePlaces = () => db.prepare("SELECT id, label, status, root_hint, identity_json FROM places WHERE kind = 'onedrive'").all() as { id: string; label: string; status: string; root_hint: string; identity_json: string }[];

  it('puts D: with the laptop: it is not offered for naming, it is recorded in the laptop identity, and naming it is refused', async () => {
    const snap = await service.refresh();
    expect(snap.unnamed.map((u) => u.letter)).toEqual(['E:']);
    const laptop = snap.places.find((p) => p.thisDevice)!;
    expect(laptop.laptopVolumes).toEqual(['C:', 'D:']);
    const identity = JSON.parse((db.prepare("SELECT identity_json FROM places WHERE kind = 'laptop'").get() as { identity_json: string }).identity_json) as { laptopVolumes: string[]; systemDisk: { number: number; busType: string } };
    expect(identity.laptopVolumes).toEqual(['C:', 'D:']);
    expect(identity.systemDisk).toEqual({ number: 0, busType: 'SATA' });
    const refused = await service.nameDrive({ letter: 'D:', name: 'Data', confirmed: true });
    expect(refused).toMatchObject({ ok: false, code: 'system-drive' });
    expect(fs.existsSync(path.join(dir, 'roots', 'D', MY_DATA_FOLDER))).toBe(false);
    // The external disk stays nameable.
    expect(snap.unnamed[0]).toMatchObject({ letter: 'E:', canName: true });
  });

  it('asks Windows about disks only when the set of letters changes, and keeps the old answer when it fails', async () => {
    await service.refresh();
    await service.refresh();
    expect(diskCalls).toBe(1);
    diskFails = true;
    volumes = [...volumes, vol('F:', { driveType: 2 })];
    const snap = await service.refresh();
    expect(diskCalls).toBe(2);
    expect(snap.listError).toBeNull();
    expect(snap.places.find((p) => p.thisDevice)?.laptopVolumes).toEqual(['C:', 'D:']);
    expect(snap.unnamed.map((u) => u.letter)).toEqual(['E:', 'F:']);
  });

  it('without disk information it behaves as before (D: is offered as a fixed disk)', async () => {
    const plain = new PlaceService({
      db,
      dataDir: path.join(dir, 'data'),
      hostname: 'STUDY-PC',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: async () => volumes,
      rootOf: (letter) => path.join(dir, 'roots', letter.replace(':', '')),
      log: silent,
    });
    plain.init();
    const snap = await plain.refresh();
    expect(snap.unnamed.map((u) => u.letter)).toEqual(['D:', 'E:']);
    expect(snap.places.find((p) => p.thisDevice)?.laptopVolumes).toEqual([]);
    expect(oneDrivePlaces()).toHaveLength(0);
  });

  it('creates one OneDrive place keyed by the account id, and follows a moved folder instead of adding a second place', async () => {
    await service.refresh();
    const [first] = oneDrivePlaces();
    expect(oneDrivePlaces()).toHaveLength(1);
    expect(first).toMatchObject({ label: 'OneDrive', status: 'connected', root_hint: 'C:\\Users\\someone\\OneDrive' });
    expect(JSON.parse(first!.identity_json)).toMatchObject({ cid: 'cid-111', email: 'someone@example.invalid', lastConnectedAt: nowMs });

    nowMs += 10 * 60_000;
    oneDrive = { cid: 'cid-111', userFolder: 'D:\\Moved\\OneDrive', email: 'someone@example.invalid' };
    const snap = await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(1);
    expect(oneDrivePlaces()[0]).toMatchObject({ id: first!.id, root_hint: 'D:\\Moved\\OneDrive' });
    expect(service.oneDriveFolders()).toEqual(['D:\\Moved\\OneDrive']);
    const view = snap.places.find((p) => p.kind === 'onedrive')!;
    expect(view).toMatchObject({ status: 'connected', lastLookedAt: null, lastConnectedAt: nowMs, canList: true, files: { files: 0, totalBytes: 0, cloudOnly: 0 } });

    // A different account is a different place.
    nowMs += 10 * 60_000;
    oneDrive = { cid: 'cid-222', userFolder: 'C:\\Users\\other\\OneDrive', email: null };
    await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(2);
  });

  it('adopts the single existing place when only the environment variable is found (no cid) rather than creating another', async () => {
    await service.refresh();
    nowMs += 10 * 60_000;
    oneDrive = { cid: null, userFolder: 'C:\\Users\\someone\\OneDrive', email: null };
    await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(1);
    expect(JSON.parse(oneDrivePlaces()[0]!.identity_json)).toMatchObject({ cid: 'cid-111', email: 'someone@example.invalid' });
  });

  it('makes no place when OneDrive is absent, and shows an existing one as not connected', async () => {
    oneDrive = null;
    await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(0);
    oneDrive = { cid: 'cid-111', userFolder: 'C:\\x\\OneDrive', email: null };
    nowMs += 10 * 60_000;
    await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(1);
    oneDrive = null;
    nowMs += 10 * 60_000;
    const snap = await service.refresh();
    expect(snap.places.find((p) => p.kind === 'onedrive')).toMatchObject({ status: 'disconnected', canList: false });
  });

  it('keeps going when the OneDrive lookup fails, and checks only every few minutes', async () => {
    oneDriveFails = true;
    const snap = await service.refresh();
    expect(snap.listError).toBeNull();
    expect(oneDrivePlaces()).toHaveLength(0);
    oneDriveFails = false;
    await service.refresh();
    expect(oneDrivePlaces()).toHaveLength(1);
    const callsBefore = oneDriveCalls;
    nowMs += 60_000;
    await service.refresh();
    expect(oneDriveCalls).toBe(callsBefore); // looked less than 5 minutes ago
    nowMs += 5 * 60_000;
    await service.refresh();
    expect(oneDriveCalls).toBe(callsBefore + 1);
  });

  it('reports file counts, listing state, roots and "can list" per place', async () => {
    await service.refresh();
    const laptopId = service.thisDevice.id;
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, cloud_only) VALUES (?, 'C:/a', 100, 1, 1, 0), (?, 'C:/b', 50, 1, 1, 1)").run(laptopId, laptopId);
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, gone_at) VALUES (?, 'C:/c', 7, 1, 1, 9)").run(laptopId);
    service.catalogChanged();
    let state: 'idle' | 'queued' | 'running' = 'idle';
    service.setListingSources({ stateOf: () => state, rootsOf: (id) => (id === laptopId ? ['D:\\MyData'] : []) });
    let laptop = service.snapshot().places.find((p) => p.thisDevice)!;
    expect(laptop).toMatchObject({ files: { files: 2, totalBytes: 150, cloudOnly: 1 }, listing: 'idle', canList: true, roots: ['D:\\MyData'] });
    state = 'running';
    laptop = service.snapshot().places.find((p) => p.thisDevice)!;
    expect(laptop).toMatchObject({ listing: 'running', canList: false });
    expect(service.snapshot().places.find((p) => p.kind === 'onedrive')?.roots).toBeNull();
    expect(service.isConnected(laptopId)).toBe(true);
    expect(service.isConnected('nope')).toBe(false);
  });
});

describe('OneDrive registry detection', () => {
  const REG = '{"UserFolder":"C:\\\\Users\\\\someone\\\\OneDrive","cid":"abc123","UserEmail":"someone@example.invalid"}';

  it('parses the registry JSON, empty output and a BOM', () => {
    expect(parseOneDriveRegistry(REG)).toMatchObject({ UserFolder: 'C:\\Users\\someone\\OneDrive', cid: 'abc123' });
    expect(parseOneDriveRegistry('')).toBeNull();
    expect(parseOneDriveRegistry(`\uFEFF${REG}`)).not.toBeNull();
    expect(parseOneDriveRegistry('[' + REG + ']')).not.toBeNull();
    expect(parseOneDriveRegistry('null')).toBeNull();
    expect(() => parseOneDriveRegistry('oops')).toThrow(/not readable JSON/);
  });

  it('reads UserFolder, cid and UserEmail from the registry', async () => {
    const found = await detectOneDrive({ readRegistry: async () => parseOneDriveRegistry(REG), env: {} });
    expect(found).toEqual({ cid: 'abc123', userFolder: 'C:\\Users\\someone\\OneDrive', email: 'someone@example.invalid' });
  });

  it('falls back to %OneDriveConsumer% when the key is absent, unreadable or points nowhere', async () => {
    const env = { OneDriveConsumer: 'C:\\Users\\someone\\OneDrive' };
    expect(await detectOneDrive({ readRegistry: async () => null, env })).toEqual({ cid: null, userFolder: 'C:\\Users\\someone\\OneDrive', email: null });
    expect(await detectOneDrive({ readRegistry: async () => Promise.reject(new Error('denied')), env })).toMatchObject({ cid: null });
    const stale = { UserFolder: 'Z:\\Gone', cid: 'abc123', UserEmail: 'a@b.invalid' };
    expect(await detectOneDrive({ readRegistry: async () => stale, env, folderExists: () => false })).toEqual({ cid: 'abc123', userFolder: 'C:\\Users\\someone\\OneDrive', email: 'a@b.invalid' });
  });

  it('finds nothing when OneDrive is absent', async () => {
    expect(await detectOneDrive({ readRegistry: async () => null, env: {} })).toBeNull();
    expect(await detectOneDrive({ readRegistry: async () => ({ UserFolder: '  ' }), env: {} })).toBeNull();
  });

  it('lists the OneDrive folders from the environment', () => {
    expect(oneDriveEnvFolders({ OneDriveConsumer: 'C:\\a', OneDriveCommercial: 'C:\\b', OneDrive: 'C:\\a' })).toEqual(['C:\\a', 'C:\\b']);
    expect(oneDriveEnvFolders({})).toEqual([]);
  });
});

describe('known folders', () => {
  const REG = '{"Personal":"%USERPROFILE%\\\\OneDrive\\\\Documents","Desktop":"C:\\\\Users\\\\someone\\\\OneDrive\\\\Desktop","My Pictures":"C:\\\\Users\\\\someone\\\\OneDrive\\\\Pictures","My Video":"%USERPROFILE%\\\\Videos"}';
  it('expands environment variables (any case) and refuses unknown ones', () => {
    expect(expandEnv('%userprofile%\\Videos', { USERPROFILE: 'C:\\Users\\someone' })).toBe('C:\\Users\\someone\\Videos');
    expect(expandEnv('%NOPE%\\x', {})).toBeNull();
    expect(expandEnv('C:\\plain', {})).toBe('C:\\plain');
  });
  it('parses the four folders, expanding variables and dropping what cannot be used', () => {
    const folders = parseKnownFolders(REG, { USERPROFILE: 'C:\\Users\\someone' });
    expect(folders).toEqual([
      { label: 'Documents', path: 'C:\\Users\\someone\\OneDrive\\Documents' },
      { label: 'Desktop', path: 'C:\\Users\\someone\\OneDrive\\Desktop' },
      { label: 'Pictures', path: 'C:\\Users\\someone\\OneDrive\\Pictures' },
      { label: 'Videos', path: 'C:\\Users\\someone\\Videos' },
    ]);
    expect(parseKnownFolders(REG, {}).map((f) => f.label)).toEqual(['Desktop', 'Pictures']);
    expect(parseKnownFolders('', {})).toEqual([]);
    expect(parseKnownFolders('{"Personal":"relative\\\\x","Desktop":""}', {})).toEqual([]);
    expect(() => parseKnownFolders('nope', {})).toThrow();
  });
});
