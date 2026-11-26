import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from '../db/connection';
import { fillSlice, FILL_SLICE_ROWS, FIRST_MERGE_PAGES, indexProgress, MAX_MERGE_PAGES, mergeStep, setMergeMode, SliceSizer, type IndexProgress } from './searchIndexFill';

/**
 * The loop that keeps the search index up to date, run inside the query worker thread on its OWN read-write connection (never the main
 * thread): slice after slice while there is something to add (the first fill, a listing's new rows, the moves and deletes in the queue),
 * then a quiet look every few seconds. A slice holds the write lock for a moment (the main thread's own writes wait for it): its size is learned
 * so a slice takes about 30 ms (`SliceSizer`), and between two transactions it rests twice as long as the last one took (at least MIN_REST_MS),
 * so a writer on the main thread gets in: the index gets a third of the time at most.
 *
 * The first fill also takes FTS5's segment merging out of the commits (`setMergeMode`): after every slice a merge step of its own runs as a
 * short transaction, its size learned the same way (about 30 ms); when the fill is over the steps go on until nothing is left to merge, and
 * FTS5's defaults are put back.
 */

/** How long it sleeps when there is nothing to do (a new listing is noticed within this time). */
export const IDLE_MS = 3000;
/** How often a resting keeper looks whether it was told to stop. */
const STOP_POLL_MS = 100;
/** How often a paused keeper looks again. */
export const PAUSED_POLL_MS = 500;
/** The least rest after a transaction. */
export const MIN_REST_MS = 20;

export interface KeeperOptions {
  sliceRows?: number;
  idleMs?: number;
  /** For measuring: each slice and merge step as it ends (rows or pages, milliseconds), and 'drained' when the first fill and its merging are over. */
  observe?: (event: { kind: 'slice' | 'merge' | 'drained'; amount: number; ms: number }) => void;
}

/** Runs until `stopped()` says so. `report` gets the progress when it changed. Never throws: a failure is reported by the caller's catch. */
export async function keepIndex(
  file: string,
  report: (progress: IndexProgress | null) => void,
  stopped: () => boolean,
  options: KeeperOptions = {},
  paused: () => boolean = () => false,
): Promise<void> {
  const db = openDatabase(file);
  try {
    // A rest that ends early when the keeper is told to stop (the app closing must not wait for a long sleep).
    const rest = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0 && !stopped(); left -= STOP_POLL_MS) await sleep(Math.min(STOP_POLL_MS, left));
    };
    let last = '';
    let lastReport = 0;
    const tell = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastReport < 500) return;
      const progress = indexProgress(db);
      const key = JSON.stringify(progress);
      if (key === last) return;
      last = key;
      lastReport = now;
      report(progress);
    };
    const sizer = new SliceSizer(options.sliceRows ?? FILL_SLICE_ROWS);
    const stepSizer = new SliceSizer(MAX_MERGE_PAGES, undefined, FIRST_MERGE_PAGES);
    // The first fill (and a fill that was stopped half way) merges in steps of its own; once it is over FTS5's own merging is back.
    let filling = indexProgress(db)?.ready === false;
    setMergeMode(db, filling ? 'fill' : 'normal');
    /** One merge step; returns whether there was work, after the rest that lets a writer in. */
    const step = async (): Promise<boolean> => {
      const t0 = performance.now();
      const work = mergeStep(db, stepSizer.rows);
      const ms = performance.now() - t0;
      options.observe?.({ kind: 'merge', amount: stepSizer.rows, ms });
      // Only a step that merged something says how long a page takes (an idle step takes no time).
      if (work) stepSizer.learn(stepSizer.rows, ms);
      await rest(Math.max(MIN_REST_MS, ms * 2));
      return work;
    };
    tell(true);
    const started0 = performance.now();
    while (!stopped()) {
      // A job is running (a listing, a check ...): its writes come first. A slice that collides with one makes the main thread wait for it.
      if (paused()) {
        await rest(PAUSED_POLL_MS);
        continue;
      }
      const started = performance.now();
      const handled = fillSlice(db, sizer.rows);
      const took = performance.now() - started;
      if (handled > 0) options.observe?.({ kind: 'slice', amount: handled, ms: took });
      sizer.learn(handled, took);
      if (handled === 0) {
        if (filling) {
          // The fill is over: merge what is left, a bounded step at a time, then FTS5's defaults again.
          while (!stopped() && !paused() && (await step())) tell(false);
          if (stopped()) break;
          if (paused()) continue;
          setMergeMode(db, 'normal');
          filling = false;
          options.observe?.({ kind: 'drained', amount: 0, ms: performance.now() - started0 });
        }
        tell(true);
        await rest(options.idleMs ?? IDLE_MS);
        continue;
      }
      tell(false);
      await rest(Math.max(MIN_REST_MS, took * 2));
      if (filling) await step();
    }
  } finally {
    db.close();
  }
}
