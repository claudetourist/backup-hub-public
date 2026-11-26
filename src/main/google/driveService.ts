import { DRIVE_REFRESH_JOB_KIND, type DriveRefreshParams, type DriveRefreshResult, type DriveRefreshView, type DriveSignInResult } from '../../shared/drive';
import { isFinished, type JobChangedEvent, type JobRecord } from '../../shared/jobs';
import type { ListingState } from '../../shared/listing';
import type { Db } from '../db';
import { VaultNotReadyError, type GoogleAuth } from './auth';

/** Running counts reach Sources at most this often. */
const PUSH_INTERVAL_MS = 3000;

/** The slice of the job service the refresh triggers need. */
export interface DriveJobs {
  create(kind: string, title: string, params: unknown): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
  params(id: number): unknown;
  onChanged(listener: (event: JobChangedEvent) => void): () => void;
}

export interface DriveServiceDeps {
  db: Db;
  jobs: DriveJobs;
  auth: Pick<GoogleAuth, 'assertVaultReady' | 'hasRefreshToken'>;
  /** Runs the browser sign-in for one account (see signIn.ts). */
  signIn: (placeId: string) => Promise<DriveSignInResult>;
  now?: () => number;
  /** Called when the refresh or sign-in state of any account changes. */
  onStateChanged?: () => void;
  log?: { info(...args: unknown[]): void };
}

interface PlaceRow {
  id: string;
  label: string;
  status: string;
}

interface ActiveJob {
  placeIds: string[];
  state: ListingState;
  message: string | null;
  paused: boolean;
}

/**
 * Starts Drive refresh jobs ("Refresh" on a card, "Refresh all"), runs the sign-in again
 * flow, and remembers which accounts have a refresh waiting or running. It never contacts Google by itself: no timer.
 */
export class DriveService {
  private readonly now: () => number;
  private readonly active = new Map<number, ActiveJob>();
  private readonly signingIn = new Set<string>();
  private lastPush = 0;

  constructor(private readonly deps: DriveServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.jobs.onChanged((event) => this.onJobEvent(event));
    for (const job of deps.jobs.list({ states: ['queued', 'running', 'needs_you'] })) this.trackJob(job);
  }

  private trackJob(job: JobRecord): void {
    if (job.kind !== DRIVE_REFRESH_JOB_KIND) return;
    if (isFinished(job.state)) {
      this.active.delete(job.id);
      return;
    }
    let placeIds = this.active.get(job.id)?.placeIds;
    if (placeIds === undefined) {
      const params = this.deps.jobs.params(job.id) as Partial<DriveRefreshParams> | null;
      if (!Array.isArray(params?.placeIds)) return;
      placeIds = params.placeIds.filter((x): x is string => typeof x === 'string');
    }
    this.active.set(job.id, {
      placeIds,
      state: job.paused ? 'paused' : job.state === 'queued' ? 'queued' : 'running',
      message: job.state === 'running' ? job.message : null,
      paused: job.paused,
    });
  }

  private onJobEvent(event: JobChangedEvent): void {
    if (event.job.kind !== DRIVE_REFRESH_JOB_KIND) return;
    if (event.reason === 'created' || event.reason === 'state') {
      this.trackJob(event.job);
      this.deps.onStateChanged?.();
    } else if (event.reason === 'progress') {
      const entry = this.active.get(event.job.id);
      if (entry) entry.message = event.job.message;
      if (this.now() - this.lastPush >= PUSH_INTERVAL_MS) {
        this.lastPush = this.now();
        this.deps.onStateChanged?.();
      }
    }
  }

  /** What Sources shows on the card of one account. */
  viewOf(placeId: string, label: string): DriveRefreshView {
    let state: ListingState = 'idle';
    let detail: string | null = null;
    let job: DriveRefreshView['job'] = null;
    for (const [id, entry] of this.active) {
      if (!entry.placeIds.includes(placeId)) continue;
      job = { id, paused: entry.paused };
      if (entry.state === 'running') {
        state = 'running';
        if (entry.message?.startsWith(`Refreshing ${label}:`)) detail = entry.message;
      } else if (state !== 'running') {
        state = entry.paused ? 'paused' : 'queued';
      }
    }
    return { state, detail, job, signingIn: this.signingIn.has(placeId) };
  }

  isRefreshing(placeId: string): boolean {
    for (const entry of this.active.values()) if (entry.placeIds.includes(placeId)) return true;
    return false;
  }

