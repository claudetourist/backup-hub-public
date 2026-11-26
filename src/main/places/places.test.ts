import fs from 'node:fs';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLabel, type PlacesSnapshot } from '../../shared/places';
import { closeDatabase, initDatabase, type Db } from '../db';
import { CARD_FILE, CARD_PARTS, MY_DATA_FOLDER } from '../../shared/appFolders';
import { filesOf } from '../writeGuard.testutil';
import { cardFolder } from './appFolders';
import { cardPath, CardExistsError, legacyCardPath, parseCard, readDriveCard, writeDriveCard, type CardRead, type DriveCard } from './driveCard';
import { isCandidate, matchVolumes } from './matching';
import { PlaceService, LOOKED_REFRESH_MS } from './placeService';
import { loadThisDevice, saveThisDeviceLabel, thisDevicePath } from './thisDevice';
import { parseVolumes, VolumeParseError, type Volume } from './volumes';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-places-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function vol(letter: string | null, overrides: Partial<Volume> = {}): Volume {
  return {
    letter,
    label: '',
    fileSystem: 'NTFS',
    capacity: 1_000_000_000_000,
    free: 400_000_000_000,
    driveType: 3,
    serial: null,
    ...overrides,
  };
}

describe('parseVolumes', () => {
  const ARRAY = JSON.stringify([
    { DriveLetter: 'C:', Label: 'Windows', FileSystem: 'NTFS', Capacity: 255_000_000_000, FreeSpace: 80_000_000_000, DriveType: 3, SerialNumber: 3735928559 },
    { DriveLetter: 'D:', Label: null, FileSystem: 'NTFS', Capacity: 500_000_000_000, FreeSpace: 100, DriveType: 3, SerialNumber: 1 },
    { DriveLetter: 'E:', Label: 'T7', FileSystem: 'exFAT', Capacity: 1_000_000_000_000, FreeSpace: 322_000_000_000, DriveType: 2, SerialNumber: 0 },
    { DriveLetter: null, Label: null, FileSystem: 'NTFS', Capacity: 100_000_000, FreeSpace: 50_000_000, DriveType: 3, SerialNumber: 2883584 },
    { DriveLetter: 'F:', Label: '', FileSystem: null, Capacity: null, FreeSpace: null, DriveType: 5, SerialNumber: null },
  ]);

  it('parses a normal array', () => {
    const volumes = parseVolumes(ARRAY);
    expect(volumes).toHaveLength(5);
    expect(volumes[0]).toEqual({
      letter: 'C:',
      label: 'Windows',
      fileSystem: 'NTFS',
      capacity: 255_000_000_000,
      free: 80_000_000_000,
      driveType: 3,
      serial: 'DEADBEEF',
    });
    expect(volumes[1]?.label).toBe('');
    expect(volumes[1]?.serial).toBe('00000001');
    expect(volumes[2]?.serial).toBeNull();
    expect(volumes[3]?.letter).toBeNull();
    expect(volumes[4]).toMatchObject({ fileSystem: null, capacity: null, free: null, driveType: 5, serial: null });
  });

  it('accepts the single-object form PowerShell prints for one volume', () => {
    const one = parseVolumes('{"DriveLetter":"E:","Label":"T7","FileSystem":"NTFS","Capacity":1000,"FreeSpace":10,"DriveType":2,"SerialNumber":305419896}');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ letter: 'E:', label: 'T7', driveType: 2, serial: '12345678' });
  });

  it('accepts empty output, a BOM and surrounding whitespace', () => {
    expect(parseVolumes('')).toEqual([]);
    expect(parseVolumes('  \r\n')).toEqual([]);
    expect(parseVolumes(`\uFEFF[{"DriveLetter":"e","DriveType":"2"}]`)[0]).toMatchObject({ letter: 'E:', driveType: 2 });
  });

  it('skips non-object entries, normalises letters, reads numeric strings', () => {
    const volumes = parseVolumes('[1, null, "x", {"DriveLetter":"g:\\\\","Capacity":"2000","FreeSpace":"5","DriveType":3,"SerialNumber":"abcd1234"}]');
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({ letter: 'G:', capacity: 2000, free: 5, serial: 'ABCD1234' });
  });

  it('treats a negative serial as unsigned and rejects non-JSON', () => {
    expect(parseVolumes('{"DriveType":3,"SerialNumber":-1}')[0]?.serial).toBe('FFFFFFFF');
    expect(() => parseVolumes('Get-CimInstance : something went wrong')).toThrow(VolumeParseError);
  });
});

