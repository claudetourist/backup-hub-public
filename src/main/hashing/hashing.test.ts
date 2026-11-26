import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATTERY_PAUSE_PERCENT, HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { LIST_PLACE_JOB_KIND } from '../../shared/listing';
import { closeDatabase, currentSchemaVersion, initDatabase, MIGRATIONS, openDatabase, runMigrations, type Db } from '../db';
import { JobAborted, JobService, type JobContext } from '../jobs/jobService';
import { checkCloudOnlyPaths, CLOUD_CHECK_SCRIPT, MAX_CLOUD_CHECK_PATHS, parseCloudCheckLine, type CloudCheckState, type SpawnFn } from '../listing/cloudOnly';
import { upsertFiles } from '../listing/fileStore';
import type { ListedPlace, Located } from '../listing/listJob';
import { toSlashes } from '../listing/skipRules';
import { parseCharge, windowsPowerSource, type PowerSource } from './battery';
import { QueryService } from '../query/queryService';
import { FingerprintService, NOTHING_WAITING_MESSAGE } from './fingerprintService';
import { fingerprintFile } from './fingerprintFile';
import { hashFile, SharedThrottle } from './hashCore';
import { hashFilesHandler, POWER_RECHECK_MS, skippedMessage, type HashJobEnv } from './hashJob';
import { createFileHasher, inProcessHasher, type FileHasher, type HashRequest } from './hasher';
import { absolutePathFor } from './paths';
import { batteryDecision, bigFileLimit, capBytesPerSecond, throttleDelayMs } from './pure';
import { clearErrors, nextBatch, queueTotals, START_CURSOR } from './queue';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string; // app data dir (database)
let tree: string; // temp fixture tree: the only files ever read
let db: Db;

const LAPTOP = '00000000-0000-4000-8000-00000000000a';
const DRIVE = '00000000-0000-4000-8000-00000000000b';
const ONEDRIVE = '00000000-0000-4000-8000-00000000000c';
const LAPTOP_BASE = (): string => path.join(tree, 'laptop');
const DRIVE_BASE = (): string => path.join(tree, 'T7');
const OD_BASE = (): string => path.join(tree, 'OneDrive');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-hash-db-'));
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-hash-tree-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label] of [
    [LAPTOP, 'laptop', 'STUDY-PC'],
    [DRIVE, 'drive', 'T7'],
    [ONEDRIVE, 'onedrive', 'OneDrive'],
  ] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tree, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Create a real file in the temp tree and a listing row for it, as the listing job would. Returns its absolute path. */
function addFile(placeId: string, rel: string, content: string | Buffer = 'hello'): string {
  const base = placeId === LAPTOP ? LAPTOP_BASE() : placeId === DRIVE ? DRIVE_BASE() : OD_BASE();
  const abs = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const st = fs.lstatSync(abs);
  const stored = placeId === LAPTOP ? toSlashes(abs) : rel;
  upsertFiles(db, placeId, [{ relPath: stored, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), cloudOnly: false }], 1000, false);
  return abs;
}

interface Row {
  id: number;
  rel_path: string;
  size: number;
  sha256: string | null;
  md5: string | null;
  hashed_at: number | null;
  hash_error: string | null;
  cloud_only: number;
  gone_at: number | null;
}
const rowsOf = (placeId: string): Row[] =>
  db.prepare('SELECT id, rel_path, size, sha256, md5, hashed_at, hash_error, cloud_only, gone_at FROM files WHERE place_id = ? ORDER BY size, id').all(placeId) as Row[];
const rowFor = (placeId: string, endsWith: string): Row => {
  const r = rowsOf(placeId).find((x) => x.rel_path.endsWith(endsWith));
  if (!r) throw new Error(`no row ${endsWith}`);
  return r;
};

const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const MD5_ABC = '900150983cd24fb0d6963f7d28e17f72';
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MD5_EMPTY = 'd41d8cd98f00b204e9800998ecf8427e';

/** A query service that counts on this thread at once (no worker, no rate limit), for tests. */
const testQuery = (now: () => number): QueryService =>
  new QueryService({ dbFile: null, db, workerPath: null, log: silent, now, schedule: (fn) => fn(), fallbackMinIntervalMs: 0 });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const never = new AbortController().signal;

/** A hasher that records which files it was asked to open, and can be told to misbehave. */
function recordingHasher(
  behave?: (request: HashRequest, real: () => ReturnType<FileHasher['hash']>) => ReturnType<FileHasher['hash']> | undefined,
): FileHasher & { opened: string[] } {
  const real = inProcessHasher();
  const opened: string[] = [];
  return {
    kind: 'in-process',
    opened,
    close: () => undefined,
    hash: (request) => {
      opened.push(request.path);
      return behave?.(request, () => real.hash(request)) ?? real.hash(request);
    },
  };
}

const ac: PowerSource = { read: async () => ({ onBattery: false, percent: null }) };

interface Harness {
  warns: string[];
  logs: string[];
  progress: { done: number; total: number; bytesDone: number | undefined; message: string | undefined }[];
  checkpoints: unknown[];
}

function makeEnv(extra: Partial<HashJobEnv> = {}): HashJobEnv {
  return {
    locate: async (place: ListedPlace): Promise<Located> => {
      if (place.kind === 'laptop') return { ok: true, base: '' };
      return { ok: true, base: place.kind === 'drive' ? DRIVE_BASE() : OD_BASE() };
    },
    ...extra,
  };
}

interface RunOptions {
  params?: unknown;
  resume?: unknown;
  env?: HashJobEnv;
  hasher?: FileHasher;
  power?: PowerSource;
  checkCloud?: (paths: string[], signal: AbortSignal) => Promise<Map<string, CloudCheckState>>;
  abortAfterYields?: number;
  batchSize?: number;
  flushFiles?: number;
  relocateMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  megabytesPerSecond?: () => number;
  yieldFiles?: number;
  parallel?: number;
  cloudFreshMs?: number;
  bigFileBytes?: number;
  now?: () => number;
}

