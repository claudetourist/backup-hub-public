import {
  CANCELLED_MESSAGE,
  parseJobError,
  stoppedByApp,
  withErrorCode,
  type JobErrorCode,
  computeEtaSeconds,
  computeSpeed,
  INTERRUPTED_MESSAGE,
  isFinished,
  PAUSED_ALL_MESSAGE,
  PAUSED_MESSAGE,
  PAUSING_MESSAGE,
  DISMISSED_MESSAGE,
  NOT_STARTED_MESSAGE,
  pickMeasure,
  SLEPT_MESSAGE,
  WAITING_TURN_MESSAGE,
  type JobChangedEvent,
  type JobChangeReason,
  type JobEvent,
  type JobEventLevel,
  type JobListFilter,
  type JobRecord,
  type RateSample,
  isContinuable,
} from '../../shared/jobs';
import { NO_RETRY_JOB_KINDS } from '../../shared/cleanup';
import type { Db } from '../db';
import { JobStore } from './jobStore';
import { KeyedThrottle, type ThrottleClock } from './throttle';

/** Heavy kinds (hashing, copying) run one at a time. */
export const MAX_HEAVY_JOBS = 1;
/** Light kinds may overlap, up to this many. */
export const MAX_LIGHT_JOBS = 2;
/** Progress and log events per job are sent at most every 250 ms (4 per second). */
export const EVENT_INTERVAL_MS = 250;
/** Progress is written to the database at most this often (it is also written on every state change). */
export const PERSIST_INTERVAL_MS = 1000;
const SAMPLE_KEEP_MS = 30_000;

/** Thrown by `ctx.yield()`/`ctx.needsYou()` when the job was cancelled or the app is closing. */
export class JobAborted extends Error {
  constructor(message = 'The job was stopped') {
    super(message);
    this.name = 'JobAborted';
  }
}

/**
 * Throw this from a handler to fail with a message the user can read. `detail` goes to the job log. `code` says what kind of
 * end it is ('refused' = a safety rule said no and trying again will not help; default 'failed').
 */
export class JobFailure extends Error {
  constructor(
    readonly plain: string,
    readonly detail?: string,
    readonly code: JobErrorCode = 'failed',
  ) {
    super(plain);
    this.name = 'JobFailure';
  }
}

export interface ProgressExtras {
  bytesDone?: number;
  bytesTotal?: number;
  /** Replaces the job's status line, e.g. "Hashing photo 12 of 200". */
  message?: string;
}

export interface JobContext {
  readonly jobId: number;
  readonly params: unknown;
  /** The last `checkpoint()` value when the job is continuing after a restart, else null. */
  readonly resume: unknown;
  /** Aborted when the user cancels (or the app closes). */
  readonly signal: AbortSignal;
  progress(done: number, total: number, extras?: ProgressExtras): void;
  log(level: JobEventLevel, text: string): void;
  /** Records a warning; the job will finish as "done with warnings". */
  warn(text: string): void;
  /** Stops and waits for the user. Resolves with the answer (one of `choices`, or "continue"). */
  needsYou(message: string, choices?: string[]): Promise<string>;
  /** Save where to continue from if the app closes. Only used by handlers declared `resumable`. */
  checkpoint(resume: unknown): void;
  /**
   * Give the event loop a turn; waits while the laptop sleeps; throws JobAborted if cancelled. This is also where Pause holds the job: call it BETWEEN
   * files (a safe point), never in the middle of one (use `turn` there).
   */
  yield(): Promise<void>;
  /** Like `yield` (a turn, the laptop-sleep wait, JobAborted on Stop or quit) but a Pause does not hold here: for the middle of a file, so Pause lets the file finish first. */
  turn?(): Promise<void>;
  /**
   * Registers what must be saved before a Pause holds the job (a checkpoint, results waiting in memory). The job service calls it once per pause, from the
   * job's own `yield`, and waits for it; the window says "Paused, safe to close" only after it ran. Keep it short and never call `yield` in it.
   */
  beforeHold?(save: () => void | Promise<void>): void;
}

/** The turn to use in the middle of a file: `ctx.turn` when the context has it (a Pause then lets the file finish), else `ctx.yield`. */
export function turnOf(ctx: { yield(): Promise<void>; turn?(): Promise<void> }): () => Promise<void> {
  return () => (ctx.turn ? ctx.turn() : ctx.yield());
}

export type JobResult = string | { message?: string } | undefined | void;

export interface JobHandler {
  kind: string;
  /** Heavy jobs run one at a time. */
  heavy: boolean;
  /** True when a job of this kind can continue from its checkpoint after the app restarts. */
  resumable?: boolean;
  run(ctx: JobContext): Promise<JobResult>;
  /**
   * The person pressed Stop (never at quit): what is kept as the checkpoint afterwards. A Stop is abrupt, so a kind that saved half-done work in its
   * checkpoint (a Google upload on its way) drops it here. Pure; called with the parsed checkpoint, only when there is one.
   */
  onStop?(resume: unknown): unknown;
}

export interface JobServiceLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface JobServiceOptions {
  db: Db;
  log?: JobServiceLogger;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
  throttleClock?: ThrottleClock;
}

