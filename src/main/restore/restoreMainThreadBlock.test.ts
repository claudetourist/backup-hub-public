import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { insertFakeRows } from '../bigCatalog.testUtil';
import type { JobContext } from '../jobs/jobService';
import { turn } from '../sliceWork';
import { COPY_SQL } from './restoreIndex';
import { restoreHandler, type RestoreJobParams } from './restoreJob';
import { RestoreService } from './restoreService';

/**
 * The window must not freeze while "Get files back" lists days and folders, makes the list, looks for copies and runs (CLAUDE.md: every new call gets a block test).
 * A real database with 100,000 files of one backup on the T7 and the Seagate (20 dated folders of 5,000 files), 30,000 of them also in Google, and 200,000 other rows.
 * A timer on the main thread says how late it fires, which is what a frozen window is.
 */
const DAYS = 20;
const PER_DAY = 5000;
const FILLER = 200_000;
const GOOGLE_FILES = 30_000;
const REAL_FILES = 150;
const MAX_BLOCK_MS = 250;
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const dayName = (d: number): string => `POCO-${String(d + 1).padStart(2, '0')}Nov26`;
const nameOf = (i: number): string => `IMG_${String(i).padStart(6, '0')}.jpg`;
const folderOf = (i: number): string => `DCIM/Camera${i % 25}`;

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

let dir: string;
let db: Db;
let backupId = 0;
let plugged = true;
const REAL_DAY = 'POCO-25Nov26';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-restore-block-'));
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
  const ins = db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, expected_sha256, verified_at, verified_how, ext_id) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let d = 0; d < DAYS; d += 1) {
      for (let k = 0; k < PER_DAY; k += 1) {
        const i = d * PER_DAY + k;
        const name = nameOf(i);
        const below = `${dayName(d)}/${folderOf(i)}/${name}`;
        const hash = sha(name);
        const size = 1000 + (i % 5000);
        ins.run('t7', `MyData/POCO/${below}`, size, 1_700_000_000_000, hash, null, hash, 1, 'read_both', null);
        ins.run('sea', `MyData/POCO/${below}`, size, 1_700_000_000_000, hash, null, hash, 1, 'read_both', null);
        if (i < GOOGLE_FILES) ins.run('g1', `My Drive/Backup Hub/POCO F4/${folderOf(i)}/${name}`, size, null, hash, null, null, 1, 'google-md5', `gid-${i}`);
      }
    }
  })();
  // A small day whose files are really on the T7, for the job itself.
  const root = path.join(dir, 'T7', 'MyData', 'POCO', REAL_DAY, 'DCIM');
  fs.mkdirSync(root, { recursive: true });
  db.transaction(() => {
    for (let i = 0; i < REAL_FILES; i += 1) {
      const body = Buffer.from(`real file ${i}`.repeat(20));
      fs.writeFileSync(path.join(root, `r${i}.txt`), body);
      const hash = createHash('sha256').update(body).digest('hex');
      ins.run('t7', `MyData/POCO/${REAL_DAY}/DCIM/r${i}.txt`, body.length, 1_700_000_000_000, hash, null, hash, 1, 'read_both', null);
    }
  })();
}, 300_000);

