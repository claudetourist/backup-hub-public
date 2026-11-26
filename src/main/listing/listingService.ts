import type { PlaceJobRef } from '../../shared/jobs';
import { isListingJobKind, LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND, type ListingState, type ListNowResult, type ListPlaceParams } from '../../shared/listing';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { isFinished } from '../../shared/jobs';
import type { Db } from '../db';

/** Running counts reach Sources at most this often. */
const PUSH_INTERVAL_MS = 3000;

/** The slice of the job service the listing triggers need. */
export interface ListingJobs {
  create(kind: string, title: string, params: unknown): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
  params(id: number): unknown;
  onChanged(listener: (event: JobChangedEvent) => void): () => void;
}

export interface ListingServiceDeps {
  db: Db;
  jobs: ListingJobs;
  /** True when the place is reachable right now (laptop, plugged-in named drive, OneDrive folder present). */
  isConnected: (placeId: string) => boolean;
  now?: () => number;
  /** Called when the listing state of any place changes. */
  onStateChanged?: () => void;
  log?: { info(...args: unknown[]): void };
}

interface PlaceRow {
  id: string;
  kind: string;
  label: string;
  last_looked_at: number | null;
}

/**
 * Starts listing jobs ("Check now") and remembers which places have a listing waiting
 * or running. It never lists anything by itself: there is no timer and no plug-in trigger (Simple plan, rule 2).
 */
export class ListingService {
  private readonly now: () => number;
  /** job id -> place id and state, for jobs that are queued, running or waiting for the user. */
  private readonly active = new Map<number, { placeId: string; state: ListingState; message: string | null; paused: boolean }>();
  private lastPush = 0;

  constructor(private readonly deps: ListingServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.jobs.onChanged((event) => this.onJobEvent(event));
    // Jobs queued before this start (resumed after a restart).
    for (const job of deps.jobs.list({ states: ['queued', 'running', 'needs_you'] })) this.trackJob(job);
  }

  private trackJob(job: JobRecord): void {
    if (!isListingJobKind(job.kind)) return;
    if (isFinished(job.state)) {
      this.active.delete(job.id);
      return;
    }
    let placeId = this.active.get(job.id)?.placeId;
    if (placeId === undefined) {
      const params = this.deps.jobs.params(job.id) as Partial<ListPlaceParams> | null;
      if (typeof params?.placeId !== 'string') return;
      placeId = params.placeId;
    }
    this.active.set(job.id, {
      placeId,
      state: job.paused ? 'paused' : job.state === 'queued' ? 'queued' : 'running',
      message: job.state === 'running' ? job.message : null,
      paused: job.paused,
    });
  }

  private onJobEvent(event: JobChangedEvent): void {
    if (!isListingJobKind(event.job.kind)) return;
    if (event.reason === 'created' || event.reason === 'state') {
      this.trackJob(event.job);
      this.deps.onStateChanged?.();
    } else if (event.reason === 'progress') {
      // Sources shows the running count and speed; it is refreshed at most every few seconds.
      const entry = this.active.get(event.job.id);
      if (entry) entry.message = event.job.message;
      if (this.now() - this.lastPush >= PUSH_INTERVAL_MS) {
        this.lastPush = this.now();
        this.deps.onStateChanged?.();
      }
    }
  }

  /** What a running listing says about itself ("12,345 files so far · 1,200 files per second"), or null. */
  detailOf(placeId: string): string | null {
    for (const entry of this.active.values()) if (entry.placeId === placeId && entry.state === 'running' && entry.message) return entry.message;
    return null;
  }

  /** The listing job for a place: none, waiting its turn, or walking the folders. */
  stateOf(placeId: string): ListingState {
    let state: ListingState = 'idle';
    for (const entry of this.active.values()) {
      if (entry.placeId !== placeId) continue;
      if (entry.state === 'running') return 'running';
      state = entry.paused ? 'paused' : 'queued';
    }
    return state;
  }

  /** The listing job of a place, for Pause, Resume and Stop (null when there is none). */
  jobOf(placeId: string): PlaceJobRef | null {
    for (const [id, entry] of this.active) if (entry.placeId === placeId) return { id, paused: entry.paused };
    return null;
  }

  isListing(placeId: string): boolean {
    return this.stateOf(placeId) !== 'idle';
  }

  private place(placeId: string): PlaceRow | undefined {
    return this.deps.db.prepare('SELECT id, kind, label, last_looked_at FROM places WHERE id = ?').get(placeId) as PlaceRow | undefined;
  }

  /**
   * "Look again": a quick pass over the laptop or a named drive that only reads the folders that changed, marks files
   * that are gone and picks up new ones. Never deletes anything.
   */
  lookAgain(placeId: unknown): ListNowResult {
    const place = typeof placeId === 'string' ? this.place(placeId) : undefined;
    if (place && place.kind !== 'laptop' && place.kind !== 'drive') return { ok: false, message: `${place.label} cannot be checked quickly. Use Check everything instead.` };
    return this.listNow(placeId, { quick: true });
  }

  /** Start a listing of one place (the "List now" button); `quick` looks only at folders that changed. */
  listNow(placeId: unknown, options: { quick?: boolean } = {}): ListNowResult {
    if (typeof placeId !== 'string') return { ok: false, message: 'That place is not valid.' };
    const place = this.place(placeId);
    if (!place) return { ok: false, message: 'That place no longer exists.' };
    if (place.kind !== 'laptop' && place.kind !== 'drive' && place.kind !== 'onedrive') {
      return { ok: false, message: 'Only the laptop, named drives and OneDrive can be checked.' };
    }
    if (!this.deps.isConnected(placeId)) {
      return { ok: false, message: `${place.label} is not connected, so it cannot be checked now.` };
    }
    if (this.isListing(placeId)) return { ok: false, message: `${place.label} is already being checked. Watch it in Jobs.` };
    const params: ListPlaceParams = options.quick ? { placeId, quick: true } : { placeId };
    const jobId = this.deps.jobs.create(options.quick ? LOOK_AGAIN_JOB_KIND : LIST_PLACE_JOB_KIND, options.quick ? `Check ${place.label}` : `Check all files on ${place.label}`, params);
    this.active.set(jobId, { placeId, state: 'queued', message: null, paused: false });
    this.deps.onStateChanged?.();
    return { ok: true, jobId };
  }

  /** Called by the job when it starts, so a resumed job is known too. */
  noteStarted(jobId: number, placeId: string): void {
    this.active.set(jobId, { placeId, state: 'running', message: this.active.get(jobId)?.message ?? null, paused: false });
    this.deps.onStateChanged?.();
  }
}
