import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { DRIVE_PROBLEM_WORDS } from '../../shared/places';
import { readDriveCard, type CardRead } from './driveCard';
import { matchVolumes } from './matching';
import { CARD_RETRY_AFTER_MS, PlaceService } from './placeService';
import type { Volume } from './volumes';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ID_A = '11111111-1111-4111-8111-111111111111';
const T0 = 1_800_000_000_000;

const vol = (letter: string, overrides: Partial<Volume> = {}): Volume => ({ letter, label: '', fileSystem: 'NTFS', capacity: 1_000_000_000_000, free: 400_000_000_000, driveType: 3, serial: null, ...overrides });

describe('a drive that is plugged in but does not read properly', () => {
  let dir: string;
  let roots: string;
  let db: Db;
  let volumes: Volume[];
  let service: PlaceService;
  let nowMs: number;
  /** What the next card read does: 'ok' reads the real card, 'error' fails, 'hang' never answers. */
  let mode: 'ok' | 'error' | 'hang';
  let reads: number;
  const rootOf = (letter: string): string => path.join(roots, letter.replace(':', ''));
  const make = (timeoutMs?: number): PlaceService =>
    new PlaceService({
      db,
      dataDir: path.join(dir, 'data'),
      hostname: 'STUDY-PC',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: () => Promise.resolve(volumes),
      rootOf,
      now: () => nowMs,
      uuid: () => ID_A,
      log: silent,
      ...(timeoutMs !== undefined ? { cardReadTimeoutMs: timeoutMs } : {}),
      readCard: (root): Promise<CardRead> => {
        reads += 1;
        if (mode === 'error') return Promise.reject(Object.assign(new Error('I/O error'), { code: 'EIO' }));
        if (mode === 'hang') return new Promise<CardRead>(() => undefined);
        return readDriveCard(root);
      },
    });
  const drive = () => service.snapshot().places.find((p) => p.id === ID_A)!;
  const dbStatus = (): string => (db.prepare('SELECT status FROM places WHERE id = ?').pluck().get(ID_A) as string);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-driveproblem-test-'));
    roots = path.join(dir, 'roots');
    fs.mkdirSync(path.join(dir, 'data'));
    for (const l of ['C', 'E', 'G']) fs.mkdirSync(path.join(roots, l), { recursive: true });
    const opened = initDatabase(path.join(dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    nowMs = T0;
    mode = 'ok';
    reads = 0;
    volumes = [vol('C:', { label: 'Windows' }), vol('G:', { label: 'Seagate', driveType: 2, serial: '366041AD' })];
    service = make();
    service.init();
    await service.refresh();
    expect(await service.nameDrive({ letter: 'G:', name: 'Seagate', confirmed: true })).toMatchObject({ ok: true, placeId: ID_A });
    expect(drive()).toMatchObject({ status: 'connected', canList: true, problem: null });
  });
  afterEach(() => {
    service.stopPolling();
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a card read that fails: shown as plugged in with a problem, not as disconnected, and not usable', async () => {
    mode = 'error';
    nowMs += 10_000;
    const snap = await service.refresh();
    const seagate = snap.places.find((p) => p.id === ID_A)!;
    expect(seagate).toMatchObject({ status: 'problem', rootHint: 'G:', canList: false, canFingerprint: false });
    expect(seagate.problem).toBe("Plugged in at G:, but Windows can't read it properly right now. Nothing is written to it. Try another cable or USB port.");
    expect(seagate.problem).toBe(DRIVE_PROBLEM_WORDS('G:'));
    expect(service.isConnected(ID_A)).toBe(false);
    expect(service.connectedDrives()).toEqual([]);
    expect(service.baseFolderOf({ id: ID_A, kind: 'drive' })).toBeNull();
    expect(snap.unnamed).toEqual([]);
    expect(dbStatus()).toBe('connected'); // never written as disconnected
  });

  it('a card read that never answers is given up on after the time limit', async () => {
    service.stopPolling();
    service = make(25);
    service.init();
    mode = 'hang';
    nowMs += 10_000;
    const started = Date.now();
    await service.refresh();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(drive()).toMatchObject({ status: 'problem', canList: false });
    expect(service.isConnected(ID_A)).toBe(false);
  });

  it('after a failed read the card of that letter is not read again for 60 seconds, then it is', async () => {
    mode = 'error';
    nowMs += 10_000;
    await service.refresh();
    const afterFirst = reads;
    mode = 'ok'; // the disk would answer now, but it is not asked yet
    nowMs += 10_000;
    await service.refresh();
    nowMs += 40_000;
    await service.refresh();
    expect(reads).toBe(afterFirst);
    expect(drive().status).toBe('problem');
    nowMs += CARD_RETRY_AFTER_MS; // past the pause
    await service.refresh();
    expect(reads).toBe(afterFirst + 1);
    expect(drive()).toMatchObject({ status: 'connected', problem: null, canList: true });
  });

  it('the pause belongs to the drive at that letter: another drive plugged into it is read at once', async () => {
    mode = 'error';
    nowMs += 10_000;
    await service.refresh();
    const afterFirst = reads;
    mode = 'ok';
    volumes = [vol('C:', { label: 'Windows' }), vol('G:', { label: 'Other', driveType: 2, serial: 'OTHER001' })];
    nowMs += 10_000;
    await service.refresh();
    expect(reads).toBe(afterFirst + 1);
  });

  it('a drive that is really gone is still disconnected', async () => {
    volumes = [vol('C:', { label: 'Windows' })];
    nowMs += 10_000;
    await service.refresh();
    expect(drive().status).toBe('disconnected');
    expect(dbStatus()).toBe('disconnected');
    expect(drive().problem).toBeNull();
  });

  it('a failing drive that is not a known drive stays an unnamed drive with an unreadable card', async () => {
    volumes = [vol('C:', { label: 'Windows' }), vol('G:', { label: 'Stranger', driveType: 2, serial: 'STRANGER1' })];
    mode = 'error';
    nowMs += 10_000;
    const snap = await service.refresh();
    expect(snap.unnamed).toHaveLength(1);
    expect(snap.unnamed[0]).toMatchObject({ letter: 'G:', canName: false });
    expect(snap.unnamed[0]!.reason).toMatch(/cannot read/);
    expect(drive().status).toBe('disconnected');
  });

  it('"Name this drive" is refused on a drive that does not read, and nothing is written', async () => {
    mode = 'error';
    nowMs += 10_000;
    await service.refresh();
    const result = await service.nameDrive({ letter: 'G:', name: 'Seagate again', confirmed: true });
    expect(result).toMatchObject({ ok: false });
    expect(drive().label).toBe('Seagate');
  });
});

