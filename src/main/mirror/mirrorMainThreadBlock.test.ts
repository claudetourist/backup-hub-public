import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { JobService } from '../jobs/jobService';
import { listCsvSteps } from '../phoneBackup/runCsv';
import { finishSliced, turn } from '../sliceWork';
import { realMirrorDrive } from './mirrorDrive';
import { planMirror } from './mirrorLook';
import { pairOf } from './mirrorPairs';
import { behindSteps } from './mirrorScan';
import { MirrorService } from './mirrorService';
import { CHECK_TX_ROWS } from './mirrorCheckRun';
import { listRowsSteps, recordCheckedBatch, type CheckedLink } from './mirrorStore';
import type { MirrorDeps } from './mirrorTypes';

/**
 * The window must not freeze while the second drive is looked at (CLAUDE.md: every new IPC call gets a main-thread block test, limit 250 ms).
 * A backup folder of 60,000 files on the T7 with 40,000 of them already on the Seagate, in the index; the REAL plan, the counts, the confirm and the
 * list written at the end run on it; a timer on the main thread says how late it fires. Then the real look (the listing's quick look) on a REAL folder
 * of 60,000 files. The real numbers are printed.
 */
const FILES = 60_000;
const ON_SEAGATE = 40_000;
const MAX_BLOCK_MS = 250;

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

class TurningCtx extends FakeCtx {
  override async yield(): Promise<void> {
    await turn();
  }
}

let rig: Rig;
let w: World;
const place = (i: number): string => w.destinations[i]!.placeId;
const relOf = (i: number): string => `MyData/POCO/Poco-F4-24Nov26/DCIM/Camera${i % 60}/IMG_${String(i).padStart(6, '0')}.jpg`;

beforeAll(() => {
  rig = makeRig();
  w = new World(rig, { seed: 9, drives: [{ caseInsensitive: true }, { caseInsensitive: true }] });
  rig.db.pragma('wal_autocheckpoint = 0');
  const insert = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, expected_sha256, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'photos')");
  rig.db.transaction(() => {
    for (let i = 0; i < FILES; i += 1) {
      const sha = i % 3 === 0 ? null : `${i}`.padStart(64, '0');
      insert.run(place(0), relOf(i), 1000 + ((i * 37) % 5_000_000), 1_700_000_000_000 + i, sha, i % 2 === 0 ? sha : null);
      if (i < ON_SEAGATE) insert.run(place(1), relOf(i), 1000 + ((i * 37) % 5_000_000), 1_700_000_000_000 + i, sha, null);
    }
  })();
});
afterAll(() => {
  w.dispose();
  rig.close();
});

