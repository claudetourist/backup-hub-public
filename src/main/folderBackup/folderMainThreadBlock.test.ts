import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobService } from '../jobs/jobService';
import { inlineQuickWalkRunner } from '../listing/quickWalkRunner';
import { normalizeRoot } from '../listing/roots';
import { FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { fakeMirrorDrive } from '../look/harness/mirrorWorld.testutil';
import { listCsvSteps } from '../phoneBackup/runCsv';
import { finishSliced, turn } from '../sliceWork';
import { listRowsSteps } from '../mirror/mirrorStore';
import { FolderBackupService } from './folderBackupService';
import { planFolderBackup } from './folderPlan';
import { realSourceFor } from './folderSource';
import type { FolderBackupDeps } from './folderTypes';

/**
 * The window must not freeze while a folder backup is looked at, planned or confirmed (CLAUDE.md: every new IPC call gets a main-thread block test, limit
 * 250 ms). A REAL folder of 100,000 files is walked by the real look; the real plan compares it with 100,000 copies the index already holds on the drive
 * (all of them older versions, so all 100,000 are to copy), names them, and the confirm and the list at the end run on it; a timer on the main thread says
 * how late it fires. The real numbers are printed.
 */
const FILES = Number(process.env['FOLDER_BLOCK_FILES'] ?? 100_000);
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
let source: string;
let backupId: number;
const rel = (i: number): string => `d${i % 500}/f${i % 200}/file_${String(i).padStart(6, '0')}.bin`;

beforeAll(async () => {
  rig = makeRig();
  w = new World(rig, { seed: 91, drives: [{ caseInsensitive: true }] });
  rig.db.pragma('wal_autocheckpoint = 0');
  source = normalizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-folder-big-')));
  for (let i = 0; i < 1000; i += 1) fs.mkdirSync(path.dirname(path.join(source, ...rel(i).split('/'))), { recursive: true });
  // In slices with a turn between them: a long synchronous loop starves the test runner's own messages (it then reports a timeout).
  for (let i = 0; i < FILES; i += 1) {
    fs.writeFileSync(path.join(source, ...rel(i).split('/')), '');
    if (i % 500 === 499) await turn();
  }
  rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('laptop-big', 1, 'laptop', 'Laptop', '{}', 1)").run();
  backupId = Number(rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (1, 'Big folder', 'folder', ?, 'Big', 'size_or_date', 1)").run(source).lastInsertRowid);
  rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(backupId, w.destinations[0]!.placeId, 'MyData/BigBackup', 'primary');
  // The drive already holds 100,000 older copies (another date: so each file is "changed"), as the old tool's index import leaves them.
  const insert = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, expected_sha256, verified_how, first_seen_at, last_seen_at, kind) VALUES (?, ?, 0, 1000000, NULL, NULL, 'imported', 1, 1, 'other')");
  rig.db.transaction(() => {
    for (let i = 0; i < FILES; i += 1) insert.run(w.destinations[0]!.placeId, `MyData/BigBackup/Big-05Jul26/${rel(i)}`);
  })();
}, 600_000);
afterAll(async () => {
  w.dispose();
  rig.close();
  await fs.promises.rm(source, { recursive: true, force: true, maxRetries: 3 });
}, 300_000);

describe('a folder backup never freezes the window', () => {
  it('the real look of a real folder of 100,000 files, the plan, the confirm and the list at the end', async () => {
    const placeId = w.destinations[0]!.placeId;
    const quickRunner = inlineQuickWalkRunner(rig.db);
    const t7 = fakeMirrorDrive(w, 0, 'T7', () => undefined);
    const real = realSourceFor({ db: rig.db, quickRunner });
    const deps: FolderBackupDeps = {
      db: rig.db,
      log: { info: () => undefined, warn: () => undefined },
      driveFor: async () => ({ drive: { ...t7, look: async () => ({ complete: true, rootMissing: false, message: null }) }, label: 'T7' }),
      sourceFor: real,
    };
    await turn();

    // The real look on the real folder (the listing's own full walk, here on this thread: the worst case).
    const found = await real({ id: backupId, name: 'Big folder', sourceRoot: source, importKey: null, folderPrefix: 'Big' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    let dog = watchdog();
    let t0 = performance.now();
    const seen = await found.source.look({ signal: new AbortController().signal, progress: () => undefined });
    const lookMs = Math.round(performance.now() - t0);
    const lookBlock = dog.stop();
    expect(seen.complete).toBe(true);
    console.log(`[folder real look] ${FILES.toLocaleString('en-US')} files on disk, ${lookMs} ms in all, longest block ${lookBlock} ms`);
    expect(lookBlock).toBeLessThan(MAX_BLOCK_MS);
    expect(rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NULL').pluck().get('laptop-big')).toBe(FILES);

    // The plan: the folder was just looked at (its rows are in the file list), so the plan's own look is the instant one here; the drive's side is looked at the same way.
    dog = watchdog();
    t0 = performance.now();
    const planDeps: FolderBackupDeps = { ...deps, sourceFor: async () => ({ ok: true, source: { ...found.source, look: async () => ({ complete: true, rootMissing: false, message: null }) } }) };
    const outcome = await planFolderBackup(planDeps, { backupId }, new TurningCtx());
    const planMs = Math.round(performance.now() - t0);
    const planBlock = dog.stop();
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok || outcome.stored === null) return;
    expect(outcome.result.plan.totals.files).toBe(FILES);
    expect(outcome.result.plan.rows.every((r) => r.kind === 'changed')).toBe(true);
    console.log(`[folder plan] ${FILES.toLocaleString('en-US')} files, compare and name, ${planMs} ms in all, longest block ${planBlock} ms`);
    expect(planBlock).toBeLessThan(MAX_BLOCK_MS);

    // Confirm, through the service (the same steps the window's click runs, sliced).
    const jobs = new JobService({ db: rig.db });
    const service = new FolderBackupService({ ...deps, pluggedPlaces: async () => new Set([placeId]) }, jobs);
    (service as unknown as { plans: Map<string, unknown> }).plans.set(outcome.stored.planId, outcome.stored);
    dog = watchdog();
    t0 = performance.now();
    const started = await service.confirmSliced({ planId: outcome.stored.planId, hash: outcome.stored.hash, unticked: [], untickedFolders: [], included: [] });
    const confirmBlock = dog.stop();
    expect(started.ok).toBe(true);
    console.log(`[folder confirm] ${Math.round(performance.now() - t0)} ms in all, longest block ${confirmBlock} ms`);
    expect(confirmBlock).toBeLessThan(MAX_BLOCK_MS);

    // The cards (the Backups screen asks for them whenever it opens).
    dog = watchdog();
    const cards = await service.cards();
    expect(cards.cards).toHaveLength(1);
    expect(dog.stop()).toBeLessThan(MAX_BLOCK_MS);

    // The list written at the end of a run, and the "Show all copied files" answer.
    const runId = Number(rig.db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, folder, started_at, state) VALUES (?, ?, 'MyData/BigBackup', 1, 'running')").run(backupId, placeId).lastInsertRowid);
    rig.db.prepare("UPDATE files SET backup_run_id = ? WHERE place_id = ? AND rel_path LIKE 'MyData/BigBackup/Big-05Jul26/%'").run(runId, placeId);
    dog = watchdog();
    t0 = performance.now();
    const rows = await finishSliced(listRowsSteps(rig.db, runId), turn);
    const csv = await finishSliced(listCsvSteps(rows), turn);
    const listBlock = dog.stop();
    expect(rows).toHaveLength(FILES);
    expect(csv.length).toBeGreaterThan(1000);
    console.log(`[folder list] ${Math.round(performance.now() - t0)} ms in all, longest block ${listBlock} ms`);
    expect(listBlock).toBeLessThan(MAX_BLOCK_MS);
  }, 900_000);
});
