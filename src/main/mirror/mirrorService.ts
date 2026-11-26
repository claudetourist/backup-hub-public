/**
 * What the app calls for the second drive (R1.3). Every method is a direct answer to a click; nothing here starts by itself. `addCopy` only writes
 * the database. `startLook` makes the look-and-plan job, `confirmSliced` starts the copy only for a plan main itself made (found again by id and
 * hash) that the person confirmed, `status` only reads the file list.
 */
import type { JobRecord } from '../../shared/jobs';
import { MIRROR_COPY_JOB_KIND, MIRROR_LOOK_JOB_KIND, MIRROR_PLAN_LIFETIME_MS, type MirrorAddRequest, type MirrorAddResult, type MirrorBackupStatus, type MirrorChoicesResult, type MirrorLookResult, type MirrorReport, type MirrorSelection, type MirrorStartResult, type MirrorStatusResult } from '../../shared/mirror';
import { MIRROR_CHECK_JOB_KIND, type MirrorCheckPreviewResult, type MirrorCheckReport, type MirrorCheckSelection } from '../../shared/mirrorCheck';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { JobFailure, type JobHandler } from '../jobs/jobService';
import { loadDestinations } from '../look/lookStore';
import { finishSliced, finishSync, STEP_ITEMS, turn, type Steps } from '../sliceWork';
import { MirrorRun, type MirrorCheckpoint } from './mirrorRun';
import { MirrorCheckRun, type CheckCheckpoint } from './mirrorCheckRun';
import { checkPlanSteps } from './mirrorCheckPlan';
import { planMirror, plugInSourceLine, plugInTargetLine } from './mirrorLook';
import { allPairs, pairOf } from './mirrorPairs';
import { behindSteps } from './mirrorScan';
import { dropConfirmed, loadCheckReport, loadConfirmedSteps, loadReport, saveCheckReport, openMirrorProblems, saveConfirmedSteps, saveReport, type ConfirmedMirror } from './mirrorStore';
import type { MirrorDeps, MirrorItem, StoredCheckPlan, StoredMirrorPlan } from './mirrorTypes';

export interface MirrorJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

