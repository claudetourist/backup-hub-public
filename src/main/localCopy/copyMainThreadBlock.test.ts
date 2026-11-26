import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { realMirrorDrive } from '../mirror/mirrorDrive';
import { turn } from '../sliceWork';
import { driveTmpFolder } from '../places/appFolders';
import { adoptVerifiedTemp, settleLeftover, sweepStaleTemps, tempPathFor, verifiedCopy } from './verifiedCopy';

/**
 * The window must not freeze while a copy waits for a slow USB drive (found 25 Nov 2026 with the CPU recorder: fs.utimesSync, fs.linkSync, fs.rmSync and
 * fs.mkdirSync on the drive each held the main thread 0.6 to 0.9 s). Here the drive is made slow on purpose: every call that touches a path in the test
 * "drive" and has a synchronous form waits ${SYNC_BLOCK_MS} ms ON THE CALLING THREAD (what a slow drive does to a sync call), and every promise form waits
 * ${ASYNC_WAIT_MS} ms without holding the thread (what it does to a call that runs on the thread pool). A timer on the main thread says how late it fires, which
 * is exactly what a frozen window is. Nothing on a copy path may use the synchronous forms: the counter must stay at zero.
 */
const MAX_BLOCK_MS = 250;
const SYNC_BLOCK_MS = 400;
const ASYNC_WAIT_MS = 120;
const FILE_BYTES = 1024 * 1024;

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
let drive: string;
let tmpDir: string;
let syncCalls: string[];
let slowAsyncCalls: string[];
const restore: (() => void)[] = [];

const SYNC_NAMES = ['utimesSync', 'linkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'statSync', 'existsSync', 'readdirSync', 'renameSync', 'writeFileSync', 'statfsSync', 'unlinkSync', 'copyFileSync'] as const;
const ASYNC_NAMES = ['utimes', 'link', 'rm', 'rmdir', 'mkdir', 'stat', 'readdir', 'rename', 'writeFile', 'statfs', 'unlink', 'copyFile'] as const;

const onDrive = (arg: unknown): boolean => typeof arg === 'string' && path.resolve(arg).toLowerCase().startsWith(drive.toLowerCase());
const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

/** Puts the real fs back (the test's own sync checks must not count) and returns the synchronous calls the product made on the drive. */
function plain(): string[] {
  for (const undo of restore.splice(0)) undo();
  return [...syncCalls];
}

/** Makes the "drive" slow: sync forms block the calling thread, promise forms only take time. */
function slowDrive(): void {
  const mutableFs = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of SYNC_NAMES) {
    const real = mutableFs[name]!;
    const spy = vi.spyOn(mutableFs as never, name as never).mockImplementation(((...a: unknown[]) => {
      if (onDrive(a[0]) || onDrive(a[1])) {
        syncCalls.push(`${name} ${String(a[0])}`);
        busy(SYNC_BLOCK_MS);
      }
      return real.apply(fs, a);
    }) as never);
    restore.push(() => spy.mockRestore());
  }
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ASYNC_NAMES) {
    const real = promises[name]!;
    const spy = vi.spyOn(promises as never, name as never).mockImplementation((async (...a: unknown[]) => {
      if (onDrive(a[0]) || onDrive(a[1])) {
        slowAsyncCalls.push(name);
        await new Promise((resolve) => setTimeout(resolve, ASYNC_WAIT_MS));
      }
      return real.apply(fs.promises, a);
    }) as never);
    restore.push(() => spy.mockRestore());
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-copy-block-'));
  drive = path.join(dir, 'drive');
  tmpDir = driveTmpFolder(drive);
  fs.mkdirSync(path.join(drive, 'BackupHub'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  syncCalls = [];
  slowAsyncCalls = [];
});
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

const bytes = (n: number, seed: number): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed) % 251;
  return b;
};
const sourceFile = (name: string, seed: number): string => {
  const p = path.join(dir, 'source', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes(FILE_BYTES, seed));
  return p;
};