interface LiveJob {
  record: JobRecord;
  handler: JobHandler;
  controller: AbortController;
  samples: RateSample[];
  itemSamples: RateSample[];
  sampleUnit: 'bytes' | 'items' | null;
  lastPersist: number;
  /** Final state already written (finished or cancelled); the handler may still be unwinding. */
  finalized: boolean;
  pending: { resolve: (answer: string) => void; reject: (err: Error) => void } | null;
  /**
   * True while the job gives up its slot: paused by the user, or resumed and waiting for a free
   * slot. The handler stops at its next `ctx.yield()` until `gate` is released.
   */
  suspended: boolean;
  gate: { promise: Promise<void>; release: () => void } | null;
  /** The drives (place ids) this job reads or writes: no other job uses them meanwhile. */
  drives: string[];
  /** The stored error when the job was stopped on purpose (by you or by the app); a handler that unwinds after it reports this. */
  stopError: string | null;
  /** When the job gave up its slot (paused, or waiting for a free slot after a resume); null while it works. Its time is not active time. */
  pausedAt: number | null;
  /** True once the handler has stopped at a safe point and is held (and its pause save ran). From Pause until then the job is "pausing": it still works and keeps its slot and drive. */
  parked: boolean;
  /** What the handler asked to be saved before a pause holds it, and whether that ran for this pause. */
  holdSave: (() => void | Promise<void>) | null;
  holdSaved: boolean;
  /** The status line a paused job keeps in the database (and shows once it is held). */
  pausedMessage: string | null;
}

const silent: JobServiceLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * What the person reads when a job stops by surprise: what happened, what was not changed, what to do. The names of the errors are
 * matched as text so this module does not depend on the Google code.
 */
export function describeError(err: unknown): { plain: string; detail: string; code: JobErrorCode } {
  if (err instanceof JobFailure) return { plain: err.plain, detail: err.detail ?? err.stack ?? err.message, code: err.code };
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : '';
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
  if (name === 'NetworkError') return { plain: 'The internet connection was lost, so this job stopped. Nothing was deleted. Check the connection and run it again; it carries on where it can.', detail, code: 'network' };
  if (name === 'GoogleApiError') return { plain: 'Google did not accept a request, so this job stopped. Nothing in your Google accounts was deleted. Try again in a little while; if it keeps happening, sign the account in again under Settings, Drives and accounts.', detail, code: 'google' };
  if (code === 'ENOSPC') return { plain: 'A disk is full, so this job stopped. Nothing was deleted. Free some space on that disk (the Jobs log says which one) and run it again.', detail, code: 'disk-full' };
  if (code === 'EPERM' || code === 'EACCES') return { plain: 'Windows refused access to a file or folder, so this job stopped. Nothing was deleted. Check that nothing else is using it and that the drive is not read-only, then run it again.', detail, code: 'access' };
  if (code === 'EIO' || code === 'ENODEV' || code === 'ENXIO') return { plain: 'A drive stopped answering, so this job stopped. Nothing was deleted. Check the cable and that the drive is still plugged in, then run it again.', detail, code: 'drive-gone' };
  if (code === 'EBUSY' || code.startsWith('SQLITE_BUSY') || /database is locked/i.test(message)) {
    return { plain: 'The data file was busy with another task for too long, so this job stopped. Nothing was deleted. Run it again; it carries on where it can.', detail, code: 'busy' };
  }
  return { plain: 'Something unexpected went wrong and this job stopped. Nothing was deleted. Run it again; if it stops again, the job log has the technical details to pass on.', detail, code: 'unexpected' };
}

/**
 * The job queue: persistence in `jobs`/`job_events`, a runner with heavy/light limits, resume on
 * start, cancel/retry/answer, and one typed change event per state or progress change.
 */
export class JobService {
  private readonly store: JobStore;
  private readonly log: JobServiceLogger;
  private readonly now: () => number;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly live = new Map<number, LiveJob>();
  private readonly listeners = new Set<(event: JobChangedEvent) => void>();
  private readonly throttle: KeyedThrottle<number, JobChangeReason>;
  private started = false;
  private paused = false;
  private wakes = 0;
  /** "Pause everything" is on: nothing starts, and running jobs stop at their next safe point. */
  private held = false;
  private shuttingDown = false;
  private wake: { promise: Promise<void>; release: () => void } | null = null;

  constructor(options: JobServiceOptions) {
    this.store = new JobStore(options.db);
    this.log = options.log ?? silent;
    this.now = options.now ?? Date.now;
    this.throttle = new KeyedThrottle<number, JobChangeReason>(
      EVENT_INTERVAL_MS,
      (id, reason) => this.emitNow(id, reason),
      options.throttleClock,
    );
  }

