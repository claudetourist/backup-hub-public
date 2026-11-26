import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../shared/jobs';
import type { AdbPort } from './adbPort';
import { QUIT_RELEASE_MS, releaseAdb, releaseWithin } from './adbRelease';
import { PhoneAdbService } from './phoneAdbService';

/** Only the two calls that matter for letting go of the phone. */
function fakeAdb(over: Partial<{ has: boolean; devices: () => Promise<never[]>; kill: () => Promise<void> }> = {}): AdbPort & { killed: number } {
  const adb = {
    killed: 0,
    available: () => over.has ?? true,
    devices: over.devices ?? (() => Promise.resolve([])),
    killServer: () => {
      adb.killed += 1;
      return over.kill ? over.kill() : Promise.resolve();
    },
  };
  return adb as unknown as AdbPort & { killed: number };
}

describe('letting go of the phone (adb kill-server)', () => {
  it('stops the adb server, only when adb.exe is there', async () => {
    const adb = fakeAdb();
    expect(await releaseAdb(adb)).toBe('released');
    expect(adb.killed).toBe(1);
    const missing = fakeAdb({ has: false });
    expect(await releaseAdb(missing)).toBe('skipped');
    expect(missing.killed).toBe(0);
  });

  it('never throws, and never waits longer than the limit when closing the app', async () => {
    expect(await releaseAdb(fakeAdb({ kill: () => Promise.reject(new Error('no server')) }))).toBe('released');
    const stuck = fakeAdb({ kill: () => new Promise<void>(() => undefined) });
    const started = Date.now();
    expect(await releaseWithin(stuck, 40)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(QUIT_RELEASE_MS).toBeLessThanOrEqual(5000);
  });

  it('closing the app releases the phone, awaited, and also on the window-close path', () => {
    const mainText = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    // before-quit: prevent the quit, release (bounded), then ask to quit again; window-all-closed goes through app.quit().
    // (R0.6b: it is one step of the shutdown routine now; before-quit runs the routine.)
    expect(mainText).toMatch(/app\.on\('before-quit', createBeforeQuit\(\{ shutdown, quitAgain: \(\) => app\.quit\(\) \}\)\)/);
    expect(mainText).toMatch(/releaseAdb: \(\) => services\?\.releasePhoneOnQuit\(\)/);
    expect(mainText).toMatch(/window-all-closed', \(\) => \{\s*app\.quit\(\);/);
    const services = fs.readFileSync(path.join(__dirname, '..', 'appServices.ts'), 'utf8');
    expect(services).toMatch(/releasePhoneOnQuit: \(\) => releaseWithin\(adb, QUIT_RELEASE_MS\)/);
  });
});

const job = (kind: string): JobRecord => ({ kind, state: 'running' }) as unknown as JobRecord;

describe('the phone is let go after phone work, however it ended', () => {
  const service = (adb: AdbPort, jobs: JobRecord[] = []): PhoneAdbService => new PhoneAdbService({ adb, jobs: { list: () => jobs } });

  it('after device checks, whether they worked or failed', async () => {
    const ok = fakeAdb();
    await service(ok).status();
    expect(ok.killed).toBe(1);
    const failed = fakeAdb({ devices: () => Promise.reject(new Error('device offline')) });
    expect(await service(failed).status()).toEqual({ adb: 'ready', devices: [] });
    expect(failed.killed).toBe(1);
  });

  it('but not while a phone job is using the phone, and not at all without adb.exe', async () => {
    const busy = fakeAdb();
    await service(busy, [job('clean.phone')]).status();
    await service(busy, [job('clean.putBack')]).release();
    expect(busy.killed).toBe(0);
    const none = fakeAdb({ has: false });
    await service(none).release();
    expect(none.killed).toBe(0);
  });

  it('the "Let go of the phone" button still works', async () => {
    const adb = fakeAdb();
    expect(await service(adb).eject()).toMatchObject({ ok: true });
    expect(adb.killed).toBe(1);
  });
});