/** Runs the handler directly with a stand-in context. */
async function runHash(options: RunOptions = {}): Promise<{ message: string; h: Harness }> {
  const h: Harness = { warns: [], logs: [], progress: [], checkpoints: [] };
  let yields = 0;
  const ctx: JobContext = {
    jobId: 1,
    params: options.params ?? {},
    resume: options.resume ?? null,
    signal: new AbortController().signal,
    progress: (done, total, extras) => h.progress.push({ done, total, bytesDone: extras?.bytesDone, message: extras?.message }),
    log: (_l, text) => h.logs.push(text),
    warn: (text) => {
      h.warns.push(text);
      h.logs.push(text);
    },
    needsYou: () => Promise.reject(new Error('not used')),
    checkpoint: (value) => h.checkpoints.push(JSON.parse(JSON.stringify(value))),
    yield: async () => {
      yields += 1;
      if (yields > (options.abortAfterYields ?? Infinity)) throw new JobAborted();
    },
  };
  const handler = hashFilesHandler({
    db,
    env: options.env ?? makeEnv(),
    log: silent,
    hasher: options.hasher ?? inProcessHasher(),
    power: options.power ?? ac,
    megabytesPerSecond: options.megabytesPerSecond ?? (() => 60),
    batchSize: options.batchSize,
    flushFiles: options.flushFiles,
    relocateMs: options.relocateMs,
    yieldFiles: options.yieldFiles ?? 1,
    parallel: options.parallel,
    cloudFreshMs: options.cloudFreshMs,
    bigFileBytes: options.bigFileBytes,
    now: options.now,
    ...(options.checkCloud ? { checkCloud: options.checkCloud } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const result = await handler.run(ctx);
  return { message: typeof result === 'string' ? result : '', h };
}

describe('pure rules', () => {
  it('throttle: waits only as long as needed to stay at or under the cap', () => {
    expect(throttleDelayMs(60_000_000, 0, 60_000_000)).toBe(1000);
    expect(throttleDelayMs(60_000_000, 400, 60_000_000)).toBe(600);
    expect(throttleDelayMs(60_000_000, 1000, 60_000_000)).toBe(0);
    expect(throttleDelayMs(60_000_000, 5000, 60_000_000)).toBe(0);
    expect(throttleDelayMs(1_000_000, 0, 0)).toBe(0); // 0 = no limit
    expect(throttleDelayMs(0, 0, 60_000_000)).toBe(0);
    expect(capBytesPerSecond(60)).toBe(60_000_000);
  });

  it('battery: pauses only on battery below 30%, with a plain message; unknown charge keeps going', () => {
    expect(BATTERY_PAUSE_PERCENT).toBe(30);
    expect(batteryDecision({ onBattery: false, percent: 5 })).toEqual({ pause: false });
    expect(batteryDecision({ onBattery: true, percent: 30 })).toEqual({ pause: false });
    expect(batteryDecision({ onBattery: true, percent: 80 })).toEqual({ pause: false });
    expect(batteryDecision({ onBattery: true, percent: null })).toEqual({ pause: false });
    const low = batteryDecision({ onBattery: true, percent: 29 });
    expect(low.pause).toBe(true);
    expect(low.pause && low.message).toBe('Paused to save battery (29% left, not plugged in). It continues when you plug in or the battery is above 30%.');
  });

  it('reads the battery charge from Windows only while on battery, and caches it for a minute', async () => {
    expect(parseCharge('87\r\n')).toBe(87);
    expect(parseCharge('')).toBeNull();
    expect(parseCharge('error')).toBeNull();
    expect(parseCharge('300')).toBeNull();
    let onBattery = false;
    let t = 0;
    const read = vi.fn(async () => '25\n');
    const source = windowsPowerSource(() => onBattery, read, () => t);
    expect(await source.read()).toEqual({ onBattery: false, percent: null });
    expect(read).not.toHaveBeenCalled();
    onBattery = true;
    expect(await source.read()).toEqual({ onBattery: true, percent: 25 });
    t = 30_000;
    await source.read();
    expect(read).toHaveBeenCalledTimes(1);
    t = 61_000;
    await source.read();
    expect(read).toHaveBeenCalledTimes(2);
    const broken = windowsPowerSource(() => true, async () => Promise.reject(new Error('no wmi')), () => 0);
    expect(await broken.read()).toEqual({ onBattery: true, percent: null });
  });

  it('maps a stored rel_path back to a path: laptop absolute, drive and OneDrive under their base, never outside', () => {
    expect(absolutePathFor('laptop', '', 'D:/MyData/a b/c.jpg')).toBe(path.normalize('D:/MyData/a b/c.jpg'));
    expect(absolutePathFor('laptop', '', 'MyData/c.jpg')).toBeNull();
    expect(absolutePathFor('laptop', '', 'D:/MyData/../Windows/x')).toBeNull();
    const base = path.join(tree, 'T7');
    expect(absolutePathFor('drive', base, 'Photos/2026/a.jpg')).toBe(path.join(base, 'Photos', '2026', 'a.jpg'));
    expect(absolutePathFor('onedrive', base, '../x')).toBeNull();
    expect(absolutePathFor('drive', base, 'a//b')).toBeNull();
    expect(absolutePathFor('drive', '', 'a')).toBeNull();
    expect(absolutePathFor('drive', base, '')).toBeNull();
  });
});

describe('hashing a file', () => {
  it('matches known SHA-256 and MD5 vectors, in one read', async () => {
    const a = path.join(tree, 'abc.txt');
    fs.writeFileSync(a, 'abc');
    const empty = path.join(tree, 'empty.txt');
    fs.writeFileSync(empty, '');
    let seen = 0;
    expect(await hashFile(a, { capBytesPerSec: 0, isCancelled: () => false, onBytes: (n) => (seen += n) })).toEqual({ ok: true, sha256: SHA_ABC, md5: MD5_ABC, bytes: 3 });
    expect(seen).toBe(3);
    expect(await hashFile(empty, { capBytesPerSec: 0, isCancelled: () => false })).toEqual({ ok: true, sha256: SHA_EMPTY, md5: MD5_EMPTY, bytes: 0 });
  });

  it('hashes a file bigger than one chunk the same as a one-shot hash', async () => {
    const big = Buffer.alloc(2_500_000, 'xyz');
    const f = path.join(tree, 'big.bin');
    fs.writeFileSync(f, big);
    const crypto = await import('node:crypto');
    const result = await hashFile(f, { capBytesPerSec: 0, isCancelled: () => false });
    expect(result).toMatchObject({ ok: true, bytes: big.length });
    expect(result.ok && result.sha256).toBe(crypto.createHash('sha256').update(big).digest('hex'));
    expect(result.ok && result.md5).toBe(crypto.createHash('md5').update(big).digest('hex'));
  });

  it('slows down to the cap: it sleeps the time the cap asks for after each chunk', async () => {
    const f = path.join(tree, 'three.bin');
    fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 1));
    let clock = 0;
    const sleeps: number[] = [];
    const result = await hashFile(f, {
      capBytesPerSec: 1024 * 1024, // 1 MiB/s
      isCancelled: () => false,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it('reports a read problem as a value, in plain words, and stops when cancelled', async () => {
    const missing = await hashFile(path.join(tree, 'nope.bin'), { capBytesPerSec: 0, isCancelled: () => false });
    expect(missing).toMatchObject({ ok: false, code: 'ENOENT' });
    const folder = await hashFile(tree, { capBytesPerSec: 0, isCancelled: () => false });
    expect(folder.ok).toBe(false);
    const f = path.join(tree, 'c.bin');
    fs.writeFileSync(f, Buffer.alloc(3_000_000));
    expect(await hashFile(f, { capBytesPerSec: 0, isCancelled: () => true })).toMatchObject({ ok: false, code: 'ABORTED' });
  });

  it('createFileHasher falls back to reading in the main process when the worker cannot start', async () => {
    const f = path.join(tree, 'abc.txt');
    fs.writeFileSync(f, 'abc');
    const warn = vi.fn();
    const hasher = createFileHasher({ workerPath: path.join(tree, 'no-such-worker.js'), log: { info: () => {}, warn } });
    const result = await hasher.hash({ path: f, capBytesPerSec: 0, signal: never });
    expect(result).toMatchObject({ ok: true, sha256: SHA_ABC });
    expect(hasher.kind).toBe('in-process');
    expect(warn).toHaveBeenCalledTimes(1);
    hasher.close();
  });
});

describe('fingerprintFile (size and date checks)', () => {
  const listedOf = (abs: string) => {
    const st = fs.lstatSync(abs);
    return { size: st.size, mtime: Math.trunc(st.mtimeMs) };
  };

  it('returns the fingerprints for an untouched file', async () => {
    const f = path.join(tree, 'abc.txt');
    fs.writeFileSync(f, 'abc');
    expect(await fingerprintFile(inProcessHasher(), f, listedOf(f), { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'hashed', sha256: SHA_ABC, md5: MD5_ABC });
  });

  it('discards the result when the file changed while it was being read (size)', async () => {
    const f = path.join(tree, 'grow.txt');
    fs.writeFileSync(f, 'abc');
    const hasher = recordingHasher((request, real) => {
      fs.appendFileSync(request.path, 'more');
      return real();
    });
    expect(await fingerprintFile(hasher, f, listedOf(f), { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'changed' });
  });

  it('discards the result when only the date changed during the read', async () => {
    const f = path.join(tree, 'touch.txt');
    fs.writeFileSync(f, 'abc');
    const listed = listedOf(f);
    const hasher = recordingHasher((request, real) => {
      const later = new Date(listed.mtime + 60_000);
      fs.utimesSync(request.path, later, later);
      return real();
    });
    expect(await fingerprintFile(hasher, f, listed, { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'changed' });
  });

  it('does not even read a file that already differs from the listing, and tells missing from unreadable', async () => {
    const f = path.join(tree, 'old.txt');
    fs.writeFileSync(f, 'abc');
    const hasher = recordingHasher();
    expect(await fingerprintFile(hasher, f, { size: 99, mtime: listedOf(f).mtime }, { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'changed' });
    expect(await fingerprintFile(hasher, f, { size: 3, mtime: 1 }, { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'changed' });
    expect(hasher.opened).toEqual([]);
    expect(await fingerprintFile(hasher, path.join(tree, 'gone.txt'), { size: 1, mtime: 1 }, { capBytesPerSec: 0, signal: never })).toEqual({ kind: 'missing' });
  });

  it('turns a read error into an error outcome with a plain message', async () => {
    const f = path.join(tree, 'busy.txt');
    fs.writeFileSync(f, 'abc');
    const hasher = recordingHasher(() => Promise.resolve({ ok: false, code: 'EBUSY', message: 'Could not read it (the file is in use by another program, EBUSY).' }));
    expect(await fingerprintFile(hasher, f, listedOf(f), { capBytesPerSec: 0, signal: never })).toEqual({
      kind: 'error',
      code: 'EBUSY',
      message: 'Could not read it (the file is in use by another program, EBUSY).',
    });
  });
});

describe('the queue', () => {
  it('hands out the smallest files first and never the errored, gone, cloud-only or already fingerprinted ones', () => {
    addFile(LAPTOP, 'q/big.bin', Buffer.alloc(500));
    addFile(LAPTOP, 'q/small.bin', Buffer.alloc(5));
    addFile(LAPTOP, 'q/mid.bin', Buffer.alloc(50));
    addFile(LAPTOP, 'q/tie-b.bin', Buffer.alloc(50));
    addFile(LAPTOP, 'q/errored.bin', Buffer.alloc(1));
    addFile(LAPTOP, 'q/gone.bin', Buffer.alloc(2));
    addFile(LAPTOP, 'q/cloud.bin', Buffer.alloc(3));
    addFile(LAPTOP, 'q/done.bin', Buffer.alloc(4));
    db.prepare("UPDATE files SET hash_error = 'x' WHERE rel_path LIKE '%errored.bin'").run();
    db.prepare('UPDATE files SET gone_at = 5 WHERE rel_path LIKE ?').run('%gone.bin');
    db.prepare('UPDATE files SET cloud_only = 1 WHERE rel_path LIKE ?').run('%cloud.bin');
    db.prepare("UPDATE files SET sha256 = 'aa', md5 = 'bb' WHERE rel_path LIKE ?").run('%done.bin');

    const names = (rows: { rel_path: string }[]) => rows.map((r) => path.posix.basename(r.rel_path));
    expect(names(nextBatch(db, LAPTOP, START_CURSOR, 10))).toEqual(['small.bin', 'mid.bin', 'tie-b.bin', 'big.bin']);
    expect(queueTotals(db, LAPTOP)).toEqual({ files: 4, bytes: 605 });

    // The cursor moves past rows that were skipped, so they come up once.
    const first = nextBatch(db, LAPTOP, START_CURSOR, 2);
    const last = first[first.length - 1]!;
    expect(names(nextBatch(db, LAPTOP, { size: last.size, id: last.id }, 10))).toEqual(['tie-b.bin', 'big.bin']);
  });

  it('is served by the partial index (no scan over errored rows)', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, rel_path, size, mtime FROM files
          WHERE place_id = ? AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL AND (size, id) > (?, ?)
          ORDER BY size, id LIMIT 200`,
      )
      .all(LAPTOP, -1, 0) as { detail: string }[];
    const text = plan.map((p) => p.detail).join(' ');
    expect(text).toContain('idx_files_to_hash');
    expect(text).not.toContain('USE TEMP B-TREE');
  });

  it('a listing that sees the file change clears its read error, so it is tried again', () => {
    const abs = addFile(LAPTOP, 'e/x.bin', 'abc');
    db.prepare("UPDATE files SET hash_error = 'busy'").run();
    expect(queueTotals(db, LAPTOP).files).toBe(0);
    const st = fs.lstatSync(abs);
    // Same size and date: still errored.
    upsertFiles(db, LAPTOP, [{ relPath: toSlashes(abs), size: st.size, mtimeMs: Math.trunc(st.mtimeMs), cloudOnly: false }], 2000, false);
    expect(queueTotals(db, LAPTOP).files).toBe(0);
    // Changed: back in the queue.
    upsertFiles(db, LAPTOP, [{ relPath: toSlashes(abs), size: st.size + 1, mtimeMs: Math.trunc(st.mtimeMs), cloudOnly: false }], 3000, false);
    expect(queueTotals(db, LAPTOP).files).toBe(1);
    expect(rowsOf(LAPTOP)[0]?.hash_error).toBeNull();
  });

  it('clearErrors ("Try again") puts errored live rows back and leaves gone ones alone', () => {
    addFile(LAPTOP, 'e/a.bin');
    addFile(LAPTOP, 'e/b.bin');
    db.prepare("UPDATE files SET hash_error = 'busy'").run();
    db.prepare("UPDATE files SET gone_at = 9 WHERE rel_path LIKE '%b.bin'").run();
    expect(clearErrors(db, LAPTOP)).toBe(1);
    expect(queueTotals(db, LAPTOP).files).toBe(1);
  });
});

describe('hash.files', () => {
  it('fingerprints every waiting laptop file, smallest first, and records sha256, md5 and hashed_at', async () => {
    addFile(LAPTOP, 'm/abc.txt', 'abc');
    addFile(LAPTOP, 'm/empty.txt', '');
    addFile(LAPTOP, 'm/longer.txt', 'abcdefgh');
    const hasher = recordingHasher();
    const { message, h } = await runHash({ hasher, params: { placeId: LAPTOP } });
    expect(message).toBe('Checked 3 files (11 bytes).');
    expect(hasher.opened.map((p) => path.basename(p))).toEqual(['empty.txt', 'abc.txt', 'longer.txt']);
    expect(rowFor(LAPTOP, 'abc.txt')).toMatchObject({ sha256: SHA_ABC, md5: MD5_ABC, hash_error: null });
    expect(rowFor(LAPTOP, 'abc.txt').hashed_at).toBeGreaterThan(0);
    expect(rowFor(LAPTOP, 'empty.txt')).toMatchObject({ sha256: SHA_EMPTY, md5: MD5_EMPTY });
    expect(h.warns).toEqual([]);
    // Progress is in bytes, with a total.
    expect(h.progress.at(-1)).toMatchObject({ done: 3, total: 3, bytesDone: 11 });
  });

  it('reports bytes while one file is still being read (at most every 250 ms), so a big file shows a speed', async () => {
    addFile(LAPTOP, 'big/one.bin', 'abcdefgh');
    let clock = 1_000_000;
    const hasher = recordingHasher((request) => {
      return (async () => {
        // The worker reports chunks of a file that is still being read.
        for (let i = 0; i < 6; i += 1) {
          clock += 100;
          request.onBytes?.(1);
        }
        return { ok: true as const, sha256: SHA_ABC, md5: MD5_ABC, bytes: 6 };
      })();
    });
    const { h } = await runHash({ hasher, params: { placeId: LAPTOP }, now: () => clock });
    const mid = h.progress.filter((p) => p.done === 0 && (p.bytesDone ?? 0) > 0);
    // 600 ms of reading gives two reports, not six.
    expect(mid.length).toBeGreaterThanOrEqual(2);
    expect(mid.length).toBeLessThanOrEqual(3);
    expect(mid.at(-1)?.bytesDone).toBeGreaterThan(0);
  });

  it('with nothing waiting it says so and reads nothing', async () => {
    const hasher = recordingHasher();
    const { message } = await runHash({ hasher });
    expect(message).toBe('Nothing was waiting for a checksum.');
    expect(hasher.opened).toEqual([]);
  });

  it('without a place it works through every connected local place (laptop, OneDrive, drive)', async () => {
    addFile(LAPTOP, 'l/a.txt', 'abc');
    addFile(DRIVE, 'd/b.txt', 'abc');
    addFile(ONEDRIVE, 'o/c.txt', 'abc');
    const { message } = await runHash({
      checkCloud: async (paths) => new Map(paths.map((p) => [p, 'local' as const])),
    });
    expect(message).toBe('Checked 3 files (9 bytes).');
    for (const id of [LAPTOP, DRIVE, ONEDRIVE]) expect(rowsOf(id)[0]?.sha256).toBe(SHA_ABC);
  });

  it('keeps no checksum for a file that changed during the read and leaves the row for the next listing, with one warning', async () => {
    addFile(LAPTOP, 'c/steady.txt', 'abc');
    addFile(LAPTOP, 'c/moving.txt', 'abcd');
    const hasher = recordingHasher((request, real) => {
      if (request.path.endsWith('moving.txt')) fs.appendFileSync(request.path, 'x');
      return real();
    });
    const { h } = await runHash({ hasher, params: { placeId: LAPTOP } });
    expect(rowFor(LAPTOP, 'steady.txt').sha256).toBe(SHA_ABC);
    expect(rowFor(LAPTOP, 'moving.txt')).toMatchObject({ sha256: null, md5: null, hashed_at: null, hash_error: null });
    expect(h.warns).toEqual(['1 file changed or went missing since they were last checked, so no checksum was kept. Check the place again to refresh them.']);
  });

  it('stores read errors on the row, warns once, and does not retry them in the same run or the next one', async () => {
    addFile(LAPTOP, 'r/ok.txt', 'abc');
    for (const name of ['bad1', 'bad2', 'bad3']) addFile(LAPTOP, `r/${name}.txt`, 'abcd');
    const hasher = recordingHasher((request) =>
      path.basename(request.path).startsWith('bad') ? Promise.resolve({ ok: false, code: 'EBUSY', message: 'Could not read it (the file is in use by another program, EBUSY).' }) : undefined,
    );
    const first = await runHash({ hasher, params: { placeId: LAPTOP } });
    expect(first.h.warns).toHaveLength(1);
    expect(first.h.warns[0]).toMatch(/^3 files could not be read and were skipped\. They are tried again after a check finds them changed, or press Start on Home to try again/);
    expect(rowFor(LAPTOP, 'bad1.txt').hash_error).toBe('Could not read it (the file is in use by another program, EBUSY).');
    expect(rowFor(LAPTOP, 'ok.txt').sha256).toBe(SHA_ABC);
    // Each bad file was tried exactly once.
    expect(hasher.opened.filter((p) => path.basename(p).startsWith('bad'))).toHaveLength(3);

    const second = await runHash({ hasher, params: { placeId: LAPTOP } });
    expect(second.message).toBe('Nothing was waiting for a checksum.');
    expect(hasher.opened.filter((p) => path.basename(p).startsWith('bad'))).toHaveLength(3);

    // "Try again" puts them back; this time the read works.
    expect(clearErrors(db, LAPTOP)).toBe(3);
    const third = await runHash({ params: { placeId: LAPTOP } });
    expect(third.message).toBe('Checked 3 files (12 bytes).');
    expect(rowFor(LAPTOP, 'bad1.txt')).toMatchObject({ sha256: expect.any(String), hash_error: null });
  });

  it('writes in small transactions with a checkpoint, and keeps what was read when the job is stopped', async () => {
    for (let i = 0; i < 6; i += 1) addFile(LAPTOP, `s/f${i}.txt`, `data${i}`);
    // Each file gives the job one yield; stop on the fourth.
    await expect(runHash({ params: { placeId: LAPTOP }, flushFiles: 2, abortAfterYields: 4, parallel: 1 })).rejects.toBeInstanceOf(JobAborted);
    const done = rowsOf(LAPTOP).filter((r) => r.sha256 !== null).length;
    expect(done).toBeGreaterThanOrEqual(3);
    expect(done).toBeLessThan(6);
  });

  it('resumes after an interruption: finished rows are not read again and the rest are done', async () => {
    for (let i = 0; i < 7; i += 1) addFile(LAPTOP, `z/f${i}.txt`, `data${i}${'x'.repeat(i)}`);
    const first = recordingHasher();
    const h1: Harness = { warns: [], logs: [], progress: [], checkpoints: [] };
    let yields = 0;
    const ctx1: JobContext = {
      jobId: 1,
      params: { placeId: LAPTOP },
      resume: null,
      signal: never,
      progress: () => {},
      log: () => {},
      warn: (t) => h1.warns.push(t),
      needsYou: () => Promise.reject(new Error('no')),
      checkpoint: (v) => h1.checkpoints.push(JSON.parse(JSON.stringify(v))),
      yield: async () => {
        yields += 1;
        if (yields > 3) throw new JobAborted();
      },
    };
    const handler = hashFilesHandler({ db, env: makeEnv(), log: silent, hasher: first, power: ac, megabytesPerSecond: () => 60, flushFiles: 1, yieldFiles: 1, parallel: 1 });
    await expect(handler.run(ctx1)).rejects.toBeInstanceOf(JobAborted);
    const hashedBefore = rowsOf(LAPTOP).filter((r) => r.sha256 !== null).length;
    expect(hashedBefore).toBeGreaterThan(0);
    expect(hashedBefore).toBeLessThan(7);
    const checkpoint = h1.checkpoints.at(-1) as { filesDone: number; hashed: number; cursor: { size: number } };
    expect(checkpoint.hashed).toBe(hashedBefore);
    expect(checkpoint.cursor.size).toBeGreaterThan(0);

    const second = recordingHasher();
    const { message } = await runHash({ params: { placeId: LAPTOP }, resume: checkpoint, hasher: second });
    expect(second.opened).toHaveLength(7 - hashedBefore);
    expect(rowsOf(LAPTOP).every((r) => r.sha256 !== null)).toBe(true);
    expect(message).toBe(`Checked 7 files (${rowsOf(LAPTOP).reduce((n, r) => n + r.size, 0)} bytes).`);

    // Even without a checkpoint (it was lost), rows without a fingerprint are the queue.
    addFile(LAPTOP, 'z/late.txt', 'late');
    const third = recordingHasher();
    await runHash({ params: { placeId: LAPTOP }, hasher: third });
    expect(third.opened.map((p) => path.basename(p))).toEqual(['late.txt']);
  });

  it('skips a drive that is not there, carries on with the other places, and says what was skipped', async () => {
    addFile(LAPTOP, 'l/a.txt', 'abc');
    addFile(DRIVE, 'd/b.txt', 'abc');
    addFile(DRIVE, 'd/c.txt', 'abcd');
    const env = makeEnv({
      locate: async (place) => (place.kind === 'drive' ? { ok: false, reason: 'unplugged', message: 'T7 was unplugged' } : { ok: true, base: '' }),
    });
    const hasher = recordingHasher();
    const { h } = await runHash({ env, hasher });
    expect(rowFor(LAPTOP, 'a.txt').sha256).toBe(SHA_ABC);
    expect(rowsOf(DRIVE).every((r) => r.sha256 === null && r.hash_error === null)).toBe(true);
    expect(hasher.opened.every((p) => !p.includes('T7'))).toBe(true);
    expect(h.warns).toEqual([skippedMessage('T7', 2)]);
    expect(h.warns[0]).toBe('T7 is not connected, so its 2 waiting files were skipped. Nothing was lost. Plug it in and choose Match copies now to continue.');
  });

  it('a drive unplugged in the middle: its files are not blamed (no read error is stored) and the job ends with a warning', async () => {
    addFile(DRIVE, 'd/a.txt', 'abc');
    addFile(DRIVE, 'd/b.txt', 'abcd');
    addFile(LAPTOP, 'l/x.txt', 'xyz');
    let plugged = true;
    const hasher = recordingHasher((request) => {
      if (request.path.endsWith('a.txt')) plugged = false; // unplugged as the first drive file is being read
      return plugged ? undefined : Promise.resolve({ ok: false, code: 'EIO', message: 'Could not read it (the disk could not be read, EIO).' });
    });
    const env = makeEnv({
      locate: async (place) => {
        if (place.kind === 'laptop') return { ok: true, base: '' };
        return plugged ? { ok: true, base: DRIVE_BASE() } : { ok: false, reason: 'unplugged', message: 'gone' };
      },
    });
    const { h } = await runHash({ env, hasher });
    expect(rowsOf(DRIVE).every((r) => r.hash_error === null)).toBe(true);
    expect(h.warns.some((w) => w.startsWith('T7 is not connected'))).toBe(true);
    expect(rowFor(LAPTOP, 'x.txt').sha256).not.toBeNull();
  });

  it('a drive file is found again from the drive letter of the day (the base can change between runs)', async () => {
    addFile(DRIVE, 'Photos/a.txt', 'abc');
    const moved = path.join(tree, 'T7-other-letter');
    fs.renameSync(DRIVE_BASE(), moved);
    const env = makeEnv({ locate: async () => ({ ok: true, base: moved }) });
    await runHash({ env, params: { placeId: DRIVE } });
    expect(rowFor(DRIVE, 'a.txt').sha256).toBe(SHA_ABC);
  });

  it('never opens a OneDrive file the cloud check says is cloud-only, missing, or could not be checked', async () => {
    const local = addFile(ONEDRIVE, 'Docs/local.txt', 'abc');
    const cloud = addFile(ONEDRIVE, 'Docs/cloud.txt', 'abcd');
    const gone = addFile(ONEDRIVE, 'Docs/gone.txt', 'abcde');
    const unknown = addFile(ONEDRIVE, 'Docs/unknown.txt', 'abcdef');
    const asked: string[][] = [];
    const hasher = recordingHasher();
    const { h } = await runHash({
      params: { placeId: ONEDRIVE },
      hasher,
      checkCloud: async (paths) => {
        asked.push(paths);
        return new Map<string, CloudCheckState>([
          [local, 'local'],
          [cloud, 'cloud'],
          [gone, 'missing'],
          // `unknown` is not answered at all
        ]);
      },
    });
    expect(unknown).toBeTruthy();
    expect(hasher.opened).toEqual([local]);
    expect(rowFor(ONEDRIVE, 'local.txt').sha256).toBe(SHA_ABC);
    expect(rowFor(ONEDRIVE, 'cloud.txt')).toMatchObject({ sha256: null, cloud_only: 1 });
    expect(rowFor(ONEDRIVE, 'gone.txt')).toMatchObject({ sha256: null, cloud_only: 0 });
    expect(rowFor(ONEDRIVE, 'unknown.txt')).toMatchObject({ sha256: null, cloud_only: 0 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(4);
    expect(h.warns.some((w) => w.includes('only in the cloud') && w.startsWith('1 OneDrive file'))).toBe(true);
    expect(h.warns.some((w) => w.includes('could not be checked'))).toBe(true);
    // A row marked cloud-only is out of the queue for good.
    expect(queueTotals(db, ONEDRIVE).files).toBe(2);
  });

  it('asks about OneDrive files in batches (never more than 5,000 paths at once) and opens nothing when the check cannot run', async () => {
    for (let i = 0; i < 7; i += 1) addFile(ONEDRIVE, `b/f${i}.txt`, `d${i}`);
    const sizes: number[] = [];
    const hasher = recordingHasher();
    const { h } = await runHash({
      params: { placeId: ONEDRIVE },
      hasher,
      batchSize: 3,
      checkCloud: async (paths) => {
        sizes.push(paths.length);
        throw new Error('The cloud-only check could not run');
      },
    });
    expect(sizes).toEqual([3]);
    expect(hasher.opened).toEqual([]);
    expect(h.warns.some((w) => w.includes('Could not check which OneDrive files are only in the cloud'))).toBe(true);
    expect(h.warns.some((w) => w.startsWith('OneDrive is not connected') || w.includes('7 waiting files'))).toBe(true);
    expect(MAX_CLOUD_CHECK_PATHS).toBe(5000);
  });

  it('pauses while on a low battery (with its message in the job), then carries on when power is back', async () => {
    addFile(LAPTOP, 'p/a.txt', 'abc');
    addFile(LAPTOP, 'p/b.txt', 'abcd');
    const readings = [
      { onBattery: true, percent: 12 },
      { onBattery: true, percent: 14 },
      { onBattery: false, percent: null },
    ];
    let i = 0;
    const power: PowerSource = { read: async () => readings[Math.min(i++, readings.length - 1)]! };
    const paused: (string | null)[] = [];
    const waits: number[] = [];
    const hasher = recordingHasher();
    const { h } = await runHash({
      power,
      hasher,
      sleep: async (ms) => {
        waits.push(ms);
        // Nothing is read while paused.
        expect(hasher.opened).toEqual([]);
      },
      env: makeEnv({ paused: (r) => paused.push(r) }),
    });
    expect(waits).toEqual([POWER_RECHECK_MS, POWER_RECHECK_MS]);
    expect(paused[0]).toMatch(/^Paused to save battery \(12% left/);
    expect(paused.at(-1)).toBeNull();
    expect(h.progress.some((p) => p.message?.startsWith('Paused to save battery'))).toBe(true);
    expect(rowsOf(LAPTOP).every((r) => r.sha256 !== null)).toBe(true);
  });

  it('reads at the speed the setting asks for', async () => {
    addFile(LAPTOP, 'v/a.txt', 'abc');
    const caps: number[] = [];
    const hasher = recordingHasher((request) => {
      caps.push(request.capBytesPerSec);
      return undefined;
    });
    await runHash({ hasher, megabytesPerSecond: () => 30 });
    expect(caps).toEqual([30_000_000]);
  });

  it('fails plainly for a place that cannot be fingerprinted', async () => {
    await expect(runHash({ params: { placeId: 'no-such-place' } })).rejects.toThrow(/cannot be checked/);
  });

  it('runs through the job service: done, and done with warnings when a drive is missing', async () => {
    addFile(LAPTOP, 'j/a.txt', 'abc');
    addFile(DRIVE, 'j/b.txt', 'abc');
    const service = new JobService({ db, log: silent });
    let plugged = true;
    service.register(
      hashFilesHandler({
        db,
        env: makeEnv({ locate: async (p) => (p.kind === 'drive' && !plugged ? { ok: false, reason: 'unplugged', message: 'gone' } : { ok: true, base: p.kind === 'drive' ? DRIVE_BASE() : '' }) }),
        log: silent,
        hasher: inProcessHasher(),
        power: ac,
        megabytesPerSecond: () => 60,
      }),
    );
    service.start();
    const finish = async (id: number): Promise<JobRecord> => {
      for (let n = 0; n < 400; n += 1) {
        const job = service.get(id);
        if (job && ['done', 'done_warnings', 'failed'].includes(job.state)) return job;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('job did not finish');
    };
    const ok = await finish(service.create(HASH_FILES_JOB_KIND, 'Match copies on STUDY-PC', { placeId: LAPTOP }));
    expect(ok.state).toBe('done');
    expect(ok.message).toBe('Checked 1 file (3 bytes).');
    plugged = false;
    const warned = await finish(service.create(HASH_FILES_JOB_KIND, 'Fingerprint files', {}));
    expect(warned.state).toBe('done_warnings');
    expect(warned.warnings).toEqual([skippedMessage('T7', 1)]);
    service.shutdown();
  });
});

describe('cloud-only path check', () => {
  it('reads helper lines', () => {
    expect(parseCloudCheckLine('0 C')).toEqual({ index: 0, state: 'cloud' });
    expect(parseCloudCheckLine('12 L\r')).toEqual({ index: 12, state: 'local' });
    expect(parseCloudCheckLine('3 M')).toEqual({ index: 3, state: 'missing' });
    expect(parseCloudCheckLine('4 E')).toEqual({ index: 4, state: 'unknown' });
    expect(parseCloudCheckLine('garbage')).toBeNull();
    expect(parseCloudCheckLine('5 X')).toBeNull();
  });

  it('the script only asks for attributes: it never opens, reads or copies a file', () => {
    expect(CLOUD_CHECK_SCRIPT).toContain('GetAttributes');
    for (const forbidden of ['OpenRead', 'ReadAllBytes', 'ReadAllText', 'Get-Content', 'FileStream', 'Copy-Item', 'Remove-Item', 'Set-Content']) {
      expect(CLOUD_CHECK_SCRIPT).not.toContain(forbidden);
    }
  });

  it('runs in groups of at most 5,000 paths and maps each answer to its path (fake helper)', async () => {
    const paths = Array.from({ length: 12001 }, (_, i) => `C:\\fake\\${i}.txt`);
    const groups: number[] = [];
    const spawnFn: SpawnFn = (_command, _args, options) => {
      const list = fs.readFileSync(options.env['BACKUPHUB_LIST']!, 'utf8').split('\n');
      groups.push(list.length);
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean };
      child.stdout = Readable.from([list.map((_p, i) => `${i} ${i % 3 === 0 ? 'C' : i % 3 === 1 ? 'L' : 'M'}`).join('\r\n') + '\r\n']);
      child.stderr = Readable.from([]);
      child.kill = () => true;
      child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      return child as never;
    };
    const result = await checkCloudOnlyPaths(paths, { spawnFn, tempDir: tree });
    expect(groups).toEqual([5000, 5000, 2001]);
    expect(result.size).toBe(12001);
    expect(result.get(paths[0]!)).toBe('cloud');
    expect(result.get(paths[1]!)).toBe('local');
    expect(result.get(paths[2]!)).toBe('missing');
    expect(result.get(paths[5000]!)).toBe('cloud'); // first path of the second group
    expect(result.get(paths[5001]!)).toBe('local');
  });

  it('a path the helper did not answer for comes back unknown, and the list file is removed', async () => {
    const spawnFn: SpawnFn = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean };
      child.stdout = Readable.from(['0 L\r\n']);
      child.stderr = Readable.from([]);
      child.kill = () => true;
      child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      return child as never;
    };
    const result = await checkCloudOnlyPaths(['C:\\a', 'C:\\b'], { spawnFn, tempDir: tree });
    expect([...result.values()]).toEqual(['local', 'unknown']);
    expect(fs.readdirSync(tree).filter((n) => n.startsWith('backuphub-cloudcheck-'))).toEqual([]);
  });

  it('rejects, in plain words, when the helper cannot run', async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('spawn denied');
    };
    await expect(checkCloudOnlyPaths(['C:\\a'], { spawnFn, tempDir: tree })).rejects.toThrow('The cloud-only check could not start (spawn denied)');
  });

  it.runIf(process.platform === 'win32')('Windows: finds a temp file marked Offline (attrib +O), a normal one and a missing one, without reading them', async () => {
    const cloudFile = path.join(tree, 'placeholder.txt');
    const plain = path.join(tree, 'plain.txt');
    fs.writeFileSync(cloudFile, 'x');
    fs.writeFileSync(plain, 'x');
    fs.writeFileSync(path.join(tree, 'ünï cödé.txt'), 'x');
    execFileSync('attrib', ['+O', cloudFile], { windowsHide: true });
    const result = await checkCloudOnlyPaths([cloudFile, plain, path.join(tree, 'missing.txt'), path.join(tree, 'ünï cödé.txt')], { timeoutMs: 60_000 });
    expect(result.get(cloudFile)).toBe('cloud');
    expect(result.get(plain)).toBe('local');
    expect(result.get(path.join(tree, 'missing.txt'))).toBe('missing');
    expect(result.get(path.join(tree, 'ünï cödé.txt'))).toBe('local'); // non-ASCII names survive the trip to PowerShell
  }, 90_000);
});

describe('migration 0005', () => {
  it('upgrades a v4 database: adds hash_error, rebuilds the queue index and resets laptop/onedrive last looked where no listing is done', () => {
    const file = path.join(dir, 'upgrade5.db');
    const old = openDatabase(file);
    runMigrations(old, MIGRATIONS.slice(0, 4));
    expect(currentSchemaVersion(old)).toBe(4);
    const place = (id: string, kind: string, looked: number | null) =>
      old.prepare("INSERT INTO places (id, profile_id, kind, label, last_looked_at, status, created_at) VALUES (?, 1, ?, ?, ?, 'connected', 1)").run(id, kind, id, looked);
    place('lap-never', 'laptop', 1690000000000); // F4 polling value, never listed
    place('lap-listed', 'laptop', 1690000000001);
    place('od-failed', 'onedrive', 1690000000002); // only a failed listing job
    place('od-running', 'onedrive', 1690000000003);
    place('od-null', 'onedrive', null);
    place('drive-1', 'drive', null);
    place('g1', 'gdrive', 1650000000000);
    const job = (kind: string, state: string, params: string) =>
      old.prepare("INSERT INTO jobs (kind, title, state, created_at, params_json) VALUES (?, 't', ?, 1, ?)").run(kind, state, params);
    job('list.place', 'done', '{"placeId":"lap-listed"}');
    job('list.place', 'failed', '{"placeId":"od-failed"}');
    job('list.place', 'running', '{"placeId":"od-running"}');
    job('hash.files', 'done', '{"placeId":"lap-never"}'); // another kind: does not count
    job('list.place', 'done', 'not json'); // a broken row must not break the migration
    old.prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, cloud_only) VALUES ('lap-listed', 'D:/a', 10, 5, 'abc', 1, 2, 0)").run();
    old.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('lap-listed', 'D:/b', 20, 1, 2)").run();

    const result = runMigrations(old);
    expect(result).toMatchObject({ from: 4, to: MIGRATIONS.length });
    expect(MIGRATIONS[4]?.name).toBe('fingerprints');
    expect(currentSchemaVersion(old)).toBe(MIGRATIONS.length);

    const looked = (id: string) => (old.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(id) as { t: number | null }).t;
    expect(looked('lap-never')).toBeNull();
    expect(looked('lap-listed')).toBe(1690000000001); // a done listing: kept
    expect(looked('od-failed')).toBeNull();
    expect(looked('od-running')).toBeNull();
    expect(looked('od-null')).toBeNull();
    expect(looked('g1')).toBe(1650000000000); // other kinds untouched

    // Existing rows keep their values and get no error.
    expect(old.prepare("SELECT size, sha256, hash_error FROM files WHERE rel_path = 'D:/a'").get()).toEqual({ size: 10, sha256: 'abc', hash_error: null });
    expect(old.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 2 });

    // The queue index skips errored rows; the two copy indexes exist.
    const names = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_files_to_hash', 'idx_files_sha256_live', 'idx_files_md5_size']));
    old.prepare("UPDATE files SET hash_error = 'busy' WHERE rel_path = 'D:/b'").run();
    const plan = old
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM files WHERE place_id = 'lap-listed' AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL ORDER BY size")
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_files_to_hash');
    expect(old.prepare("SELECT count(*) AS n FROM files WHERE place_id = 'lap-listed' AND sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL").get()).toEqual({ n: 0 });
    closeDatabase(old, silent);
  });
});

describe('FingerprintService', () => {
  /** A stand-in job service: records created jobs and lets the test send job events. */
  function fakeJobs() {
    const listeners = new Set<(event: JobChangedEvent) => void>();
    const created: { kind: string; title: string; params: unknown }[] = [];
    const params = new Map<number, unknown>();
    let nextId = 100;
    return {
      created,
      params,
      create: (kind: string, title: string, p: unknown) => {
        created.push({ kind, title, params: p });
        const id = nextId++;
        params.set(id, p);
        return id;
      },
      list: () => [] as JobRecord[],
      paramsOf: (id: number) => params.get(id) ?? null,
      onChanged: (l: (event: JobChangedEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      emit: (event: JobChangedEvent) => listeners.forEach((l) => l(event)),
    };
  }
  const job = (over: Partial<JobRecord>): JobRecord => ({
    id: 1,
    kind: HASH_FILES_JOB_KIND,
    title: 't',
    state: 'running',
    progressDone: 0,
    progressTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
    warnings: [],
    error: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
    hasCheckpoint: false,
    speed: null,
    etaSeconds: null,
    choices: [],
    paused: false,
    ...over,
  });

  let jobs: ReturnType<typeof fakeJobs>;
  let connected: Set<string>;
  let changed: number;
  let svc: FingerprintService;
  beforeEach(() => {
    const query = testQuery(Date.now);
    jobs = fakeJobs();
    connected = new Set([LAPTOP, DRIVE, ONEDRIVE]);
    changed = 0;
    svc = new FingerprintService({
      db,
      query,
      jobs: { create: jobs.create, list: jobs.list, params: jobs.paramsOf, onChanged: jobs.onChanged },
      isConnected: (id) => connected.has(id),
      onStateChanged: () => {
        changed += 1;
      },
    });
  });

  it('"Match copies now" starts one job for a connected local place, once, and only when files wait', () => {
    expect(svc.fingerprintNow(LAPTOP)).toEqual({ ok: false, message: NOTHING_WAITING_MESSAGE });
    addFile(LAPTOP, 'n/a.txt');
    const started = svc.fingerprintNow(LAPTOP);
    expect(started).toMatchObject({ ok: true });
    expect(jobs.created).toEqual([{ kind: HASH_FILES_JOB_KIND, title: 'Match copies on STUDY-PC', params: { placeId: LAPTOP } }]);
    expect(svc.stateOf(LAPTOP)).toBe('queued');
    expect(svc.stateOf(DRIVE)).toBe('idle');
    expect(svc.fingerprintNow(LAPTOP)).toMatchObject({ ok: false, message: expect.stringContaining('already being checked') });
    connected.delete(DRIVE);
    addFile(DRIVE, 'n/b.txt');
    expect(svc.fingerprintNow(DRIVE)).toMatchObject({ ok: false, message: 'T7 is not connected, so its files cannot be read now.' });
    expect(svc.fingerprintNow('nope')).toMatchObject({ ok: false });
    expect(svc.fingerprintNow(42)).toMatchObject({ ok: false });
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('gd', 1, 'gdrive', 'Mail', 'unknown', 1)").run();
    expect(svc.fingerprintNow('gd')).toMatchObject({ ok: false, message: expect.stringContaining('Only the laptop') });
  });

  it('"Check them now" starts ONE job for every connected place with files waiting, only when something waits, and not twice', () => {
    expect(svc.checkAllNow()).toEqual({ ok: false, message: NOTHING_WAITING_MESSAGE });
    addFile(LAPTOP, 'n/a.txt');
    addFile(DRIVE, 'n/b.txt');
    connected.delete(ONEDRIVE);
    const started = svc.checkAllNow();
    expect(started).toMatchObject({ ok: true });
    expect(jobs.created).toEqual([{ kind: HASH_FILES_JOB_KIND, title: 'Check new and changed files', params: {} }]);
    expect(svc.stateOf(LAPTOP)).toBe('queued');
    expect(svc.stateOf(DRIVE)).toBe('queued');
    expect(svc.checkAllNow()).toMatchObject({ ok: false, message: expect.stringContaining('already under way') });
    expect(jobs.created).toHaveLength(1);
  });

  it('"Check them now" does not read a place that is not connected', () => {
    addFile(DRIVE, 'n/b.txt');
    connected.delete(DRIVE);
    expect(svc.checkAllNow()).toEqual({ ok: false, message: NOTHING_WAITING_MESSAGE });
    expect(jobs.created).toEqual([]);
  });

  it('a listing that ends starts nothing: fingerprinting is only started by the person', () => {
    addFile(LAPTOP, 'a/a.txt');
    jobs.params.set(7, { placeId: LAPTOP });
    jobs.emit({ reason: 'state', job: job({ id: 7, kind: LIST_PLACE_JOB_KIND, state: 'done', finishedAt: 5 }) });
    expect(jobs.created).toEqual([]);
  });

  it('"Try again" puts failed files back and starts a job only when the place is connected', () => {
    addFile(LAPTOP, 'a/a.txt');
    addFile(DRIVE, 'a/b.txt');
    db.prepare("UPDATE files SET hash_error = 'busy'").run();
    expect(svc.retryFailed(LAPTOP)).toEqual({ ok: true, requeued: 1, jobId: expect.any(Number) });
    connected.delete(DRIVE);
    expect(svc.retryFailed(DRIVE)).toEqual({ ok: true, requeued: 1, jobId: null });
    expect(queueTotals(db, DRIVE).files).toBe(1);
    expect(svc.retryFailed('gone')).toMatchObject({ ok: false });
  });

  it('describes a place: counts, state with speed and pause reason, and coverage (counted off the call)', async () => {
    addFile(LAPTOP, 'a/one.txt', 'abc');
    addFile(LAPTOP, 'a/two.txt', 'abcd');
    addFile(LAPTOP, 'a/three.txt', 'abcde');
    db.prepare("UPDATE files SET sha256 = ?, md5 = ? WHERE rel_path LIKE '%one.txt'").run(SHA_ABC, MD5_ABC);
    db.prepare("UPDATE files SET hash_error = 'busy' WHERE rel_path LIKE '%three.txt'").run();
    // The first look only asks the query service; the numbers are in on the next one.
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ fileCount: 0, coverage: null, countedAt: null });
    await settle();
    const fp = svc.fingerprintOf(LAPTOP, 'laptop');
    expect(fp).toMatchObject({ fileCount: 3, fingerprintedFiles: 1, totalBytes: 12, fingerprintedBytes: 3, failedFiles: 1, state: 'idle', speedBytesPerSec: null, detail: null });
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage).toMatchObject({ none: { files: 1, bytes: 3 }, notFingerprinted: { files: 2 } });
    expect(svc.fingerprintOf('gd', 'gdrive')).toBeNull();

    jobs.params.set(50, { placeId: LAPTOP });
    jobs.emit({ reason: 'created', job: job({ id: 50, state: 'queued' }) });
    jobs.emit({ reason: 'state', job: job({ id: 50, state: 'running', speed: { unit: 'bytes', perSecond: 55_000_000 }, message: 'Matching copies on STUDY-PC: 1 of 3 files' }) });
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ state: 'running', speedBytesPerSec: 55_000_000, detail: 'Matching copies on STUDY-PC: 1 of 3 files' });
    svc.notePaused('Paused to save battery (12% left, not plugged in). It continues when you plug in or the battery is above 30%.');
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ state: 'paused', speedBytesPerSec: null, detail: expect.stringMatching(/^Paused to save battery/) });
    jobs.emit({ reason: 'state', job: job({ id: 50, state: 'done', finishedAt: 9 }) });
    expect(svc.stateOf(LAPTOP)).toBe('idle');
    expect(changed).toBeGreaterThan(0);
  });
});

describe('speed: small files in one read, several at once', () => {
  /** Creates n small real files in the temp tree and their rows in one go. Returns the folder. */
  function bulkFiles(n: number, folder = 'bulk'): void {
    const base = path.join(LAPTOP_BASE(), folder);
    fs.mkdirSync(base, { recursive: true });
    const listed = [];
    for (let i = 0; i < n; i += 1) {
      const abs = path.join(base, `f${i}.txt`);
      fs.writeFileSync(abs, `file number ${i} ${'x'.repeat(i % 700)}`);
      const st = fs.lstatSync(abs);
      listed.push({ relPath: toSlashes(abs), size: st.size, mtimeMs: Math.trunc(st.mtimeMs), cloudOnly: false });
    }
    upsertFiles(db, LAPTOP, listed, 1000, false);
  }

  // 300 files per second is a hard limit only when benchmarking (BACKUPHUB_BENCH=1, as in query.test.ts); on a loaded machine the
  // normal run only checks that every file gets both digests, at 20 files per second or better.
  it('benchmark: 5,000 small files (no cap) run at 300 files per second or better (20 when not benchmarking)', async () => {
    bulkFiles(5000);
    const t0 = performance.now();
    const { message } = await runHash({ params: { placeId: LAPTOP }, megabytesPerSecond: () => 0, yieldFiles: 500 });
    const seconds = (performance.now() - t0) / 1000;
    const rate = 5000 / seconds;
    console.log(`BENCHMARK 5000 small files: ${seconds.toFixed(2)} s = ${Math.round(rate)} files/s`);
    expect(message).toContain('Checked 5,000 files');
    expect(rowsOf(LAPTOP).every((r) => r.sha256 !== null && r.md5 !== null)).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(process.env['BACKUPHUB_BENCH'] === '1' ? 300 : 20);
  }, 300_000);

  it('a small file is read in one go and gives the same digests as the stream; a grown file shows a wrong byte count', async () => {
    const abs = addFile(LAPTOP, 'one.txt', 'abc');
    const opts = { capBytesPerSec: 0, isCancelled: () => false };
    expect(await hashFile(abs, { ...opts, sizeHint: 3 })).toEqual({ ok: true, sha256: SHA_ABC, md5: MD5_ABC, bytes: 3 });
    expect(await hashFile(abs, { ...opts })).toEqual({ ok: true, sha256: SHA_ABC, md5: MD5_ABC, bytes: 3 });
    const grown = await hashFile(abs, { ...opts, sizeHint: 2 });
    expect(grown.ok && grown.bytes).toBe(3); // one more than the listing saw: the job discards it
    const empty = addFile(LAPTOP, 'empty.txt', '');
    expect(await hashFile(empty, { ...opts, sizeHint: 0 })).toEqual({ ok: true, sha256: SHA_EMPTY, md5: MD5_EMPTY, bytes: 0 });
    const missing = await hashFile(path.join(tree, 'nope.txt'), { ...opts, sizeHint: 5 });
    expect(missing).toMatchObject({ ok: false, code: 'ENOENT' });
  });

  it('the shared throttle keeps the total at the cap however many files read at once', () => {
    let t = 10_000;
    const throttle = new SharedThrottle(() => t);
    expect(throttle.take(1_000_000, 0)).toBe(0); // no limit
    // Ten reads of 6 MB at 60 MB/s at the same moment: the last waits for all of them (one second), minus the banked half second.
    const waits = Array.from({ length: 10 }, () => throttle.take(6_000_000, 60_000_000));
    expect(waits[9]!).toBeGreaterThan(waits[0]!);
    expect(waits[9]!).toBeLessThanOrEqual(1000);
    t += 5000; // a long idle time only banks half a second
    expect(throttle.take(60_000_000, 60_000_000)).toBe(500);
  });

  it('runs up to 8 small files at once, and a big file alone', async () => {
    for (let i = 0; i < 30; i += 1) addFile(LAPTOP, `p/f${String(i).padStart(2, '0')}.txt`, `data ${i}`);
    const measure = async (bigFileBytes?: number): Promise<number> => {
      let running = 0;
      let peak = 0;
      const hasher = recordingHasher((_req, real) => {
        running += 1;
        peak = Math.max(peak, running);
        return new Promise((resolve) =>
          setTimeout(() => {
            void real().then((r) => {
              running -= 1;
              resolve(r);
              return undefined;
            });
          }, 5),
        );
      });
      db.prepare('UPDATE files SET sha256 = NULL, md5 = NULL WHERE place_id = ?').run(LAPTOP);
      await runHash({ params: { placeId: LAPTOP }, hasher, ...(bigFileBytes !== undefined ? { bigFileBytes } : {}) });
      return peak;
    };
    const peak = await measure();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(await measure(1)).toBe(1);
  });

  it('allows 1 big file at a time under 250 MB/s and 2 at 250 or No limit; the big files are marked wide only then', async () => {
    for (let i = 0; i < 6; i += 1) addFile(LAPTOP, `big/f${i}.txt`, `data ${i}`);
    const measure = async (mb: number): Promise<{ peak: number; wide: number }> => {
      let running = 0;
      let peak = 0;
      let wide = 0;
      const hasher = recordingHasher((req, real) => {
        running += 1;
        peak = Math.max(peak, running);
        if (req.wide) wide += 1;
        return new Promise((resolve) =>
          setTimeout(() => {
            void real().then((r) => {
              running -= 1;
              resolve(r);
              return undefined;
            });
          }, 5),
        );
      });
      db.prepare('UPDATE files SET sha256 = NULL, md5 = NULL WHERE place_id = ?').run(LAPTOP);
      // bigFileBytes 1: every file counts as big.
      await runHash({ params: { placeId: LAPTOP }, hasher, bigFileBytes: 1, megabytesPerSecond: () => mb });
      return { peak, wide };
    };
    expect(await measure(30)).toEqual({ peak: 1, wide: 0 });
    expect(await measure(120)).toEqual({ peak: 1, wide: 0 });
    expect(await measure(250)).toEqual({ peak: 2, wide: 6 });
    expect(await measure(0)).toEqual({ peak: 2, wide: 6 });
    expect(bigFileLimit(60)).toBe(1);
    expect(bigFileLimit(249)).toBe(1);
    expect(bigFileLimit(250)).toBe(2);
    expect(bigFileLimit(0)).toBe(2);
  });

  it('with two big files at once the checkpoint cursor still only passes rows that are all finished', async () => {
    for (let i = 0; i < 8; i += 1) addFile(LAPTOP, `two/f${String(i).padStart(2, '0')}.txt`, `data${i}`);
    const hasher = recordingHasher((req, real) =>
      req.path.endsWith('f00.txt') ? new Promise((resolve) => setTimeout(() => void real().then(resolve), 60)) : undefined,
    );
    const checked: number[] = [];
    let peak = 0;
    let running = 0;
    const counting = recordingHasher((req) => {
      running += 1;
      peak = Math.max(peak, running);
      return hasher.hash(req).finally(() => (running -= 1));
    });
    const ctx: JobContext = {
      jobId: 1,
      params: { placeId: LAPTOP },
      resume: null,
      signal: never,
      progress: () => {},
      log: () => {},
      warn: () => {},
      needsYou: () => Promise.reject(new Error('no')),
      checkpoint: (v) => {
        const cursor = (v as { cursor: { size: number; id: number } }).cursor;
        const open = rowsOf(LAPTOP).filter((r) => r.sha256 === null && (r.size < cursor.size || (r.size === cursor.size && r.id <= cursor.id)));
        checked.push(open.length);
      },
      yield: async () => {},
    };
    const handler = hashFilesHandler({ db, env: makeEnv(), log: silent, hasher: counting, power: ac, megabytesPerSecond: () => 0, flushFiles: 1, bigFileBytes: 1 });
    await handler.run(ctx);
    expect(peak).toBe(2);
    expect(checked.length).toBeGreaterThan(3);
    expect(checked.every((n) => n === 0)).toBe(true);
    expect(rowsOf(LAPTOP).every((r) => r.sha256 !== null)).toBe(true);
  });

  it('two threads sharing one budget read at the cap in total, not twice the cap', () => {
    let t = 1_000_000;
    const buffer = SharedThrottle.createShared();
    const a = new SharedThrottle(() => t, buffer);
    const b = new SharedThrottle(() => t, buffer);
    const lone = new SharedThrottle(() => t);
    // Two threads each read 60 MB at a 60 MB/s cap at the same instant.
    const waits = [a.take(60_000_000, 60_000_000), b.take(60_000_000, 60_000_000)];
    expect(waits).toEqual([500, 1500]); // the second one waits for the first one's turn
    // Separate budgets would each wait only 500 ms (double the speed).
    expect([lone.take(60_000_000, 60_000_000), new SharedThrottle(() => t).take(60_000_000, 60_000_000)]).toEqual([500, 500]);
    t += 5_000;
    expect(a.take(1_000_000, 60_000_000)).toBeLessThanOrEqual(1); // time passed: no debt carried
    expect(a.take(1_000_000, 0)).toBe(0); // no limit never waits
  });

  it('checkpoints only a cursor below which every row is finished, even when a small file is slow', async () => {
    for (let i = 0; i < 12; i += 1) addFile(LAPTOP, `c/f${String(i).padStart(2, '0')}.txt`, `data${i}`);
    const hasher = recordingHasher((req, real) =>
      req.path.endsWith('f00.txt') ? new Promise((resolve) => setTimeout(() => void real().then(resolve), 60)) : undefined,
    );
    const checked: number[] = [];
    const ctx: JobContext = {
      jobId: 1,
      params: { placeId: LAPTOP },
      resume: null,
      signal: never,
      progress: () => {},
      log: () => {},
      warn: () => {},
      needsYou: () => Promise.reject(new Error('no')),
      checkpoint: (v) => {
        const cursor = (v as { cursor: { size: number; id: number } }).cursor;
        const open = rowsOf(LAPTOP).filter((r) => r.sha256 === null && (r.size < cursor.size || (r.size === cursor.size && r.id <= cursor.id)));
        checked.push(open.length);
      },
      yield: async () => {},
    };
    const handler = hashFilesHandler({ db, env: makeEnv(), log: silent, hasher, power: ac, megabytesPerSecond: () => 60, flushFiles: 1, parallel: 4 });
    await handler.run(ctx);
    expect(checked.length).toBeGreaterThan(3);
    expect(checked.every((n) => n === 0)).toBe(true);
    expect(rowsOf(LAPTOP).every((r) => r.sha256 !== null)).toBe(true);
  });

  it('a OneDrive check older than the limit is repeated for the rest of the batch before more files are read', async () => {
    for (let i = 0; i < 6; i += 1) addFile(ONEDRIVE, `r/f${i}.txt`, `data${i}`);
    let clock = 1_000_000;
    const asked: number[] = [];
    let opened = 0;
    const hasher = recordingHasher(() => {
      opened += 1;
      if (opened === 3) clock += 11 * 60_000;
      return undefined;
    });
    await runHash({
      params: { placeId: ONEDRIVE },
      hasher,
      parallel: 1,
      now: () => clock,
      checkCloud: async (paths) => {
        asked.push(paths.length);
        return new Map(paths.map((p) => [p, 'local']));
      },
    });
    expect(asked).toEqual([6, 3]);
    expect(opened).toBe(6);
  });

  it("OneDrive's own dot-and-GUID marker file is never opened and never counted as failed", async () => {
    addFile(ONEDRIVE, '.849C9593-D756-4E56-8D6E-42412F2A707B', 'locked');
    addFile(ONEDRIVE, 'real.txt', 'abc');
    const hasher = recordingHasher();
    const { h } = await runHash({
      params: { placeId: ONEDRIVE },
      hasher,
      checkCloud: async (paths) => new Map(paths.map((p) => [p, 'local'])),
    });
    expect(hasher.opened.map((p) => path.basename(p))).toEqual(['real.txt']);
    expect(h.warns.some((w) => w.includes('could not be read'))).toBe(false);
    expect(rowFor(ONEDRIVE, '.849C9593-D756-4E56-8D6E-42412F2A707B').hash_error).toBeNull();
  });
});

describe('FingerprintService: your pause, both speeds, failed reason, coverage refresh', () => {
  const baseJob = (over: Partial<JobRecord>): JobRecord => ({
    id: 7,
    kind: HASH_FILES_JOB_KIND,
    title: 't',
    state: 'running',
    progressDone: 0,
    progressTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
    warnings: [],
    error: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
    hasCheckpoint: false,
    speed: null,
    etaSeconds: null,
    choices: [],
    paused: false,
    ...over,
  });

  function setup() {
    const listeners = new Set<(event: JobChangedEvent) => void>();
    let clock = 1_000_000;
    const svc = new FingerprintService({
      db,
      query: testQuery(() => clock),
      jobs: {
        create: () => 7,
        list: () => [],
        params: () => ({ placeId: LAPTOP }),
        onChanged: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      isConnected: () => true,
      now: () => clock,
    });
    const emit = (event: JobChangedEvent): void => listeners.forEach((l) => l(event));
    return { svc, emit, tick: (ms: number) => (clock += ms) };
  }

  it('shows files per second and bytes per second, the job to pause or stop, and "Paused by you"', () => {
    addFile(LAPTOP, 'q/a.txt');
    const { svc, emit } = setup();
    emit({ reason: 'state', job: baseJob({ speed: { unit: 'bytes', perSecond: 2_100_000, itemsPerSecond: 38 } }) });
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ state: 'running', speedBytesPerSec: 2_100_000, speedFilesPerSec: 38, job: { id: 7, paused: false } });
    emit({ reason: 'state', job: baseJob({ state: 'queued', paused: true }) });
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ state: 'paused', detail: 'Paused by you', speedBytesPerSec: null, job: { id: 7, paused: true } });
    emit({ reason: 'state', job: baseJob({ state: 'done', finishedAt: 5 }) });
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ state: 'idle', job: null });
  });

  it('gives the first failure reason for the Try again tooltip, only when files failed', async () => {
    addFile(LAPTOP, 'q/ok.txt');
    const bad = addFile(LAPTOP, 'q/bad.txt');
    const { svc } = setup();
    svc.fingerprintOf(LAPTOP, 'laptop');
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.failedReason).toBeNull();
    db.prepare("UPDATE files SET hash_error = 'Could not read it (EBUSY).' WHERE rel_path = ?").run(toSlashes(bad));
    svc.invalidate();
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')).toMatchObject({ failedFiles: 1, failedReason: 'Could not read it (EBUSY).' });
  });

  it('counts the coverage lines again at most every 60 s while hashing runs, and keeps showing the old lines meanwhile', async () => {
    const a = addFile(LAPTOP, 'q/a.txt', 'aaa');
    addFile(LAPTOP, 'q/b.txt', 'bbbb');
    const { svc, emit, tick } = setup();
    const progress = () => emit({ reason: 'progress', job: baseJob({}) });
    db.prepare('UPDATE files SET sha256 = ?, md5 = ? WHERE rel_path = ?').run('s1', 'm1', toSlashes(a));
    svc.fingerprintOf(LAPTOP, 'laptop');
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage?.notFingerprinted.files).toBe(1);
    db.prepare("UPDATE files SET sha256 = 's2', md5 = 'm2' WHERE sha256 IS NULL AND place_id = ?").run(LAPTOP);
    tick(30_000);
    progress(); // too early: nothing is counted again
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage?.notFingerprinted.files).toBe(1);
    tick(31_000);
    progress(); // a minute passed: counted again (the old lines were never blanked)
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage?.notFingerprinted.files).toBe(0);
  });

  it('counts once more when the job ends, whatever the time since the last count', async () => {
    const a = addFile(LAPTOP, 'q/a.txt', 'aaa');
    const { svc, emit } = setup();
    svc.fingerprintOf(LAPTOP, 'laptop');
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage?.notFingerprinted.files).toBe(1);
    db.prepare('UPDATE files SET sha256 = ?, md5 = ? WHERE rel_path = ?').run('s1', 'm1', toSlashes(a));
    emit({ reason: 'state', job: baseJob({ state: 'done', finishedAt: 9 }) });
    await settle();
    expect(svc.fingerprintOf(LAPTOP, 'laptop')?.coverage?.notFingerprinted.files).toBe(0);
  });
});
