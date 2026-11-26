import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FREEUP_GROUPS, type FreeUpRemoveFile, type FreeUpRemoveJobParams } from '../../shared/freeUp';
import { closeDatabase, initDatabase, type Db } from '../db';
import type { JobContext } from '../jobs/jobService';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { turn } from '../sliceWork';
import type { Sha256Batch } from '../adb/phoneModel';
import type { GoogleAsk } from './googleAsk';
import { FreeUpResults, freeUpCheckHandler, type FreeUpAdb, type HashFile } from './freeUpCheck';
import { freeUpConfirmed, freeUpRemoveHandler } from './freeUpRemove';
import { FreeUpService } from './freeUpService';
import { CleanupService } from '../cleanup/cleanupService';
import { hashConfirmed } from '../danger';

/**
 * The window must not freeze while Free up phone space checks, lists, keeps and removes (CLAUDE.md: every new job and call gets a block test).
 * A real database with 230,000 file rows (30,000 phone photos, each with a copy on two drives and one in Google, and 200,000 other rows),
 * the real check and removal jobs with a phone, drives and Google that answer at once; a timer on the main thread says how late it fires,
 * which is exactly what a frozen window is.
 */
const PHONE_FILES = 30_000;
const FILLER = 200_000;
const REMOVE_FILES = 3_000;
const MAX_BLOCK_MS = 250;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const nameOf = (i: number): string => `IMG_${String(i).padStart(7, '0')}.jpg`;
const folderOf = (i: number): string => `/sdcard/DCIM/Camera${i % 50}`;
const sizeOf = (i: number): number => 1000 + ((i * 37) % 5_000_000);
const shaOfName = (name: string): string => createHash('sha256').update(name).digest('hex');
const md5OfName = (name: string): string => createHash('md5').update(name).digest('hex');
const indexOfName = (name: string): number => Number(/IMG_(\d+)/.exec(name)![1]);

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

const adb: FreeUpAdb = {
  available: () => true,
  devices: () => Promise.resolve([{ serial: 'S1', model: 'POCO F4', state: 'device' as const }]),
  listFiles: () => Promise.resolve(Array.from({ length: PHONE_FILES }, (_, i) => ({ path: `${folderOf(i)}/${nameOf(i)}`, size: sizeOf(i), mtimeSec: 1_700_000_000 }))),
  sha256: (_s, p) => Promise.resolve(shaOfName(p.slice(p.lastIndexOf('/') + 1))),
  sha256Many: (_s, paths) => {
    const answers: Sha256Batch['answers'] = new Map();
    for (const p of paths) answers.set(p, { kind: 'sha256', sha256: shaOfName(p.slice(p.lastIndexOf('/') + 1)) });
    return Promise.resolve({ answers, adbError: null });
  },
  pull: () => Promise.resolve(),
  statSize: (_s, p) => Promise.resolve(removedPaths.has(p) ? null : sizeOf(indexOfName(p))),
  remove: (_s, p) => {
    removedPaths.add(p);
    return Promise.resolve();
  },
  statSizes: (_s, paths) => Promise.resolve(paths.map((p) => (removedPaths.has(p) ? null : sizeOf(indexOfName(p))))),
  removeMany: (_s, items) =>
    Promise.resolve(
      items.map((i) => {
        if (removedPaths.has(i.path)) return 'missing' as const;
        if (sizeOf(indexOfName(i.path)) !== i.size) return 'changed' as const;
        removedPaths.add(i.path);
        return 'removed' as const;
      }),
    ),
  push: () => Promise.resolve(),
  scanMedia: () => Promise.resolve(),
  killServer: () => Promise.resolve(),
};
const removedPaths = new Set<string>();
const google: GoogleAsk = {
  reachable: () => Promise.resolve(true),
  ask: (ref) => Promise.resolve({ kind: 'found' as const, md5: md5OfName(ref.name), size: sizeOf(indexOfName(ref.name)) }),
};
const hashFile: HashFile = (abs) => {
  const name = path.basename(abs);
  return Promise.resolve({ sha256: shaOfName(name), md5: md5OfName(name), bytes: sizeOf(indexOfName(name)) });
};