  private accounts(): PlaceRow[] {
    return this.deps.db.prepare("SELECT id, label, status FROM places WHERE kind = 'gdrive' AND NOT (json_valid(identity_json) AND json_extract(identity_json, '$.removedAt') IS NOT NULL) ORDER BY label").all() as PlaceRow[];
  }

  private start(placeIds: string[], title: string): number {
    const params: DriveRefreshParams = { placeIds };
    const jobId = this.deps.jobs.create(DRIVE_REFRESH_JOB_KIND, title, params);
    this.active.set(jobId, { placeIds, state: 'queued', message: null, paused: false });
    this.deps.onStateChanged?.();
    return jobId;
  }

  private vaultProblem(): string | null {
    try {
      this.deps.auth.assertVaultReady();
      return null;
    } catch (err) {
      if (err instanceof VaultNotReadyError) return err.message;
      throw err;
    }
  }

  /** The "Refresh" button on one card. */
  refresh(placeId: unknown): DriveRefreshResult {
    if (typeof placeId !== 'string') return { ok: false, message: 'That account is not valid.' };
    const place = this.accounts().find((p) => p.id === placeId);
    if (!place) return { ok: false, message: 'That Google account no longer exists.' };
    if (place.status === 'needs_signin') return { ok: false, message: `${place.label} needs signing in again first. Use "Sign in again" on its card.` };
    if (this.isRefreshing(placeId)) return { ok: false, message: `${place.label} is already being refreshed. Watch it in Jobs.` };
    if (this.signingIn.has(placeId)) return { ok: false, message: `${place.label} is being signed in right now.` };
    const problem = this.vaultProblem();
    if (problem) return { ok: false, message: problem };
    if (!this.deps.auth.hasRefreshToken(placeId)) return { ok: false, message: `${place.label} has no saved sign-in. Use "Sign in again" on its card.` };
    return { ok: true, jobId: this.start([placeId], `Refresh ${place.label}`), started: 1, skipped: 0, note: null };
  }

  /** "Refresh all": one job for every account that has a sign-in. Accounts needing a new sign-in are skipped with a note. */
  refreshAll(): DriveRefreshResult {
    const problem = this.vaultProblem();
    if (problem) return { ok: false, message: problem };
    const eligible: PlaceRow[] = [];
    let needSignIn = 0;
    let busy = 0;
    for (const place of this.accounts()) {
      if (place.status === 'needs_signin' || !this.deps.auth.hasRefreshToken(place.id)) needSignIn += 1;
      else if (this.isRefreshing(place.id) || this.signingIn.has(place.id)) busy += 1;
      else eligible.push(place);
    }
    const noteParts: string[] = [];
    if (needSignIn > 0) noteParts.push(`${needSignIn} ${needSignIn === 1 ? 'account needs' : 'accounts need'} signing in again and ${needSignIn === 1 ? 'was' : 'were'} skipped`);
    if (busy > 0) noteParts.push(`${busy} ${busy === 1 ? 'is' : 'are'} already being refreshed`);
    const note = noteParts.length > 0 ? `${noteParts.join('; ')}.` : null;
    if (eligible.length === 0) return { ok: false, message: note ?? 'There are no Google accounts to refresh yet.' };
    const jobId = this.start(
      eligible.map((p) => p.id),
      `Refresh Google Drive (${eligible.length} ${eligible.length === 1 ? 'account' : 'accounts'})`,
    );
    return { ok: true, jobId, started: eligible.length, skipped: needSignIn + busy, note };
  }

  /** The "Sign in again" button: opens the browser, waits, saves the new sign-in if it is the right account. */
  async signIn(placeId: unknown): Promise<DriveSignInResult> {
    if (typeof placeId !== 'string') return { ok: false, message: 'That account is not valid.' };
    const place = this.accounts().find((p) => p.id === placeId);
    if (!place) return { ok: false, message: 'That Google account no longer exists.' };
    if (this.signingIn.size > 0) return { ok: false, message: 'Another sign-in is open. Finish or close it first.' };
    if (this.isRefreshing(placeId)) return { ok: false, message: `${place.label} is being refreshed. Stop that first, then sign in again.` };
    this.signingIn.add(placeId);
    this.deps.onStateChanged?.();
    try {
      return await this.deps.signIn(placeId);
    } finally {
      this.signingIn.delete(placeId);
      this.deps.onStateChanged?.();
    }
  }

  /** Called by the job when it starts, so a resumed job is known too. */
  noteStarted(jobId: number, placeIds: string[]): void {
    const old = this.active.get(jobId);
    this.active.set(jobId, { placeIds, state: 'running', message: old?.message ?? null, paused: false });
    this.deps.onStateChanged?.();
  }
}
