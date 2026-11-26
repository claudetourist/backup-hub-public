import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ShellRunner } from '../adb/phoneLook';
import { LIST_END_MARKER } from '../adb/phoneModel';
import { FakeCtx, ProductWorld } from '../look/harness/phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { turn } from '../sliceWork';
import { finishSliced } from '../sliceWork';
import type { JobContext } from '../jobs/jobService';
import { planPhoneBackup } from './planJob';
import { PhoneBackupService } from './phoneBackupService';
import { listCsv, listCsvSteps } from './runCsv';
import { checkOldCountsOf } from './checkOld';
import { checkOldCountsInWorker } from '../query/queryService';
import { loadConfirmed, loadConfirmedSteps, runListRows, runListRowsSteps } from './runStore';

/**
 * The window must not freeze while a big phone is looked at (first real backup of a second phone: 51,645 files, the whole app hung for
 * about 37 seconds). The REAL look and plan run on a generated phone of 60,000 files and a database that already holds a 6,828-file backup
 * folder; a timer on the main thread says how late it fires, which is exactly what a frozen window is.
 */
const FILES = 60_000;
const LOOSE_ROWS = 6_828;
/** The limit of the test: the real number is printed and is far lower; the margin is for a busy machine. */
const MAX_BLOCK_MS = 250;
/** Confirm and the start of the copy keep to the stricter limit of the brief (before: 0.2 to 0.5 s for 60,000 rows). */
const MAX_CONFIRM_BLOCK_MS = 100;
const T = 1_700_000_000;

const pathOf = (i: number): string => `/sdcard/DCIM/Camera${i % 60}/IMG_${String(i).padStart(6, '0')}.jpg`;
const sizeOf = (i: number): number => 1000 + ((i * 37) % 5_000_000);

/** The text a phone's listing command prints (the real format), with a few hundred files in folders that hold a .nomedia file. */
function listingText(changes: { editedFrom?: number; gone?: number; extra?: number } = {}): string {
  let out = '';
  const gone = changes.gone ?? 0;
  for (let i = gone; i < FILES; i += 1) {
    const edited = changes.editedFrom !== undefined && i >= changes.editedFrom && i < changes.editedFrom + 100;
    out += `${sizeOf(i) + (edited ? 1 : 0)}|${T + i + (edited ? 99_999 : 0)}.000000000|${pathOf(i)}\n`;
  }
  for (let k = 0; k < 40; k += 1) {
    out += `0|${T}.000000000|/sdcard/Pictures/Hidden${k}/.nomedia\n`;
    for (let j = 0; j < 20; j += 1) out += `${100 + j}|${T + j}.000000000|/sdcard/Pictures/Hidden${k}/p${j}.jpg\n`;
  }
  for (let i = 0; i < (changes.extra ?? 0); i += 1) out += `${5000 + i}|${T + 5_000_000 + i}.000000000|/sdcard/DCIM/New/N_${i}.jpg\n`;
  const lines = out.split('\n').length - 1;
  return out + `${LIST_END_MARKER}|0|${lines}\n`;
}

/**
 * Records the longest time the main thread did not get back to its timers. A pause in which this process was not even given the CPU (a busy
 * machine: other test files, a real backup running) is not a block of ours, so a gap counts as the smaller of the wall time and the CPU
 * time the process used in it: work that really ran without a turn has both.
 */
function watchdog(intervalMs = 10): { stop(): number } {
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000;
    max = Math.max(max, Math.min(now - last - intervalMs, cpuMs));
    last = now;
    lastCpu = cpu;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(0, Math.round(max));
    },
  };
}

/** The job's own `yield` gives the event loop a real turn (the plain FakeCtx one does not). */
class TurningCtx extends FakeCtx {
  override async yield(): Promise<void> {
    await turn();
  }
}

let rig: Rig;
let w: World;
let pw: ProductWorld;
let listing = '';

beforeAll(() => {
  rig = makeRig();
  w = new World(rig, { seed: 7, drives: [{ caseInsensitive: true }] });
  pw = new ProductWorld(w);
  // As in the app: the main connection never folds the write-ahead log back itself (the worker thread does, see walKeeper.ts).
  rig.db.pragma('wal_autocheckpoint = 0');
  const run: ShellRunner = async () => ({ exitCode: 0, stdout: listing, stderr: '' });
  pw.adb.listRunner = () => run;
  // The backup folder on the drive holds 6,828 files an older tool copied (no phone row behind them); 300 of them look like phone files.
  const place = w.destinations[0]!.placeId;
  const insert = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, ?, 1, 1, 'photos')");
  rig.db.transaction(() => {
    for (let i = 0; i < LOOSE_ROWS; i += 1) {
      const like = i < 300 ? i * 150 : null;
      insert.run(place, `MyData/POCO/old/${like === null ? `other_${i}.jpg` : `IMG_${String(like).padStart(6, '0')}.jpg`}`, like === null ? 7 + i : sizeOf(like), (T + i) * 1000);
    }
  })();
});

