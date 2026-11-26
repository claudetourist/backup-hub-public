import { HASH_FILES_JOB_KIND, type FingerprintNowResult, type HashFilesParams, type CoverageBucket, type HashingState, type PlaceCoverage, type PlaceFingerprint, type RetryFailedResult } from '../../shared/fingerprint';
import { isFinished, type JobChangedEvent, type JobRecord, type PlaceJobRef } from '../../shared/jobs';
import { isListingJobKind } from '../../shared/listing';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import type { FingerprintCounts } from '../copies/copiesIndex';
import type { Db } from '../db';
import type { CoverageSnapshot, RequestOptions, StatsSnapshot } from '../query/queryService';
import { clearErrors, queueTotals } from './queue';

/** The slice of the job service the fingerprint triggers need. */
export interface FingerprintJobs {
  create(kind: string, title: string, params: unknown): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
  params(id: number): unknown;
  onChanged(listener: (event: JobChangedEvent) => void): () => void;
}

/** The slice of the query service Sources needs: cached numbers, and requests that count in the background. */
export interface FingerprintQuery {
  coverage(): CoverageSnapshot | null;
  stats(): StatsSnapshot | null;
  requestCoverage(options?: RequestOptions): void;
  requestStats(options?: RequestOptions): void;
}

export interface FingerprintServiceDeps {
  db: Db;
  /** Counts that take long run in the query worker; this class only reads what it has cached. */
  query: FingerprintQuery;
  jobs: FingerprintJobs;
  /** True when the place is reachable right now. */
  isConnected: (placeId: string) => boolean;
  now?: () => number;
  /** Called when what Sources shows changed (state, counts, coverage). */
  onStateChanged?: () => void;
  /** Called when files were put back in the queue (the counts made from the file list are out of date). */
  dataChanged?: () => void;
  log?: { info(...args: unknown[]): void };
}

interface ActiveJob {
  id: number;
  paused: boolean;
  speedFiles: number | null;
  /** Null = every connected local place. */
  placeId: string | null;
  state: 'queued' | 'running';
  speed: number | null;
  message: string | null;
}

/** Progress changes reach Sources at most this often. */
const PUSH_INTERVAL_MS = 3_000;
const emptyBucket = (): CoverageBucket => ({ files: 0, bytes: 0 });
const emptyCoverage = (): PlaceCoverage => ({ none: emptyBucket(), one: emptyBucket(), twoPlus: emptyBucket(), notFingerprinted: emptyBucket(), cloudOnly: emptyBucket(), empty: emptyBucket() });
const LOCAL_KINDS = new Set(['laptop', 'drive', 'onedrive']);

export const NOTHING_WAITING_MESSAGE = 'Every file on that place has already been matched, or could not be read. Use Try again for files that failed.';

/**
 * Starts fingerprint jobs ("Fingerprint now", "Try again") and answers what Sources shows: percent fingerprinted, how many other
 * places hold each file, and what the job is doing. Nothing is read by this class itself.
 */
export class FingerprintService {
  private readonly now: () => number;
  private readonly active = new Map<number, ActiveJob>();
  private pausedReason: string | null = null;
  private lastPush = 0;

  constructor(private readonly deps: FingerprintServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.jobs.onChanged((event) => this.onJobEvent(event));
    for (const job of deps.jobs.list({ states: ['queued', 'running', 'needs_you'] })) this.track(job);
  }

  private track(job: JobRecord): void {
    if (job.kind !== HASH_FILES_JOB_KIND) return;
    if (isFinished(job.state)) {
      this.active.delete(job.id);
      if (this.active.size === 0) this.pausedReason = null;
      return;
    }
    const known = this.active.get(job.id);
    let placeId = known?.placeId ?? null;
    if (!known) {
      const params = this.deps.jobs.params(job.id) as Partial<HashFilesParams> | null;
      placeId = typeof params?.placeId === 'string' ? params.placeId : null;
    }
    this.active.set(job.id, {
      id: job.id,
      paused: job.paused,
      speedFiles: job.speed?.itemsPerSecond ?? null,
      placeId,
      state: job.state === 'queued' ? 'queued' : 'running',
      speed: job.speed?.unit === 'bytes' ? job.speed.perSecond : null,
      message: job.state === 'running' ? job.message : null,
    });
  }