afterAll(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

function service(): RestoreService {
  const roots = (): { placeId: string; label: string; root: string }[] => (plugged ? [{ placeId: 't7', label: 'T7', root: path.join(dir, 'T7') }, { placeId: 'sea', label: 'Seagate2TB', root: path.join(dir, 'Sea') }] : []);
  return new RestoreService({
    db,
    jobs: { create: () => 5 },
    drives: () => Promise.resolve(roots()),
    defaultParent: () => Promise.resolve(path.join(dir, 'Restored')),
    freeBytes: () => Promise.resolve(500_000_000_000),
    // A real pause between slices, as in the app.
    pause: turn,
  });
}

/** Runs one call the way the window does, with a timer on the main thread watching how late it fires. */
async function timed<T>(name: string, fn: () => Promise<T>, out: Record<string, number>): Promise<T> {
  await turn();
  const dog = watchdog();
  const t0 = performance.now();
  const result = await fn();
  await new Promise((resolve) => setTimeout(resolve, 30)); // the watchdog reads only after one timer tick that follows a synchronous block
  out[name] = dog.stop();
  console.log(`RESTORE ${name}: ${Math.round(performance.now() - t0)} ms, longest block ${out[name]} ms`);
  return result;
}

describe('Get files back does not freeze the main thread (100,000 backup files on two drives, 30,000 in Google, 200,000 other rows)', () => {
  it('the screens: info, the days, a folder, a folder of 5,000 files', async () => {
    const svc = service();
    const blocks: Record<string, number> = {};
    const info = await timed('info', () => svc.info(backupId), blocks);
    const dates = await timed('days', () => svc.dates(backupId), blocks);
    const top = await timed('browse top', () => svc.browse({ backupId, folder: dayName(3), path: '' }), blocks);
    const deep = await timed('browse folder', () => svc.browse({ backupId, folder: dayName(3), path: 'DCIM/Camera3' }), blocks);
    expect(info.ok).toBe(true);
    expect(dates.ok && dates.dates).toHaveLength(DAYS + 1);
    expect(top.ok && top.entries.map((e) => e.name)).toEqual(['DCIM']);
    expect(deep.ok && deep.entries.length).toBe(PER_DAY / 25);
    for (const [name, ms] of Object.entries(blocks)) expect(ms, name).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('the list: one day, a ticked folder, and the newest copy of every one of the 100,000 files', async () => {
    const svc = service();
    const blocks: Record<string, number> = {};
    const day = await timed('plan day', () => svc.plan({ pick: { kind: 'date', backupId, folder: dayName(3), items: [] }, destination: { mode: 'new' } }), blocks);
    const folder = await timed('plan folder', () => svc.plan({ pick: { kind: 'date', backupId, folder: dayName(3), items: ['DCIM/Camera3/'] }, destination: { mode: 'new' } }), blocks);
    const newest = await timed('plan newest', () => svc.plan({ pick: { kind: 'newest', backupId }, destination: { mode: 'new' } }), blocks);
    expect(day.ok && day.plan.files).toBe(PER_DAY);
    expect(folder.ok && folder.plan.files).toBe(PER_DAY / 25);
    expect(newest.ok && newest.plan.files).toBe(DAYS * PER_DAY + REAL_FILES);
    for (const [name, ms] of Object.entries(blocks)) expect(ms, name).toBeLessThan(MAX_BLOCK_MS);
  }, 300_000);

  it('the list with no drive plugged in: 100,000 files looked up one by one for a copy in Google', async () => {
    plugged = false;
    try {
      const svc = service();
      const blocks: Record<string, number> = {};
      const newest = await timed('plan newest, no drive', () => svc.plan({ pick: { kind: 'newest', backupId }, destination: { mode: 'new' } }), blocks);
      expect(newest.ok && newest.plan.fromGoogle).toBe(GOOGLE_FILES);
      expect(newest.ok && newest.plan.notAvailable).toBe(DAYS * PER_DAY - GOOGLE_FILES + REAL_FILES);
      expect(blocks['plan newest, no drive']).toBeLessThan(MAX_BLOCK_MS);
    } finally {
      plugged = true;
    }
  }, 300_000);

  it('the copy job itself, with a turn between files', async () => {
    const svc = service();
    const planned = await svc.plan({ pick: { kind: 'date', backupId, folder: REAL_DAY, items: [] }, destination: { mode: 'new' } });
    expect(planned.ok).toBe(true);
    let params: RestoreJobParams | null = null;
    const withJobs = new RestoreService({ db, jobs: { create: (_k, _t, p) => ((params = p as RestoreJobParams), 6) }, drives: () => Promise.resolve([{ placeId: 't7', label: 'T7', root: path.join(dir, 'T7') }]), defaultParent: () => Promise.resolve(path.join(dir, 'Restored')), freeBytes: () => Promise.resolve(500_000_000_000), pause: turn });
    const again = await withJobs.plan({ pick: { kind: 'date', backupId, folder: REAL_DAY, items: [] }, destination: { mode: 'new' } });
    if (!again.ok) throw new Error(again.message);
    withJobs.start({ planId: again.plan.planId, confirmed: true });
    const ctx: JobContext = {
      jobId: 6,
      params,
      resume: null,
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
      warn: () => {},
      needsYou: () => Promise.resolve('continue'),
      checkpoint: () => {},
      yield: () => turn(),
    };
    await turn();
    const dog = watchdog();
    const message = await restoreHandler({ db, log: silent, baseOf: (id) => Promise.resolve(id === 't7' ? path.join(dir, 'T7') : null), freeBytes: () => Promise.resolve(500_000_000_000) }).run(ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const block = dog.stop();
    console.log(`RESTORE JOB: ${REAL_FILES} files, longest block ${block} ms`);
    expect(String(message)).toMatch(/^Got back 150 files/);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('the lookups made for each file use the (place, path) and checksum indexes, never a scan of the table', () => {
    const plan = (sql: string, args: unknown[]): string => (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ');
    for (const [name, sql, args] of [
      ['exact', COPY_SQL.exact, ['sea', 'x', ]],
      ['by checksum', COPY_SQL.bySha, ['abc', 'sea', 1, 'MyData/POCO/', 'MyData/POCO0']],
      ['google', COPY_SQL.google, ['abc', 1]],
    ] as const) {
      const detail = plan(sql, [...args]);
      expect(detail, name).toMatch(/USING (COVERING )?INDEX/);
      expect(detail, name).not.toMatch(/SCAN files/);
    }
  });
});
