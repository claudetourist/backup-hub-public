import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../../shared/jobs';
import type { PhoneDevice } from '../../shared/phone';
import type { PhoneBackupAdb } from '../adb/adbPort';
import { PROBE_EVERY_MS } from '../adb/adbHold';
import { parseUsbProbe, usbPhonePlugged, usbProbeCommand } from '../adb/phoneUsbProbe';
import { closeDatabase, initDatabase, type Db } from '../db';
import { PhoneBackupService } from './phoneBackupService';

/** "Safe to unplug": adb is let go and not asked again until the phone is plugged in again (fake adb, fake jobs, fake clock). */
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const POCO: PhoneDevice = { serial: 'SERIAL0001', model: '22021211RI', state: 'device' };

describe('Safe to unplug for phones', () => {
  let dir: string;
  let db: Db;
  let clock: number;
  let devices: PhoneDevice[];
  let deviceCalls: number;
  let killed: number;
  let active: Pick<JobRecord, 'kind' | 'title'>[];
  let plugged: (boolean | null)[];
  let probeCalls: number;
  let seen: string[][];
  let released: string[][];
  let service: PhoneBackupService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-safeunplug-test-'));
    fs.mkdirSync(path.join(dir, 'data'));
    const opened = initDatabase(path.join(dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
    clock = 1_000_000;
    devices = [POCO];
    deviceCalls = 0;
    killed = 0;
    active = [];
    plugged = [];
    probeCalls = 0;
    seen = [];
    released = [];
    const adb = {
      devices: async () => {
        deviceCalls += 1;
        return devices;
      },
      killServer: async () => {
        killed += 1;
      },
    } as unknown as PhoneBackupAdb;
    service = new PhoneBackupService(
      {
        db,
        adb,
        log: silent,
        now: () => clock,
        driveFor: async () => null,
        phonesSeen: (serials) => seen.push(serials),
        phonesReleased: (serials) => released.push(serials),
        phonePlugged: async () => {
          probeCalls += 1;
          return plugged.shift() ?? null;
        },
      },
      { create: () => 1, list: () => active as JobRecord[] },
    );
  });
  afterEach(() => {
    closeDatabase(db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets go of adb once and then does not ask adb about phones any more, however often the screens poll', async () => {
    expect((await service.connected()).newPhones).toHaveLength(1); // the warm-up: adb is asked
    const result = await service.safeUnplug();
    expect(result).toEqual({ ok: true, message: 'Safe to unplug the phone' });
    expect(killed).toBe(1);
    const asked = deviceCalls;
    for (let i = 0; i < 5; i += 1) {
      clock += 31_000; // the poll of Home, Backups and Devices
      const status = await service.connected();
      expect(status.phones).toEqual([]);
      expect(status.newPhones).toEqual([]);
      expect(status.released).toEqual([{ serial: 'SERIAL0001', phoneName: '22021211RI' }]);
      expect(await service.pluggedSerials()).toEqual([]);
    }
    expect(deviceCalls).toBe(asked); // adb was not asked again
    expect(killed).toBe(1);
    expect(released.at(-1)).toEqual(['SERIAL0001']); // the Devices screen is told
    expect(seen.at(-1)).toEqual([]); // and the phone is not shown as connected
  });

  it('a phone job that uses the phone refuses it, names the job, and lets nothing go', async () => {
    active = [{ kind: 'phone.backup', title: 'Back up Poco F4' }];
    const result = await service.safeUnplug();
    expect(result).toMatchObject({ ok: false, busyJob: 'Back up Poco F4' });
    expect(result.message).toContain('Back up Poco F4');
    expect(killed).toBe(0);
    expect(released).toEqual([]);
    expect((await service.connected()).released).toBeUndefined();
    // Free up phone space and the clean-up jobs count too.
    for (const kind of ['freeup.remove', 'freeup.check', 'phone.checkOld']) {
      active = [{ kind, title: kind }];
      expect((await service.safeUnplug()).ok).toBe(false);
    }
    expect(killed).toBe(0);
  });

  it('a phone that was unplugged and plugged in again ends it; a phone that never left does not', async () => {
    await service.safeUnplug();
    const asked = deviceCalls;
    plugged = [true]; // still plugged in right after the button: not yet a replug
    clock += PROBE_EVERY_MS + 1;
    expect((await service.connected()).released).toHaveLength(1);
    plugged = [false]; // unplugged
    clock += PROBE_EVERY_MS + 1;
    expect((await service.connected()).released).toHaveLength(1);
    expect(deviceCalls).toBe(asked);
    plugged = [null]; // could not tell: nothing changes
    clock += PROBE_EVERY_MS + 1;
    expect((await service.connected()).released).toHaveLength(1);
    plugged = [true]; // plugged in again
    clock += PROBE_EVERY_MS + 1;
    const back = await service.connected();
    expect(back.released).toBeUndefined();
    expect(back.newPhones).toHaveLength(1);
    expect(deviceCalls).toBe(asked + 1); // adb is asked again
    expect(released.at(-1)).toEqual([]);
  });

  it('the probe is not asked more often than every few seconds', async () => {
    await service.safeUnplug();
    plugged = [false, false, false];
    await service.connected();
    await service.connected();
    await service.connected();
    expect(probeCalls).toBeLessThanOrEqual(1);
  });

  it('a phone job starting, or "Use the phone again", ends it at once', async () => {
    await service.safeUnplug();
    active = [{ kind: 'phone.backup', title: 'Back up Poco F4' }];
    const before = deviceCalls;
    expect((await service.connected()).released).toBeUndefined();
    expect(deviceCalls).toBe(before + 1);
    active = [];
    await service.safeUnplug();
    await service.useAgain();
    expect(released.at(-1)).toEqual([]);
    expect((await service.connected()).released).toBeUndefined();
  });

  it('pressing it again while it is on says the same, and a computer with no phone plugged in holds nothing', async () => {
    await service.safeUnplug();
    expect(await service.safeUnplug()).toEqual({ ok: true, message: 'Safe to unplug the phone' });
    expect(killed).toBe(1);
    await service.useAgain();
    devices = [];
    expect(await service.safeUnplug()).toEqual({ ok: true, message: 'Safe to unplug the phone' });
    expect((await service.connected()).released).toBeUndefined();
  });

  it('polling while it is on never holds the window (200 polls answer in under 250 ms)', async () => {
    await service.safeUnplug();
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) await service.connected();
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('the Windows probe for a plugged-in phone', () => {
  it('builds one read-only line for a valid serial, and refuses anything else', () => {
    expect(usbProbeCommand('SERIAL0001')).toContain("Get-PnpDevice -PresentOnly");
    expect(usbProbeCommand('SERIAL0001')).toContain("'*SERIAL0001*'");
    expect(() => usbProbeCommand("a'; Remove-Item x; '")).toThrow();
    expect(() => usbProbeCommand('')).toThrow();
  });
  it('reads the count, and says null when it cannot tell', async () => {
    expect(parseUsbProbe('2\r\n')).toBe(true);
    expect(parseUsbProbe('0')).toBe(false);
    expect(parseUsbProbe('oops')).toBeNull();
    expect(await usbPhonePlugged(async () => '1', 'abc')).toBe(true);
    expect(await usbPhonePlugged(async () => '0', 'abc')).toBe(false);
    expect(await usbPhonePlugged(async () => Promise.reject(new Error('no powershell')), 'abc')).toBeNull();
    expect(await usbPhonePlugged(async () => '1', 'bad serial')).toBeNull();
  });
});
