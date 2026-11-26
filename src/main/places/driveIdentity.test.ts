import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { assertWritable, configureWriteGuard, DriveWriteProtectedError, resetWriteGuardForTests } from '../fsutil';
import { CARD_FILE, LEGACY_CARD_FOLDER } from '../../shared/appFolders';
import { cardPath, legacyCardPath } from './driveCard';
import { filesOf } from '../writeGuard.testutil';
import { PlaceService } from './placeService';
import type { Volume } from './volumes';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const vol = (letter: string, overrides: Partial<Volume> = {}): Volume => ({ letter, label: '', fileSystem: 'NTFS', capacity: 1_000_000_000_000, free: 400_000_000_000, driveType: 3, serial: null, ...overrides });

describe('drive identity: a card that matches but whose serial or size differs, and two drives with one card', () => {
  let dir: string;
  let roots: string;
  let db: Db;
  let volumes: Volume[];
  let service: PlaceService;
  const rootOf = (letter: string): string => path.join(roots, letter.replace(':', ''));
  const make = (): PlaceService =>
    new PlaceService({ db, dataDir: path.join(dir, 'data'), hostname: 'STUDY-PC', appVersion: '0.1.0', systemDrive: 'C:', listVolumes: () => Promise.resolve(volumes), rootOf, now: () => 1_800_000_000_000, uuid: () => ID_A, log: silent });
  const E = (): Volume => volumes.find((v) => v.letter === 'E:')!;
  const stored = (): { serial?: string; capacity?: number } => JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(ID_A) as { identity_json: string }).identity_json) as { serial?: string; capacity?: number };
  const writeAt = (letter: string): void => assertWritable(path.join(rootOf(letter), 'Anything', 'x.bin'));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-identity-test-'));
    roots = path.join(dir, 'roots');
    fs.mkdirSync(path.join(dir, 'data'));
    for (const l of ['C', 'D', 'E', 'F']) fs.mkdirSync(path.join(roots, l), { recursive: true });
    const opened = initDatabase(path.join(dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    volumes = [vol('C:', { label: 'Windows' }), vol('E:', { label: 'T7', driveType: 2, serial: 'AAAA0001' })];
    service = make();
    service.init();
    await service.refresh();
    expect(await service.nameDrive({ letter: 'E:', name: 'T7', confirmed: true })).toMatchObject({ ok: true, placeId: ID_A });
    configureWriteGuard({ protectedDrives: () => [], rootOf: (p) => (p.startsWith(roots) ? path.join(roots, path.relative(roots, p).split(path.sep)[0]!) : null), identityBlock: (id) => service.identityBlock(id), systemRoot: 'ZZ:\\' });
  });
  afterEach(() => {
    resetWriteGuardForTests();
    service.stopPolling();
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the same drive again changes nothing and is not blocked', async () => {
    await service.refresh();
    expect(service.driveDecisions()).toEqual([]);
    expect(service.identityBlock(ID_A)).toBeNull();
    expect(() => writeAt('E')).not.toThrow();
  });

  it('another serial: a decision is stored, the stored serial is NOT overwritten, nothing can be written to the drive', async () => {
    E().serial = 'BBBB0002';
    await service.refresh();
    const items = service.driveDecisions(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ placeId: ID_A, kind: 'serial_changed', detail: { storedSerial: 'AAAA0001', foundSerial: 'BBBB0002' } });
    expect(stored().serial).toBe('AAAA0001');
    expect(() => writeAt('E')).toThrow(DriveWriteProtectedError);
    expect(service.identityBlock(ID_A)).toMatch(/another serial/);
    await service.refresh();
    await service.refresh();
    expect(service.driveDecisions()).toHaveLength(1); // asked once, not every minute
    expect(stored().serial).toBe('AAAA0001');
  });

  it('another size: a decision, nothing overwritten, writes refused', async () => {
    E().capacity = 500_000_000_000;
    await service.refresh();
    expect(service.driveDecisions(true).map((d) => d.kind)).toEqual(['size_changed']);
    expect(stored().capacity).toBe(1_000_000_000_000);
    expect(() => writeAt('E')).toThrow(DriveWriteProtectedError);
  });

  it('"it is the same drive" stores the new facts and lifts the block; the block stays across a restart until then', async () => {
    E().serial = 'BBBB0002';
    await service.refresh();
    const restarted = make();
    expect(restarted.identityBlock(ID_A)).not.toBeNull();
    const id = service.driveDecisions(true)[0]!.id;
    expect(service.answerDriveDecision(id, 'accepted')).toMatchObject({ ok: true });
    expect(stored().serial).toBe('BBBB0002');
    expect(service.identityBlock(ID_A)).toBeNull();
    expect(() => writeAt('E')).not.toThrow();
    expect(service.answerDriveDecision(id, 'accepted')).toMatchObject({ ok: false }); // already answered
    await service.refresh();
    expect(service.driveDecisions(true)).toEqual([]);
  });

  it('"it is not the same drive" keeps the drive blocked and does not ask again about the same facts', async () => {
    E().serial = 'BBBB0002';
    await service.refresh();
    const id = service.driveDecisions(true)[0]!.id;
    expect(service.answerDriveDecision(id, 'rejected')).toMatchObject({ ok: true });
    expect(stored().serial).toBe('AAAA0001');
    expect(() => writeAt('E')).toThrow(DriveWriteProtectedError);
    await service.refresh();
    expect(service.driveDecisions(true)).toEqual([]);
    expect(service.driveDecisions()).toHaveLength(1);
    expect(service.identityBlock(ID_A)).not.toBeNull();
  });

  it('a first serial or size where none was stored is simply recorded (no decision)', async () => {
    db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify({ lastConnectedAt: 1 }), ID_A);
    await service.refresh();
    expect(service.driveDecisions()).toEqual([]);
    expect(stored().serial).toBe('AAAA0001');
  });

  it('two connected drives with the same card: a decision, neither drive can be written to, and it closes when only one is left', async () => {
    fs.mkdirSync(path.dirname(cardPath(rootOf('F:'))), { recursive: true });
    fs.copyFileSync(cardPath(rootOf('E:')), cardPath(rootOf('F:')));
    volumes.push(vol('F:', { driveType: 2, serial: 'CCCC0003' }));
    await service.refresh();
    const items = service.driveDecisions(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ placeId: ID_A, kind: 'cloned_card', detail: { letters: ['E:', 'F:'] } });
    expect(() => writeAt('E')).toThrow(DriveWriteProtectedError);
    expect(() => writeAt('F')).toThrow(DriveWriteProtectedError);
    expect(service.answerDriveDecision(items[0]!.id, 'accepted')).toMatchObject({ ok: false }); // cannot both be this drive
    volumes = volumes.filter((v) => v.letter !== 'F:');
    await service.refresh();
    expect(service.driveDecisions(true)).toEqual([]);
    expect(service.driveDecisions()[0]).toMatchObject({ answer: 'resolved' });
    expect(() => writeAt('E')).not.toThrow();
    expect(ID_B).not.toBe(ID_A);
  });

  /** A card written by hand at the OLD place (the drive root), as a drive that has not been moved yet has it. */
  const putLegacyCard = (letter: string, id: string, name: string): string => {
    const file = legacyCardPath(rootOf(letter));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id, name, createdAt: '', appVersion: 'old' }));
    return file;
  };
  const guardWithClock = (protectedNames: string[]): void => {
    let t = 0;
    configureWriteGuard({ protectedDrives: () => protectedNames, rootOf: (p) => (p.startsWith(roots) ? path.join(roots, path.relative(roots, p).split(path.sep)[0]!) : null), identityBlock: (id) => service.identityBlock(id), systemRoot: 'ZZ:\\', now: () => (t += 10_000) });
  };

  it('a drive with its card only at the old place is identified, protected by that card, and nothing is ever written next to it', async () => {
    const old = putLegacyCard('F', ID_B, 'Seagate');
    const before = fs.readFileSync(old, 'utf8');
    volumes.push(vol('F:', { driveType: 2, serial: 'CCCC0003' }));
    const snap = await service.refresh();
    expect(snap.places.find((p) => p.id === ID_B)).toMatchObject({ kind: 'drive', label: 'Seagate', status: 'connected', rootHint: 'F:' });
    expect(snap.unnamed.find((u) => u.letter === 'F:')).toBeUndefined();
    // Naming it again is refused (it already has a card) and writes nothing.
    expect(await service.nameDrive({ letter: 'F:', name: 'Other', confirmed: true })).toMatchObject({ ok: false, code: 'has-card' });
    expect(filesOf(rootOf('F'))).toEqual([path.join(LEGACY_CARD_FOLDER, CARD_FILE)]);
    expect(fs.readFileSync(old, 'utf8')).toBe(before);
    // The write guard recognises the drive by the old card too.
    guardWithClock(['Seagate']);
    expect(() => writeAt('F')).toThrow(DriveWriteProtectedError);
    guardWithClock([]);
    expect(() => writeAt('F')).not.toThrow();
  });

  it('cards at both places that name different drives: a decision, the drive is not connected, nothing can be written, and it closes when only one card is left', async () => {
    const old = putLegacyCard('E', ID_B, 'Seagate');
    guardWithClock([]);
    const snap = await service.refresh();
    const items = service.driveDecisions(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ placeId: ID_A, kind: 'card_conflict', detail: { name: 'T7', oldName: 'Seagate', oldId: ID_B } });
    expect(snap.places.find((p) => p.id === ID_A)?.status).toBe('disconnected');
    expect(snap.unnamed.find((u) => u.letter === 'E:')).toMatchObject({ canName: false });
    expect(await service.nameDrive({ letter: 'E:', name: 'Third', confirmed: true })).toMatchObject({ ok: false, code: 'has-card' });
    expect(() => writeAt('E')).toThrow(DriveWriteProtectedError);
    expect(service.identityBlock(ID_A)).toMatch(/two different ID cards/);
    expect(service.answerDriveDecision(items[0]!.id, 'accepted')).toMatchObject({ ok: false });
    expect(service.answerDriveDecision(items[0]!.id, 'rejected')).toMatchObject({ ok: false });
    expect(fs.existsSync(old)).toBe(true); // the app removes neither card
    await service.refresh();
    expect(service.driveDecisions()).toHaveLength(1); // asked once

    fs.rmSync(old);
    await service.refresh();
    expect(service.driveDecisions(true)).toEqual([]);
    expect(service.driveDecisions()[0]).toMatchObject({ answer: 'resolved' });
    expect(service.identityBlock(ID_A)).toBeNull();
    expect(() => writeAt('E')).not.toThrow();
  });

  it('the same card at both places is fine (the new place decides)', async () => {
    fs.mkdirSync(path.dirname(legacyCardPath(rootOf('E'))), { recursive: true });
    fs.copyFileSync(cardPath(rootOf('E')), legacyCardPath(rootOf('E')));
    const snap = await service.refresh();
    expect(service.driveDecisions()).toEqual([]);
    expect(snap.places.find((p) => p.id === ID_A)?.status).toBe('connected');
  });
});