const KEEP_PLANS = 3;
const ACTIVE: JobRecord['state'][] = ['queued', 'running', 'needs_you'];
/** The last counts of a backup are used for this long; after it they are counted again. */
const COUNTS_MAX_AGE_MS = 5 * 60 * 1000;
const MIRROR_JOB_KINDS: ReadonlySet<string> = new Set([MIRROR_LOOK_JOB_KIND, MIRROR_COPY_JOB_KIND, MIRROR_CHECK_JOB_KIND]);

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export class MirrorService {
  private readonly plans = new Map<string, StoredMirrorPlan>();
  private readonly confirming = new Set<string>();
  /** The lists of "Check old copies" previews, in memory until they are confirmed. */
  private readonly checkPlans = new Map<string, StoredCheckPlan>();
  /** The answer of each look job, for the preview screen (the plan itself stays here, in memory). */
  private readonly results = new Map<number, MirrorLookResult & { planId?: string }>();
  private readonly now: () => number;
  private readonly store: BackupProfileStore;
  private readonly counts = new Map<number, { at: number; version: number; files: number; bytes: number }>();
  private version = 0;

  constructor(
    private readonly deps: MirrorDeps,
    private readonly jobs: MirrorJobs,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = new BackupProfileStore(deps.db, this.now);
  }

  /** Something the counts are made of changed (a look, a copy, a destination, an answer): cached counts are old. */
  countsChanged(): void {
    this.version += 1;
  }

  private busy(): boolean {
    return this.jobs.list({ states: ACTIVE }).some((j) => MIRROR_JOB_KINDS.has(j.kind));
  }

  // ---- "Also keep a copy on ..." ---------------------------------------------------------------------------------------------------

  /** Which drives can hold the second copy of a backup (read only). */
  choices(backupId: unknown): MirrorChoicesResult {
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.' };
    const profile = this.store.get(backupId);
    if (!profile) return { ok: false, message: 'That backup does not exist.' };
    const dests = loadDestinations(this.deps.db, backupId);
    const first = dests[0];
    if (!first) return { ok: false, message: `${profile.name} has no backup folder on a drive yet.` };
    const taken = new Set(this.store.destinations(backupId).map((d) => d.placeId));
    const drives = (this.deps.db.prepare("SELECT id, label FROM places WHERE kind = 'drive' ORDER BY label").all() as { id: string; label: string }[]).filter((d) => !taken.has(d.id));
    const label = (this.deps.db.prepare('SELECT label FROM places WHERE id = ?').pluck().get(first.placeId) as string | undefined) ?? 'the first drive';
    return { ok: true, backupId, backupName: profile.name, sourceLabel: label, folder: first.root, drives: drives.map((d) => ({ placeId: d.id, label: d.label })) };
  }

  /**
   * "Also keep a copy on <drive>": the second place of a backup, the same relative folder as on the first drive. Database only: nothing is copied and
   * nothing is written to either drive. A backup has one second drive.
   */
  addCopy(request: MirrorAddRequest): MirrorAddResult {
    const no = (message: string): MirrorAddResult => ({ ok: false, message: `${message} Nothing was changed.` });
    if (!request || !Number.isInteger(request.backupId) || request.backupId <= 0 || typeof request.placeId !== 'string' || request.placeId === '') return no('That is not a valid request.');
    const profile = this.store.get(request.backupId);
    if (!profile) return no('That backup does not exist.');
    const dests = loadDestinations(this.deps.db, request.backupId);
    const first = dests[0];
    if (!first) return no(`${profile.name} has no backup folder on a drive yet.`);
    if (dests.length >= 2) return no(`${profile.name} already has a second drive.`);
    const place = this.deps.db.prepare('SELECT kind, label FROM places WHERE id = ?').get(request.placeId) as { kind: string; label: string } | undefined;
    if (!place || place.kind !== 'drive') return no('That is not a drive Backup Hub knows.');
    if (request.placeId === first.placeId) return no('The second copy has to be on another drive.');
    const made = this.store.addDestination({ profileId: request.backupId, placeId: request.placeId, root: first.root, role: 'copy', position: 2 });
    if (!made.ok) return no(made.message);
    this.countsChanged();
    this.deps.log.info(`mirror: backup ${request.backupId} now also goes to ${place.label} (folder ${first.root})`);
    return { ok: true, message: `${profile.name} will also be kept on ${place.label}, in the folder ${first.root.split('/').join('\\')}. Nothing is copied until you bring it up to date.` };
  }

  // ---- status ------------------------------------------------------------------------------------------------------------------------

  /** Per backup with a second drive: is each drive plugged in, and how far behind is the second (counted from the file list, off the window's thread). */
  async status(): Promise<MirrorStatusResult> {
    const plugged = this.deps.pluggedPlaces ? await this.deps.pluggedPlaces() : new Set<string>();
    const backups: MirrorBackupStatus[] = [];
    for (const pair of allPairs(this.deps.db)) {
      const behind = await this.behind(pair);
      backups.push({
        backupId: pair.backupId,
        sourceLabel: pair.srcLabel,
        sourceConnected: plugged.has(pair.srcPlaceId),
        mirrors: [{ placeId: pair.dstPlaceId, label: pair.dstLabel, position: 2, connected: plugged.has(pair.dstPlaceId), behindFiles: behind.files, behindBytes: behind.bytes, needYou: openMirrorProblems(this.deps.db, pair.srcPlaceId, pair.srcRoot) }],
      });
    }
    return { backups };
  }

  private async behind(pair: NonNullable<ReturnType<typeof pairOf>>): Promise<{ files: number; bytes: number }> {
    const cached = this.counts.get(pair.backupId);
    if (cached && cached.version === this.version && this.now() - cached.at < COUNTS_MAX_AGE_MS) return cached;
    let answer: { files: number; bytes: number } | null = null;
    if (this.deps.behindInWorker) {
      try {
        answer = await this.deps.behindInWorker(pair);
      } catch {
        answer = null;
      }
    }
    answer ??= await finishSliced(behindSteps(this.deps.db, pair), turn);
    this.counts.set(pair.backupId, { at: this.now(), version: this.version, ...answer });
    return answer;
  }

  // ---- look, preview, confirm ----------------------------------------------------------------------------------------------------

  /** Starts the look-and-plan job for one backup, or for every backup that has a second drive (`backupId` left out). Nothing is copied. */
  async startLook(backupId?: unknown): Promise<MirrorStartResult> {
    const no = (message: string): MirrorStartResult => ({ ok: false, message, jobId: null });
    if (backupId !== undefined && (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0)) return no('That backup is not valid.');
    if (this.busy()) return no('A copy to a second drive is already waiting or running. Watch it in Activity.');
    const pairs = backupId === undefined ? allPairs(this.deps.db) : [pairOf(this.deps.db, backupId)].filter((p) => p !== null);
    if (pairs.length === 0) return no(backupId === undefined ? 'No backup has a second drive yet.' : 'That backup has no second drive yet.');
    // Said at once, without a job: the first drive is not here, or the second is not.
    if (this.deps.pluggedPlaces) {
      const plugged = await this.deps.pluggedPlaces();
      const ready = pairs.filter((p) => plugged.has(p.srcPlaceId) && plugged.has(p.dstPlaceId));
      if (ready.length === 0) {
        const p = pairs[0]!;
        return no(!plugged.has(p.srcPlaceId) ? plugInSourceLine(p) : plugInTargetLine(p));
      }
    }
    const label = pairs.length === 1 ? pairs[0]!.dstLabel : 'the second drives';
    const title = pairs.length === 1 ? `Look at what ${label} is missing: ${pairs[0]!.backupName}` : `Look at what ${label} are missing`;
    const placeIds = [...new Set(pairs.flatMap((p) => [p.srcPlaceId, p.dstPlaceId]))];
    const jobId = this.jobs.create(MIRROR_LOOK_JOB_KIND, title, { ...(pairs.length === 1 ? { backupId: pairs[0]!.backupId } : {}), backupIds: pairs.map((p) => p.backupId), placeIds }, `Started by you: Bring ${label} up to date`);
    return { ok: true, message: '', jobId };
  }

  /** The answer of a look job: the plan for the preview, or why there is none. Null while the job is still going. */
  preview(jobId: unknown): MirrorLookResult | null {
    return typeof jobId === 'number' ? (this.results.get(jobId) ?? null) : null;
  }

  report(jobId: unknown): MirrorReport | null {
    return typeof jobId === 'number' ? loadReport(this.deps.db, jobId) : null;
  }

  /** The copy, all at once (tests and scripts). Anything that does not match what main computed is refused and nothing is written. */
  confirm(selection: MirrorSelection): MirrorStartResult {
    return finishSync(this.confirmSteps(selection));
  }

  /** The copy as the window asks for it: the same steps in short turns, so a list of 60,000 files does not freeze the window. */
  confirmSliced(selection: MirrorSelection): Promise<MirrorStartResult> {
    return finishSliced(this.confirmSteps(selection));
  }

  private *confirmSteps(selection: MirrorSelection): Steps<MirrorStartResult> {
    const no = (message: string): MirrorStartResult => ({ ok: false, message: `${message} Nothing was copied.`, jobId: null });
    const plan = this.plans.get(selection.planId);
    if (!plan) return no('That list is not known any more. Make a new one.');
    if (this.now() - plan.createdAt > MIRROR_PLAN_LIFETIME_MS) {
      this.plans.delete(plan.planId);
      return no('That list is more than an hour old. Make a new one.');
    }
    if (selection.hash !== plan.hash) return no('The list on screen is not the list Backup Hub made.');
    if (this.busy()) return no('A copy to a second drive is already waiting or running.');
    if (this.confirming.has(plan.planId)) return no('This copy is already being started.');
    for (const p of plan.pairs) {
      const guarded = this.deps.writeProtected?.(p.dstPlaceId) ?? null;
      if (guarded) return no(guarded);
    }
    this.confirming.add(plan.planId);
    try {
      const unticked = new Set(selection.unticked);
      const items: MirrorItem[] = [];
      let seen = 0;
      for (const i of plan.copy) {
        if (!unticked.has(`${i.b}:${i.rel}`)) items.push(i);
        if (++seen % STEP_ITEMS === 0) yield;
      }
      for (const i of plan.different) items.push(i);
      if (items.length === 0) return no('Nothing is ticked.');
      const run: ConfirmedMirror = { planId: plan.planId, pairs: plan.pairs, items };
      yield* saveConfirmedSteps(this.deps.db, run);
      // Nothing yielded since this check: another start cannot slip in between it and the job.
      if (this.busy()) {
        dropConfirmed(this.deps.db, plan.planId);
        return no('A copy to a second drive is already waiting or running.');
      }
      this.plans.delete(plan.planId);
      const copyItems = items.filter((i) => i.kind === 'copy');
      const bytes = copyItems.reduce((s, i) => s + i.size, 0);
      const names = plan.pairs.length === 1 ? plan.pairs[0]!.dstLabel : 'the second drives';
      const copyNames = [...new Set(plan.pairs.map((p) => p.backupName))];
      const copyWhich = copyNames.length <= 3 ? copyNames.join(', ') : `${copyNames.length} backups`;
      const title = `Copy ${copyWhich} to ${names} (${copyItems.length.toLocaleString('en-US')} ${copyItems.length === 1 ? 'file' : 'files'}, ${gb(bytes)})`;
      const placeIds = [...new Set(plan.pairs.flatMap((p) => [p.srcPlaceId, p.dstPlaceId]))];
      const jobId = this.jobs.create(MIRROR_COPY_JOB_KIND, title, { planId: plan.planId, ...(plan.pairs.length === 1 ? { backupId: plan.pairs[0]!.backupId } : {}), backupIds: plan.pairs.map((p) => p.backupId), placeIds }, `Started by you: Copy ${copyWhich} to ${names}`);
      this.deps.log.info(`mirror: started job ${jobId} for plan ${plan.planId}: ${copyItems.length} files to copy, ${bytes} bytes, ${items.length - copyItems.length} different ones to report`);
      return { ok: true, message: '', jobId };
    } finally {
      this.confirming.delete(plan.planId);
    }
  }

  // ---- "Check old copies on <drive>" ---------------------------------------------------------------------------------------------------

  /** The list for the check, from the file list alone (no drive is read), in short turns. One backup, or all with a second drive. */
  async checkPreview(backupId?: unknown): Promise<MirrorCheckPreviewResult> {
    const no = (message: string): MirrorCheckPreviewResult => ({ ok: false, message });
    if (backupId !== undefined && (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0)) return no('That backup is not valid.');
    const pairs = backupId === undefined ? allPairs(this.deps.db) : [pairOf(this.deps.db, backupId)].filter((p) => p !== null);
    if (pairs.length === 0) return no(backupId === undefined ? 'No backup has a second drive yet.' : 'That backup has no second drive yet.');
    const stored = await finishSliced(checkPlanSteps(this.deps.db, pairs, this.now()));
    this.checkPlans.set(stored.planId, stored);
    while (this.checkPlans.size > KEEP_PLANS) this.checkPlans.delete(this.checkPlans.keys().next().value as string);
    return { ok: true, plan: stored.view };
  }

  /** Starts the check for a list main made (found again by id and hash). Reads the second drive, writes only to the file list. */
  async checkStart(selection: MirrorCheckSelection): Promise<MirrorStartResult> {
    const no = (message: string): MirrorStartResult => ({ ok: false, message: `${message} Nothing was checked.`, jobId: null });
    const plan = this.checkPlans.get(selection?.planId);
    if (!plan) return no('That list is not known any more. Make a new one.');
    if (this.now() - plan.createdAt > MIRROR_PLAN_LIFETIME_MS) {
      this.checkPlans.delete(plan.planId);
      return no('That list is more than an hour old. Make a new one.');
    }
    if (selection.hash !== plan.hash) return no('The list on screen is not the list Backup Hub made.');
    if (plan.items.length === 0) return no('There is nothing to check.');
    if (this.busy()) return no('A copy or check on a second drive is already waiting or running. Watch it in Activity.');
    if (this.confirming.has(plan.planId)) return no('This check is already being started.');
    if (this.deps.pluggedPlaces) {
      const plugged = await this.deps.pluggedPlaces();
      for (const p of plan.pairs) {
        if (!plugged.has(p.srcPlaceId)) return no(`Plug in the ${p.srcLabel} to check the old copies on the ${p.dstLabel}.`);
        if (!plugged.has(p.dstPlaceId)) return no(plugInTargetLine(p).replace('to bring it up to date', 'to check its old copies'));
      }
    }
    this.confirming.add(plan.planId);
    try {
      const run: ConfirmedMirror = { planId: plan.planId, pairs: plan.pairs, items: plan.items };
      await finishSliced(saveConfirmedSteps(this.deps.db, run));
      if (this.busy()) {
        dropConfirmed(this.deps.db, plan.planId);
        return no('A copy or check on a second drive is already waiting or running.');
      }
      this.checkPlans.delete(plan.planId);
      const names = plan.pairs.length === 1 ? plan.pairs[0]!.dstLabel : 'the second drives';
      const v = plan.view;
      // The backups by name: "Check old copies on Seagate2TB" alone did not say which backup's files were being checked (user, 25 Nov).
      const backupNames = [...new Set(plan.pairs.map((p) => p.backupName))];
      const which = backupNames.length <= 3 ? backupNames.join(', ') : `${backupNames.length} backups`;
      const title = `Check old copies of ${which} on ${names} (${v.totals.files.toLocaleString('en-US')} ${v.totals.files === 1 ? 'file' : 'files'}, ${gb(v.totals.bytes)})`;
      const placeIds = [...new Set(plan.pairs.flatMap((p) => [p.srcPlaceId, p.dstPlaceId]))];
      const jobId = this.jobs.create(MIRROR_CHECK_JOB_KIND, title, { planId: plan.planId, ...(plan.pairs.length === 1 ? { backupId: plan.pairs[0]!.backupId } : {}), backupIds: plan.pairs.map((p) => p.backupId), placeIds }, `Started by you: Check old copies of ${which} on ${names}`);
      this.deps.log.info(`mirror: started check job ${jobId} for plan ${plan.planId}: ${v.totals.files} files, ${v.oneRead.files} with one read, ${v.twoReads.files} with two`);
      return { ok: true, message: '', jobId };
    } finally {
      this.confirming.delete(plan.planId);
    }
  }

  checkReport(jobId: unknown): MirrorCheckReport | null {
    return typeof jobId === 'number' ? loadCheckReport(this.deps.db, jobId) : null;
  }

  /** The job handlers (registered once by the app). */
  handlers(): JobHandler[] {
    const deps = this.deps;
    const results = this.results;
    const keep = (planId: string, stored: StoredMirrorPlan): void => {
      this.plans.set(planId, stored);
      while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    };
    const look: JobHandler = {
      kind: MIRROR_LOOK_JOB_KIND,
      heavy: false,
      async run(ctx) {
        const params = ctx.params as { backupIds?: number[] };
        const outcome = await planMirror(deps, { backupIds: params.backupIds ?? [] }, ctx);
        results.set(ctx.jobId, outcome.result);
        if (!outcome.result.ok || outcome.stored === null) throw new JobFailure(outcome.result.ok ? 'There is no list.' : outcome.result.message, undefined, 'refused');
        keep(outcome.stored.planId, outcome.stored);
        results.set(ctx.jobId, { ...outcome.result, planId: outcome.stored.planId });
        const t = outcome.result.plan.totals;
        return `${t.files.toLocaleString('en-US')} files (${gb(t.bytes)}) are ready to copy. Nothing was copied.`;
      },
    };
    const copy: JobHandler = {
      kind: MIRROR_COPY_JOB_KIND,
      heavy: true,
      resumable: true,
      async run(ctx) {
        const params = ctx.params as { planId?: string };
        const run = typeof params.planId === 'string' ? await finishSliced(loadConfirmedSteps(deps.db, params.planId), () => ctx.yield()) : null;
        if (!run) throw new JobFailure('The list of files for this copy is not there any more. Make a new one.');
        const report = await new MirrorRun(deps, ctx, run, ctx.jobId, (ctx.resume as Partial<MirrorCheckpoint> | null) ?? null).execute();
        dropConfirmed(deps.db, params.planId!);
        saveReport(deps.db, ctx.jobId, report);
        const failed = report.failed.reduce((s, r) => s + r.count, 0);
        const line = `Copied and checked ${report.copied.files.toLocaleString('en-US')} files (${gb(report.copied.bytes)}); ${report.linked.toLocaleString('en-US')} already there and the same${report.damaged > 0 ? `; ${report.damaged} damaged on the first drive (not copied)` : ''}${report.different > 0 ? `; ${report.different} different on the second drive (not replaced)` : ''}${failed > 0 ? `; ${failed} failed` : ''}`;
        if (report.copied.files + report.linked === 0 && failed > 0) throw new JobFailure(`${line}. Nothing was copied. See the warnings.`);
        return `${line}. Nothing was deleted or overwritten.`;
      },
    };
    const check: JobHandler = {
      kind: MIRROR_CHECK_JOB_KIND,
      heavy: true,
      resumable: true,
      async run(ctx) {
        const params = ctx.params as { planId?: string };
        const run = typeof params.planId === 'string' ? await finishSliced(loadConfirmedSteps(deps.db, params.planId), () => ctx.yield()) : null;
        if (!run) throw new JobFailure('The list of files for this check is not there any more. Make a new one.');
        const runner = new MirrorCheckRun(deps, ctx, run, ctx.jobId, (ctx.resume as Partial<CheckCheckpoint> | null) ?? null);
        let report: MirrorCheckReport;
        try {
          report = await runner.execute();
        } catch (err) {
          saveCheckReport(deps.db, ctx.jobId, runner.partialReport());
          throw err;
        }
        dropConfirmed(deps.db, params.planId!);
        saveCheckReport(deps.db, ctx.jobId, report);
        const failed = report.failed.reduce((s, r) => s + r.count, 0);
        const line = `Checked ${(report.verified + report.differs).toLocaleString('en-US')} files: ${report.verified.toLocaleString('en-US')} are the same and are now verified copies${report.differs > 0 ? `; ${report.differs.toLocaleString('en-US')} different (not replaced)` : ''}${failed > 0 ? `; ${failed} could not be checked` : ''}`;
        if (report.verified + report.differs === 0 && failed > 0) throw new JobFailure(`${line}. See the warnings.`);
        return `${line}. Nothing was changed on either drive.`;
      },
    };
    return [look, copy, check].map((h): JobHandler =>
      Object.assign({}, h, {
        run: async (ctx: Parameters<JobHandler['run']>[0]) => {
          try {
            return await h.run(ctx);
          } finally {
            this.countsChanged();
          }
        },
      }),
    );
  }
}

/** Ids of drive-resolver params (the job service asks which drives a job uses). */
export const mirrorPlaceIds = (params: unknown): string[] => {
  const ids = (params as { placeIds?: unknown } | null)?.placeIds;
  return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [];
};

