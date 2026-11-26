import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../appServices';
import { closeDatabase, initDatabase, type Db } from '../db';
import { GoogleHttp } from '../google/googleHttp';
import { registerBuiltinJobs } from '../jobs/builtinJobs';
import { JobService } from '../jobs/jobService';
import { cardPath, legacyCardPath, writeDriveCard } from '../places/driveCard';
import type { Volume } from '../places/volumes';
import { IDLE_NEEDED_SECONDS, UpkeepScheduler, type UpkeepChild } from '../upkeep/upkeepScheduler';

/**
 * Plan R0.6: the app only WATCHES at start. This runs the same sequence main.ts runs (open the database, build the services, recover
 * the last session's jobs, start the job service, start the drive watching, prepare the listing, start the upkeep scheduler) with fakes
 * around it, and asserts what must NOT happen: no job is created and none from the last session runs, nothing is sent to Google, no file on a
 * plugged-in drive is opened except its ID card, and the upkeep process does not start before the computer has been idle.
 */

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const CARD_ID = '33333333-3333-4333-8333-333333333333';

let dir: string;
let driveRoot: string;
let db: Db;
let jobs: JobService;
let services: AppServices;
let stop: (() => void)[] = [];

function driveVolume(): Volume {
  return { letter: 'Z:', label: 'T7 TEST', fileSystem: 'NTFS', capacity: 2_000_000_000_000, free: 1_000_000_000_000, driveType: 2, serial: 'ABCD1234' };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-nostart-'));
  driveRoot = path.join(dir, 'drive-Z');
  // A drive with its ID card and plenty of the person's files that must stay untouched.
  fs.mkdirSync(path.join(driveRoot, 'MyData', 'Photos'), { recursive: true });
  fs.writeFileSync(path.join(driveRoot, 'MyData', 'Photos', 'reunion.jpg'), 'jpg');
  fs.writeFileSync(path.join(driveRoot, 'MyData', 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(driveRoot, 'readme.txt'), 'hello');
  writeDriveCard(driveRoot, { id: CARD_ID, name: 'T7 TEST', createdAt: '2026-01-01T00:00:00.000Z', appVersion: 't' });
  fs.mkdirSync(path.join(dir, 'data'));
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  stop = [];
});
afterEach(() => {
  for (const fn of stop.splice(0)) fn();
  vi.restoreAllMocks();
  services?.places.stopPolling();
  services?.pause.close();
  services?.query.close();
  services?.search.close();
  services?.quickRunner.close();
  jobs?.shutdown();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Records every open, read or directory listing below `root` (they still run). */
function watchDrive(root: string): { touched: Set<string> } {
  const touched = new Set<string>();
  const inside = (p: unknown): string | null => {
    if (typeof p !== 'string' && !(p instanceof URL)) return null;
    const full = path.resolve(p instanceof URL ? p.pathname : p);
    return full.toLowerCase().startsWith(path.resolve(root).toLowerCase()) ? full : null;
  };
  const wrap = <T extends object>(target: T, names: string[]): void => {
    for (const name of names) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== 'function') continue;
      vi.spyOn(target as never, name as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
        const hit = inside(args[0]);
        if (hit) touched.add(hit);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as never);
    }
  };
  wrap(fs, ['openSync', 'readFileSync', 'readdirSync', 'opendirSync', 'createReadStream', 'readSync']);
  wrap(fs.promises, ['readFile', 'open', 'readdir', 'opendir']);
  return { touched };
}