describe('drive cards', () => {
  const card: DriveCard = { id: ID_A, name: 'T7', createdAt: '2026-10-30T10:00:00.000Z', appVersion: '0.1.0' };

  it('reads none when there is no card or no card folder', async () => {
    expect(await readDriveCard(dir)).toEqual({ status: 'none' });
    expect(await readDriveCard(path.join(dir, 'missing'))).toEqual({ status: 'none' });
  });

  it('writes a card and reads the same one back', async () => {
    writeDriveCard(dir, card);
    expect(fs.existsSync(cardPath(dir))).toBe(true);
    expect(await readDriveCard(dir)).toEqual({ status: 'ok', card });
    // Only the card file was created (no temp file left behind), and only inside the app's own files folder.
    expect(fs.readdirSync(dir)).toEqual([MY_DATA_FOLDER]);
    expect(filesOf(dir)).toEqual([path.join(...CARD_PARTS, CARD_FILE)]);
  });

  it('never overwrites an existing card', () => {
    writeDriveCard(dir, card);
    expect(() => writeDriveCard(dir, { ...card, id: ID_B, name: 'Other' })).toThrow(CardExistsError);
    expect(JSON.parse(fs.readFileSync(cardPath(dir), 'utf8')).id).toBe(ID_A);
  });

  it('reports a malformed card as invalid instead of ignoring it', async () => {
    fs.mkdirSync(cardFolder(dir), { recursive: true });
    fs.writeFileSync(cardPath(dir), '{not json');
    expect((await readDriveCard(dir)).status).toBe('invalid');
    fs.writeFileSync(cardPath(dir), JSON.stringify({ id: 'nope', name: 'T7' }));
    expect((await readDriveCard(dir)).status).toBe('invalid');
  });

  it('an old-layout drive: the card at the drive root is read (marked legacy), the new place wins, a conflict is reported', async () => {
    const old = legacyCardPath(dir);
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, JSON.stringify(card));
    expect(await readDriveCard(dir)).toEqual({ status: 'ok', card, legacy: true });
    // It counts as a card: a new one is never written next to it.
    expect(() => writeDriveCard(dir, { ...card, id: ID_B, name: 'Other' })).toThrow(CardExistsError);
    expect(fs.existsSync(cardFolder(dir))).toBe(false);
    // A card at the new place that names the same drive: the new one is read, not marked legacy.
    fs.mkdirSync(cardFolder(dir), { recursive: true });
    fs.writeFileSync(cardPath(dir), JSON.stringify(card));
    expect(await readDriveCard(dir)).toEqual({ status: 'ok', card });
    // A different drive at the new place: a conflict.
    const other: DriveCard = { ...card, id: ID_B, name: 'Other' };
    fs.writeFileSync(cardPath(dir), JSON.stringify(other));
    expect(await readDriveCard(dir)).toEqual({ status: 'conflict', card: other, oldCard: card });
    // An old card that cannot be read does not disturb a good new one, and never counts as none.
    fs.writeFileSync(old, '{not json');
    expect(await readDriveCard(dir)).toEqual({ status: 'ok', card: other });
    fs.rmSync(cardFolder(dir), { recursive: true });
    expect((await readDriveCard(dir)).status).toBe('invalid');
  });

  it('accepts a card with a BOM and upper-case id', () => {
    const read = parseCard(`\uFEFF${JSON.stringify({ ...card, id: ID_A.toUpperCase() })}`);
    expect(read).toMatchObject({ status: 'ok', card: { id: ID_A } });
  });
});