  private onJobEvent(event: JobChangedEvent): void {
    const kind = event.job.kind;
    if (kind !== HASH_FILES_JOB_KIND && !isListingJobKind(kind) && kind !== IMPORT_V1_JOB_KIND) return;
    if (event.reason === 'state' && isFinished(event.job.state)) this.invalidate();
    if (kind === HASH_FILES_JOB_KIND) {
      if (event.reason === 'created' || event.reason === 'state') {
        this.track(event.job);
        this.deps.onStateChanged?.();
      } else if (event.reason === 'progress') {
        this.track(event.job);
        this.refreshWhileRunning();
        if (this.now() - this.lastPush >= PUSH_INTERVAL_MS) {
          this.lastPush = this.now();
          this.deps.onStateChanged?.();
        }
      }
      return;
    }
  }

  /** The job tells the service it is waiting for power (a reason) or going again (null). */
  notePaused(reason: string | null): void {
    this.pausedReason = reason;
    this.deps.onStateChanged?.();
  }

  /** The job tells the service it started, so a job resumed after a restart is known too. */
  noteStarted(jobId: number, placeId: string | null): void {
    const known = this.active.get(jobId);
    this.active.set(jobId, { id: jobId, paused: false, speedFiles: known?.speedFiles ?? null, placeId, state: 'running', speed: known?.speed ?? null, message: known?.message ?? null });
    this.deps.onStateChanged?.();
  }

  // ---- What Sources shows --------------------------------------------------------------------

  /** A listing, import or fingerprint run finished: count again now (in the worker; the old numbers stay on screen meanwhile). */
  invalidate(): void {
    this.deps.query.requestStats({ force: true });
    this.deps.query.requestCoverage({ force: true });
  }

  /** While files are being fingerprinted the numbers would stand still: ask for a recount (the query service spaces them out). */
  private refreshWhileRunning(): void {
    this.deps.query.requestStats({ progress: true });
    this.deps.query.requestCoverage({ progress: true });
  }

  private countsFor(placeId: string): FingerprintCounts {
    const snap = this.deps.query.stats();
    if (!snap) this.deps.query.requestStats();
    return snap?.fingerprint.get(placeId) ?? { fileCount: 0, fingerprintedFiles: 0, totalBytes: 0, fingerprintedBytes: 0, failedFiles: 0 };
  }

  private entryFor(placeId: string): ActiveJob | null {
    let best: ActiveJob | null = null;
    for (const entry of this.active.values()) {
      if (entry.placeId !== null && entry.placeId !== placeId) continue;
      if (entry.state === 'running') return entry;
      best = best ?? entry;
    }
    return best;
  }

  stateOf(placeId: string): HashingState {
    const entry = this.entryFor(placeId);
    if (!entry) return 'idle';
    if (entry.paused) return 'paused';
    if (entry.state === 'queued') return 'queued';
    return this.pausedReason !== null ? 'paused' : 'running';
  }

  isFingerprinting(placeId: string): boolean {
    return this.stateOf(placeId) !== 'idle';
  }

  /** Cached coverage from the query worker; null until the first count is in. */
  private coverageFor(placeId: string): { coverage: PlaceCoverage; at: number } | null {
    const snap = this.deps.query.coverage();
    if (!snap) {
      this.deps.query.requestCoverage();
      return null;
    }
    return { coverage: snap.byPlace.get(placeId) ?? emptyCoverage(), at: snap.at };
  }

  /** The fingerprint picture of one local place (null for places that have no files of their own on this PC). */
  fingerprintOf(placeId: string, kind: string): PlaceFingerprint | null {
    if (!LOCAL_KINDS.has(kind)) return null;
    const c = this.countsFor(placeId);
    const entry = this.entryFor(placeId);
    const state = this.stateOf(placeId);
    const cov = this.coverageFor(placeId);
    return {
      ...c,
      state,
      speedBytesPerSec: state === 'running' ? (entry?.speed ?? null) : null,
      speedFilesPerSec: state === 'running' ? (entry?.speedFiles ?? null) : null,
      job: entry ? ({ id: entry.id, paused: entry.paused } satisfies PlaceJobRef) : null,
      failedReason: c.failedFiles > 0 ? (this.deps.query.stats()?.failReasons.get(placeId) ?? null) : null,
      detail: state === 'paused' ? (entry?.paused ? 'Paused by you' : this.pausedReason) : state === 'running' ? (entry?.message ?? null) : null,
      coverage: cov?.coverage ?? null,
      countedAt: cov?.at ?? null,
    };
  }