describe('the second drive never freezes the window', () => {
  it('the plan, the counts, the confirm and the list on a 60,000-file folder', async () => {
    const pair = pairOf(rig.db, w.profileId)!;
    const fakeSide = (i: number) => ({ placeId: place(i), label: i === 0 ? 'T7' : 'Seagate2TB', look: async () => ({ complete: true, rootMissing: false, message: null }), freeBytes: () => null, finalPath: (r: string) => r }) as never;
    const deps: MirrorDeps = {
      db: rig.db,
      log: { info: () => undefined, warn: () => undefined },
      drivesFor: async () => ({ src: fakeSide(0), dst: fakeSide(1) }),
    };
    await turn();
    let dog = watchdog();
    let t0 = performance.now();
    const outcome = await planMirror(deps, { backupIds: [w.profileId] }, new TurningCtx());
    const planMs = Math.round(performance.now() - t0);
    const planBlock = dog.stop();
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok || outcome.stored === null) return;
    expect(outcome.result.plan.totals.files).toBe(FILES - ON_SEAGATE);
    expect(outcome.result.plan.toCheck.files).toBe(ON_SEAGATE);
    console.log(`[mirror plan] 60,000 files, ${planMs} ms in all, longest block ${planBlock} ms`);
    expect(planBlock).toBeLessThan(MAX_BLOCK_MS);

    dog = watchdog();
    t0 = performance.now();
    const behind = await finishSliced(behindSteps(rig.db, pair), turn);
    const behindBlock = dog.stop();
    expect(behind.files).toBe(FILES - ON_SEAGATE);
    console.log(`[mirror counts] ${Math.round(performance.now() - t0)} ms in all, longest block ${behindBlock} ms`);
    expect(behindBlock).toBeLessThan(MAX_BLOCK_MS);

    // Confirm, through the service (the same steps the window's click runs, sliced).
    const jobs = new JobService({ db: rig.db });
    const service = new MirrorService(deps, jobs);
    (service as unknown as { plans: Map<string, unknown> }).plans.set(outcome.stored.planId, outcome.stored);
    dog = watchdog();
    t0 = performance.now();
    const started = await service.confirmSliced({ planId: outcome.stored.planId, hash: outcome.stored.hash, unticked: [] });
    const confirmBlock = dog.stop();
    expect(started.ok).toBe(true);
    console.log(`[mirror confirm] ${Math.round(performance.now() - t0)} ms in all, longest block ${confirmBlock} ms`);
    expect(confirmBlock).toBeLessThan(MAX_BLOCK_MS);

    // The list written at the end of a run.
    const runId = Number(rig.db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, folder, started_at, state) VALUES (?, ?, 'MyData/POCO', 1, 'running')").run(w.profileId, place(1)).lastInsertRowid);
    rig.db.prepare('UPDATE files SET backup_run_id = ? WHERE place_id = ?').run(runId, place(1));
    dog = watchdog();
    t0 = performance.now();
    const rows = await finishSliced(listRowsSteps(rig.db, runId), turn);
    const csv = await finishSliced(listCsvSteps(rows), turn);
    const listBlock = dog.stop();
    expect(rows).toHaveLength(ON_SEAGATE);
    expect(csv.length).toBeGreaterThan(1000);
    console.log(`[mirror list] ${Math.round(performance.now() - t0)} ms in all, longest block ${listBlock} ms`);
    expect(listBlock).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('"Check old copies": the list (40,000 same-size files), its start and the index batches on a 60,000-file folder', async () => {
    const fakeSide = (i: number) => ({ placeId: place(i), label: i === 0 ? 'T7' : 'Seagate2TB', finalPath: (r: string) => r }) as never;
    const deps: MirrorDeps = { db: rig.db, log: { info: () => undefined, warn: () => undefined }, drivesFor: async () => ({ src: fakeSide(0), dst: fakeSide(1) }) };
    const created: unknown[] = [];
    const service = new MirrorService(deps, { create: (...args) => created.push(args), list: () => [] });
    await turn();
    let dog = watchdog();
    let t0 = performance.now();
    const list = await service.checkPreview(w.profileId);
    const listBlock = dog.stop();
    expect(list.ok && list.plan.totals.files).toBe(ON_SEAGATE);
    console.log(`[mirror check list] 40,000 files, ${Math.round(performance.now() - t0)} ms in all, longest block ${listBlock} ms`);
    expect(listBlock).toBeLessThan(MAX_BLOCK_MS);
    if (!list.ok) return;
    expect(list.plan.oneRead.files + list.plan.twoReads.files).toBe(ON_SEAGATE);

    dog = watchdog();
    t0 = performance.now();
    const started = await service.checkStart({ planId: list.plan.planId, hash: list.plan.hash });
    const startBlock = dog.stop();
    expect(started.ok).toBe(true);
    console.log(`[mirror check start] ${Math.round(performance.now() - t0)} ms in all, longest block ${startBlock} ms`);
    expect(startBlock).toBeLessThan(MAX_BLOCK_MS);

    // The index is written in transactions of CHECK_TX_ROWS rows with a turn between them.
    const links: CheckedLink[] = [];
    for (let i = 0; i < 500; i += 1) links.push({ dstPlaceId: place(1), dstRel: relOf(i), size: 1000 + ((i * 37) % 5_000_000), mtimeMs: 1_700_000_000_000 + i, sha256: `${i}`.padStart(64, 'a'), originId: null, srcRowId: 1, srcRead: false, now: 5 });
    dog = watchdog();
    t0 = performance.now();
    for (let at = 0; at < links.length; at += CHECK_TX_ROWS) {
      recordCheckedBatch(rig.db, links.slice(at, at + CHECK_TX_ROWS), []);
      await turn();
    }
    const batchBlock = dog.stop();
    console.log(`[mirror check batch] 500 rows in ${Math.round(performance.now() - t0)} ms (transactions of ${CHECK_TX_ROWS}), longest block ${batchBlock} ms`);
    expect(batchBlock).toBeLessThan(MAX_BLOCK_MS);
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(place(1))).toBe(500);
  }, 120_000);

  it('the real look (the listing quick look) of a real folder of 60,000 files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-mirror-big-'));
    try {
      for (let d = 0; d < 600; d += 1) {
        const dir = path.join(root, 'MyData', 'POCO', `Poco-${d % 5}`, `f${d}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 100; i += 1) fs.writeFileSync(path.join(dir, `IMG_${i}.jpg`), '');
      }
      const drive = realMirrorDrive({ db: rig.db, placeId: place(0), label: 'T7', root });
      await turn();
      const dog = watchdog();
      const t0 = performance.now();
      const seen = await drive.look('MyData/POCO', { signal: new AbortController().signal, progress: () => undefined });
      const ms = Math.round(performance.now() - t0);
      const block = dog.stop();
      expect(seen.complete).toBe(true);
      console.log(`[mirror real look] 60,000 files on disk, ${ms} ms in all, longest block ${block} ms`);
      expect(block).toBeLessThan(MAX_BLOCK_MS);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