describe('matching a volume whose card did not read', () => {
  const known = [{ placeId: ID_A, label: 'Seagate', serial: '366041AD' }];
  const cards = (read: CardRead): Map<string, CardRead> => new Map([['G:', read]]);
  const bad: CardRead = { status: 'unreadable', reason: 'the drive did not answer in time' };

  it('the serial of a known drive: that drive, with a problem', () => {
    const v = vol('G:', { driveType: 2, serial: '366041AD' });
    expect(matchVolumes([v], cards(bad), known, 'C:')).toEqual([{ kind: 'unreadable', volume: v, reason: 'the drive did not answer in time', placeId: ID_A, label: 'Seagate' }]);
  });

  it('another serial, or none, or a drive already claimed by a card elsewhere: an unreadable card as before', () => {
    const stranger = vol('G:', { driveType: 2, serial: 'ZZZ' });
    expect(matchVolumes([stranger], cards(bad), known, 'C:')[0]).toMatchObject({ kind: 'invalid-card' });
    const noSerial = vol('G:', { driveType: 2 });
    expect(matchVolumes([noSerial], cards(bad), known, 'C:')[0]).toMatchObject({ kind: 'invalid-card' });
    const claimedElsewhere = new Map<string, CardRead>([
      ['G:', bad],
      ['H:', { status: 'ok', card: { id: ID_A, name: 'Seagate', createdAt: '', appVersion: '' } }],
    ]);
    const out = matchVolumes([vol('G:', { driveType: 2, serial: '366041AD' }), vol('H:', { driveType: 2, serial: 'H1' })], claimedElsewhere, known, 'C:');
    expect(out.map((m) => m.kind).toSorted()).toEqual(['card', 'invalid-card']);
  });

  it('no card at all is still no card (not a problem)', () => {
    const v = vol('G:', { driveType: 2, serial: '366041AD' });
    expect(matchVolumes([v], cards({ status: 'none' }), known, 'C:')[0]).toMatchObject({ kind: 'serial' });
  });
});
