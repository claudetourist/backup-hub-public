import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishBench, memoryMb, readBenchConfig, type BenchFinishDeps } from './bench';
import { SCHEMAS } from './ipc/schemas';
import { IPC } from '../shared/ipc';

const tmp = path.join(os.tmpdir(), 'bh-bench-unit');
const env = (extra: Record<string, string>): Record<string, string | undefined> => ({ BACKUPHUB_BENCH: path.join(tmp, 'r.json'), BACKUPHUB_DATA_DIR: path.join(tmp, 'data'), ...extra });

describe('readBenchConfig', () => {
  it('is not a bench run without BACKUPHUB_BENCH', () => {
    expect(readBenchConfig({}, true, tmp)).toEqual({ config: null, error: null });
    expect(readBenchConfig({ BACKUPHUB_BENCH: '  ' }, true, tmp)).toEqual({ config: null, error: null });
  });
  it('accepts a packaged run with temp-folder paths', () => {
    const setup = readBenchConfig(env({}), true, tmp);
    expect(setup.error).toBeNull();
    expect(setup.config).toEqual({ resultFile: path.join(tmp, 'r.json'), dataDir: path.join(tmp, 'data') });
  });
  it('refuses an unpackaged run, a result outside the temp folder, a non-json result and a data folder outside it', () => {
    expect(readBenchConfig(env({}), false, tmp).error).toMatch(/packaged/);
    expect(readBenchConfig(env({ BACKUPHUB_BENCH: path.join(os.homedir(), 'r.json') }), true, tmp).error).toMatch(/BACKUPHUB_BENCH/);
    expect(readBenchConfig(env({ BACKUPHUB_BENCH: path.join(tmp, 'r.txt') }), true, tmp).error).toMatch(/BACKUPHUB_BENCH/);
    expect(readBenchConfig(env({ BACKUPHUB_BENCH: 'r.json' }), true, tmp).error).toMatch(/BACKUPHUB_BENCH/);
    expect(readBenchConfig(env({ BACKUPHUB_DATA_DIR: 'D:\\BackupHub\\data' }), true, tmp).error).toMatch(/BACKUPHUB_DATA_DIR/);
    expect(readBenchConfig(env({ BACKUPHUB_DATA_DIR: path.join(tmp, '..', 'elsewhere') }), true, tmp).error).toMatch(/BACKUPHUB_DATA_DIR/);
    const noData = env({});
    delete noData['BACKUPHUB_DATA_DIR'];
    expect(readBenchConfig(noData, true, tmp).error).toMatch(/BACKUPHUB_DATA_DIR/);
  });
});

describe('memoryMb', () => {
  it('sums the working sets (KB) of every process into MB', () => {
    expect(memoryMb([{ memory: { workingSetSize: 102_400 } }, { memory: { workingSetSize: 51_200 } }])).toBe(150);
    expect(memoryMb([])).toBe(0);
  });
});

describe('finishBench', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-bench-finish-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = (extra: Partial<BenchFinishDeps> = {}): { d: BenchFinishDeps; calls: string[] } => {
    const calls: string[] = [];
    const d: BenchFinishDeps = {
      report: { homeReadyEpochMs: 1_000_900, switches: [{ screen: 'home', ms: [10, 20, 30] }] },
      config: { resultFile: path.join(dir, 'result.json'), dataDir: path.join(dir, 'data') },
      idleMs: 10_000,
      sleep: (ms) => {
        calls.push(`sleep ${ms}`);
        return Promise.resolve();
      },
      metrics: () => [{ memory: { workingSetSize: 204_800 } }],
      stall: () => ({ maxMs: 42.4, count: 0 }),
      timings: () => ({ marks: { appReady: 300 }, summary: 'startup: appReady=300ms', complete: false }),
      dbBytes: () => 1234,
      electron: '43.8.12',
      startEpoch: 1_000_000,
      quit: () => {
        calls.push('quit');
      },
      log: { warn: () => {} },
      ...extra,
    };
    return { d, calls };
  };

  it('waits idle, writes the numbers, then quits', async () => {
    const { d, calls } = deps();
    await finishBench(d);
    expect(calls).toEqual(['sleep 10000', 'quit']);
    const body = JSON.parse(fs.readFileSync(d.config.resultFile, 'utf8'));
    expect(body).toMatchObject({ ok: true, homeReadyMs: 900, memoryMb: 200, processes: 1, maxStallMs: 42, stalls: 0, dbBytes: 1234, electron: '43.8.12' });
    expect(body.switches).toEqual([{ screen: 'home', ms: [10, 20, 30] }]);
  });

  it('writes the failure and still quits when something cannot be read', async () => {
    const { d, calls } = deps({ metrics: () => { throw new Error('no metrics'); } });
    await finishBench(d);
    expect(JSON.parse(fs.readFileSync(d.config.resultFile, 'utf8'))).toEqual({ ok: false, error: 'no metrics' });
    expect(calls).toContain('quit');
  });
});

describe('bench:report schema', () => {
  const parse = (...args: unknown[]) => SCHEMAS[IPC.benchReport].safeParse(args);
  it('takes exactly one report object', () => {
    expect(parse({ homeReadyEpochMs: 1_700_000_000_000, switches: [{ screen: 'home', ms: [1.5] }] }).success).toBe(true);
    expect(parse().success).toBe(false);
    expect(parse({ homeReadyEpochMs: 0, switches: [] }).success).toBe(false);
    expect(parse({ homeReadyEpochMs: 5, switches: [{ screen: 'home', ms: [-1] }] }).success).toBe(false);
    expect(parse({ homeReadyEpochMs: 5, switches: [], extra: 1 }).success).toBe(false);
  });
});