describe('a slow drive does not freeze the main thread during a copy', () => {
  it('the fake bites: one synchronous call on the slow drive blocks the main thread (what the app did before)', async () => {
    slowDrive();
    await turn();
    const dog = watchdog();
    fs.utimesSync(path.join(drive, 'BackupHub'), new Date(), new Date());
    const block = await dog.stop();
    console.log(`ONE SYNC utimes ON A SLOW DRIVE (before the fix): longest block ${block} ms`);
    expect(block).toBeGreaterThan(MAX_BLOCK_MS);
    expect(syncCalls).toHaveLength(1);
  });

  it('a verified copy (copy.toLocal and the app data copy): no synchronous call on the drive, longest block under the limit', async () => {
    const src = sourceFile('a.bin', 7);
    const final = path.join(drive, 'BackupHub', 'new-folder', 'a.bin');
    // An earlier cut-off copy left its temp name behind: it is cleared (a remove on the drive) and an old stray temp file is swept.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tempPathFor(final, tmpDir), 'half');
    fs.writeFileSync(path.join(tmpDir, 'stray.bhtmp'), 'old');
    slowDrive();
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    await fs.promises.mkdir(path.dirname(final), { recursive: true });
    const result = await verifiedCopy({ source: src, final, size: FILE_BYTES, yieldNow: turn, tmpDir });
    const swept = await sweepStaleTemps(tmpDir);
    const block = await dog.stop();
    const made = plain();
    console.log(`VERIFIED COPY ON A SLOW DRIVE: ${Math.round(performance.now() - t0)} ms, longest block ${block} ms, ${slowAsyncCalls.length} slow calls`);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(final).equals(bytes(FILE_BYTES, 7))).toBe(true);
    expect(fs.existsSync(tempPathFor(final, tmpDir))).toBe(false);
    expect(swept).toBe(1); // the stray half-written temp file of ours; the one of this copy was cleared by the copy itself
    expect(made).toEqual([]);
    expect(slowAsyncCalls.length).toBeGreaterThan(4); // the fake really was in the way
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 60_000);

  it('a mirror copy to the second drive (temp write, utimes, flush, read back, link, remove) and a leftover settle: no synchronous call, longest block under the limit', async () => {
    slowDrive();
    const src = sourceFile('b.bin', 11);
    const dst = realMirrorDrive({ db: null as never, placeId: 'p', label: 'Second', root: drive, quickRunner: {} as never, tmpDir });
    const rel = 'BackupHub/mirror/b.bin';
    const final = dst.finalPath(rel);
    const tmp = dst.tmpPath(final);
    await turn();
    const dog = watchdog();
    await dst.settle(final, async () => true);
    expect(await dst.ops.exists(final)).toBe(false);
    await dst.ensureDir(final);
    const writer = await dst.openTemp(tmp);
    await writer.write(fs.readFileSync(src));
    await writer.finish(Date.UTC(2020, 0, 2, 3, 4, 6));
    const expectedSha = (await import('node:crypto')).createHash('sha256').update(bytes(FILE_BYTES, 11)).digest('hex');
    const placed = await adoptVerifiedTemp({ tmp, final, size: FILE_BYTES, expectedSha256: expectedSha, yieldNow: turn, ops: dst.ops });
    expect(await dst.ops.sizeOf(final)).toBe(FILE_BYTES);
    expect(await dst.freeBytes()).not.toBeUndefined();
    // A second look at the same name: the file is there, the temp name is not.
    expect(await settleLeftover(final, { tmpDir, isExpected: async () => true })).toBe('none');
    const block = await dog.stop();
    const made = plain();
    console.log(`MIRROR COPY ON A SLOW DRIVE: longest block ${block} ms, ${slowAsyncCalls.length} slow calls`);
    expect(placed).toEqual({ ok: true });
    expect(fs.readFileSync(final).equals(bytes(FILE_BYTES, 11))).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(Math.round(fs.statSync(final).mtimeMs / 1000)).toBe(Math.round(Date.UTC(2020, 0, 2, 3, 4, 6) / 1000));
    expect(made).toEqual([]);
    expect(slowAsyncCalls.length).toBeGreaterThan(4);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 60_000);

  it('a link never replaces: a name that is taken stays as it is and the copy says so', async () => {
    const src = sourceFile('c.bin', 13);
    const final = path.join(drive, 'BackupHub', 'c.bin');
    fs.writeFileSync(final, 'someone else');
    slowDrive();
    // verifiedCopy refuses before it writes anything; adopting a temp file onto a taken name fails with EEXIST at the link and removes only the temp name.
    expect(await verifiedCopy({ source: src, final, size: FILE_BYTES, yieldNow: turn, tmpDir })).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(final, 'utf8')).toBe('someone else');
    const racing = path.join(drive, 'BackupHub', 'd.bin');
    const dst = realMirrorDrive({ db: null as never, placeId: 'p', label: 'Second', root: drive, quickRunner: {} as never, tmpDir });
    const tmp = dst.tmpPath(racing);
    await dst.ensureDir(racing);
    const writer = await dst.openTemp(tmp);
    await writer.write(fs.readFileSync(src));
    await writer.finish(Date.now());
    const sha = (await import('node:crypto')).createHash('sha256').update(bytes(FILE_BYTES, 13)).digest('hex');
    const ops = { ...dst.ops, exists: async () => false }; // the name appears between the look and the link
    await fs.promises.writeFile(racing, 'appeared meanwhile');
    const adopted = await adoptVerifiedTemp({ tmp, final: racing, size: FILE_BYTES, expectedSha256: sha, yieldNow: turn, ops });
    const made = plain();
    expect(adopted).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(racing, 'utf8')).toBe('appeared meanwhile');
    expect(fs.existsSync(tmp)).toBe(false);
    expect(made).toEqual([]);
  }, 60_000);
});
