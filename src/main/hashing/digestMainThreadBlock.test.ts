import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashUnbuffered } from '../localCopy/directRead';
import { verifiedCopy } from '../localCopy/verifiedCopy';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { recordCheckedBatch, type CheckedLink } from '../mirror/mirrorStore';
import { linkOriginOnly } from '../folderBackup/folderStore';
import { turn, writeSliced } from '../sliceWork';
import { closeDigestWorker, setDigestWorkerPath } from './blockDigest';

/**
 * The window must not freeze while a copy or a check reads a big file (found 25 Nov 2026 with the CPU recorder: SHA-256 `hash.update` on the main
 * thread stalled up to ~2 s, and the result rows were written in big transactions of 0.5 to 1 s). A 1 GiB generated file is read the way a copy does
 * (cache-free, every block handed on) with its checksum made on the worker thread, and a big batch of results is written in sliced transactions; a timer
 * on the main thread says how late it fires, which is exactly what a frozen window is.
 */
const MAX_BLOCK_MS = 250;
const FILE_BYTES = 1024 * 1024 * 1024;
const ROWS = 40_000;

/** The longest time the main thread did not get back to its timers (a gap in which the process had no CPU is not ours: see phoneBackup/mainThreadBlock.test.ts). */
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

const sha256Of = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

let dir: string;
let outDir: string;
let bigFile: string;
let expected: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-digest-block-'));
  bigFile = path.join(dir, 'big.bin');
  // 1 GiB, different bytes in every 16 MiB piece.
  const piece = Buffer.alloc(16 * 1024 * 1024, 7);
  const fd = fs.openSync(bigFile, 'w');
  for (let i = 0; i < FILE_BYTES / piece.length; i += 1) {
    piece.writeUInt32LE(i * 2654435761 >>> 0, 0);
    piece.writeUInt32LE(i, 4096);
    fs.writeSync(fd, piece);
  }
  fs.closeSync(fd);
  expected = await sha256Of(bigFile);
  // The checksum worker, built the way Forge does.
  outDir = path.join(process.cwd(), 'node_modules', '.cache', 'digest-block-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: path.join(__dirname, 'digestWorker.ts'),
      rollupOptions: { external: ['better-sqlite3'], output: { format: 'cjs', entryFileNames: 'digestWorker.js' } },
    },
  });
}, 300_000);

