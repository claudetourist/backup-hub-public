import { formatGb } from '../../shared/cloudCopy';
import type { JobRecord } from '../../shared/jobs';
import { COPY_TO_LOCAL_JOB_KIND, LOCAL_PLAN_LIFETIME_MS, type LocalCopyJobParams, type LocalCopyPlan, type LocalCopyStartResult, type LocalPlanResult, type LocalTarget } from '../../shared/localCopy';
import { buildLocalCopyPlan, type LocalPlannerDeps } from './localPlanner';
import { hashLocalPlan } from './localModel';

/** The slice of the job service "Back up now" needs. */
export interface LocalCopyJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface LocalCopyServiceDeps {
  planner: LocalPlannerDeps;
  /** Named drives that are plugged in right now: id, label and root. */
  drives(): Promise<{ placeId: string; label: string; root: string }[]>;
  jobs: LocalCopyJobs;
  /** The plain "read-only (protected)" line when this drive must not be written to, else null (T7 write ban). */
  writeProtected?: (placeId: string) => string | null;
  now?: () => number;
  log?: { info(...args: unknown[]): void };
}

/** At most this many plans are kept; a new one pushes the oldest out. */
const KEEP_PLANS = 5;

/**
 * "Back up now" to a plugged-in drive: makes a plan (read only), keeps it, and starts the copy job only for a plan that main
 * itself made (found again by id), that still has the hash it was given, that the person confirmed, and that is not stale.
 * The window never sends a plan, only its id and hash.
 */
export class LocalCopyService {
  private readonly plans = new Map<string, LocalCopyPlan>();
  private planning = false;
  private readonly now: () => number;

  constructor(private readonly deps: LocalCopyServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The drives a copy can go to now. */
  async targets(): Promise<LocalTarget[]> {
    const drives = await this.deps.drives();
    return Promise.all(drives.map(async (d) => ({ placeId: d.placeId, label: d.label, freeBytes: await this.deps.planner.freeBytes(d.root), readOnly: this.deps.writeProtected?.(d.placeId) ?? null })));
  }

  /** A plan that copies into a laptop folder (phone backup only; the folder comes from main, never from the window). */
  planToFolder(collectionId: number, folder: string): Promise<LocalPlanResult> {
    return this.plan(collectionId, '', folder);
  }

  async plan(collectionId: unknown, targetPlaceId: unknown, targetFolder?: string): Promise<LocalPlanResult> {
    if (typeof collectionId !== 'number' || !Number.isInteger(collectionId) || collectionId <= 0) return { ok: false, message: 'That collection is not valid.' };
    if (targetFolder === undefined && (typeof targetPlaceId !== 'string' || targetPlaceId === '' || targetPlaceId.length > 100)) return { ok: false, message: 'Choose a drive first.' };
    const guarded = targetFolder === undefined && typeof targetPlaceId === 'string' ? this.deps.writeProtected?.(targetPlaceId) : null;
    if (guarded) return { ok: false, message: guarded };
    if (this.planning) return { ok: false, message: 'A plan is already being made. Please wait a moment.' };
    this.planning = true;
    try {
      const result = await buildLocalCopyPlan(this.deps.planner, collectionId, typeof targetPlaceId === 'string' ? targetPlaceId : '', targetFolder);
      if (result.ok) {
        this.plans.set(result.plan.id, result.plan);
        while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value as string);
        this.deps.log?.info(`localCopy: plan ${result.plan.id} for collection ${collectionId} to ${typeof targetPlaceId === 'string' && targetPlaceId !== '' ? targetPlaceId : (targetFolder ?? 'a folder')}: ${result.plan.totalFiles} files, ${formatGb(result.plan.totalBytes)}, ${result.plan.doesNotFit.length} not copied`);
      }
      return result;
    } catch (err) {
      this.deps.log?.info('localCopy: the plan failed', err instanceof Error ? err.message : String(err));
      return { ok: false, message: 'The plan could not be made. Nothing was changed.' };
    } finally {
      this.planning = false;
    }
  }

  /** Starts the copy job. Anything that does not match what main computed is refused and nothing is written. */
  start(request: unknown, options: { startedBy?: string } = {}): LocalCopyStartResult {
    if (request === null || typeof request !== 'object') return { ok: false, message: 'Something went wrong. Nothing was copied.' };
    const r = request as Record<string, unknown>;
    if (r['confirmed'] !== true) return { ok: false, message: 'Tick the box to confirm the list first. Nothing was copied.' };
    if (typeof r['planId'] !== 'string' || typeof r['hash'] !== 'string') return { ok: false, message: 'Something went wrong. Nothing was copied.' };
    const plan = this.plans.get(r['planId']);
    if (!plan) return { ok: false, message: 'That plan is not known any more. Make a new plan. Nothing was copied.' };
    if (this.now() - plan.createdAt > LOCAL_PLAN_LIFETIME_MS) {
      this.plans.delete(plan.id);
      return { ok: false, message: 'That plan is more than 30 minutes old and the drive may have changed. Make a new plan. Nothing was copied.' };
    }
    if (r['hash'] !== plan.hash || hashLocalPlan(plan) !== plan.hash) return { ok: false, message: 'The list on screen is not the list Backup Hub made. Make a new plan. Nothing was copied.' };
    const guarded = plan.targetFolder === undefined ? this.deps.writeProtected?.(plan.targetPlaceId) : null;
    if (guarded) return { ok: false, message: guarded };
    if (plan.files.length === 0) return { ok: false, message: 'There is nothing to copy in this plan.' };
    const busy = this.deps.jobs.list({ states: ['queued', 'running', 'needs_you'] }).some((job) => job.kind === COPY_TO_LOCAL_JOB_KIND);
    if (busy) return { ok: false, message: 'A backup is already waiting or running. Watch it in Jobs.' };
    this.plans.delete(plan.id); // one plan, one start
    const title = `Back up ${plan.collectionName} to ${plan.targetLabel} (${plan.totalFiles} ${plan.totalFiles === 1 ? 'file' : 'files'}, ${formatGb(plan.totalBytes)})`;
    const jobId = this.deps.jobs.create(COPY_TO_LOCAL_JOB_KIND, title, { plan } satisfies LocalCopyJobParams, options.startedBy ?? null);
    this.deps.log?.info(`localCopy: started job ${jobId} for plan ${plan.id}`);
    return { ok: true, jobId };
  }
}
