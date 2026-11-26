import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { quickCheckInWorker, QueryService } from '../query/queryService';
import { createWorker, WORKER_HEAP_LIMIT_MB, WorkerRegistry, workerRegistry, type WorkerKind } from './workers';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const until = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

let dir: string;
/** A stand-in for queryWorker.js: says ready, then answers every request with an empty result of the right shape (and counts them). */
let fakeWorker: string;
/** A worker that never answers, and one that dies at once. */
let silentWorker: string;
let crashingWorker: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-workers-'));
  fakeWorker = path.join(dir, 'fake.js');
  fs.writeFileSync(
    fakeWorker,
    `const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (req) => {
  const result = req.op === 'coverage' ? { byPlace: [] } : req.op === 'stats' ? { files: [], fingerprint: [], failReasons: [] } : { ok: true, messages: ['ok'] };
  parentPort.postMessage({ type: 'result', id: req.id, ok: true, result, ms: 1 });
});`,
  );
  silentWorker = path.join(dir, 'silent.js');
  fs.writeFileSync(silentWorker, `require('node:worker_threads').parentPort.postMessage({ type: 'ready' }); setInterval(() => {}, 1000);`);
  crashingWorker = path.join(dir, 'crash.js');
  fs.writeFileSync(crashingWorker, `throw new Error('dies at start');`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('worker threads: limits and registry', () => {
  it.each(Object.keys(WORKER_HEAP_LIMIT_MB) as WorkerKind[])('a %s worker gets its heap limit', async (kind) => {
    const registry = new WorkerRegistry();
    const worker = createWorker(kind, silentWorker, {}, registry);
    expect(worker.resourceLimits?.maxOldGenerationSizeMb).toBe(WORKER_HEAP_LIMIT_MB[kind]);
    expect(registry.size).toBe(1);
    await registry.terminateAll();
    expect(registry.size).toBe(0);
  });

  it('the limits are the planned ones: 512 for query and search, 256 for listing and hashing', () => {
    expect(WORKER_HEAP_LIMIT_MB.query).toBe(512);
    expect(WORKER_HEAP_LIMIT_MB.search).toBe(512);
    expect(WORKER_HEAP_LIMIT_MB.listing).toBe(256);
    expect(WORKER_HEAP_LIMIT_MB.hashing).toBe(256);
  });

  it('a worker that exits by itself leaves the registry; terminateAll ends all the others', async () => {
    const registry = new WorkerRegistry();
    createWorker('listing', crashingWorker, {}, registry).on('error', () => undefined);
    const a = createWorker('query', silentWorker, {}, registry);
    const b = createWorker('hashing', silentWorker, {}, registry);
    await until(() => registry.size === 2, 'the crashed worker to leave');
    const exits: string[] = [];
    a.on('exit', () => exits.push('a'));
    b.on('exit', () => exits.push('b'));
    expect(await registry.terminateAll()).toBe(2);
    await until(() => exits.length === 2, 'both workers to stop');
  });
});

describe('workers are reused, not created per request', () => {
  let db: Db;
  let dataDir: string;
  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-workers-db-'));
    const opened = initDatabase(dataDir, silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
  });
  afterAll(() => {
    closeDatabase(db, silent);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('QueryService: many requests use ONE worker, and closing it ends that worker', async () => {
    const before = workerRegistry.size;
    const q = new QueryService({ dbFile: path.join(dataDir, 'x.db'), db, workerPath: fakeWorker, log: silent });
    let updates = 0;
    q.onUpdated(() => void (updates += 1));
    for (let round = 1; round <= 5; round += 1) {
      q.requestStats({ force: true });
      q.requestCoverage({ force: true });
      await until(() => updates >= round * 2, `round ${round}`);
      expect(workerRegistry.size).toBe(before + 1);
    }
    expect(q.usesWorker).toBe(true);
    q.close();
    await until(() => workerRegistry.size === before, 'the worker to end');
  });

  it('one-off workers (start-up check) always end: after an answer, after a crash, and when the script is missing', async () => {
    const before = workerRegistry.size;
    expect(await quickCheckInWorker(fakeWorker, 'any.db')).toEqual({ ok: true, messages: ['ok'] });
    expect(await quickCheckInWorker(crashingWorker, 'any.db')).toBeNull();
    expect(await quickCheckInWorker(path.join(dir, 'missing.js'), 'any.db')).toBeNull();
    await until(() => workerRegistry.size === before, 'every one-off worker to end');
  });
});