class TurningCtx {
  readonly warns: string[] = [];
  readonly ctx: JobContext;
  constructor(params: unknown, jobId: number) {
    this.ctx = {
      jobId,
      params,
      resume: null,
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
      warn: (t) => void this.warns.push(t),
      needsYou: () => Promise.resolve('continue'),
      checkpoint: () => {},
      yield: () => turn(),
    };
  }
}

let dir: string;
let db: Db;
const results = new FreeUpResults();
let backupId = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-freeup-block-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.pragma('wal_autocheckpoint = 0');
  const place = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES (?, 1, ?, ?, ?, ?, 1, 1)');
  place.run('ph', 'phone', 'POCO F4', '{}', 'connected');
  place.run('t7', 'drive', 'T7', '{}', 'connected');
  place.run('sea', 'drive', 'Seagate2TB', '{}', 'connected');
  place.run('g1', 'gdrive', 'Google 1', '{}', 'connected');
  place.run('other', 'drive', 'Other', '{}', 'connected');
  backupId = Number(db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (1, 'POCO F4', 'phone', 'ph', '', 'S1', 'POCO', 'size_and_date', 1)").run().lastInsertRowid);
  const dest = db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, position) VALUES (?, ?, ?, ?, ?)');
  dest.run(backupId, 't7', 'MyData/POCO', 'primary', 1);
  dest.run(backupId, 'sea', 'MyData/POCO', 'copy', 2);
  insertFakeRows(db, 'other', 'Filler', FILLER, { fingerprinted: true });
  const ins = db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_at, verified_how, ext_id) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)');
  const item = db.prepare('INSERT INTO drive_items (place_id, ext_id, parent_ext_id, name, is_folder) VALUES (?, ?, ?, ?, 0)');
  db.transaction(() => {
    for (let i = 0; i < PHONE_FILES; i += 1) {
      const name = nameOf(i);
      const sha = shaOfName(name);
      const rel = `${folderOf(i)}/${name}`;
      const id = Number(ins.run('ph', rel, sizeOf(i), 1_700_000_000_000, sha, null, null, null, null, null, null).lastInsertRowid);
      const copy = `MyData/POCO/${rel.split('/').slice(2).join('/')}`;
      ins.run('t7', copy, sizeOf(i), 1, sha, null, id, sha, 1, 'read_both', null);
      ins.run('sea', copy, sizeOf(i), 1, sha, null, id, sha, 1, 'read_both', null);
      ins.run('g1', `Backup Hub/${copy}`, sizeOf(i), null, sha, md5OfName(name), null, null, 1, 'google-md5', `gid-${i}`);
      item.run('g1', `gid-${i}`, 'fold-1', name);
    }
  })();
}, 180_000);

