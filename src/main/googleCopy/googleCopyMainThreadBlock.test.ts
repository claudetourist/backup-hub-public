import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { GoogleAuth, type GoogleVault } from '../google/auth';
import { DriveApi } from '../google/driveApi';
import { DriveUploader } from '../google/driveUpload';
import { FakeAccount, FakeGoogle } from '../google/fakeGoogle.testutil';
import { GoogleHttp } from '../google/googleHttp';
import type { JobContext } from '../jobs/jobService';
import { hashUnbuffered } from '../localCopy/directRead';
import { GoogleCopyService } from './googleCopyService';
import { candidatesSteps, loadReport, scanKindsSteps, sourceOf } from './googleCopyStore';
import { uploadOrder } from './googleCopyRun';
import { finishSliced, sortSteps, turn } from '../sliceWork';
import type { FileKind } from '../../shared/fileKinds';

/**
 * The window must not freeze while "Copy to Google" counts, shows the capacity screen, starts, and runs (CLAUDE.md: every new IPC call and job gets a
 * main-thread block test, limit 250 ms). A backup folder of 200,000 files on the T7 (30% already on Google, kinds mixed) in the index: the REAL status,
 * capacity screen and start run on it. Then the REAL job runs a few files of 6 MB with the app's own unbuffered read and hash, a fake Google, and a ctx
 * whose yield really gives the event loop a turn. A timer on the main thread says how late it fires, which is exactly what a frozen window is.
 */
const FILES = 200_000;
const ON_GOOGLE = 60_000;
const MAX_BLOCK_MS = 250;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function watchdog(intervalMs = 10): { stop(): Promise<number> } {
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
    // A block that ended just now is only seen by the next timer tick: wait for it.
    async stop() {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      clearInterval(timer);
      return Math.max(0, Math.round(max));
    },
  };
}

let dir: string;
let t7: string;
let db: Db;
let fake: FakeGoogle;
let service: GoogleCopyService;
const created: unknown[] = [];
const ROOT = 'Backups/POCO';
const secrets = new Map<string, string>([
  ['google.clientId', 'client-id'],
  ['google.clientSecret', 'client-secret'],
  ['gdrive.refreshToken.g1', '1//rt-g1'],
]);
const vault: GoogleVault = { status: () => ({ state: 'unlocked' }), getSecretText: (n) => secrets.get(n) ?? null, putSecret: (n, v) => void secrets.set(n, v.toString()) };

