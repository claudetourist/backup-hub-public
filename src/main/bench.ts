import os from 'node:os';
import path from 'node:path';
import type { BenchReport, TimingsSnapshot } from '../shared/ipc';
import { assertWritable, writeFileAtomic } from './fsutil';
import { processStartEpoch } from './timing';

/**
 * Bench mode (`npm run bench`, scripts/bench.mjs). Only the packaged app, only when BACKUPHUB_BENCH names a .json file inside the
 * system temp folder, and only with BACKUPHUB_DATA_DIR naming a data folder inside it too: so a bench run can never open the real data.
 * The window walks the screens and reports its timings (IPC bench:report); after a quiet spell main adds the memory, the longest
 * main-thread stall and the start-up marks, writes the result file and quits. Without the variable nothing here runs.
 */

/** How long the app sits idle on Home before memory is read. */
export const BENCH_IDLE_MS = 10_000;

export interface BenchConfig {
  /** Where the result JSON is written (inside the temp folder). */
  resultFile: string;
  /** The temporary data folder of this run (inside the temp folder). */
  dataDir: string;
}

export interface BenchSetup {
  config: BenchConfig | null;
  /** Set when BACKUPHUB_BENCH was given but cannot be honoured: the app must not start. */
  error: string | null;
}

function isInside(child: string, parent: string): boolean {
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function readBenchConfig(env: Record<string, string | undefined>, isPackaged: boolean, tmpDir: string = os.tmpdir()): BenchSetup {
  const resultFile = env['BACKUPHUB_BENCH']?.trim();
  if (!resultFile) return { config: null, error: null };
  const dataDir = env['BACKUPHUB_DATA_DIR']?.trim() ?? '';
  const refuse = (error: string): BenchSetup => ({ config: null, error: `Bench run refused: ${error}` });
  if (!isPackaged) return refuse('it measures the packaged app only.');
  if (!path.isAbsolute(resultFile) || !resultFile.toLowerCase().endsWith('.json') || !isInside(resultFile, tmpDir)) {
    return refuse('BACKUPHUB_BENCH must be an absolute .json path inside the temp folder.');
  }
  if (!path.isAbsolute(dataDir) || !isInside(dataDir, tmpDir)) return refuse('BACKUPHUB_DATA_DIR must be an absolute folder inside the temp folder.');
  return { config: { resultFile: path.resolve(resultFile), dataDir: path.resolve(dataDir) }, error: null };
}

/** Sum of the working sets (reported in KB) of every Electron process, in MB with one decimal. */
export function memoryMb(metrics: readonly { memory: { workingSetSize: number } }[]): number {
  const kb = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
  return Math.round((kb / 1024) * 10) / 10;
}

export interface BenchResult {
  ok: true;
  /** Process start to Home drawn with its data ready (ms). */
  homeReadyMs: number;
  switches: BenchReport['switches'];
  memoryMb: number;
  processes: number;
  maxStallMs: number;
  stalls: number;
  marks: TimingsSnapshot['marks'];
  summary: string;
  dbBytes: number;
  electron: string;
}

export interface BenchFinishDeps {
  report: BenchReport;
  config: BenchConfig;
  idleMs: number;
  sleep: (ms: number) => Promise<void>;
  metrics: () => readonly { memory: { workingSetSize: number } }[];
  stall: () => { maxMs: number; count: number };
  timings: () => TimingsSnapshot;
  /** Size in bytes of the database file and its log. */
  dbBytes: () => number;
  electron: string;
  /** Epoch ms of the process start (tests pass a fixed one). */
  startEpoch?: number;
  quit: () => void;
  log: { warn(...args: unknown[]): void };
}

/** Wait idle, read everything, write the result file, quit. A failure is written too, so the script never waits for nothing. */
export async function finishBench(d: BenchFinishDeps): Promise<void> {
  let body: BenchResult | { ok: false; error: string };
  try {
    await d.sleep(d.idleMs);
    const metrics = d.metrics();
    const snapshot = d.timings();
    const stall = d.stall();
    body = {
      ok: true,
      homeReadyMs: Math.round(d.report.homeReadyEpochMs - (d.startEpoch ?? processStartEpoch())),
      switches: d.report.switches,
      memoryMb: memoryMb(metrics),
      processes: metrics.length,
      maxStallMs: Math.round(stall.maxMs),
      stalls: stall.count,
      marks: snapshot.marks,
      summary: snapshot.summary,
      dbBytes: d.dbBytes(),
      electron: d.electron,
    };
  } catch (err) {
    d.log.warn('bench: could not collect the result', err);
    body = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    assertWritable(d.config.resultFile); // a temp-folder file, but every writer asks the guard
    writeFileAtomic(d.config.resultFile, JSON.stringify(body, null, 2));
  } catch (err) {
    d.log.warn('bench: could not write the result file', err);
  }
  d.quit();
}