afterAll(() => {
  closeDigestWorker();
  setDigestWorkerPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe('the checksum of a big file does not freeze the main thread', () => {
  it('in place on the main thread (what the app did before): the block this fixes', async () => {
    setDigestWorkerPath(null);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    let seen = 0;
    const hash = await hashUnbuffered(bigFile, { md5: true, onBlock: (b) => void (seen += b.length), yieldNow: turn });
    const block = await dog.stop();
    console.log(`HASH 1 GiB IN PLACE (before the fix): ${Math.round(performance.now() - t0)} ms, longest block ${block} ms`);
    expect(hash.sha256).toBe(expected);
    expect(seen).toBe(FILE_BYTES);
  }, 180_000);

  it('on the worker thread: every block still handed on, same checksum, longest block under the limit', async () => {
    setDigestWorkerPath(path.join(outDir, 'digestWorker.js'));
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    let seen = 0;
    const hash = await hashUnbuffered(bigFile, { md5: true, onBlock: (b) => void (seen += b.length), yieldNow: turn });
    const block = await dog.stop();
    console.log(`HASH 1 GiB ON THE WORKER: ${Math.round(performance.now() - t0)} ms, longest block ${block} ms`);
    expect(hash.sha256).toBe(expected);
    expect(hash.bytes).toBe(FILE_BYTES);
    expect(seen).toBe(FILE_BYTES);
    expect(hash.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 180_000);

  it('a verified copy of the big file (read, write, read back) checks out and never blocks', async () => {
    const final = path.join(dir, 'copy', 'big-copy.bin');
    fs.mkdirSync(path.dirname(final), { recursive: true });
    await turn();
    const dog = watchdog();
    const result = await verifiedCopy({ source: bigFile, final, size: FILE_BYTES, yieldNow: turn, tmpDir: path.join(dir, 'tmp') });
    const block = await dog.stop();
    console.log(`VERIFIED COPY 1 GiB: longest block ${block} ms`);
    expect(result.ok && result.hashes.sha256).toBe(expected);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 300_000);

  it('a stopped worker fails the file in hand, the next file is hashed (a worker that cannot start is given up on)', async () => {
    setDigestWorkerPath(path.join(dir, 'no-such-worker.js'));
    const small = path.join(dir, 'half.bin');
    fs.writeFileSync(small, Buffer.alloc(2 * 1024 * 1024, 3));
    await expect(hashUnbuffered(small)).rejects.toThrow();
    const again = await hashUnbuffered(small);
    expect(again.sha256).toBe(createHash('sha256').update(Buffer.alloc(2 * 1024 * 1024, 3)).digest('hex'));
  }, 60_000);
});

describe('a big batch of results is written in short transactions', () => {
  let rig: Rig;
  let w: World;
  const place = (): string => w.destinations[0]!.placeId;
  const relOf = (i: number): string => `MyData/POCO/Poco-F4-24Nov26/DCIM/Camera${i % 60}/IMG_${String(i).padStart(6, '0')}.jpg`;

  beforeAll(() => {
    rig = makeRig();
    w = new World(rig, { seed: 9, drives: [{ caseInsensitive: true }] });
    rig.db.pragma('wal_autocheckpoint = 0');
    const insert = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, ?, 1, 1, 'photos')");
    rig.db.transaction(() => {
      for (let i = 0; i < ROWS * 2; i += 1) insert.run(place(), relOf(i), 1000 + i, 1_700_000_000_000 + i);
    })();
  });
  afterAll(() => {
    w.dispose();
    rig.close();
  });

  const linksOf = (from: number): CheckedLink[] => {
    const links: CheckedLink[] = [];
    for (let i = from; i < from + ROWS; i += 1) links.push({ dstPlaceId: place(), dstRel: relOf(i), size: 1000 + i, mtimeMs: 1_700_000_000_000 + i, sha256: `${i}`.padStart(64, 'a'), originId: null, srcRowId: 1, srcRead: false, now: 5 });
    return links;
  };

  it('all in one transaction (before the fix): the block this fixes', async () => {
    const links = linksOf(0);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    recordCheckedBatch(rig.db, links, []);
    console.log(`${ROWS} RESULT ROWS IN ONE TRANSACTION (before): ${Math.round(performance.now() - t0)} ms, longest block ${await dog.stop()} ms`);
  }, 120_000);

  it('check results in sliced transactions: all written, longest block under the limit', async () => {
    const links = linksOf(ROWS);
    await turn();
    const dog = watchdog();
    const t0 = performance.now();
    await writeSliced(links, (slice) => recordCheckedBatch(rig.db, slice, []), { maxRows: 250 });
    const block = await dog.stop();
    console.log(`${ROWS} RESULT ROWS SLICED: ${Math.round(performance.now() - t0)} ms, longest block ${block} ms`);
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(place())).toBe(ROWS * 2);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);

  it('the links of a backup run (the copies already there) in sliced transactions: all written, longest block under the limit', async () => {
    const ids = rig.db.prepare('SELECT id FROM files WHERE place_id = ? ORDER BY id LIMIT ?').pluck().all(place(), ROWS) as number[];
    const relinks = ids.map((id) => ({ copyRowId: id, phoneRowId: 1 }));
    await turn();
    const dog = watchdog();
    let n = 0;
    await writeSliced(relinks, (slice) => {
      rig.db
        .transaction(() => {
          for (const r of slice) if (linkOriginOnly(rig.db, r.copyRowId, r.phoneRowId)) n += 1;
        })
        .immediate();
    });
    const block = await dog.stop();
    console.log(`${ROWS} RELINKS SLICED: longest block ${block} ms`);
    expect(n).toBe(ROWS);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
  }, 120_000);
});