  /** Files waiting for a fingerprint in a place. */
  waiting(placeId: string): number {
    return queueTotals(this.deps.db, placeId).files;
  }

  // ---- Starting jobs -------------------------------------------------------------------------

  private place(placeId: string): { id: string; kind: string; label: string } | undefined {
    return this.deps.db.prepare('SELECT id, kind, label FROM places WHERE id = ?').get(placeId) as { id: string; kind: string; label: string } | undefined;
  }

  private start(place: { id: string; label: string }): number {
    const params: HashFilesParams = { placeId: place.id };
    const jobId = this.deps.jobs.create(HASH_FILES_JOB_KIND, `Match copies on ${place.label}`, params);
    this.active.set(jobId, { id: jobId, paused: false, speedFiles: null, placeId: place.id, state: 'queued', speed: null, message: null });
    this.deps.onStateChanged?.();
    return jobId;
  }

  /** Start fingerprinting one connected local place (the "Fingerprint now" button). */
  fingerprintNow(placeId: unknown): FingerprintNowResult {
    if (typeof placeId !== 'string') return { ok: false, message: 'That place is not valid.' };
    const place = this.place(placeId);
    if (!place) return { ok: false, message: 'That place no longer exists.' };
    if (!LOCAL_KINDS.has(place.kind)) return { ok: false, message: 'Only the laptop, named drives and OneDrive can be checked.' };
    if (!this.deps.isConnected(placeId)) return { ok: false, message: `${place.label} is not connected, so its files cannot be read now.` };
    if (this.isFingerprinting(placeId)) return { ok: false, message: `${place.label} is already being checked. Watch it in Jobs.` };
    if (this.waiting(placeId) === 0) return { ok: false, message: NOTHING_WAITING_MESSAGE };
    return { ok: true, jobId: this.start(place) };
  }

  /**
   * "Check them now" on Home: ONE job that fingerprints what is waiting in every connected local place. Only files with no
   * fingerprint are read (new or changed ones); the ones already checked are not read again.
   */
  checkAllNow(): FingerprintNowResult {
    const rows = this.deps.db.prepare("SELECT id, label FROM places WHERE kind IN ('laptop', 'drive', 'onedrive') ORDER BY label").all() as { id: string; label: string }[];
    const waiting = rows.filter((r) => this.deps.isConnected(r.id) && this.waiting(r.id) > 0);
    if (waiting.length === 0) return { ok: false, message: NOTHING_WAITING_MESSAGE };
    if (this.active.size > 0 || waiting.some((r) => this.isFingerprinting(r.id))) return { ok: false, message: 'Checking is already under way. Watch it in Jobs.' };
    const params: HashFilesParams = {};
    const jobId = this.deps.jobs.create(HASH_FILES_JOB_KIND, 'Check new and changed files', params);
    this.active.set(jobId, { id: jobId, paused: false, speedFiles: null, placeId: null, state: 'queued', speed: null, message: null });
    this.deps.onStateChanged?.();
    return { ok: true, jobId };
  }

  /** "Try again": put the files that could not be read back in the queue and fingerprint them if the place is connected. */
  retryFailed(placeId: unknown): RetryFailedResult {
    if (typeof placeId !== 'string') return { ok: false, message: 'That place is not valid.' };
    const place = this.place(placeId);
    if (!place || !LOCAL_KINDS.has(place.kind)) return { ok: false, message: 'That place cannot be checked.' };
    const requeued = clearErrors(this.deps.db, placeId);
    if (requeued > 0) this.deps.dataChanged?.();
    this.invalidate();
    let jobId: number | null = null;
    if (requeued > 0 && this.deps.isConnected(placeId) && !this.isFingerprinting(placeId)) jobId = this.start(place);
    else this.deps.onStateChanged?.();
    return { ok: true, requeued, jobId };
  }
}
