/**
 * Long loops on the main thread, cut into slices. The window freezes (even Alt+Tab) when the main process does one synchronous job for
 * longer than a moment, so a loop over tens of thousands of files is written ONCE as a generator that `yield`s every few hundred items
 * (`STEP_ITEMS`), and run one of two ways:
 *   - `finishSync`: ignores the yields and runs it through at once (tests, and scripts that have no window to freeze);
 *   - `finishSliced`: gives the event loop a turn (`pause`) whenever `SLICE_MS` have passed since the last turn.
 * Both give the same answer: the logic is not written twice.
 */

/** A loop that can be cut: `yield` is "this is a good place to give the window a turn"; the return value is the result. */
export type Steps<T> = Generator<void, T, void>;

/** Items between two `yield`s of a loop (a few milliseconds of work at most). */
export const STEP_ITEMS = 200;

/** Longest time the main thread works before the event loop gets a turn. */
export const SLICE_MS = 20;

/** One turn of the event loop. */
export const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export function finishSync<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** For loops that write in slices themselves: `await due()` after each slice, it only pauses when `SLICE_MS` have passed. */
export function sliceClock(pause: () => Promise<void> = turn, sliceMs: number = SLICE_MS): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await pause();
    since = performance.now();
  };
}

export async function finishSliced<T>(steps: Steps<T>, pause: () => Promise<void> = turn, sliceMs: number = SLICE_MS): Promise<T> {
  let since = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - since >= sliceMs) {
      await pause();
      since = performance.now();
    }
  }
}

/** Rows per transaction that `writeSliced` starts with, before it has measured how long a row takes. */
/** A cold write can cost ~30 ms a row on the real db (a dozen indexes): start small, grow from what was measured. */
const FIRST_WRITE_ROWS = 2;

/**
 * Writes `items` to the database in SHORT transactions: `write` gets a slice and runs ONE transaction for it. The slice size is measured and
 * adapted so a transaction takes about half of `SLICE_MS` (on the real 1.6 GB database a row costs far more than on a fixture: cold pages),
 * at most `maxRows` rows; between transactions the event loop gets a turn (`pause`) whenever `SLICE_MS` have passed. One big transaction of
 * a few thousand result rows held the window for 0.5 to 1 s. A stop between two slices leaves the slices already written (each is true).
 */
export async function writeSliced<T>(items: readonly T[], write: (slice: readonly T[]) => void, opts: { pause?: () => Promise<void>; maxRows?: number; sliceMs?: number; memo?: { rows: number } } = {}): Promise<void> {
  const sliceMs = opts.sliceMs ?? SLICE_MS;
  const maxRows = Math.max(1, opts.maxRows ?? 500);
  const due = sliceClock(opts.pause ?? turn, sliceMs);
  // `memo` carries the learned slice size from one call to the next (a job that flushes every few seconds must not start at a guess each time).
  let rows = Math.min(opts.memo?.rows ?? FIRST_WRITE_ROWS, maxRows);
  for (let at = 0; at < items.length; ) {
    const slice = items.slice(at, at + rows);
    const t0 = performance.now();
    write(slice);
    const took = Math.max(performance.now() - t0, 0.05);
    at += slice.length;
    // Aim at half a slice per transaction; grow at most 2x at a time (one slow row must not lead to a huge next slice), shrink at once.
    const aimed = Math.floor((slice.length * (sliceMs / 2)) / took);
    rows = Math.max(1, Math.min(maxRows, slice.length * 2, aimed));
    if (opts.memo) opts.memo.rows = rows;
    if (at < items.length) await due();
  }
}

/**
 * Sorts `items` in place (stable) in slices: chunks of `chunk` items are sorted one at a time, then merged pairwise with a turn every
 * few thousand items. One `Array.sort` over 60,000 paths takes over 100 ms in one go. The order is the same as `items.sort(compare)`.
 */
export function* sortSteps<T>(items: T[], compare: (a: T, b: T) => number, chunk = 4000): Steps<void> {
  if (items.length <= chunk) {
    items.sort(compare);
    return;
  }
  let runs: T[][] = [];
  for (let i = 0; i < items.length; i += chunk) {
    const run = items.slice(i, i + chunk);
    run.sort(compare);
    runs.push(run);
    yield;
  }
  while (runs.length > 1) {
    const merged: T[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r]!;
      const b = runs[r + 1];
      if (b === undefined) {
        merged.push(a);
        continue;
      }
      const out: T[] = [];
      let i = 0;
      let j = 0;
      while (i < a.length && j < b.length) {
        out.push(compare(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
        if (out.length % 4096 === 0) yield;
      }
      while (i < a.length) out.push(a[i++]!);
      while (j < b.length) out.push(b[j++]!);
      merged.push(out);
      yield;
    }
    runs = merged;
  }
  const sorted = runs[0]!;
  for (let i = 0; i < items.length; i += 1) items[i] = sorted[i]!;
}