describe('start-up only watches', () => {
  it('creates no job, calls no Google endpoint, opens only the ID card on a drive, and starts upkeep only when the computer is idle', async () => {
    const googleCalls: string[] = [];
    const googleHttp = new GoogleHttp({ fetchFn: (input) => (googleCalls.push(String(input)), Promise.reject(new Error('the network must not be used'))) });
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('the network must not be used')));

    // The last session left jobs behind: one running with a checkpoint and one still queued.
    jobs = new JobService({ db, log: silent });
    const ran: number[] = [];
    registerBuiltinJobs(jobs, { db, dataDir: path.join(dir, 'data'), log: silent }, true);
    jobs.register({ kind: 'test.left', heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) });
    const insert = db.prepare("INSERT INTO jobs (kind, title, state, created_at, started_at, resume_json) VALUES ('test.left', 'Left', ?, 1, 1, ?)");
    const leftRunning = Number(insert.run('running', '{"at":3}').lastInsertRowid);
    const leftQueued = Number(insert.run('queued', null).lastInsertRowid);

    const drive = watchDrive(driveRoot);
    const volumes = [driveVolume()];
    services = createAppServices({
      db,
      dbFile: path.join(dir, 'data', 'backuphub.db'),
      dataDir: path.join(dir, 'data'),
      logsDir: path.join(dir, 'logs'),
      appVersion: 't',
      jobs,
      log: silent,
      isOnBattery: () => false,
      googleHttp,
      adb: { available: () => false, killServer: () => Promise.resolve() } as never,
      placeDeps: {
        listVolumes: () => Promise.resolve(volumes),
        listDisks: () => Promise.resolve([]),
        rootOf: (letter) => (letter === 'Z:' ? driveRoot : path.join(dir, 'no-such-drive', letter.replace(':', ''))),
        detectOneDrive: () => Promise.resolve(null),
        hostname: 'TEST-PC',
        systemDrive: 'C:',
      },
    });
    // The USB health reader asks Windows' event log through PowerShell; not in a test.
    vi.spyOn(services.usb, 'start').mockImplementation(() => undefined);

    // ---- the sequence of main.ts, in its order ----
    jobs.recoverInterrupted();
    jobs.start();
    services.places.startPolling();
    await services.places.refresh();
    await services.prepareListing();

    let spawned = 0;
    let idle = 0;
    let now = 1_000_000;
    const timers: { at: number; run: () => void }[] = [];
    const child: UpkeepChild = { postMessage: () => undefined, kill: () => undefined, onSpawn: () => undefined, onMessage: () => undefined, onExit: () => undefined };
    const scheduler = new UpkeepScheduler({
      now: () => now,
      idleSeconds: () => idle,
      onBattery: () => false,
      jobsBusy: () => jobs.hasPendingWork(),
      paused: () => services.pause.isOn(),
      spawn: () => (spawned += 1, child),
      dbFile: path.join(dir, 'data', 'backuphub.db'),
      lowerPriority: () => undefined,
      schedule: (run, ms) => {
        const entry = { at: now + ms, run };
        timers.push(entry);
        return () => void timers.splice(timers.indexOf(entry), 1);
      },
      log: silent,
    });
    stop.push(() => scheduler.endNow());
    services.pause.onChanged(() => scheduler.check());
    scheduler.start();
    // Minutes pass at the keyboard: nothing starts.
    for (let i = 0; i < 20; i += 1) {
      now += 30_000;
      idle = 5 * (i % 3);
      for (const t of timers.splice(0).filter((x) => x.at <= now)) t.run();
    }
    expect(spawned).toBe(0);
    scheduler.check();
    expect(spawned).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));

    // ---- what must not have happened ----
    // No job exists except the two the last session left, and both are held (interrupted), none ran.
    expect(jobs.list().map((j) => j.id).toSorted()).toEqual([leftRunning, leftQueued]);
    expect(jobs.list({ states: ['queued', 'running'] })).toEqual([]);
    expect(jobs.get(leftRunning)).toMatchObject({ state: 'failed', hasCheckpoint: true });
    expect(jobs.get(leftQueued)).toMatchObject({ state: 'failed' });
    expect(ran).toEqual([]);
    // Nothing was sent to Google, by the app's network layer or by anything else.
    expect(googleCalls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
    // The drive was recognised (its card was read) ...
    const snapshot = await services.places.refresh();
    expect(JSON.stringify(snapshot)).toContain(CARD_ID);
    // ... and no file on it was opened except the ID card (new place, old place).
    expect([...drive.touched].map((p) => path.relative(driveRoot, p).toLowerCase()).toSorted()).toEqual(
      [path.relative(driveRoot, cardPath(driveRoot)), path.relative(driveRoot, legacyCardPath(driveRoot))].map((p) => p.toLowerCase()).toSorted(),
    );
    // Upkeep starts only once every idle condition holds.
    idle = IDLE_NEEDED_SECONDS;
    scheduler.check();
    expect(spawned).toBe(1);
  });
});