afterAll(() => {
  w.dispose();
  rig.close();
});

async function plan(): Promise<{ ok: boolean; items: number; block: number; ms: number }> {
  const ctx = new TurningCtx();
  await turn();
  const dog = watchdog();
  const t0 = performance.now();
  const outcome = await planPhoneBackup(pw.deps, { backupId: w.profileId }, ctx);
  const ms = Math.round(performance.now() - t0);
  const block = dog.stop();
  return { ok: outcome.result.ok, items: outcome.stored?.items.length ?? 0, block, ms };
}

describe('a look at a phone of 60,000 files does not freeze the main thread', () => {
  it('first look (every file new): the longest block is far under a quarter of a second, and everything is recorded', async () => {
    listing = listingText();
    const r = await plan();
    console.log(`FIRST LOOK: longest block ${r.block} ms, whole look and plan ${r.ms} ms, ${r.items} files to copy`);
    expect(r.ok).toBe(true);
    expect(r.items).toBeGreaterThan(FILES - 1000);
    expect(rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NULL').pluck().get(w.placeId)).toBe(FILES + 840);
    expect(r.block).toBeLessThan(MAX_BLOCK_MS);
  }, 180_000);

  it('second look (60,000 rows already known, some changed, new and gone): same limit', async () => {
    listing = listingText({ editedFrom: 1000, gone: 100, extra: 100 });
    const r = await plan();
    console.log(`SECOND LOOK: longest block ${r.block} ms, whole look and plan ${r.ms} ms, ${r.items} files to copy`);
    expect(r.ok).toBe(true);
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NOT NULL AND gone_reason = 'gone_from_source'").pluck().get(w.placeId)).toBe(100);
    expect(r.block).toBeLessThan(MAX_BLOCK_MS);
  }, 180_000);

  it('Confirm for 60,000 files (saving what was confirmed) and the start of the copy (reading it back): each far under a tenth of a second, same content as the one-go version', async () => {
    listing = listingText({ editedFrom: 1000, gone: 100, extra: 100 });
    const created: { title: string }[] = [];
    const service = new PhoneBackupService(pw.deps, { create: (_kind, title) => created.push({ title }), list: () => [] });
    const lookCtx = Object.assign(new TurningCtx(), { jobId: 1, params: { backupId: w.profileId }, resume: null }) as unknown as JobContext;
    await service.handlers()[0]!.run(lookCtx);
    // The look handler keeps its plan in the service (as in the app); it is found there, the window would have its id and hash from the preview.
    const held = [...(service as unknown as { plans: Map<string, { planId: string; hash: string; items: unknown[] }> }).plans.values()].at(-1)!;
    expect(held.items.length).toBeGreaterThan(FILES - 1000);

    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const started = await service.confirmSliced({ planId: held.planId, hash: held.hash, unticked: ['/sdcard/DCIM/Camera20/IMG_000500.jpg'], untickedFolders: [], included: [] });
    const confirmMs = Math.round(performance.now() - t0);
    const confirmBlock = dog.stop();
    expect(started.ok).toBe(true);
    expect(created[0]!.title).toMatch(/^Back up Backup \S+ now \(/);

    await turn();
    const dog2 = watchdog();
    const loaded = await finishSliced(loadConfirmedSteps(rig.db, held.planId), turn);
    const loadBlock = dog2.stop();
    console.log(`CONFIRM: longest block ${confirmBlock} ms (whole confirm ${confirmMs} ms); READ BACK: longest block ${loadBlock} ms, ${loaded?.items.length} files`);
    expect(loaded?.items.length).toBe(held.items.length - 1);
    expect(loaded?.items.some((i) => i.path === '/sdcard/DCIM/Camera20/IMG_000500.jpg')).toBe(false);
    // The one-go reader gives the same run as the sliced one.
    expect(loadConfirmed(rig.db, held.planId)).toEqual(loaded);
    expect(confirmBlock).toBeLessThan(MAX_CONFIRM_BLOCK_MS);
    expect(loadBlock).toBeLessThan(MAX_CONFIRM_BLOCK_MS);
  }, 180_000);

  it('the list written at the end of a run of 60,000 copied files: same limit, same list as the one-go version', async () => {
    // Make the rows a finished run would have made: one copy row on the drive for every phone row, all of run 1.
    const place = w.destinations[0]!.placeId;
    rig.db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, folder, started_at, state) VALUES (?, ?, 'f', 1, 'running')").run(w.profileId, place);
    const runId = rig.db.prepare('SELECT max(id) FROM backup_runs').pluck().get() as number;
    rig.db
      .prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind, origin_file_id, backup_run_id, sha256) SELECT ?, 'MyData/POCO/run/' || rel_path, size, mtime, 1, 1, 'photos', id, ?, 'ab' FROM files WHERE place_id = ? AND gone_at IS NULL")
      .run(place, runId, w.placeId);
    const pause = (): Promise<void> => turn();
    await turn();
    const dog = watchdog();
    const rows = await finishSliced(runListRowsSteps(rig.db, runId), pause);
    const text = await finishSliced(listCsvSteps(rows), pause);
    const block = dog.stop();
    console.log(`END LIST: longest block ${block} ms, ${rows.length} rows`);
    expect(rows).toEqual(runListRows(rig.db, runId));
    expect(text).toBe(listCsv(rows));
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 180_000);
});

/**
 * The Backups screen asks for the counts of "Check old copies" every time it opens. On the real database (1.6 GB) that read 203,335 copy rows
 * and classified ~50,000 phone files on the main thread: 8.3 s with the window frozen. Now the count runs on a worker thread, and without one
 * in slices. A generated catalog of the same size: 50,000 phone rows, 203,000 copy rows on the drive.
 */
describe('the counts of "Check old copies" on a catalog of 200,000 copies do not freeze the main thread', () => {
  const PHONE_ROWS = 50_000;
  const COPY_ROWS = 203_000;
  let bigRig: Rig;
  let bigWorld: World;
  let bigPw: ProductWorld;
  let outDir: string;
  let workerPath: string;

  beforeAll(async () => {
    bigRig = makeRig();
    bigWorld = new World(bigRig, { seed: 9, drives: [{ caseInsensitive: true }] });
    bigPw = new ProductWorld(bigWorld);
    bigRig.db.pragma('wal_autocheckpoint = 0');
    const phone = bigWorld.placeId;
    const drive = bigWorld.destinations[0]!.placeId;
    const insertPhone = bigRig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, ?, 1, 1, 'photos')");
    const insertCopy = bigRig.db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how, sha256) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)');
    const hows = [null, 'imported', 'name_size', 'read_both'];
    bigRig.db.transaction(() => {
      for (let i = 0; i < PHONE_ROWS; i += 1) {
        const rel = `sdcard/DCIM/Camera${i % 60}/IMG_${String(i).padStart(6, '0')}.jpg`;
        const id = Number(insertPhone.run(phone, rel, sizeOf(i), (T + i) * 1000).lastInsertRowid);
        // About four copies of every phone file (older runs of the old tool), as on the real drive.
        for (let c = 0; c * PHONE_ROWS + i < COPY_ROWS; c += 1) insertCopy.run(drive, `MyData/POCO/old${c}/${rel}`, sizeOf(i), (T + i) * 1000, id, hows[(i + c) % hows.length]!, c === 0 ? 'ab' : null);
      }
    })();
    // The query worker, built the way Forge does.
    outDir = path.join(process.cwd(), 'node_modules', '.cache', 'counts-block-test');
    fs.rmSync(outDir, { recursive: true, force: true });
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        ssr: path.join(__dirname, '..', 'query', 'queryWorker.ts'),
        rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'queryWorker.js' } },
      },
    });
    workerPath = path.join(outDir, 'queryWorker.js');
  }, 180_000);

  afterAll(() => {
    bigWorld.dispose();
    bigRig.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  const idle = { create: () => 1, list: () => [] };

  it('all in one go (what the main thread did before): the block this fixes', () => {
    const t0 = performance.now();
    const counts = checkOldCountsOf(bigRig.db, bigWorld.profileId);
    console.log(`COUNTS ALL AT ONCE (before the fix, a main-thread block): ${Math.round(performance.now() - t0)} ms`);
    expect(counts.ok && counts.total.onPhone.files).toBe(PHONE_ROWS);
  }, 120_000);

  it('on a worker thread: the main thread is never held, and the numbers are the same', async () => {
    const service = new PhoneBackupService({ ...bigPw.deps, countsInWorker: (id) => checkOldCountsInWorker(workerPath, path.join(bigRig.dir, 'test.db'), id) }, idle);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const counts = await service.checkOldCounts(bigWorld.profileId);
    const ms = Math.round(performance.now() - t0);
    const block = dog.stop();
    console.log(`COUNTS IN WORKER: longest block ${block} ms (whole count ${ms} ms)`);
    expect(counts).toEqual(checkOldCountsOf(bigRig.db, bigWorld.profileId));
    expect(block).toBeLessThan(MAX_BLOCK_MS);
    // Asked again: the last answer comes back at once.
    const t1 = performance.now();
    expect(await service.checkOldCounts(bigWorld.profileId)).toEqual(counts);
    expect(performance.now() - t1).toBeLessThan(20);
  }, 180_000);

  it('no worker can start: counted on the main thread in slices, longest block under the limit, same numbers', async () => {
    const service = new PhoneBackupService({ ...bigPw.deps, countsInWorker: () => Promise.resolve(null) }, idle);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const counts = await service.checkOldCounts(bigWorld.profileId);
    const ms = Math.round(performance.now() - t0);
    const block = dog.stop();
    console.log(`COUNTS SLICED ON MAIN: longest block ${block} ms (whole count ${ms} ms)`);
    expect(counts).toEqual(checkOldCountsOf(bigRig.db, bigWorld.profileId));
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 180_000);
});