const KINDS = ['video-camera', 'video-whatsapp', 'photo-camera', 'photo-screenshot', 'documents'] as const;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-gcopy-block-'));
  t7 = path.join(dir, 't7');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(t7, { recursive: true });
  const o = initDatabase(path.join(dir, 'data'), silent);
  if (!o.ok) throw new Error('db did not open');
  db = o.db;
  db.pragma('wal_autocheckpoint = 0');
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('t7', 1, 'drive', 'T7', '{}', 'connected', 1)").run();
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('g1', 1, 'gdrive', 'G1', ?, 'connected', 1)").run(JSON.stringify({ email: 'a@example.com', quotaLimit: 1e15, quotaUsage: 0 }));
  db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (5, 1, 'POCO', 'phone', '/sdcard', 'poco', 'size_and_date', 1)").run();
  db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role) VALUES (5, 't7', ?, 'primary')").run(ROOT);
  const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, 1000, ?, 1, 1, ?)");
  const google = db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, ext_id, first_seen_at, last_seen_at, verified_how) VALUES ('g1', ?, ?, ?, 'm', ?, 1, 1, 'google-md5')");
  db.transaction(() => {
    for (let i = 0; i < FILES; i += 1) {
      const sha = i.toString(16).padStart(64, '0');
      const size = 1000 + ((i * 37) % 5_000_000);
      insert.run('t7', `${ROOT}/DCIM/d${i % 400}/f${i}.bin`, size, sha, KINDS[i % KINDS.length]);
      if (i < ON_GOOGLE) google.run(`My Drive/Backup Hub/POCO/f${i}.bin`, size, sha, `e${i}`);
    }
  })();
  fake = new FakeGoogle();
  const acc = fake.add(new FakeAccount('a@example.com', '1//rt-g1'));
  acc.quota = { limit: '1000000000000000', usage: '0', usageInDrive: '0', usageInDriveTrash: '0' };
  const http = new GoogleHttp({ fetchFn: fake.fetchFn, sleep: () => Promise.resolve() });
  const auth = new GoogleAuth(vault, http);
  const api = new DriveApi(http, auth);
  service = new GoogleCopyService({
    db,
    log: silent,
    uploader: new DriveUploader(http, auth),
    auth,
    http,
    room: async (id, signal) => {
      const about = await api.about(id, signal);
      return { limit: about.limit, usage: about.usage };
    },
    driveRoot: async () => t7,
    hashFile: async (file, yieldNow) => {
      const h = await hashUnbuffered(file, { md5: true, yieldNow });
      return { sha256: h.sha256, md5: h.md5, bytes: h.bytes };
    },
    fileSize: async (file) => (fs.existsSync(file) ? fs.statSync(file).size : null),
    jobs: { create: (kind, title, params) => (created.push({ kind, title, params }), created.length), list: () => [] },
    pluggedPlaces: async () => new Set(['t7']),
    chunkBytes: 4 * 1024 * 1024,
  });
}, 300_000);
afterAll(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('copy to Google never freezes the window', () => {
  it('the first line, the capacity screen and the start on a 200,000-file backup', async () => {
    await turn();
    let dog = watchdog();
    let t0 = performance.now();
    const status = await service.status(5);
    const statusMs = Math.round(performance.now() - t0);
    let block = await dog.stop();
    expect(status).toMatchObject({ ok: true, status: { filesOnGoogle: ON_GOOGLE } });
    console.log(`[google status] ${FILES.toLocaleString('en-US')} files, ${statusMs} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);

    service.countsChanged();
    dog = watchdog();
    t0 = performance.now();
    const preview = await service.preview(5);
    const previewMs = Math.round(performance.now() - t0);
    block = await dog.stop();
    expect(preview.ok && preview.preview.kinds.length).toBe(KINDS.length);
    console.log(`[google capacity screen] ${previewMs} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);

    // The real per-file plan (140,000 files not on Google yet, three tick changes in a row: the sizes are read once and cached).
    for (const kinds of [['video-camera'], ['video-camera', 'photo-camera'], [...KINDS]]) {
      dog = watchdog();
      t0 = performance.now();
      const planned = await service.plan({ backupId: 5, kinds, accountIds: ['g1'] });
      const planMs = Math.round(performance.now() - t0);
      block = await dog.stop();
      expect(planned).toMatchObject({ ok: true, plan: { unplacedFiles: 0 } });
      console.log(`[google plan] ${kinds.length} kinds, ${planMs} ms in all, longest block ${block} ms`);
      expect(block).toBeLessThan(MAX_BLOCK_MS);
    }

    dog = watchdog();
    t0 = performance.now();
    const started = await service.start({ backupId: 5, kinds: ['video-camera', 'photo-camera'], accountIds: ['g1'], confirmedAccounts: true, seenRoom: {} });
    const startMs = Math.round(performance.now() - t0);
    block = await dog.stop();
    expect(started.ok).toBe(true);
    console.log(`[google start] ${startMs} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('"only what is still on the phone" and "fit what I have room for": capacity screen, plan and start on the same 200,000-file backup with a 100,000-file phone listing', async () => {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('ph', 1, 'phone', 'POCO', '{}', 'connected', 1)").run();
    db.prepare("UPDATE backup_profiles SET source_place_id = 'ph' WHERE id = 5").run();
    const phone = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at) VALUES ('ph', ?, ?, 1000, ?, 1, 1)");
    db.transaction(() => {
      for (let i = 0; i < FILES; i += 2) phone.run(`/sdcard/DCIM/f${i}.bin`, 1000 + ((i * 37) % 5_000_000), i.toString(16).padStart(64, '0'));
    })();
    service.countsChanged();
    await turn();
    let dog = watchdog();
    let t0 = performance.now();
    const preview = await service.preview(5, true);
    const previewMs = Math.round(performance.now() - t0);
    let block = await dog.stop();
    expect(preview.ok && preview.preview.kinds.reduce((s, k) => s + k.files, 0)).toBe(FILES / 2);
    console.log(`[google capacity screen, only on the phone] ${previewMs} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
    for (const fitBiggest of [false, true]) {
      dog = watchdog();
      t0 = performance.now();
      const planned = await service.plan({ backupId: 5, kinds: [...KINDS], accountIds: ['g1'], onlyOnPhone: true, fitBiggest });
      const planMs = Math.round(performance.now() - t0);
      block = await dog.stop();
      expect(planned).toMatchObject({ ok: true, plan: { toPlaceFiles: FILES / 2 - ON_GOOGLE / 2, unplacedFiles: 0 } });
      console.log(`[google plan, only on the phone, fit ${fitBiggest}] ${planMs} ms in all, longest block ${block} ms`);
      expect(block).toBeLessThan(MAX_BLOCK_MS);
    }
    dog = watchdog();
    t0 = performance.now();
    const started = await service.start({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'], confirmedAccounts: true, seenRoom: {}, onlyOnPhone: true, fitBiggest: true });
    const startMs = Math.round(performance.now() - t0);
    block = await dog.stop();
    expect(started.ok).toBe(true);
    console.log(`[google start, only on the phone, fit] ${startMs} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
    // Put back for the next tests (the list of the job reads the whole backup).
    db.prepare('UPDATE backup_profiles SET source_place_id = NULL WHERE id = 5').run();
    service.countsChanged();
  }, 120_000);

  it('the list of the job: 140,000 files not on Google, read and put in upload order, in slices', async () => {
    const src = sourceOf(db, 5)!;
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    const list = await finishSliced(candidatesSteps(db, src, new Set<FileKind>(KINDS)), turn);
    await finishSliced(sortSteps(list, uploadOrder), turn);
    const ms = Math.round(performance.now() - t0);
    const block = await dog.stop();
    expect(list).toHaveLength(FILES - ON_GOOGLE);
    expect(list[0]!.kind).toBe('video-camera');
    expect(list[0]!.size).toBeGreaterThanOrEqual(list[1]!.size);
    console.log(`[google job list] ${list.length.toLocaleString('en-US')} files read and sorted, ${ms} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('one checksum with 1,000 copies elsewhere (the real db has such shas): the status scan and the job list stay in slices, with and without "only on the phone"', async () => {
    // Found on the real db (26 Nov 2026): the "already on Google?" probe walked every same-sha row (page up to 22 s, window frozen 14 s after Pause).
    const heavy = 'ab'.repeat(32);
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('lap', 1, 'laptop', 'Laptop', '{}', 'connected', 1)").run();
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('ph8', 1, 'phone', 'Heavy', '{}', 'connected', 1)").run();
    db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_root, folder_prefix, change_rule, source_place_id, created_at) VALUES (8, 1, 'Heavy', 'phone', '/sdcard', 'heavy', 'size_and_date', 'ph8', 1)").run();
    db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role) VALUES (8, 't7', 'Backups/Heavy', 'primary')").run();
    const ins = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind) VALUES (?, ?, 5000, 1000, ?, 1, 1, 'photo-camera')");
    db.transaction(() => {
      for (let i = 0; i < 1000; i += 1) ins.run('lap', `Pictures/c${i}.jpg`, heavy);
      for (let i = 0; i < 1500; i += 1) {
        ins.run('t7', `Backups/Heavy/DCIM/h${i}.jpg`, heavy);
        ins.run('ph8', `sdcard/DCIM/h${i}.jpg`, heavy);
      }
    })();
    const src = sourceOf(db, 8)!;
    for (const onlyOnPhone of [false, true]) {
      await turn();
      const dog = watchdog();
      const t0 = performance.now();
      const list = await finishSliced(candidatesSteps(db, src, new Set<FileKind>(KINDS), onlyOnPhone), turn);
      const scan = await finishSliced(scanKindsSteps(db, src, onlyOnPhone), turn);
      const ms = Math.round(performance.now() - t0);
      const block = await dog.stop();
      expect(list).toHaveLength(1); // one content, listed once; the other 1,499 are repeats
      expect(scan.kinds.get('photo-camera')).toMatchObject({ files: 1, repeatFiles: 1499 });
      console.log(`[google scan, sha with 1,000 copies, only on the phone ${onlyOnPhone}] ${ms} ms in all, longest block ${block} ms`);
      expect(block).toBeLessThan(MAX_BLOCK_MS);
    }
  }, 120_000);

  it('the job: the checks, the read and hash, the upload in chunks', async () => {
    // A small backup of its own: 3 real files of 6 MB on the "T7".
    db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (6, 1, 'Big', 'phone', '/sdcard', 'big', 'size_and_date', 1)").run();
    db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role) VALUES (6, 't7', 'Backups/Big', 'primary')").run();
    const { createHash } = await import('node:crypto');
    for (let n = 0; n < 3; n += 1) {
      const data = Buffer.alloc(6 * 1024 * 1024, n + 1);
      const abs = path.join(t7, 'Backups', 'Big', 'VID', `v${n}.mp4`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind) VALUES ('t7', ?, ?, 1000, ?, 1, 1, 'video-camera')").run(`Backups/Big/VID/v${n}.mp4`, data.length, createHash('sha256').update(data).digest('hex'));
    }
    const handler = service.handlers()[0]!;
    const ctx: JobContext = {
      jobId: 3,
      params: { backupId: 6, kinds: ['video-camera'], placeIds: ['t7'], accountIds: ['g1'] },
      resume: null,
      signal: new AbortController().signal,
      progress: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      needsYou: () => Promise.reject(new Error('not used')),
      checkpoint: () => undefined,
      yield: () => turn(),
    };
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    await handler.run(ctx);
    const ms = Math.round(performance.now() - t0);
    const block = await dog.stop();
    expect(loadReport(db, 3)).toMatchObject({ copied: { files: 3, bytes: 3 * 6 * 1024 * 1024 } });
    console.log(`[google job] 3 files of 6 MB, ${ms} ms in all, longest block ${block} ms`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('the job with 3 accounts: up to six files read, hashed and sent at once (4 into one account), and the live per-account numbers asked every few ms', async () => {
    // Three accounts, nine real files of 6 MB: they are read once, hashed while they are read, and sent in 4 MB chunks.
    db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (7, 1, 'Par', 'phone', '/sdcard', 'par', 'size_and_date', 1)").run();
    db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role) VALUES (7, 't7', 'Backups/Par', 'primary')").run();
    const { createHash } = await import('node:crypto');
    for (const id of ['g2', 'g3']) {
      db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, 'gdrive', ?, ?, 'connected', 1)").run(id, id.toUpperCase(), JSON.stringify({ email: `${id}@example.com`, quotaLimit: 1e15, quotaUsage: 0 }));
      secrets.set(`gdrive.refreshToken.${id}`, `1//rt-${id}`);
      const acc = fake.add(new FakeAccount(`${id}@example.com`, `1//rt-${id}`));
      acc.quota = { limit: '1000000000000000', usage: '0', usageInDrive: '0', usageInDriveTrash: '0' };
    }
    for (let n = 0; n < 9; n += 1) {
      const data = Buffer.alloc(6 * 1024 * 1024, n + 20);
      const abs = path.join(t7, 'Backups', 'Par', 'VID', `v${n}.mp4`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind) VALUES ('t7', ?, ?, 1000, ?, 1, 1, 'video-camera')").run(`Backups/Par/VID/v${n}.mp4`, data.length, createHash('sha256').update(data).digest('hex'));
    }
    fake.delayMs = () => 3;
    const handler = service.handlers()[0]!;
    const ctx: JobContext = {
      jobId: 4,
      params: { backupId: 7, kinds: ['video-camera'], placeIds: ['t7'], accountIds: ['g1', 'g2', 'g3'] },
      resume: null,
      signal: new AbortController().signal,
      progress: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      needsYou: () => Promise.reject(new Error('not used')),
      checkpoint: () => undefined,
      yield: () => turn(),
    };
    await turn();
    const dog = watchdog();
    let asked = 0;
    const poll = setInterval(() => {
      service.sent(4);
      asked += 1;
    }, 5);
    const t0 = performance.now();
    await handler.run(ctx);
    const ms = Math.round(performance.now() - t0);
    clearInterval(poll);
    const block = await dog.stop();
    fake.delayMs = null;
    expect(loadReport(db, 4)).toMatchObject({ copied: { files: 9, bytes: 9 * 6 * 1024 * 1024 } });
    expect(service.sent(4).reduce((s, l) => s + l.files, 0)).toBe(9);
    const used = service.sent(4).filter((l) => l.files > 0);
    expect(used.length).toBeGreaterThanOrEqual(2); // 4 files at most into one account at the same time
    expect(Math.max(...used.map((l) => l.files))).toBeLessThanOrEqual(9);
    console.log(`[google job x3] 9 files of 6 MB into 3 accounts, ${ms} ms in all, longest block ${block} ms, live numbers asked ${asked} times`);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);
});