describe('this-device.json', () => {
  it('creates a device with a uuid and the hostname as label, then keeps the same id', () => {
    const first = loadThisDevice(dir, 'STUDY-PC');
    expect(first.label).toBe('STUDY-PC');
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    const second = loadThisDevice(dir, 'SOMETHING-ELSE');
    expect(second).toEqual(first);
  });

  it('keeps the id when the label changes', () => {
    const first = loadThisDevice(dir, 'STUDY-PC');
    saveThisDeviceLabel(dir, first, 'Rajesh laptop');
    const again = loadThisDevice(dir, 'STUDY-PC');
    expect(again).toMatchObject({ id: first.id, label: 'Rajesh laptop' });
  });

  it('moves an unreadable file aside instead of deleting it', () => {
    fs.writeFileSync(thisDevicePath(dir), 'garbage');
    const device = loadThisDevice(dir, 'PC');
    expect(device.label).toBe('PC');
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('this-device.json.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]!), 'utf8')).toBe('garbage');
  });

  it('falls back to a plain label when the hostname is unusable', () => {
    expect(loadThisDevice(dir, '').label).toBe('This laptop');
  });
});

describe('checkLabel', () => {
  it('trims, collapses spaces and rejects bad names', () => {
    expect(checkLabel('  My   T7 ')).toEqual({ ok: true, value: 'My T7' });
    expect(checkLabel('').ok).toBe(false);
    expect(checkLabel('a'.repeat(61)).ok).toBe(false);
    expect(checkLabel('bad/name').ok).toBe(false);
    expect(checkLabel(5).ok).toBe(false);
  });
});

describe('matchVolumes', () => {
  const t7 = vol('E:', { driveType: 2, serial: 'AAAA0001' });
  const ok = (id: string, name = 'T7') => ({ status: 'ok' as const, card: { id, name, createdAt: '', appVersion: '' } });

  it('matches by card id and ignores the letter and serial', () => {
    const result = matchVolumes([t7], new Map([['E:', ok(ID_A)]]), [{ placeId: ID_B, label: 'Other', serial: 'AAAA0001' }], 'C:');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'card', card: { id: ID_A } });
  });

  it('falls back to a unique serial match only when there is no card', () => {
    const known = [{ placeId: ID_A, label: 'T7', serial: 'AAAA0001' }];
    const result = matchVolumes([t7], new Map(), known, 'C:');
    expect(result[0]).toMatchObject({ kind: 'serial', placeId: ID_A, label: 'T7' });
  });

  it('does not guess when two known drives share a serial, or the serial is unknown', () => {
    const twins = [
      { placeId: ID_A, label: 'A', serial: 'AAAA0001' },
      { placeId: ID_B, label: 'B', serial: 'AAAA0001' },
    ];
    expect(matchVolumes([t7], new Map(), twins, 'C:')[0]?.kind).toBe('none');
    expect(matchVolumes([t7], new Map(), [{ placeId: ID_A, label: 'A', serial: 'FFFF0000' }], 'C:')[0]?.kind).toBe('none');
  });

  it('does not use the serial of a drive whose card is connected elsewhere', () => {
    const clone = vol('F:', { driveType: 2, serial: 'AAAA0001' });
    const result = matchVolumes([t7, clone], new Map([['E:', ok(ID_A)]]), [{ placeId: ID_A, label: 'T7', serial: 'AAAA0001' }], 'C:');
    expect(result.find((r) => r.volume.letter === 'F:')?.kind).toBe('none');
  });

  it('marks a second volume with the same card id as a duplicate and unreadable cards as invalid', () => {
    const a = vol('E:', { driveType: 2 });
    const b = vol('F:', { driveType: 2 });
    const c = vol('G:', { driveType: 2 });
    const cards = new Map<string, CardRead>([
      ['E:', ok(ID_A)],
      ['F:', ok(ID_A)],
      ['G:', { status: 'invalid' as const, reason: 'not valid JSON' }],
    ]);
    const kinds = matchVolumes([a, b, c], cards, [], 'C:').map((r) => `${r.volume.letter}:${r.kind}`);
    expect(kinds).toEqual(['E::card', 'F::duplicate', 'G::invalid-card']);
  });

  it('a conflict between the two card places is its own kind and claims nothing', () => {
    const a = vol('E:', { driveType: 2 });
    const b = vol('F:', { driveType: 2 });
    const conflict = { status: 'conflict' as const, card: { id: ID_A, name: 'T7', createdAt: '', appVersion: '' }, oldCard: { id: ID_B, name: 'Old', createdAt: '', appVersion: '' } };
    const cards = new Map<string, CardRead>([['E:', conflict], ['F:', ok(ID_A)]]);
    const result = matchVolumes([a, b], cards, [], 'C:');
    expect(result.map((r) => `${r.volume.letter}:${r.kind}`)).toEqual(['E::card-conflict', 'F::card']);
  });

  it('only considers removable or fixed volumes with a letter and a file system, never the system drive', () => {
    expect(isCandidate(vol('C:'), 'C:')).toBe(false);
    expect(isCandidate(vol('D:'), 'C:')).toBe(true);
    expect(isCandidate(vol(null), 'C:')).toBe(false);
    expect(isCandidate(vol('F:', { driveType: 5 }), 'C:')).toBe(false);
    expect(isCandidate(vol('G:', { driveType: 4 }), 'C:')).toBe(false);
    expect(isCandidate(vol('H:', { fileSystem: null, capacity: null }), 'C:')).toBe(false);
    expect(isCandidate(vol('I:', { capacity: 523_235_328 }), 'C:')).toBe(false); // 500 MB recovery partition
  });
});

