import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { PHONE_ANSWER_LIFETIME_MS, PHONE_READ_EVERY_MS, PlaceService } from './placeService';
import { phoneIsPlugged, phoneSerialOf } from './phonePresence';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('which phone place is plugged in', () => {
  const id = (o: object): string => JSON.stringify(o);

  it('reads the stored serial, trimmed, and nothing from a place without one', () => {
    expect(phoneSerialOf(id({ serial: ' ABC123 ', model: 'Poco F4' }))).toBe('ABC123');
    expect(phoneSerialOf(id({ model: 'Poco F4' }))).toBeNull();
    expect(phoneSerialOf(id({ serial: '  ' }))).toBeNull();
    expect(phoneSerialOf(id({ serial: 5 }))).toBeNull();
    expect(phoneSerialOf('not json')).toBeNull();
    expect(phoneSerialOf('[]')).toBeNull();
  });

  it('matches by serial only', () => {
    expect(phoneIsPlugged(id({ serial: 'ABC123' }), new Set(['ABC123', 'ZZZ']))).toBe(true);
    expect(phoneIsPlugged(id({ serial: 'ABC123' }), new Set(['OTHER']))).toBe(false);
    expect(phoneIsPlugged(id({ serial: 'ABC123' }), new Set())).toBe(false);
  });

  it('is false without an answer from adb or without a stored serial', () => {
    expect(phoneIsPlugged(id({ serial: 'ABC123' }), null)).toBe(false);
    expect(phoneIsPlugged(id({}), new Set(['ABC123']))).toBe(false);
  });
});

describe('the phone place in the places snapshot', () => {
  let dir: string;
  let db: Db;
  let service: PlaceService;
  let nowMs: number;
  let asked: number;
  let plugged: string[] | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-phone-place-test-'));
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const opened = initDatabase(dataDir, silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    nowMs = 1_800_000_000_000;
    asked = 0;
    plugged = ['SER-1'];
    service = new PlaceService({
      db,
      dataDir,
      hostname: 'STUDY-PC',
      appVersion: '0.1.0',
      systemDrive: 'C:',
      listVolumes: () => Promise.resolve([]),
      rootOf: (letter) => path.join(dir, letter.replace(':', '')),
      now: () => nowMs,
      log: silent,
    });
    service.init();
    const profileId = (db.prepare("SELECT profile_id FROM places WHERE kind = 'laptop'").get() as { profile_id: number }).profile_id;
    const insert = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)');
    insert.run('phone-1', profileId, 'phone', 'Poco F4', JSON.stringify({ serial: 'SER-1', model: 'Poco F4' }), 'unknown');
    insert.run('phone-2', profileId, 'phone', 'Old phone', JSON.stringify({ serial: 'SER-2' }), 'unknown');
    insert.run('phone-3', profileId, 'phone', 'No serial', JSON.stringify({}), 'unknown');
  });
  afterEach(() => {
    service.stopPolling();
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const status = (placeId: string): string | undefined => service.snapshot().places.find((p) => p.id === placeId)?.status;
  const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('says connected for the serial adb sees, and not connected for the others', () => {
    service.notePhones(['SER-1']);
    expect(status('phone-1')).toBe('connected');
    expect(status('phone-2')).toBe('disconnected');
    expect(status('phone-3')).toBe('disconnected');
  });

  it('a phone told "Safe to unplug" says so on its card (only that phone), until it is cleared', () => {
    service.notePhones([]);
    service.noteReleased(['SER-1']);
    const view = (id: string) => service.snapshot().places.find((p) => p.id === id);
    expect(view('phone-1')?.safeToUnplug).toBe(true);
    expect(view('phone-1')?.status).toBe('disconnected');
    expect(view('phone-2')?.safeToUnplug).toBeUndefined();
    service.noteReleased([]);
    expect(view('phone-1')?.safeToUnplug).toBeUndefined();
  });

  it('keeps what the row says before adb was asked, and trusts an answer only for a while', () => {
    expect(status('phone-1')).toBe('unknown');
    service.notePhones(['SER-1']);
    nowMs += PHONE_ANSWER_LIFETIME_MS + 1;
    expect(status('phone-1')).toBe('unknown');
  });

  it('asks adb on the poll only when a phone place has a serial, and at most every 30 seconds', async () => {
    service.setPhoneSource(() => {
      asked += 1;
      return Promise.resolve(plugged);
    });
    await service.refresh();
    await wait();
    expect(asked).toBe(1);
    expect(status('phone-1')).toBe('connected');
    nowMs += PHONE_READ_EVERY_MS - 1;
    await service.refresh();
    await wait();
    expect(asked).toBe(1);
    plugged = [];
    nowMs += 2;
    await service.refresh();
    await wait();
    expect(asked).toBe(2);
    expect(status('phone-1')).toBe('disconnected');
  });

  it('does not ask adb at all when no phone place has a serial', async () => {
    db.prepare("UPDATE places SET identity_json = '{}' WHERE kind = 'phone'").run();
    service.setPhoneSource(() => {
      asked += 1;
      return Promise.resolve(plugged);
    });
    await service.refresh();
    await wait();
    expect(asked).toBe(0);
  });

  it('an adb that is missing or fails leaves the phone not connected and breaks nothing', async () => {
    service.setPhoneSource(() => Promise.reject(new Error('adb is gone')));
    await service.refresh();
    await wait();
    expect(status('phone-1')).toBe('unknown');
    plugged = null;
    nowMs += PHONE_READ_EVERY_MS + 1;
    service.setPhoneSource(() => Promise.resolve(null));
    await service.refresh();
    await wait();
    expect(status('phone-1')).toBe('disconnected');
  });
});
