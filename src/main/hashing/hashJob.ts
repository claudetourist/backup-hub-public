import { HASH_FILES_JOB_KIND, type HashFilesParams } from '../../shared/fingerprint';
import type { Db } from '../db';
import { JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { checkCloudOnlyPaths, type CloudCheckState } from '../listing/cloudOnly';
import type { ListedPlace, Located } from '../listing/listJob';
import type { PowerSource } from './battery';
import { isOneDriveMarkerRelPath } from '../listing/skipRules';
import { fingerprintFile } from './fingerprintFile';
import type { FileHasher } from './hasher';
import { absolutePathFor } from './paths';
import { batteryDecision, bigFileLimit, capBytesPerSecond } from './pure';
import { emptyWrites, nextBatch, queueTotals, START_CURSOR, writeResults, type PendingWrites, type QueueCursor, type QueueRow, type QueueTotals } from './queue';

/** What the fingerprint job needs from the rest of the app. Tests pass fakes. */
export interface HashJobEnv {
  /** Find the place's base folder fresh (a drive's card is read again, so an unplugged drive is noticed). */
  locate(place: ListedPlace): Promise<Located>;
  /** The job started; `placeId` is null when it works through every connected local place. */
  started?(jobId: number, placeId: string | null): void;
  /** The job is waiting for power (a reason) or going again (null). */
  paused?(reason: string | null): void;
}

export interface HashJobDeps {
  db: Db;
  env: HashJobEnv;
  log: JobServiceLogger;
  hasher: FileHasher;
  power: PowerSource;
  /** The setting: most MB per second to read. */
  megabytesPerSecond: () => number;
  /** How many files wait in a place (a count over the whole place). The app answers from a worker thread; default: this thread. */
  totals?: ((placeId: string) => Promise<QueueTotals>) | undefined;
  /** Cloud-only check for a list of paths; defaults to the PowerShell helper. */
  checkCloud?: (paths: string[], signal: AbortSignal) => Promise<Map<string, CloudCheckState>>;
  now?: (() => number) | undefined;
  /** Rows fetched at a time (also the size of one cloud-only check). */
  batchSize?: number | undefined;
  /** Results are written after this many files, this many bytes, or this long. */
  flushFiles?: number | undefined;
  flushBytes?: number | undefined;
  flushMs?: number | undefined;
  /** Test knobs: pool size, the big-file threshold, and how long a OneDrive check stays fresh. */
  parallel?: number | undefined;
  /** Yield to the job service after this many files at the latest (default 500; also every 50 ms). */
  yieldFiles?: number | undefined;
  bigFileBytes?: number | undefined;
  cloudFreshMs?: number | undefined;
  /** A drive's card is read again at least this often while its files are read. */
  relocateMs?: number | undefined;
  /** Waits between battery checks; injectable for tests. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export const DEFAULT_BATCH = 5000;
/** Files in flight at once (small files); a file over BIG_FILE_BYTES is read alone. */
export const MAX_PARALLEL = 8;
export const BIG_FILE_BYTES = 64 * 1000 * 1000;
/** A OneDrive check is trusted for this long; after that the rest of the batch is checked again. */
export const CLOUD_FRESH_MS = 10 * 60_000;
const YIELD_MS = 50;
const YIELD_FILES = 500;
const REPORT_MS = 250;
const DEFAULT_FLUSH_FILES = 50;
const DEFAULT_FLUSH_BYTES = 256 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_RELOCATE_MS = 30_000;
export const POWER_RECHECK_MS = 30_000;
/** At most this many read errors are written to the job log one by one. */
const MAX_ERROR_LOG_LINES = 10;

interface Checkpoint {
  placeIds: string[];
  placeIndex: number;
  cursor: QueueCursor;
  filesDone: number;
  bytesDone: number;
  hashed: number;
  changed: number;
  failed: number;
  cloudFound: number;
  unverified: number;
  skipped: { label: string; files: number }[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function sizeText(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return i === 0 ? `${v} bytes` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Thrown inside a place's loop when its drive went away; that place is skipped, the job goes on. */
class Unplugged extends Error {}

export const skippedMessage = (label: string, files: number): string =>
  `${label} is not connected, so its ${plural(files, 'waiting file')} ${files === 1 ? 'was' : 'were'} skipped. Nothing was lost. Plug it in and choose Match copies now to continue.`;

/**
 * Job `hash.files` (heavy, resumable). Works through the files that have no fingerprint yet,
 * smallest first (by design: the queue is the partial index on size, so thousands of small files finish quickly and the big ones come last; the file count in the progress line moves fast at first and slows at the end), place by place, for connected local places only. Each file is read once (in a
 * worker thread) to get its SHA-256 and MD5 together; size and date are checked before and after,
 * and a file that changed is left for the next listing. OneDrive files are checked for "only in the
 * cloud" right before they are read, and a cloud-only file is never opened. Reading is capped in
 * MB per second and waits while the laptop is on a low battery. Results are written in small
 * transactions with a checkpoint; rows without a fingerprint ARE the queue, so a restart continues
 * where it stopped.
 */
export function hashFilesHandler(deps: HashJobDeps): JobHandler {
  return {
    kind: HASH_FILES_JOB_KIND,
    heavy: true,
    resumable: true,
    run: (ctx) => new HashRun(deps, ctx).run(),
  };
}

class HashRun {
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private placeIds: string[] = [];
  private cursor: QueueCursor = START_CURSOR;
  private filesDone = 0;
  private bytesDone = 0;
  private hashed = 0;
  private changed = 0;
  private failed = 0;
  private cloudFound = 0;
  private unverified = 0;
  private skipped: { label: string; files: number }[] = [];
  private placeIndex = 0;

  private filesTotal = 0;
  private bytesTotal = 0;
  private label = '';
  private errorLines = 0;
  private pausedNow = false;
  private writes: PendingWrites = emptyWrites();
  private writtenAt = 0;
  private bytesSinceFlush = 0;
  private filesSinceFlush = 0;
  private inFlight = 0;
  private safeCursor: QueueCursor = START_CURSOR;
  private order: { cursor: QueueCursor; done: boolean }[] = [];
  private readonly active = new Set<Promise<void>>();
  private fatal: unknown = null;
  private lastYield = 0;
  private yieldedFiles = 0;
  private lastReport = 0;

  constructor(
    private readonly deps: HashJobDeps,
    private readonly ctx: JobContext,
  ) {
    this.now = deps.now ?? Date.now;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  private totals(placeId: string): Promise<QueueTotals> {
    return this.deps.totals ? this.deps.totals(placeId) : Promise.resolve(queueTotals(this.deps.db, placeId));
  }

  private selectPlaces(): ListedPlace[] {
    const params = (this.ctx.params ?? {}) as Partial<HashFilesParams>;
    const rows = this.deps.db
      .prepare(
        `SELECT id, kind, label FROM places WHERE kind IN ('laptop', 'drive', 'onedrive')
         ORDER BY CASE kind WHEN 'laptop' THEN 0 WHEN 'onedrive' THEN 1 ELSE 2 END, label`,
      )
      .all() as ListedPlace[];
    if (params.placeId === undefined) return rows;
    if (typeof params.placeId !== 'string') throw new JobFailure('This job has no valid place. Press Start on Home to try again.');
    const one = rows.find((r) => r.id === params.placeId);
    if (!one) throw new JobFailure('That place cannot be checked (only the laptop, named drives and OneDrive can).');
    return [one];
  }

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const all = this.selectPlaces();
    const resume = (ctx.resume ?? null) as Checkpoint | null;
    const usable = resume !== null && resume.placeIds.every((id) => all.some((p) => p.id === id)) && resume.placeIds.length > 0;
    if (usable) {
      this.placeIds = resume.placeIds;
      this.placeIndex = resume.placeIndex;
      this.cursor = resume.cursor;
      this.filesDone = resume.filesDone;
      this.bytesDone = resume.bytesDone;
      this.hashed = resume.hashed;
      this.changed = resume.changed;
      this.failed = resume.failed;
      this.cloudFound = resume.cloudFound;
      this.unverified = resume.unverified;
      this.skipped = resume.skipped;
      ctx.log('info', `Continuing after ${this.filesDone.toLocaleString('en-US')} files of the earlier run`);
    } else {
      this.placeIds = all.map((p) => p.id);
    }
    const params = ctx.params as Partial<HashFilesParams> | null;
    deps.env.started?.(ctx.jobId, typeof params?.placeId === 'string' ? params.placeId : null);

    const places = this.placeIds.map((id) => all.find((p) => p.id === id)!);
    for (let i = this.placeIndex; i < places.length; i += 1) {
      const t = await this.totals(places[i]!.id);
      this.filesTotal += t.files;
      this.bytesTotal += t.bytes;
    }
    this.filesTotal += this.filesDone;
    this.bytesTotal += this.bytesDone;
    if (this.filesTotal === 0) return 'Nothing was waiting for a checksum.';
    this.writtenAt = this.now();
    this.report('Starting');
    // A Pause holds between files: what was read so far is written and the checkpoint saved first (read only job: a close loses at most the files in flight).
    ctx.beforeHold?.(() => this.flush());

    try {
      for (let i = this.placeIndex; i < places.length; i += 1) {
        this.placeIndex = i;
        await this.runPlace(places[i]!);
        this.cursor = START_CURSOR;
        this.safeCursor = START_CURSOR;
        this.placeIndex = i + 1;
        this.flush();
        await ctx.yield();
      }
    } finally {
      // Whatever was read before a stop (cancel, quit) is kept.
      this.flush();
      deps.env.paused?.(null);
    }
    this.report();
    return this.finish();
  }

  private finish(): string {
    const { ctx, deps } = this;
    for (const s of this.skipped) ctx.warn(skippedMessage(s.label, s.files));
    if (this.failed > 0) {
      ctx.warn(
        `${plural(this.failed, 'file')} could not be read and ${this.failed === 1 ? 'was' : 'were'} skipped. They are tried again after a check finds them changed, or press Start on Home to try again. The job log has the first ${MAX_ERROR_LOG_LINES}.`,
      );
    }
    if (this.changed > 0) {
      ctx.warn(`${plural(this.changed, 'file')} changed or went missing since they were last checked, so no checksum was kept. Check the place again to refresh them.`);
    }
    if (this.cloudFound > 0) {
      ctx.warn(`${plural(this.cloudFound, 'OneDrive file')} turned out to be only in the cloud. They were not opened or downloaded, and are marked as cloud-only.`);
    }
    if (this.unverified > 0) {
      ctx.warn(`${plural(this.unverified, 'OneDrive file')} could not be checked for being in the cloud, so they were not opened.`);
    }
    const summary = `Checked ${plural(this.hashed, 'file')} (${sizeText(this.bytesDone)}).`;
    ctx.log('info', summary);
    deps.log.info(`hash.files: ${summary}`);
    return summary;
  }

  private report(message?: string): void {
    this.ctx.progress(this.filesDone, this.filesTotal, {
      bytesDone: this.bytesDone + this.inFlight,
      bytesTotal: this.bytesTotal,
      message: message ?? `Matching copies on ${this.label}: ${this.filesDone.toLocaleString('en-US')} of ${this.filesTotal.toLocaleString('en-US')} files, ${sizeText(this.bytesDone + this.inFlight)} of ${sizeText(this.bytesTotal)}`,
    });
  }

  private flush(): void {
    const w = this.writes;
    if (w.hashed.length > 0 || w.errors.length > 0 || w.cloudOnly.length > 0) {
      writeResults(this.deps.db, w, this.now());
      this.writes = emptyWrites();
    }
    this.writtenAt = this.now();
    this.bytesSinceFlush = 0;
    this.filesSinceFlush = 0;
    this.ctx.checkpoint({
      placeIds: this.placeIds,
      placeIndex: this.placeIndex,
      cursor: this.safeCursor,
      filesDone: this.filesDone,
      bytesDone: this.bytesDone,
      hashed: this.hashed,
      changed: this.changed,
      failed: this.failed,
      cloudFound: this.cloudFound,
      unverified: this.unverified,
      skipped: this.skipped,
    } satisfies Checkpoint);
  }

  private flushIfDue(): void {
    const d = this.deps;
    if (
      this.filesSinceFlush >= (d.flushFiles ?? DEFAULT_FLUSH_FILES) ||
      this.bytesSinceFlush >= (d.flushBytes ?? DEFAULT_FLUSH_BYTES) ||
      this.now() - this.writtenAt >= (d.flushMs ?? DEFAULT_FLUSH_MS)
    ) {
      this.flush();
    }
  }

  /** Wait here while the laptop is on a low battery. */
  private async waitForPower(): Promise<void> {
    for (;;) {
      const decision = batteryDecision(await this.deps.power.read());
      if (!decision.pause) {
        if (this.pausedNow) {
          this.pausedNow = false;
          this.deps.env.paused?.(null);
          this.ctx.log('info', 'Continuing: the laptop has enough power again');
          this.report();
        }
        return;
      }
      if (!this.pausedNow) {
        this.pausedNow = true;
        this.deps.env.paused?.(decision.message);
        this.ctx.log('info', decision.message);
      }
      this.flush();
      this.report(decision.message);
      await this.sleep(POWER_RECHECK_MS, this.ctx.signal);
      await this.ctx.yield();
    }
  }

  private async runPlace(place: ListedPlace): Promise<void> {
    const { ctx, deps } = this;
    this.label = place.label;
    const waiting = queueTotals(deps.db, place.id).files;
    if (waiting === 0) return;
    const first = await deps.env.locate(place);
    if (!first.ok) {
      this.skipPlace(place, waiting);
      return;
    }
    let base = first.base;
    let locatedAt = this.now();
    ctx.log('info', `Matching copies on ${place.label}: ${plural(waiting, 'file')} waiting (smallest first)`);
    this.safeCursor = this.cursor;
    this.order = [];
    let fetchFrom = this.cursor;

    try {
      for (;;) {
        const rows = nextBatch(deps.db, place.id, fetchFrom, this.batchSize);
        if (rows.length === 0) break;
        fetchFrom = { size: rows[rows.length - 1]!.size, id: rows[rows.length - 1]!.id };
        let cloud: Map<string, CloudCheckState> | null = null;
        let cloudAt = 0;
        if (place.kind === 'onedrive') {
          cloud = await this.cloudStates(place, base, rows);
          cloudAt = this.now();
          if (cloud === null) {
            // The helper could not run: nothing can be verified, so nothing is opened.
            this.skipPlace(place, (await this.totals(place.id)).files);
            return;
          }
        }
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          if (ctx.signal.aborted) await this.stopHere();
          await this.waitForPower();
          await this.takeSlot(row.size);
          await this.checkFatal();
          if (ctx.signal.aborted) await this.stopHere();

          if (place.kind === 'drive' && this.now() - locatedAt >= (deps.relocateMs ?? DEFAULT_RELOCATE_MS)) {
            base = await this.stillThere(place);
            locatedAt = this.now();
          }
          if (place.kind === 'onedrive' && this.now() - cloudAt >= (deps.cloudFreshMs ?? CLOUD_FRESH_MS)) {
            // The check is old: ask again for what is left, so a file is only read if it was checked "local" shortly before.
            await this.drain();
            cloud = await this.cloudStates(place, base, rows.slice(i));
            cloudAt = this.now();
            if (cloud === null) {
              this.skipPlace(place, (await this.totals(place.id)).files);
              return;
            }
          }
          this.begin(place, base, row, cloud, async () => {
            if (place.kind !== 'drive') return;
            base = await this.stillThere(place);
            locatedAt = this.now();
          });
          await this.maybeYield();
        }
        await this.drain();
        await this.checkFatal();
        if (ctx.signal.aborted) await this.stopHere();
      }
    } catch (err) {
      await this.drain();
      if (!(err instanceof Unplugged)) throw err;
      this.skipPlace(place, (await this.totals(place.id)).files);
    } finally {
      await this.drain();
    }
  }

  /** Waits for the files in flight, keeps what they gave, and throws the stop (cancel or quit). */
  private async stopHere(): Promise<void> {
    await this.drain();
    this.flush();
    await this.ctx.yield();
  }

  /** Waits until a file of this size may start: 8 small files at once, a big one alone. */
  private async takeSlot(size: number): Promise<void> {
    const limit = this.isBig(size) ? bigFileLimit(this.deps.megabytesPerSecond()) : (this.deps.parallel ?? MAX_PARALLEL);
    while (this.active.size >= limit) await Promise.race(this.active);
  }

  private isBig(size: number): boolean {
    return size > (this.deps.bigFileBytes ?? BIG_FILE_BYTES);
  }

  private async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.race(this.active);
  }

  private async checkFatal(): Promise<void> {
    if (this.fatal === null) return;
    await this.drain();
    const err = this.fatal;
    this.fatal = null;
    throw err;
  }

  /** Yields to the job service (cancel, pause) every 50 ms, not for every file. */
  private async maybeYield(): Promise<void> {
    const t = this.now();
    this.yieldedFiles += 1;
    if (t - this.lastYield < YIELD_MS && this.yieldedFiles < (this.deps.yieldFiles ?? YIELD_FILES)) return;
    this.lastYield = t;
    this.yieldedFiles = 0;
    await this.ctx.yield();
  }

  /** Starts one file in the pool. Its result is kept when it finishes; an error is held for the loop. */
  private begin(place: ListedPlace, base: string, row: QueueRow, cloud: Map<string, CloudCheckState> | null, confirmDriveStillThere: () => Promise<void>): void {
    const entry = { cursor: { size: row.size, id: row.id }, done: false };
    this.order.push(entry);
    let reported = 0;
    const run = async (): Promise<void> => {
      try {
        const completed = await this.processRow(place, base, row, cloud, confirmDriveStillThere, (n) => {
          reported += n;
          this.inFlight += n;
          // A big file is read alone for minutes: report while it is read (at most every 250 ms) so speed shows.
          this.reportIfDue();
        });
        this.inFlight -= reported;
        entry.done = completed;
        if (completed) this.filesDone += 1;
        this.filesSinceFlush += 1;
        this.advanceSafe();
        this.reportIfDue();
        this.flushIfDue();
      } catch (err) {
        this.inFlight -= reported;
        this.fatal ??= err;
      } finally {
        this.active.delete(task);
      }
    };
    const task: Promise<void> = run();
    this.active.add(task);
  }

  /** The checkpoint cursor: everything at or below it is finished (written or skipped on purpose). */
  private advanceSafe(): void {
    let n = 0;
    while (n < this.order.length && this.order[n]!.done) {
      this.safeCursor = this.order[n]!.cursor;
      n += 1;
    }
    if (n > 0) this.order.splice(0, n);
  }

  private reportIfDue(): void {
    const t = this.now();
    if (t - this.lastReport < REPORT_MS) return;
    this.lastReport = t;
    this.report();
  }

  /** The drive is checked again (card read); returns its base folder or throws Unplugged. */
  private async stillThere(place: ListedPlace): Promise<string> {
    const again = await this.deps.env.locate(place);
    if (!again.ok) throw new Unplugged();
    return again.base;
  }

  private skipPlace(place: ListedPlace, files: number): void {
    this.flush();
    this.skipped.push({ label: place.label, files });
    this.deps.log.info(`hash.files: ${place.label} skipped (${files} files waiting)`);
    this.ctx.log('warn', skippedMessage(place.label, files));
  }

  /** One check for the whole batch: which of these OneDrive files are only in the cloud. Null when the helper cannot run. */
  private async cloudStates(place: ListedPlace, base: string, rows: QueueRow[]): Promise<Map<string, CloudCheckState> | null> {
    const paths: string[] = [];
    for (const row of rows) {
      const abs = absolutePathFor('onedrive', base, row.rel_path);
      if (abs !== null) paths.push(abs);
    }
    try {
      return await (this.deps.checkCloud ?? ((p, signal) => checkCloudOnlyPaths(p, { signal })))(paths, this.ctx.signal);
    } catch (err) {
      if (this.ctx.signal.aborted) await this.ctx.yield();
      this.ctx.warn(`Could not check which ${place.label} files are only in the cloud (${(err as Error).message}). Nothing there was opened.`);
      return null;
    }
  }

  /** Resolves true when the file is finished (written, skipped or counted), false when a stop interrupted it. */
  private async processRow(
    place: ListedPlace,
    base: string,
    row: QueueRow,
    cloud: Map<string, CloudCheckState> | null,
    confirmDriveStillThere: () => Promise<void>,
    onBytes: (n: number) => void,
  ): Promise<boolean> {
    const { ctx, deps } = this;
    if (place.kind === 'onedrive' && isOneDriveMarkerRelPath(row.rel_path)) return true;
    const abs = absolutePathFor(place.kind, base, row.rel_path);
    if (abs === null) {
      this.changed += 1;
      ctx.log('warn', `Skipped ${row.rel_path}: the stored path does not map to a file on this PC`);
      return true;
    }
    if (cloud !== null) {
      const state = cloud.get(abs) ?? 'unknown';
      if (state === 'cloud') {
        this.writes.cloudOnly.push(row.id);
        this.cloudFound += 1;
        return true;
      }
      if (state === 'missing') {
        this.changed += 1;
        return true;
      }
      if (state === 'unknown') {
        this.unverified += 1;
        return true;
      }
    }

    const outcome = await fingerprintFile(
      deps.hasher,
      abs,
      { size: row.size, mtime: row.mtime },
      { capBytesPerSec: capBytesPerSecond(deps.megabytesPerSecond()), signal: ctx.signal, onBytes, wide: this.isBig(row.size) && bigFileLimit(deps.megabytesPerSecond()) > 1 },
    );
    switch (outcome.kind) {
      case 'hashed':
        this.writes.hashed.push({ id: row.id, size: row.size, mtime: row.mtime, sha256: outcome.sha256, md5: outcome.md5 });
        this.hashed += 1;
        this.bytesDone += row.size;
        this.bytesSinceFlush += row.size;
        return true;
      case 'changed':
        this.changed += 1;
        return true;
      case 'aborted':
        return false;
      case 'missing':
      case 'error': {
        // A vanished or unreadable drive file may just mean the drive was unplugged: look before blaming the file.
        await confirmDriveStillThere();
        if (outcome.kind === 'missing') {
          this.changed += 1;
          return true;
        }
        this.writes.errors.push({ id: row.id, message: outcome.message });
        this.failed += 1;
        if (this.errorLines < MAX_ERROR_LOG_LINES) {
          this.errorLines += 1;
          ctx.log('warn', `${abs}: ${outcome.message}`);
        }
        return true;
      }
      default:
        return true;
    }
  }
}