describe('PlaceService', () => {
  let db: Db;
  let dataDir: string;
  let roots: string;
  let volumes: Volume[];
  let listFails: boolean;
  let nowMs: number;
  let service: PlaceService;
  let uuids: string[];

  /** Each fake drive letter maps to a folder in the temp area: that folder poses as the drive root. */
  const rootOf = (letter: string) => path.join(roots, letter.replace(':', ''));

  beforeEach(() => {
    dataDir = path.join(dir, 'data');
    roots = path.join(dir, 'roots');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(roots);
    for (const l of ['C', 'D', 'E', 'F']) fs.mkdirSync(path.join(roots, l));
    const opened = initDatabase(dataDir, silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    volumes = [vol('C:', { label: 'Windows' }), vol('D:', { label: 'Data' }), vol('E:', { label: 'T7', driveType: 2, serial: 'AAAA0001' })];
    listFails = false;
    nowMs = 1_800_000_000_000;
    uuids = [ID_A, ID_B];
    service = new PlaceService({
      db,
      dataDir,
      hostname: 'STUDY-PC',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: () => (listFails ? Promise.reject(new Error('powershell failed')) : Promise.resolve(volumes)),
      rootOf,
      now: () => nowMs,
      uuid: () => uuids.shift() ?? ID_B,
      log: silent,
    });
    service.init();
  });
  afterEach(() => {
    service.stopPolling();
    closeDatabase(db, silent);
  });

  const name = (letter: string, label: string, extra: object = {}) =>
    service.nameDrive({ letter, name: label, confirmed: true, ...extra });
  const connectedAt = () => (JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(ID_A) as { identity_json: string }).identity_json) as { lastConnectedAt?: number }).lastConnectedAt;
  const driveRows = () => db.prepare("SELECT * FROM places WHERE kind = 'drive'").all() as { id: string; label: string; status: string; last_looked_at: number | null; root_hint: string | null }[];

  it('creates the laptop place linked to this-device.json and profile You, once', () => {
    const rows = db.prepare("SELECT p.id, p.label, p.status, pr.name AS profile FROM places p JOIN profiles pr ON pr.id = p.profile_id WHERE p.kind = 'laptop'").all() as { id: string; label: string; status: string; profile: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: service.thisDevice.id, label: 'STUDY-PC', status: 'connected', profile: 'You' });
    service.init();
    expect(db.prepare("SELECT count(*) AS n FROM places WHERE kind = 'laptop'").get()).toEqual({ n: 1 });
  });

  it('shows an unnamed external drive but stores nothing for it', async () => {
    const snap = await service.refresh();
    expect(snap.unnamed.map((u) => u.letter)).toEqual(['D:', 'E:']);
    expect(snap.unnamed.find((u) => u.letter === 'E:')).toMatchObject({ driveType: 'removable', canName: true, probable: null });
    expect(driveRows()).toHaveLength(0);
    expect(snap.places.map((p) => p.kind)).toEqual(['laptop']);
    expect(snap.places[0]).toMatchObject({ thisDevice: true, status: 'connected', rootHint: 'C:', freeBytes: 400_000_000_000 });
  });

  it('a busy database (another writer holding it) does not make the refresh fail; the next refresh catches up', async () => {
    await name('E:', 'T7');
    const other = new Database(path.join(dataDir, 'backuphub.db'));
    db.pragma('busy_timeout = 50');
    try {
      other.prepare('BEGIN IMMEDIATE').run();
      nowMs += 60_000;
      volumes = volumes.filter((v) => v.letter !== 'E:');
      const snap = await service.refresh();
      expect(snap.places.length).toBeGreaterThan(0);
      other.prepare('ROLLBACK').run();
      const after = await service.refresh();
      expect(after.places.find((p) => p.label === 'T7')?.status).not.toBe('connected');
    } finally {
      if (other.inTransaction) other.prepare('ROLLBACK').run();
      other.close();
    }
  });

  it('writes a card only when named with confirmation, then tracks the drive by card id', async () => {
    await service.refresh();
    expect(fs.existsSync(cardFolder(rootOf('E:')))).toBe(false);

    const result = await name('E:', 'T7');
    expect(result).toEqual({ ok: true, placeId: ID_A, name: 'T7' });
    const card = JSON.parse(fs.readFileSync(cardPath(rootOf('E:')), 'utf8'));
    expect(card).toMatchObject({ id: ID_A, name: 'T7', appVersion: '0.1.0' });
    // Nothing else was written to the drive.
    expect(fs.readdirSync(rootOf('E:'))).toEqual([MY_DATA_FOLDER]);
    expect(filesOf(rootOf('E:'))).toEqual([path.join(...CARD_PARTS, CARD_FILE)]);

    const rows = driveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ID_A, label: 'T7', status: 'connected', root_hint: 'E:' });
    const snap = service.snapshot();
    expect(snap.places.find((p) => p.id === ID_A)).toMatchObject({ status: 'connected', rootHint: 'E:', freeBytes: 400_000_000_000 });
    expect(snap.unnamed.map((u) => u.letter)).toEqual(['D:']);
  });

  it('refuses without confirmation and writes nothing', async () => {
    const result = await service.nameDrive({ letter: 'E:', name: 'T7', confirmed: false });
    expect(result).toMatchObject({ ok: false, code: 'needs-confirmation' });
    expect(fs.readdirSync(rootOf('E:'))).toEqual([]);
    const sneaky = await service.nameDrive({ letter: 'E:', name: 'T7', confirmed: 'yes' as unknown as boolean });
    expect(sneaky).toMatchObject({ ok: false, code: 'needs-confirmation' });
  });

  it('refuses to write a card on the system drive, in any spelling', async () => {
    for (const letter of ['C:', 'c', 'C']) {
      const result = await name(letter, 'Windows');
      expect(result).toMatchObject({ ok: false, code: 'system-drive' });
    }
    expect(fs.readdirSync(rootOf('C:'))).toEqual([]);
    expect(driveRows()).toHaveLength(0);
  });

  it('refuses network, optical, missing and invalid targets', async () => {
    volumes.push(vol('F:', { driveType: 4 }));
    expect(await name('F:', 'Share')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await name('Z:', 'Nope')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await name('12', 'Nope')).toMatchObject({ ok: false, code: 'not-found' });
    expect(fs.readdirSync(rootOf('F:'))).toEqual([]);
  });

  it('refuses bad names and a name another drive already uses', async () => {
    expect(await name('E:', '')).toMatchObject({ ok: false, code: 'bad-name' });
    expect(await name('E:', 'a/b')).toMatchObject({ ok: false, code: 'bad-name' });
    expect(await name('E:', 'T7')).toMatchObject({ ok: true });
    volumes.push(vol('F:', { driveType: 2, serial: 'BBBB0002' }));
    expect(await name('F:', 't7')).toMatchObject({ ok: false, code: 'name-in-use' });
    expect(fs.readdirSync(rootOf('F:'))).toEqual([]);
  });

  it('never overwrites a card that is already there', async () => {
    expect(await name('E:', 'T7')).toMatchObject({ ok: true });
    const before = fs.readFileSync(cardPath(rootOf('E:')), 'utf8');
    expect(await name('E:', 'Renamed')).toMatchObject({ ok: false, code: 'has-card' });
    expect(fs.readFileSync(cardPath(rootOf('E:')), 'utf8')).toBe(before);
  });

  it('leaves an unreadable card alone and says why', async () => {
    fs.mkdirSync(cardFolder(rootOf('E:')), { recursive: true });
    fs.writeFileSync(cardPath(rootOf('E:')), 'not json');
    const snap = await service.refresh();
    expect(snap.unnamed.find((u) => u.letter === 'E:')).toMatchObject({ canName: false });
    expect(await name('E:', 'T7')).toMatchObject({ ok: false, code: 'has-card' });
    expect(fs.readFileSync(cardPath(rootOf('E:')), 'utf8')).toBe('not json');
  });

  it('marks a drive disconnected and keeps when it was last seen; connecting is never a "look" (last looked stays empty)', async () => {
    await name('E:', 'T7');
    const connectedWhenNamed = nowMs;
    expect(driveRows()[0]?.last_looked_at).toBeNull();
    expect(connectedAt()).toBe(connectedWhenNamed);

    nowMs += 5000;
    volumes = volumes.filter((v) => v.letter !== 'E:');
    const gone = await service.refresh();
    expect(gone.places.find((p) => p.id === ID_A)).toMatchObject({ status: 'disconnected', lastLookedAt: null, lastConnectedAt: connectedWhenNamed });
    expect(driveRows()[0]).toMatchObject({ status: 'disconnected', last_looked_at: null });
    expect(connectedAt()).toBe(connectedWhenNamed);

    // Plugged back in under another letter: same place, letter is only a hint.
    nowMs += 5000;
    volumes.push(vol('F:', { driveType: 2, serial: 'AAAA0001', label: 'T7' }));
    fs.mkdirSync(cardFolder(rootOf('F:')), { recursive: true });
    fs.copyFileSync(cardPath(rootOf('E:')), cardPath(rootOf('F:')));
    const back = await service.refresh();
    expect(back.places.find((p) => p.id === ID_A)).toMatchObject({ status: 'connected', rootHint: 'F:', lastLookedAt: null, lastConnectedAt: nowMs });
    expect(driveRows()).toHaveLength(1);
  });

  it('does not rewrite the connect time on every poll, only after the refresh interval, and never touches last looked', async () => {
    await name('E:', 'T7');
    db.prepare('UPDATE places SET last_looked_at = 1234 WHERE id = ?').run(ID_A); // as a finished listing would
    const first = connectedAt();
    nowMs += 10_000;
    await service.refresh();
    expect(connectedAt()).toBe(first);
    nowMs += LOOKED_REFRESH_MS;
    await service.refresh();
    expect(connectedAt()).toBe(nowMs);
    expect(driveRows()[0]?.last_looked_at).toBe(1234);
  });

  it('does not touch the database or claim a look when listing fails', async () => {
    await name('E:', 'T7');
    const before = db.prepare('SELECT * FROM places ORDER BY id').all();
    listFails = true;
    nowMs += 100_000;
    const snap = await service.refresh();
    expect(snap.listError).toMatch(/Could not list/);
    expect(db.prepare('SELECT * FROM places ORDER BY id').all()).toEqual(before);
    expect(snap.places.find((p) => p.id === ID_A)?.status).toBe('connected');
    listFails = false;
    expect((await service.refresh()).listError).toBeNull();
  });

  it('stops claiming a drive is plugged in after the drive list failed twice in a row, and trusts the list again once it works', async () => {
    await name('E:', 'T7');
    listFails = true;
    nowMs += 100_000;
    expect((await service.refresh()).places.find((p) => p.id === ID_A)?.status).toBe('connected');
    nowMs += 10_000;
    const stale = await service.refresh();
    expect(stale.places.find((p) => p.id === ID_A)).toMatchObject({ status: 'unknown' });
    expect(service.isConnected(ID_A)).toBe(false);
    listFails = false;
    nowMs += 10_000;
    expect((await service.refresh()).places.find((p) => p.id === ID_A)?.status).toBe('connected');
  });

  it('offers "probably T7, confirm" by serial when the card is missing, and confirming restores the same id', async () => {
    await name('E:', 'T7');
    // The card file is lost (drive reformatted by hand, say) but the serial is the same.
    fs.rmSync(cardFolder(rootOf('E:')), { recursive: true });
    const snap = await service.refresh();
    expect(snap.places.find((p) => p.id === ID_A)?.status).toBe('disconnected');
    expect(snap.unnamed.find((u) => u.letter === 'E:')?.probable).toEqual({ placeId: ID_A, label: 'T7' });

    // A wrong placeId is refused.
    expect(await name('E:', 'T7', { existingPlaceId: ID_B })).toMatchObject({ ok: false });
    expect(fs.existsSync(cardFolder(rootOf('E:')))).toBe(false);

    const confirmed = await name('E:', 'T7', { existingPlaceId: ID_A });
    expect(confirmed).toEqual({ ok: true, placeId: ID_A, name: 'T7' });
    expect(driveRows()).toHaveLength(1);
    expect(service.snapshot().places.find((p) => p.id === ID_A)?.status).toBe('connected');
  });

  it('emits a change only when something changed, and announces newly connected named drives', async () => {
    const changes: PlacesSnapshot[] = [];
    const plugged: string[][] = [];
    service.onChanged((s) => changes.push(s));
    service.onDriveConnected((ids) => plugged.push(ids));
    await service.refresh();
    const afterFirst = changes.length;
    await service.refresh();
    expect(changes.length).toBe(afterFirst);

    await name('E:', 'T7');
    expect(plugged).toEqual([[ID_A]]);
    nowMs += 1000;
    await service.refresh();
    expect(plugged).toHaveLength(1);

    volumes = volumes.filter((v) => v.letter !== 'E:');
    const before = changes.length;
    await service.refresh();
    expect(changes.length).toBe(before + 1);
    volumes.push(vol('E:', { driveType: 2, serial: 'AAAA0001' }));
    await service.refresh();
    expect(plugged).toEqual([[ID_A], [ID_A]]);
  });

  it('lists connected named drives with their root', async () => {
    await name('E:', 'T7');
    const drives = service.connectedDrives();
    expect(drives).toHaveLength(1);
    expect(drives[0]).toMatchObject({ root: rootOf('E:'), card: { id: ID_A }, place: { label: 'T7' } });
  });

  it('renames places, keeps names unique per kind, and updates this-device.json for the laptop', async () => {
    const laptopId = service.thisDevice.id;
    expect(service.renamePlace(laptopId, '  Rajesh laptop ')).toEqual({ ok: true, label: 'Rajesh laptop' });
    expect(JSON.parse(fs.readFileSync(thisDevicePath(dataDir), 'utf8'))).toMatchObject({ id: laptopId, label: 'Rajesh laptop' });
    expect(service.renamePlace(laptopId, '')).toMatchObject({ ok: false });
    expect(service.renamePlace('missing', 'x')).toMatchObject({ ok: false });

    await name('E:', 'T7');
    volumes.push(vol('F:', { driveType: 2, serial: 'BBBB0002' }));
    await name('F:', 'Spare');
    expect(service.renamePlace(ID_B, 't7')).toMatchObject({ ok: false });
    expect(service.renamePlace(ID_B, 'Spare 2')).toEqual({ ok: true, label: 'Spare 2' });
    // Renaming a drive place never touches the card on the drive.
    expect(JSON.parse(fs.readFileSync(cardPath(rootOf('F:')), 'utf8')).name).toBe('Spare');
  });

  it('passes the fingerprint picture and the running listing detail through, and offers Match copies now only when files wait on a connected place', () => {
    const picture = (over: object = {}) => ({
      fileCount: 10,
      fingerprintedFiles: 4,
      totalBytes: 100,
      fingerprintedBytes: 40,
      failedFiles: 0,
      state: 'idle' as const,
      speedBytesPerSec: null,
      speedFilesPerSec: null,
      job: null,
      failedReason: null,
      detail: null,
      coverage: null,
      countedAt: null,
      ...over,
    });
    let current = picture();
    service.setFingerprintSource((_id, kind) => (kind === 'laptop' ? current : null));
    service.setListingSources({ stateOf: () => 'running', rootsOf: () => [], detailOf: () => 'Listing STUDY-PC: 2,000 files so far · 900 files per second' });
    const laptop = () => service.snapshot().places.find((p) => p.thisDevice);
    expect(laptop()).toMatchObject({ fingerprint: { fileCount: 10, fingerprintedFiles: 4 }, canFingerprint: true, listingDetail: 'Listing STUDY-PC: 2,000 files so far · 900 files per second' });
    current = picture({ fingerprintedFiles: 9, failedFiles: 1 }); // everything is done or failed
    expect(laptop()?.canFingerprint).toBe(false);
    current = picture({ state: 'running' });
    expect(laptop()?.canFingerprint).toBe(false);
    service.setListingSources({ stateOf: () => 'idle', rootsOf: () => [] });
    expect(laptop()?.listingDetail).toBeNull();
    // Places that are not local have no fingerprint picture.
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('g1', 1, 'gdrive', 'Mail', 'unknown', 1)").run();
    expect(service.snapshot().places.find((p) => p.id === 'g1')).toMatchObject({ fingerprint: null, canFingerprint: false });
  });

  it('shows drives as unknown until the first listing', () => {
    db.prepare(`INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, 'drive', 'T7', 'connected', 1)`).run(ID_A);
    expect(service.snapshot().places.find((p) => p.id === ID_A)?.status).toBe('unknown');
  });

  it('shows Google accounts with quota, file count and needs_signin, without touching their status when polling', async () => {
    const identity = (extra: object) => JSON.stringify({ email: 'x@example.invalid', quotaLimit: 100, quotaUsage: 40, ...extra });
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('g1', 1, 'gdrive', 'Alpha', ?, 'unknown', 1)").run(identity({ catalog: { from: 'fleet-manager-v1' } }));
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('g2', 1, 'gdrive', 'Beta', ?, 'needs_signin', 2)").run(identity({}));
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      db.prepare('INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES (?, ?, NULL, 1, 1)').run('g1', `My Drive/${id}${i}`);
    }
    const snap = await service.refresh();
    const g1 = snap.places.find((p) => p.id === 'g1');
    const g2 = snap.places.find((p) => p.id === 'g2');
    expect(g1).toMatchObject({ kind: 'gdrive', status: 'unknown', gdrive: { quotaLimitBytes: 100, quotaUsageBytes: 40, fileCount: 3, fromV1: true } });
    expect(g2).toMatchObject({ status: 'needs_signin', gdrive: { fileCount: 0, fromV1: false } });
    expect(JSON.stringify(snap)).not.toContain('example.invalid');
    // Counts are cached for a few seconds; catalogChanged() recounts and tells listeners.
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('g1', 'My Drive/d', 1, 1, 1)").run();
    expect(service.snapshot().places.find((p) => p.id === 'g1')?.gdrive?.fileCount).toBe(3);
    const seen: number[] = [];
    service.onChanged((s) => seen.push(s.places.find((p) => p.id === 'g1')?.gdrive?.fileCount ?? -1));
    service.catalogChanged();
    expect(seen).toEqual([4]);
    expect(db.prepare("SELECT status FROM places WHERE id = 'g2'").get()).toEqual({ status: 'needs_signin' });
  });

  it('does not poll while suspended', async () => {
    let calls = 0;
    const counting = new PlaceService({
      db,
      dataDir,
      hostname: 'X',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: () => {
        calls += 1;
        return Promise.resolve(volumes);
      },
      rootOf,
      log: silent,
    });
    counting.init();
    counting.suspend();
    counting.startPolling(20);
    await new Promise((r) => setTimeout(r, 150));
    const duringSleep = calls;
    expect(duringSleep).toBe(1); // only the initial listing
    counting.resume();
    await new Promise((r) => setTimeout(r, 100));
    counting.stopPolling();
    await counting.refresh(); // let any in-flight listing finish before the database closes
    expect(calls).toBeGreaterThan(duringSleep);
  });
});