afterAll(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('Free up phone space does not freeze the main thread', () => {
  it('the check of 30,000 phone files (three copies each) on a 230,000-row database', async () => {
    const run = new TurningCtx({ backupId }, 51);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const message = await freeUpCheckHandler({ db, adb, baseOf: (id) => Promise.resolve(id === 't7' || id === 'sea' ? dir : null), google, results, hashFile, fileSize: (abs) => Promise.resolve(sizeOf(indexOfName(path.basename(abs)))) }).run(run.ctx);
    const ms = Math.round(performance.now() - t0);
    const block = dog.stop();
    console.log(`FREE UP CHECK: ${PHONE_FILES} files, ${ms} ms, longest block ${block} ms`);
    expect(String(message)).toMatch(/30,000 files/);
    expect(results.get(51)!.ready).toHaveLength(PHONE_FILES);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 300_000);

  it('the per-file ticks on 30,000 files: the biggest-first page, one file, a page, Untick all, Tick all, and the confirm numbers after them', async () => {
    const service = new FreeUpService({ db, results, jobs: { create: () => 78, list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    const timed: Record<string, number> = {};
    const call = async <T,>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      await turn();
      const dog = watchdog();
      const out = await fn();
      await new Promise((resolve) => setTimeout(resolve, 30));
      timed[name] = dog.stop();
      return out;
    };
    const first = await call('files first page', () => service.files({ checkId: 51, list: 'camera-photos', offset: 0 }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const group = results.get(51)!.view.groups.find((g) => g.id === 'camera-photos')!;
    expect(first.total).toBe(group.files); // ALL files of the group, in pages of 100
    expect(first.rows).toHaveLength(100);
    for (let i = 1; i < first.rows.length; i += 1) expect(first.rows[i - 1]!.size).toBeGreaterThanOrEqual(first.rows[i]!.size); // biggest first
    expect(first.rows.every((r) => r.ticked === true)).toBe(true);
    const last = await call('files last page', () => service.files({ checkId: 51, list: 'camera-photos', offset: Math.floor((first.total - 1) / 100) * 100 }));
    expect(last.ok && last.rows.length).toBeGreaterThan(0);
    const one = await call('untick one', () => service.tick({ checkId: 51, list: 'camera-photos', ticked: false, paths: [first.rows[0]!.path] }));
    expect(one).toMatchObject({ ok: true, files: group.files - 1, leftOut: 1 });
    const page = await call('untick a page', () => service.tick({ checkId: 51, list: 'camera-photos', ticked: false, paths: first.rows.map((r) => r.path) }));
    expect(page).toMatchObject({ ok: true, files: group.files - 100, leftOut: 100 });
    const prepared = await call('prepare after unticks', () => service.prepare({ checkId: 51, groups: [...FREEUP_GROUPS] }));
    expect(prepared.ok && prepared.prepare.files).toBe(PHONE_FILES - 100);
    for (const g of FREEUP_GROUPS) {
      const r = await call(`untick all ${g}`, () => service.tick({ checkId: 51, list: g, ticked: false, all: true }));
      expect(r.ok && r.files).toBe(0);
    }
    expect((await call('prepare with nothing ticked', () => service.prepare({ checkId: 51, groups: [...FREEUP_GROUPS] }))).ok).toBe(false);
    for (const g of FREEUP_GROUPS) {
      const r = await call(`tick all ${g}`, () => service.tick({ checkId: 51, list: g, ticked: true, all: true }));
      expect(r.ok && r.leftOut).toBe(0);
    }
    const again = await call('prepare after tick all', () => service.prepare({ checkId: 51, groups: [...FREEUP_GROUPS] }));
    expect(again.ok && again.prepare.files).toBe(PHONE_FILES);
    console.log(`FREE UP TICKS (longest block of each, ms): ${JSON.stringify(timed)}`);
    for (const [name, ms] of Object.entries(timed)) expect(ms, name).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('the calls the window makes on that result: overview, prepare, a page, Keep, start (each one on its own, as separate calls of the window)', async () => {
    const service = new FreeUpService({ db, results, jobs: { create: () => 77, list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    const timed: Record<string, number> = {};
    const call = async <T,>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      await turn();
      const dog = watchdog();
      const out = await fn();
      await new Promise((resolve) => setTimeout(resolve, 30)); // the watchdog reads only after one timer tick that follows a synchronous block
      timed[name] = dog.stop();
      return out;
    };
    const overview = await call('overview', () => service.overview(backupId));
    const page = await call('files', () => service.files({ checkId: 51, list: 'camera-photos', offset: 0 }));
    const prepared = await call('prepare', () => service.prepare({ checkId: 51, groups: [...FREEUP_GROUPS] }));
    const kept = await call('keep', () => service.keep({ backupId, scope: 'folder', path: '/sdcard/DCIM/Camera7' }));
    const prepared2 = await call('prepare after keep', () => service.prepare({ checkId: 51, groups: [...FREEUP_GROUPS] }));
    const started = await call('start', () => (prepared2.ok ? service.start({ checkId: 51, groups: [...FREEUP_GROUPS], hash: prepared2.prepare.hash, expectFiles: prepared2.prepare.files, expectBytes: prepared2.prepare.bytes, confirmed: true }) : null));
    if (kept.ok) service.unkeep({ backupId, id: kept.keep[0]!.id }); // the next test removes files of that folder too
    console.log(`FREE UP CALLS (longest block of each, ms): ${JSON.stringify(timed)}`);
    expect(overview.ok && page.ok && prepared.ok && kept.ok && prepared2.ok && started?.ok).toBe(true);
    expect(prepared.ok && prepared.prepare.files).toBe(PHONE_FILES);
    expect(prepared2.ok && prepared2.prepare.files).toBe(PHONE_FILES - PHONE_FILES / 50);
    for (const [name, ms] of Object.entries(timed)) expect(ms, name).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  const removalList = (from: number, count: number): FreeUpRemoveFile[] => {
    const files: FreeUpRemoveFile[] = [];
    for (let i = from; i < from + count; i += 1) {
      const name = nameOf(i);
      const copy = `MyData/POCO/${folderOf(i).split('/').slice(2).join('/')}/${name}`;
      const sha = shaOfName(name);
      const v = (placeId: string, label: string, kind: string, rel: string, md5: string | null): FreeUpRemoveFile['vouchers'][number] => ({ placeId, placeLabel: label, placeKind: kind, relPath: rel, size: sizeOf(i), sha256: sha, md5 });
      files.push({
        path: `${folderOf(i)}/${name}`,
        size: sizeOf(i),
        sha256: sha,
        kind: 'photo-camera',
        vouchers: [v('t7', 'T7', 'drive', copy, md5OfName(name)), v('sea', 'Seagate2TB', 'drive', copy, null), v('g1', 'Google', 'gdrive', `Backup Hub/${copy}`, md5OfName(name))],
        google: { placeId: 'g1', fileId: `gid-${i}`, name, parentId: 'fold-1', md5: md5OfName(name), size: sizeOf(i) },
      });
    }
    return files;
  };

  const removeWith = async (files: FreeUpRemoveFile[], removeMode: 'quick' | 'full', jobId: number): Promise<{ message: unknown; warns: string[]; block: number; ms: number }> => {
    const listId = `block-list-${removeMode}`;
    const removeResults = new FreeUpResults();
    removeResults.holdRemoval(listId, files);
    const params: FreeUpRemoveJobParams = { backupId, serial: 'S1', model: 'POCO F4', listId, listHash: hashConfirmed(freeUpConfirmed('S1', files)), count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), removeMode };
    const run = new TurningCtx(params, jobId);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const message = await freeUpRemoveHandler({ db, adb, baseOf: (id) => Promise.resolve(id === 't7' || id === 'sea' ? dir : null), google, results: removeResults, hashFile, fileSize: (abs) => Promise.resolve(sizeOf(indexOfName(path.basename(abs)))), log: silent }).run(run.ctx);
    const ms = Math.round(performance.now() - t0);
    return { message, warns: run.warns, block: dog.stop(), ms };
  };

  it('the removal of 3,000 files (three copies re-read, logged, locked, removed) on the same database', async () => {
    const r = await removeWith(removalList(0, REMOVE_FILES), 'full', 52);
    console.log(`FREE UP REMOVAL: ${REMOVE_FILES} files, ${r.ms} ms, longest block ${r.block} ms`);
    expect(String(r.message)).toMatch(/Removed 3,000 files/);
    expect(r.warns).toEqual([]);
    expect(removedPaths.size).toBe(REMOVE_FILES);
    expect(r.block).toBeLessThan(MAX_BLOCK_MS);
  }, 300_000);

  it('the quick removal of 1,000 more files (copies looked at, not read; logged, locked, removed)', async () => {
    const r = await removeWith(removalList(REMOVE_FILES, 1_000), 'quick', 53);
    console.log(`FREE UP QUICK REMOVAL: 1000 files, ${r.ms} ms, longest block ${r.block} ms`);
    expect(String(r.message)).toMatch(/Removed 1,000 files .*checked quickly/);
    expect(r.warns).toEqual([]);
    expect(removedPaths.size).toBe(REMOVE_FILES + 1_000);
    expect(r.block).toBeLessThan(MAX_BLOCK_MS);
  }, 300_000);

  it('the put-back list on a removal log of 50,000 lines: a page, the last page, Tick all, the overview count, and the put-back check of 50,000 ids', async () => {
    const LINES = 50_000;
    const insert = db.prepare('INSERT INTO removal_log (run_id, kind, place_id, device, path, size, sha256, vouchers_json, quarantine_path, removed_at) VALUES (1, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)');
    const sha = 'a'.repeat(64);
    const first = Number(db.prepare('SELECT coalesce(max(id), 0) FROM removal_log').pluck().get()) + 1;
    db.transaction(() => {
      for (let i = 0; i < LINES; i += 1) {
        const rel = `${folderOf(i).split('/').slice(2).join('/')}/${nameOf(i)}`;
        const vouchers = [
          { placeId: 't7', placeLabel: 'T7', placeKind: 'drive', relPath: `MyData/POCO/${rel}`, size: sizeOf(i), sha256: sha, md5: md5OfName(nameOf(i)) },
          { placeId: 'sea', placeLabel: 'Seagate2TB', placeKind: 'drive', relPath: `MyData/POCO/${rel}`, size: sizeOf(i), sha256: sha, md5: null },
          { placeId: 'g1', placeLabel: 'Google', placeKind: 'gdrive', relPath: `Backup Hub/MyData/POCO/${rel}`, size: sizeOf(i), sha256: sha, md5: md5OfName(nameOf(i)) },
        ];
        insert.run('phone', 'POCO F4', `${folderOf(i)}/${nameOf(i)}`, sizeOf(i), sha, JSON.stringify(vouchers), 1_700_000_000_000 + i);
      }
    })();
    const service = new FreeUpService({ db, results, jobs: { create: () => 78, list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    const cleanup = new CleanupService({ db, phone: {} as never, laptop: {} as never, jobs: { create: () => 79, list: () => [] } });
    const timed: Record<string, number> = {};
    const call = async <T,>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      await turn();
      const dog = watchdog();
      const out = await fn();
      await new Promise((resolve) => setTimeout(resolve, 30));
      timed[name] = dog.stop();
      return out;
    };
    const page = await call('removedPage first', () => service.removedPage({ backupId, offset: 0, limit: 100 }));
    const deep = await call('removedPage last', () => service.removedPage({ backupId, offset: 49_900, limit: 100 }));
    const ids = await call('removedIds', () => service.removedIds({ backupId }));
    const overview = await call('overview', () => service.overview(backupId));
    const putBack = await call('putBack 50,000 ids', () => cleanup.putBack({ serial: 'S1', removalIds: Array.from({ length: LINES }, (_, i) => first + i), confirmed: true }));
    console.log(`FREE UP PUT-BACK LIST on ${LINES} log lines (longest block of each, ms): ${JSON.stringify(timed)}`);
    expect(page.ok && page.total >= LINES).toBe(true);
    expect(page.ok && page.rows).toHaveLength(100);
    expect(deep.ok && deep.rows.length).toBeGreaterThan(0);
    expect(ids.ok && ids.ids.length).toBe(LINES);
    expect(overview.ok && overview.removedTotal.files).toBeGreaterThanOrEqual(LINES);
    expect(putBack).toEqual({ ok: true, jobId: 79 });
    for (const [name, ms] of Object.entries(timed)) expect(ms, name).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);
});
