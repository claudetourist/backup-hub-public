import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_FREE_BYTES, spaceLevel, WARN_FREE_BYTES } from '../shared/dataSpace';
import { DataSpace, diskNameOf, spaceMessage } from './dataSpace';
import { closeDatabase, createSnapshotAsync, DB_FILE_NAME, initDatabase, snapshotsDir, SnapshotRefused, type Db } from './db';
import { snapshotHandler } from './jobs/builtinJobs';
import { JobService, type JobContext, type JobHandler } from './jobs/jobService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const GB = 1_000_000_000;

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-space-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('levels', () => {
  it('warns under 5 GB, stops heavy work under 2 GB, and does not guess when Windows will not say', () => {
    expect(spaceLevel(6 * GB)).toBe('ok');
    expect(spaceLevel(WARN_FREE_BYTES)).toBe('ok');
    expect(spaceLevel(WARN_FREE_BYTES - 1)).toBe('low');
    expect(spaceLevel(BLOCK_FREE_BYTES)).toBe('low');
    expect(spaceLevel(BLOCK_FREE_BYTES - 1)).toBe('critical');
    expect(spaceLevel(null)).toBe('unknown');
  });

  it('says what happened, what to do, and the disk, in plain words', () => {
    expect(spaceMessage('ok', 9 * GB, 'D:')).toBeNull();
    expect(spaceMessage('unknown', null, 'D:')).toBeNull();
    expect(spaceMessage('low', 3.3 * GB, 'D:')).toMatch(/only 3\.3 GB free.*Free some space on D:, or move old saved copies to a backup drive/);
    const critical = spaceMessage('critical', 1.4 * GB, 'D:') ?? '';
    expect(critical).toMatch(/will not start checking, matching copies or saving copies/);
    expect(critical).toMatch(/Nothing was lost/);
    expect(diskNameOf('d:\\BackupHub\\data')).toBe('D:');
  });
});

describe('the data disk', () => {
  it('reports sizes of the database, its log and the daily copies, with the free space', () => {
    const snaps = snapshotsDir(dir);
    fs.mkdirSync(snaps, { recursive: true });
    fs.writeFileSync(path.join(snaps, 'backuphub-20261101-010101.db'), Buffer.alloc(500));
    fs.writeFileSync(path.join(snaps, 'notes.txt'), 'not a copy');
    const space = new DataSpace(dir, () => 3.3 * GB);
    const info = space.info();
    expect(info.dbBytes).toBeGreaterThan(0);
    expect(info.walBytes).toBeGreaterThanOrEqual(0);
    expect(info.snapshotCount).toBe(1);
    expect(info.snapshotsBytes).toBe(500);
    expect(info).toMatchObject({ freeBytes: 3.3 * GB, level: 'low', warnBelowBytes: WARN_FREE_BYTES });
    expect(info.message).toMatch(/3\.3 GB free/);
  });

  it('refuses heavy jobs under 2 GB, never the checks or the clean-up, and says so', () => {
    const low = new DataSpace(dir, () => 1.4 * GB);
    expect(low.refusalFor('list.place')).toMatch(/^Did not start: .*1\.4 GB free/);
    expect(low.refusalFor('hash.files')).not.toBeNull();
    expect(low.refusalFor('db.integrityCheck')).toBeNull();
    expect(low.refusalFor('clean.laptop')).toBeNull();
    expect(new DataSpace(dir, () => 3 * GB).refusalFor('list.place')).toBeNull();
    expect(new DataSpace(dir, () => null).refusalFor('list.place')).toBeNull();
  });

  it('a saved copy needs about the size of the database plus the safe margin', () => {
    const size = fs.statSync(path.join(dir, DB_FILE_NAME)).size;
    expect(new DataSpace(dir, () => size + BLOCK_FREE_BYTES + 10).copyRefusal()).toBeNull();
    const refusal = new DataSpace(dir, () => BLOCK_FREE_BYTES).copyRefusal() ?? '';
    expect(refusal).toMatch(/No saved copy was made/);
    expect(refusal).toMatch(/The database itself is fine/);
  });
});

describe('refusing work when the disk is short', () => {
  it('the daily copy is not made, nothing is written, and the job ends with a warning', async () => {
    const space = new DataSpace(dir, () => 1 * GB);
    await expect(createSnapshotAsync(db, dir, new Date(), () => space.copyRefusal())).rejects.toBeInstanceOf(SnapshotRefused);
    expect(fs.existsSync(snapshotsDir(dir)) ? fs.readdirSync(snapshotsDir(dir)) : []).toEqual([]);

    const warnings: string[] = [];
    const ctx = { yield: async () => undefined, warn: (t: string) => warnings.push(t) } as unknown as JobContext;
    const handler = snapshotHandler({ db, dataDir: dir, log: silent, copyRefusal: () => space.copyRefusal() });
    expect(await handler.run(ctx)).toBe('No daily copy was made (not enough room on the disk)');
    expect(warnings[0]).toMatch(/No saved copy was made/);
  });

  it('with room, the copy is made as before', async () => {
    const space = new DataSpace(dir, () => 50 * GB);
    const result = await createSnapshotAsync(db, dir, new Date(), () => space.copyRefusal());
    expect(result.created).toBe(true);
  });

  it('a heavy job does not start under 2 GB and fails with the reason; a light one still runs', async () => {
    const service = new JobService({ db, log: silent });
    const ran: string[] = [];
    const handler = (kind: string, heavy: boolean): JobHandler => ({ kind, heavy, run: async () => void ran.push(kind) });
    service.register(handler('list.place', true));
    service.register(handler('files.classify', false));
    service.setStartGate((kind) => new DataSpace(dir, () => 1 * GB).refusalFor(kind));
    const heavy = service.create('list.place', 'List T7', {});
    const light = service.create('files.classify', 'Sort files', {});
    service.start();
    for (let i = 0; i < 200 && service.get(light)?.state !== 'done'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toEqual(['files.classify']);
    expect(service.get(heavy)).toMatchObject({ state: 'failed' });
    expect(service.get(heavy)?.error).toMatch(/Did not start: .*will not start checking/);
    service.shutdown();
  });
});