  // ---- Registration and lifecycle ----------------------------------------------------------

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.kind)) throw new Error(`A job handler for "${handler.kind}" is already registered`);
    this.handlers.set(handler.kind, handler);
  }

  hasHandler(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /**
   * Fix up jobs the last run left `running`, `needs_you` or still `queued`. Nothing continues by itself: every one of them ends as "Interrupted when
   * the app closed" and keeps its checkpoint (`resume_json`); a queued one that never started says so and waits for Continue too. A resumable job with a checkpoint can be carried on by the person with
   * `continueInterrupted`; they can also `dismissInterrupted` it. Call after all handlers are registered. Starts nothing.
   */
  recoverInterrupted(): { interrupted: number } {
    let interrupted = 0;
    const now = this.now();
    for (const stored of this.store.interrupted()) {
      const id = stored.record.id;
      const handlerResumable = this.handlers.get(stored.record.kind)?.resumable === true;
      const resumable = handlerResumable && stored.resumeJson !== null;
      // Still waiting in the queue and never started: held like an interrupted one (Continue starts it from the beginning, Dismiss drops the offer).
      const waiting = stored.record.state === 'queued' && stored.resumeJson === null && handlerResumable;
      this.store.finish(id, 'failed', now, waiting ? { error: INTERRUPTED_MESSAGE, message: NOT_STARTED_MESSAGE } : { error: INTERRUPTED_MESSAGE });
      this.store.addEvent(
        id,
        now,
        resumable || waiting ? 'info' : 'error',
        waiting
          ? `${NOT_STARTED_MESSAGE}. It starts only when you press Continue.`
          : resumable
            ? `${parseJobError(INTERRUPTED_MESSAGE).text}. It carries on from its last checkpoint only when you press Continue.`
            : parseJobError(INTERRUPTED_MESSAGE).text,
      );
      this.emitNow(id, 'state');
      interrupted += 1;
    }
    if (interrupted > 0) this.log.info(`jobs: ${interrupted} job(s) were interrupted when the app closed; none was started again`);
    return { interrupted };
  }

  /**
   * The person pressed Continue on an interrupted job: it goes back to the queue and carries on from its last checkpoint. Only for a
   * resumable kind that kept a checkpoint and was not dismissed or started again; otherwise false and nothing changes.
   */
  continueInterrupted(id: number): boolean {
    const stored = this.store.getStored(id);
    if (!stored || !isContinuable(stored.record)) return false;
    if (this.handlers.get(stored.record.kind)?.resumable !== true) return false;
    // No checkpoint is allowed only for a job that never started (it was still queued when the app closed).
    if (stored.resumeJson === null && stored.record.message !== NOT_STARTED_MESSAGE) return false;
    this.store.requeueFromCheckpoint(id);
    this.store.addEvent(id, this.now(), 'info', stored.resumeJson === null ? 'Started by you with Continue' : 'Continued by you from the last checkpoint');
    this.log.info(`jobs: #${id} continued from its checkpoint by a click on Continue`);
    this.emitNow(id, 'state');
    this.pump();
    return true;
  }

  /** The person pressed Dismiss on an interrupted job: it is marked as seen and Continue goes away. The row and its checkpoint stay. */
  dismissInterrupted(id: number): boolean {
    const record = this.store.get(id);
    if (!record || record.state !== 'failed' || parseJobError(record.error).code !== 'interrupted' || record.message === DISMISSED_MESSAGE) return false;
    this.store.setSeen(id, DISMISSED_MESSAGE);
    this.store.addEvent(id, this.now(), 'info', 'Dismissed by you');
    this.emitNow(id, 'state');
    return true;
  }

  /** Allow jobs to run. The app calls this 3 s after the first paint; queued jobs begin now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pump();
  }

  /** Housekeeping the app does once after start: drop job log lines older than 90 days. */
  pruneOldEvents(): number {
    const removed = this.store.pruneEvents(this.now());
    if (removed > 0) this.log.info(`jobs: pruned ${removed} job log lines older than 90 days`);
    return removed;
  }

  /** The laptop is going to sleep: no new jobs start until `resumeAfterSleep()`. */
  suspend(): void {
    if (this.paused) return;
    this.paused = true;
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.wake = { promise, release };
  }

  /** The laptop woke up: note it in running jobs' logs, wake waiting handlers, start queued jobs. */
  resumeAfterSleep(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wakes += 1;
    const now = this.now();
    for (const [id, live] of this.live) {
      if (live.finalized) continue;
      this.store.addEvent(id, now, 'info', SLEPT_MESSAGE);
      this.emitSoon(id, 'log');
    }
    this.wake?.release();
    this.wake = null;
    this.pump();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** How many times the laptop has woken up since the app started. A phone backup compares it between files: a wake is treated like an unplug. */
  get wakeCount(): number {
    return this.wakes;
  }

  /** App is quitting: stop handlers without marking jobs failed (they resume or fail on next start). */
  shutdown(): void {
    this.shuttingDown = true;
    this.throttle.dispose();
    for (const live of this.live.values()) {
      live.controller.abort();
      live.pending?.reject(new JobAborted());
      live.pending = null;
      live.gate?.release();
    }
    this.wake?.release();
    this.listeners.clear();
  }

  /**
   * The shutdown routine's way to pause running jobs: stop them (see shutdown), then wait until their handlers have wound down (they
   * write their last checkpoint on the way) or `maxMs` has passed. Resolves in both cases; never throws.
   */
  async shutdownAndWait(maxMs: number): Promise<{ settled: boolean }> {
    this.shutdown();
    const deadline = Date.now() + maxMs;
    while (this.live.size > 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return { settled: this.live.size === 0 };
  }

  // ---- Public API --------------------------------------------------------------------------

  create(kind: string, title: string, params: unknown = {}, startedBy: string | null = null): number {
    const id = this.store.create(kind, title, params, this.now(), startedBy);
    this.emitNow(id, 'created');
    this.pump();
    return id;
  }

  /**
   * Create `kind` unless one is already queued/running or one finished within `intervalMs`.
   * Used for the daily integrity check and snapshot.
   */
  ensureRecurring(kind: string, title: string, intervalMs: number, params: unknown = {}, startedBy: string | null = null): number | null {
    if (this.store.hasActive(kind)) return null;
    const last = this.store.lastFinishedAt(kind);
    if (last !== null && this.now() - last < intervalMs) return null;
    return this.create(kind, title, params, startedBy);
  }

  list(filter: JobListFilter = {}): JobRecord[] {
    const records = this.store.list(filter);
    const retried = records.some((r) => r.state === 'failed') ? this.store.retriedByMap() : new Map<number, number>();
    return records.map((record) => this.withOwner(this.overlay(withRetried(record, retried))));
  }

  get(id: number): JobRecord | null {
    const record = this.store.get(id);
    return record ? this.withOwner(this.overlay(record.state === 'failed' ? withRetried(record, this.store.retriedByMap()) : record)) : null;
  }

  /** Whose job a job of this kind with these parameters is (a person's id), or null when it is shared. Set by the app; without it jobs carry no owner. */
  private ownerResolver: ((kind: string, params: unknown) => number | null) | null = null;

  setOwnerResolver(resolver: ((kind: string, params: unknown) => number | null) | null): void {
    this.ownerResolver = resolver;
  }

  /** Which backups a job of this kind with these parameters works on (ids), empty when none. Set by the app; without it jobs name no backup. */
  private backupsResolver: ((kind: string, params: unknown) => number[]) | null = null;

  setBackupsResolver(resolver: ((kind: string, params: unknown) => number[]) | null): void {
    this.backupsResolver = resolver;
  }

  private withOwner(record: JobRecord): JobRecord {
    if (!this.ownerResolver && !this.backupsResolver) return record;
    try {
      const params = this.store.paramsOf(record.id);
      const backupIds = this.backupsResolver ? this.backupsResolver(record.kind, params) : [];
      return {
        ...record,
        ...(this.ownerResolver ? { personId: this.ownerResolver(record.kind, params) } : {}),
        ...(backupIds.length > 0 ? { backupIds } : {}),
      };
    } catch {
      return record;
    }
  }

  /** The parameters the job was created with (null when the job does not exist). */
  params(id: number): unknown {
    return this.store.getStored(id)?.params ?? null;
  }

  events(id: number): JobEvent[] {
    return this.store.events(id);
  }

  /**
   * New job with the same kind, title and parameters. The old one stays as history, but it is marked "Retried as job #N"
   * (its row then says Retried and no longer shows as Interrupted or Failed: the result is the retry's).
   */
  retry(id: number): number {
    const stored = this.store.getStored(id);
    if (!stored) throw new Error(`No job #${id}`);
    if (!isFinished(stored.record.state)) throw new Error('Only a finished job can be retried');
    if (NO_RETRY_JOB_KINDS.includes(stored.record.kind)) throw new Error('A clean-up cannot be retried: plan it and confirm it again on the Clean up screen.');
    const newId = this.store.create(stored.record.kind, stored.record.title, stored.params, this.now(), `Started by you: Retry of job #${id}`);
    this.store.addEvent(newId, this.now(), 'info', `Retry of job #${id}`);
    this.store.addEvent(id, this.now(), 'info', `Retried as job #${newId}`);
    this.emitNow(newId, 'created');
    this.emitNow(id, 'state');
    this.pump();
    return newId;
  }

  /**
   * The person pressed Stop (only the window's Stop button calls this). It ends as failed with the "Stopped by you" code.
   * Anything the app stops by itself goes through `cancelByApp`, which says why: "by you" is never written for it.
   */
  cancel(id: number): boolean {
    this.log.info(`jobs: #${id} stopped by a click on Stop`);
    return this.stop(id, CANCELLED_MESSAGE);
  }

  /** The app stops a job by itself (for example to let a drive be ejected). The reason is shown to the person. */
  cancelByApp(id: number, reason: string): boolean {
    this.log.info(`jobs: #${id} stopped by the app: ${reason}`);
    return this.stop(id, stoppedByApp(reason));
  }

  private stop(id: number, error: string): boolean {
    const live = this.live.get(id);
    if (live) {
      if (live.finalized) return false;
      live.controller.abort();
      live.pending?.reject(new JobAborted());
      live.pending = null;
      live.gate?.release();
      live.stopError = error;
      this.dropOnStop(id, live.handler);
      this.finalizeFailed(live, error, null);
      return true;
    }
    const record = this.store.get(id);
    if (!record || record.state !== 'queued') return false;
    const now = this.now();
    this.dropOnStop(id, this.handlers.get(record.kind));
    this.store.finish(id, 'failed', now, { error });
    this.store.addEvent(id, now, 'warn', parseJobError(error).text);
    this.emitNow(id, 'state');
    return true;
  }

  /** A Stop is abrupt: the kind drops what it saved for half-done work (an upload on its way) from the checkpoint it keeps. */
  private dropOnStop(id: number, handler: JobHandler | undefined): void {
    if (!handler?.onStop) return;
    try {
      const stored = this.store.getStored(id);
      if (stored?.resumeJson == null) return;
      this.store.saveCheckpoint(id, JSON.stringify(handler.onStop(safeParse(stored.resumeJson)) ?? null));
    } catch (err) {
      this.log.warn(`jobs: #${id} could not clean its checkpoint at Stop`, err);
    }
  }

  /**
   * Pause a queued or running job. A queued job simply waits. A running job is "pausing" until it reaches its next
   * `ctx.yield()` (between files: it finishes the file it is on first, and saves its place); then it is held, gives up its slot
   * (another heavy job can run) and the window says "safe to close". It stays in the 'queued' state with `paused` set (saved, so it stays paused after a restart).
   */
  pause(id: number): boolean {
    return this.pauseWith(id, PAUSED_MESSAGE, 'Paused by you');
  }

  private pauseWith(id: number, message: string, eventText: string): boolean {
    const live = this.live.get(id);
    const now = this.now();
    if (live) {
      if (live.finalized || live.record.paused || live.record.state === 'needs_you') return false;
      const alreadyHeld = live.suspended && live.parked; // resumed and waiting for its turn: the handler is still held at its safe point
      live.suspended = true;
      live.parked = alreadyHeld;
      live.holdSaved = alreadyHeld;
      live.pausedAt = now;
      live.pausedMessage = message;
      live.gate ??= makeGate();
      const r = live.record;
      r.state = 'queued';
      r.paused = true;
      r.pausing = !alreadyHeld;
      r.message = alreadyHeld ? message : PAUSING_MESSAGE;
      r.speed = null;
      r.etaSeconds = null;
      this.persistProgress(live);
      this.store.markPaused(id, message);
      this.store.addEvent(id, now, 'info', eventText);
      this.throttle.drop(id);
      this.emitNow(id, 'state');
      // Its slot and drive are given up when the handler reaches its safe point (see `hold`), not before: it is still working until then.
      return true;
    }
    const record = this.store.get(id);
    if (!record || record.state !== 'queued' || record.paused) return false;
    this.store.setPaused(id, true);
    // "Pause everything" marks its jobs by the message, so it lets go of exactly these when it ends (also after a restart).
    if (message !== PAUSED_MESSAGE) this.store.setMessage(id, message);
    this.store.addEvent(id, now, 'info', eventText);
    this.emitNow(id, 'state');
    return true;
  }

  /** Let a paused job go on. A job still in memory waits for a free slot first. */
  resume(id: number): boolean {
    return this.resumeWith(id, 'Resumed by you');
  }

  private resumeWith(id: number, eventText: string): boolean {
    const live = this.live.get(id);
    const now = this.now();
    if (live) {
      if (live.finalized || !live.record.paused) return false;
      live.record.paused = false;
      live.record.pausing = false;
      live.record.message = WAITING_TURN_MESSAGE;
      live.samples = [];
      live.itemSamples = [];
      live.sampleUnit = null;
      this.store.setPaused(id, false);
      this.store.addEvent(id, now, 'info', eventText);
      if (!live.parked) this.unsuspend(live); // it never gave up its slot: it just goes on
      else {
        this.emitNow(id, 'state');
        this.pump();
      }
      return true;
    }
    const record = this.store.get(id);
    if (!record || record.state !== 'queued' || !record.paused) return false;
    this.store.setPaused(id, false);
    if (record.message === PAUSED_ALL_MESSAGE) this.store.setMessage(id, null);
    this.store.addEvent(id, now, 'info', eventText);
    this.emitNow(id, 'state');
    this.pump();
    return true;
  }

  /** Answer a job that is waiting in `needs_you`. Returns false if it was not waiting or the answer is not allowed. */
  resolve(id: number, answer: string): boolean {
    const live = this.live.get(id);
    if (!live || live.finalized || !live.pending || live.record.state !== 'needs_you') return false;
    const choices = live.record.choices;
    if (choices.length > 0 && !choices.includes(answer)) return false;
    const pending = live.pending;
    live.pending = null;
    live.record.state = 'running';
    live.record.message = null;
    live.record.choices = [];
    this.store.markRunning(id, this.now());
    this.store.addEvent(id, this.now(), 'info', `You answered: ${answer}`);
    this.emitNow(id, 'state');
    pending.resolve(answer);
    return true;
  }

  onChanged(listener: (event: JobChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Runner ------------------------------------------------------------------------------

  private runningCounts(): { heavy: number; light: number } {
    let heavy = 0;
    let light = 0;
    for (const live of this.live.values()) {
      if (live.suspended && live.parked) continue;
      if (live.handler.heavy) heavy += 1;
      else light += 1;
    }
    return { heavy, light };
  }

  /** Asked before a heavy job starts: a plain sentence refuses it (the job fails with that sentence), null lets it run. */
  private startGate: ((kind: string) => string | null) | null = null;

  setStartGate(gate: ((kind: string) => string | null) | null): void {
    this.startGate = gate;
  }

  /** Which drives (place ids) a job of this kind with these parameters reads or writes. Set by the app; without it no drive queue applies. */
  private driveResolver: ((kind: string, params: unknown) => string[]) | null = null;
  /** Asked before a job that uses drives starts: a plain sentence refuses it (USB trouble, not enough room), null lets it run. */
  private driveGate: ((kind: string, drives: string[]) => string | null) | null = null;

  setDriveResolver(resolver: ((kind: string, params: unknown) => string[]) | null): void {
    this.driveResolver = resolver;
  }

  setDriveGate(gate: ((kind: string, drives: string[]) => string | null) | null): void {
    this.driveGate = gate;
  }

  /** True while a running (not paused) job uses one of these drives. */
  private driveBusy(drives: readonly string[]): boolean {
    if (drives.length === 0) return false;
    for (const live of this.live.values()) {
      if (live.finalized || (live.suspended && live.parked)) continue;
      if (live.drives.some((d) => drives.includes(d))) return true;
    }
    return false;
  }

  private drivesOf(id: number, kind: string): string[] {
    if (!this.driveResolver) return [];
    try {
      return [...new Set(this.driveResolver(kind, this.store.getStored(id)?.params ?? {}))];
    } catch {
      return [];
    }
  }

  /**
   * "Pause everything". On: every running job stops at its next safe point (the same pause as the person's Pause button, with its
   * own message), queued jobs wait, nothing new starts. Off: the jobs it paused go on and the queue runs again. Safe to call with the
   * same value twice; calling it with false also lets go of jobs a previous run (before a restart) left paused by it.
   */
  setHeld(held: boolean): void {
    if (held) {
      if (this.held) return;
      this.held = true;
      for (const id of this.live.keys()) this.pauseWith(id, PAUSED_ALL_MESSAGE, 'Paused by Pause everything');
      this.log.info('jobs: Pause everything is on; running jobs stop at their next safe point and queued jobs wait');
      return;
    }
    const wasHeld = this.held;
    this.held = false;
    let released = 0;
    for (const id of this.store.pausedWithMessage(PAUSED_ALL_MESSAGE)) if (this.resumeWith(id, 'Resumed: Pause everything ended')) released += 1;
    if (wasHeld || released > 0) this.log.info(`jobs: Pause everything is off; ${released} paused job(s) go on`);
    this.pump();
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** True while some job is running or waiting for its turn. The quiet upkeep of the database never runs then. */
  hasPendingWork(): boolean {
    return this.store.anyWorkPending();
  }

  private pump(): void {
    if (!this.started || this.paused || this.held || this.shuttingDown) return;
    const counts = this.runningCounts();
    // Jobs that were paused and resumed take a slot again before anything new starts.
    for (const live of this.live.values()) {
      if (!live.suspended || live.finalized || live.record.paused) continue;
      if (live.handler.heavy ? counts.heavy >= MAX_HEAVY_JOBS : counts.light >= MAX_LIGHT_JOBS) continue;
      if (live.handler.heavy) counts.heavy += 1;
      else counts.light += 1;
      this.unsuspend(live);
    }
    for (const { id, kind } of this.store.queued()) {
      if (this.live.has(id)) continue;
      const handler = this.handlers.get(kind);
      if (!handler) {
        const now = this.now();
        this.store.finish(id, 'failed', now, { error: 'This kind of job is not available in this version of the app.' });
        this.store.addEvent(id, now, 'error', `No handler registered for "${kind}"`);
        this.emitNow(id, 'state');
        continue;
      }
      // One job at a time per drive (anything that reads or writes it): a queued job waits its turn.
      const drives = this.drivesOf(id, kind);
      if (this.driveBusy(drives)) continue;
      if (drives.length > 0 && (handler.heavy ? counts.heavy < MAX_HEAVY_JOBS : counts.light < MAX_LIGHT_JOBS)) {
        const refusal = this.driveGate?.(kind, drives) ?? null;
        if (refusal !== null) {
          const refusedAt = this.now();
          this.store.finish(id, 'failed', refusedAt, { error: withErrorCode('refused', refusal) });
          this.store.addEvent(id, refusedAt, 'warn', refusal);
          this.emitNow(id, 'state');
          continue;
        }
      }
      if (handler.heavy) {
        if (counts.heavy >= MAX_HEAVY_JOBS) continue;
        // Not enough room on the data disk: the job does not start, and says why in plain words.
        const refusal = this.startGate?.(kind) ?? null;
        if (refusal !== null) {
          const refusedAt = this.now();
          this.store.finish(id, 'failed', refusedAt, { error: withErrorCode('refused', refusal) });
          this.store.addEvent(id, refusedAt, 'warn', refusal);
          this.emitNow(id, 'state');
          continue;
        }
        counts.heavy += 1;
      } else {
        if (counts.light >= MAX_LIGHT_JOBS) continue;
        counts.light += 1;
      }
      this.launch(id, handler, drives);
    }
  }

  private unsuspend(live: LiveJob): void {
    const id = live.record.id;
    live.suspended = false;
    live.parked = false;
    live.record.pausing = false;
    live.pausedMessage = null;
    // The time the job was paused or waiting for its turn is not working time: the time left is worked out from active time only.
    if (live.pausedAt !== null) live.record.pausedMs = (live.record.pausedMs ?? 0) + Math.max(0, this.now() - live.pausedAt);
    live.pausedAt = null;
    live.record.state = 'running';
    live.record.message = null;
    this.store.markRunning(id, this.now());
    const gate = live.gate;
    live.gate = null;
    gate?.release();
    this.emitNow(id, 'state');
  }

  private launch(id: number, handler: JobHandler, drives: string[] = []): void {
    const stored = this.store.getStored(id);
    if (!stored) return;
    const now = this.now();
    const resuming = stored.resumeJson !== null;
    this.store.markRunning(id, now);
    const record = this.store.get(id);
    if (!record) return;
    const live: LiveJob = {
      record,
      handler,
      controller: new AbortController(),
      samples: [],
      itemSamples: [],
      sampleUnit: null,
      lastPersist: now,
      finalized: false,
      pending: null,
      suspended: false,
      gate: null,
      drives,
      stopError: null,
      pausedAt: null,
      parked: false,
      holdSave: null,
      holdSaved: false,
      pausedMessage: null,
    };
    this.live.set(id, live);
    this.store.addEvent(id, now, 'info', resuming ? 'Continuing from the last checkpoint' : 'Started');
    this.emitNow(id, 'state');
    void this.execute(live, stored.params, resuming ? safeParse(stored.resumeJson) : null);
  }

  private async execute(live: LiveJob, params: unknown, resume: unknown): Promise<void> {
    const id = live.record.id;
    try {
      // Let the "running" event go out and the event loop breathe before the handler's first work.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (live.controller.signal.aborted) throw new JobAborted();
      const result = await live.handler.run(this.makeContext(live, params, resume));
      if (!live.finalized && !this.shuttingDown) {
        const message = typeof result === 'string' ? result : (result?.message ?? null);
        this.finalizeDone(live, message);
      }
    } catch (err) {
      if (this.shuttingDown) {
        // Left as "running" on purpose: the next start resumes it (if resumable) or marks it interrupted.
      } else if (!live.finalized) {
        if (live.controller.signal.aborted) {
          this.finalizeFailed(live, live.stopError ?? CANCELLED_MESSAGE, null);
        } else {
          const { plain, detail, code } = describeError(err);
          this.log.warn(`jobs: #${id} ${live.record.kind} failed: ${plain}`, err);
          this.finalizeFailed(live, code === 'failed' ? plain : withErrorCode(code, plain), detail);
        }
      }
    } finally {
      this.live.delete(id);
      this.pump();
    }
  }

  private persistProgress(live: LiveJob): void {
    const r = live.record;
    this.store.saveProgress(r.id, {
      done: r.progressDone,
      total: r.progressTotal,
      bytesDone: r.bytesDone,
      bytesTotal: r.bytesTotal,
      message: r.paused ? (live.pausedMessage ?? r.message) : r.message,
    });
    live.lastPersist = this.now();
  }

  private finalizeDone(live: LiveJob, message: string | null): void {
    const r = live.record;
    live.finalized = true;
    const now = this.now();
    if (r.progressTotal > 0) r.progressDone = r.progressTotal;
    if (r.bytesTotal > 0) r.bytesDone = r.bytesTotal;
    if (message !== null) r.message = message;
    this.persistProgress(live);
    const state = r.warnings.length > 0 ? 'done_warnings' : 'done';
    this.store.finish(r.id, state, now, { message });
    this.store.addEvent(
      r.id,
      now,
      r.warnings.length > 0 ? 'warn' : 'info',
      r.warnings.length > 0 ? `Finished with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : 'Finished',
    );
    this.throttle.drop(r.id);
    this.emitNow(r.id, 'state');
  }

  private finalizeFailed(live: LiveJob, error: string, detail: string | null): void {
    const r = live.record;
    live.finalized = true;
    const now = this.now();
    this.persistProgress(live);
    this.store.finish(r.id, 'failed', now, { error });
    const { code, text } = parseJobError(error);
    this.store.addEvent(r.id, now, code === 'stopped-by-you' || code === 'stopped-by-app' ? 'warn' : 'error', text);
    if (detail) {
      // Error level, so the details block of the Activity screen always has the stack and the step the job was on.
      this.store.addEvent(r.id, now, 'error', `Technical detail: ${detail}`);
      this.store.addEvent(r.id, now, 'error', `Last step: ${r.message ?? (r.progressTotal > 0 ? `${r.progressDone} of ${r.progressTotal} done` : 'before the first step')}`);
    }
    this.throttle.drop(r.id);
    this.emitNow(r.id, 'state');
  }

  private makeContext(live: LiveJob, params: unknown, resume: unknown): JobContext {
    const id = live.record.id;
    const alive = () => !live.finalized && !this.shuttingDown;
    return {
      jobId: id,
      params,
      resume,
      signal: live.controller.signal,

      progress: (done, total, extras = {}) => {
        if (!alive()) return;
        const r = live.record;
        r.progressDone = Math.max(0, done);
        r.progressTotal = Math.max(0, total);
        if (extras.bytesDone !== undefined) r.bytesDone = Math.max(0, extras.bytesDone);
        if (extras.bytesTotal !== undefined) r.bytesTotal = Math.max(0, extras.bytesTotal);
        if (extras.message !== undefined && !r.paused) r.message = extras.message; // a paused job keeps its Pausing / Paused line
        this.updateRate(live);
        if (this.now() - live.lastPersist >= PERSIST_INTERVAL_MS) this.persistProgress(live);
        this.throttle.push(id, 'progress');
      },

      log: (level, text) => {
        if (!alive()) return;
        // A log line is a note, not the work: a busy database must not stop the job over it (job #92 died on one).
        try {
          this.store.addEvent(id, this.now(), level, text);
        } catch (err) {
          this.log.warn(`jobs: #${id} could not write a log line`, err);
          return;
        }
        this.throttle.push(id, 'log');
      },

      warn: (text) => {
        if (!alive()) return;
        live.record.warnings = [...live.record.warnings, text];
        this.store.saveWarnings(id, live.record.warnings);
        this.store.addEvent(id, this.now(), 'warn', text);
        this.throttle.push(id, 'log');
      },

      needsYou: (message, choices = []) => {
        if (!alive() || live.controller.signal.aborted) return Promise.reject(new JobAborted());
        const r = live.record;
        r.state = 'needs_you';
        r.message = message;
        r.choices = choices;
        r.speed = null;
        r.etaSeconds = null;
        this.persistProgress(live);
        this.store.markNeedsYou(id, message);
        this.store.addEvent(id, this.now(), 'info', `Needs you: ${message}`);
        this.throttle.drop(id);
        this.emitNow(id, 'state');
        return new Promise<string>((resolve, reject) => {
          live.pending = { resolve, reject };
        });
      },

      checkpoint: (value) => {
        if (!alive()) return;
        this.store.saveCheckpoint(id, JSON.stringify(value ?? null));
        live.record.hasCheckpoint = true;
      },

      yield: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (live.suspended && live.gate && !live.controller.signal.aborted && !this.shuttingDown) await this.hold(live);
        while (live.suspended && live.gate && !live.controller.signal.aborted && !this.shuttingDown) await live.gate.promise;
        while (this.paused && this.wake && !live.controller.signal.aborted) await this.wake.promise;
        if (live.controller.signal.aborted || this.shuttingDown) throw new JobAborted();
      },

      turn: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        while (this.paused && this.wake && !live.controller.signal.aborted) await this.wake.promise;
        if (live.controller.signal.aborted || this.shuttingDown) throw new JobAborted();
      },

      beforeHold: (save) => {
        live.holdSave = save;
      },
    };
  }

  /**
   * The handler is at a safe point and a pause is waiting: what it asked to be saved is saved (once per pause), then the job is held ("Paused", safe to
   * close the app), its slot and drive are free for another job. A save that fails is logged and the job is still held: its last checkpoint stays.
   */
  private async hold(live: LiveJob): Promise<void> {
    const id = live.record.id;
    if (!live.holdSaved) {
      live.holdSaved = true;
      try {
        await live.holdSave?.();
      } catch (err) {
        this.log.warn(`jobs: #${id} could not save its place before the pause`, err);
      }
    }
    if (!live.suspended || !live.gate || live.parked || live.finalized) return;
    live.parked = true;
    live.record.pausing = false;
    live.record.message = live.pausedMessage ?? PAUSED_MESSAGE;
    this.emitNow(id, 'state');
    this.pump(); // its slot is free for another job
  }

  private updateRate(live: LiveJob): void {
    const r = live.record;
    const measure = pickMeasure(r);
    if (!measure) {
      r.speed = null;
      r.etaSeconds = null;
      return;
    }
    const now = this.now();
    if (live.sampleUnit !== measure.unit) {
      live.samples = [];
      live.itemSamples = [];
      live.sampleUnit = measure.unit;
    }
    live.samples.push({ at: now, done: measure.done });
    live.samples = live.samples.filter((s) => s.at >= now - SAMPLE_KEEP_MS);
    const perSecond = computeSpeed(live.samples, now);
    live.itemSamples.push({ at: now, done: r.progressDone });
    live.itemSamples = live.itemSamples.filter((s) => s.at >= now - SAMPLE_KEEP_MS);
    const itemsPerSecond = measure.unit === 'bytes' && r.progressTotal > 0 ? computeSpeed(live.itemSamples, now) : null;
    r.speed = perSecond === null ? null : { unit: measure.unit, perSecond, itemsPerSecond };
    r.etaSeconds = computeEtaSeconds(measure.done, measure.total, perSecond);
  }

  // ---- Events ------------------------------------------------------------------------------

  /** The freshest view of a job: live in-memory numbers for jobs being run, else the database row. */
  private overlay(record: JobRecord): JobRecord {
    const live = this.live.get(record.id);
    return live && !live.finalized ? { ...live.record } : record;
  }

  private emitSoon(id: number, reason: JobChangeReason): void {
    this.throttle.push(id, reason);
  }

  private emitNow(id: number, reason: JobChangeReason): void {
    if (this.listeners.size === 0) return;
    const job = this.get(id);
    if (!job) return;
    const event: JobChangedEvent = { reason, job };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn('jobs: a change listener threw', err);
      }
    }
  }
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function safeParse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function withRetried(record: JobRecord, retried: ReadonlyMap<number, number>): JobRecord {
  const by = retried.get(record.id);
  return by === undefined ? record : { ...record, retriedBy: by };
}
