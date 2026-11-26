/**
 * Clean up: the one place the window reaches the removal features. Plans are made here (read only), kept by id, and a job
 * starts only for a plan main made itself, with the hash it was given, confirmed, not stale, and with exactly the count and
 * size the person confirmed. The window never sends a plan or a path to remove.
 */
import { formatGb } from '../../shared/cloudCopy';
import {
  CLEAN_LAPTOP_JOB_KIND,
  CLEAN_PHONE_JOB_KIND,
  PUT_BACK_JOB_KIND,
  plural,
  type CleanStartResult,
  type CleanupOverview,
  type LaptopCleanJobParams,
  type LaptopCleanPlan,
  type LaptopCleanPlanResult,
  type PhoneCleanJobParams,
  type PhoneCleanPlan,
  type PhoneCleanPlanResult,
  type PutBackJobParams,
  type EmptyQuarantineResult,
  type UndoResult,
} from '../../shared/cleanup';
import { FREEUP_MAX_PUT_BACK } from '../../shared/freeUp';
import type { JobRecord } from '../../shared/jobs';
import { DEFAULT_PHONE_FOLDERS } from '../../shared/phone';
import type { Db } from '../db/connection';
import { releaseAdb } from '../adb/adbRelease';
import { CleanStore } from './cleanStore';
import { buildLaptopCleanPlan, hashLaptopCleanPlan, type LaptopCleanPlannerDeps } from './laptopCleanPlanner';
import { hashConfirmed } from '../danger';
import { laptopConfirmed } from './laptopCleanJob';
import { phoneConfirmed } from './phoneCleanJob';
import { emptyQuarantine, undoLaptopRemoval, type QuarantineDeps } from './quarantine';
import { buildPhoneCleanPlan, hashPhoneCleanPlan, type PhoneCleanPlannerDeps } from './phoneCleanPlanner';
import { planIsStale, selectDuplicateGroups, selectPhoneFiles } from './safety';

export interface CleanupJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface CleanupServiceDeps {
  db: Db;
  phone: Omit<PhoneCleanPlannerDeps, 'cache' | 'onProgress'>;
  laptop: LaptopCleanPlannerDeps;
  quarantine?: QuarantineDeps;
  jobs: CleanupJobs;
  now?: () => number;
  log?: { info(...args: unknown[]): void };
  /** Told when something was undone or changed outside a job. */
  changed?: () => void;
}

const KEEP_PLANS = 3;
const PHONE_JOB_KINDS = [CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const CAMERA_FOLDER = '/sdcard/DCIM';

/** The camera folder is offered first; 'others' is the rest of the folders Backup Hub looks at; anything else = all of them. */
export function phoneFoldersFor(scope: unknown): string[] | undefined {
  if (scope === 'camera') return [CAMERA_FOLDER];
  if (scope === 'others') return DEFAULT_PHONE_FOLDERS.filter((f) => f !== CAMERA_FOLDER);
  return undefined;
}

export class CleanupService {
  private readonly phonePlans = new Map<string, PhoneCleanPlan>();
  private readonly phoneCache = new Map<string, string | null>();
  private readonly folderHashes = new Map<string, string>();
  private readonly laptopPlans = new Map<string, LaptopCleanPlan>();
  private planningPhone = false;
  private planningLaptop = false;
  private progress = { planning: false, done: 0, total: 0 };
  private readonly now: () => number;
  readonly store: CleanStore;

  constructor(private readonly deps: CleanupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new CleanStore(deps.db, this.now);
  }

  overview(): CleanupOverview {
    return this.store.overview();
  }

  phoneProgress(): { planning: boolean; done: number; total: number } {
    return { ...this.progress };
  }

  private busy(kinds: readonly string[]): boolean {
    return this.deps.jobs.list({ states: ['queued', 'running', 'needs_you'] }).some((j) => kinds.includes(j.kind));
  }

  // ---- 5a Free up phone space ----

  async phonePlan(serial: unknown, scope?: unknown): Promise<PhoneCleanPlanResult> {
    if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(serial)) return { ok: false, message: 'Choose a phone first.' };
    if (this.planningPhone) return { ok: false, message: 'A plan is already being made. Please wait a moment.' };
    this.planningPhone = true;
    this.progress = { planning: true, done: 0, total: 0 };
    try {
      const result = await buildPhoneCleanPlan({ ...this.deps.phone, cache: this.phoneCache, folderHashes: this.folderHashes, onProgress: (done, total) => (this.progress = { planning: true, done, total }) }, serial, phoneFoldersFor(scope));
      if (result.ok) {
        this.phonePlans.set(result.plan.id, result.plan);
        while (this.phonePlans.size > KEEP_PLANS) this.phonePlans.delete(this.phonePlans.keys().next().value as string);
        this.deps.log?.info(`cleanup: phone plan ${result.plan.id}: ${result.plan.safe.files} safe, ${result.plan.waiting.files} waiting, ${result.plan.stale.files} stale`);
      }
      return result;
    } catch (err) {
      this.deps.log?.info('cleanup: the phone plan failed', err instanceof Error ? err.message : String(err));
      return { ok: false, message: 'The plan could not be made. Nothing was changed.' };
    } finally {
      this.planningPhone = false;
      this.progress = { planning: false, done: 0, total: 0 };
      // Let go of the phone so Windows can eject it (not while a phone job is using it).
      if (!this.busy([CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND])) await releaseAdb(this.deps.phone.adb);
    }
  }

  phoneStart(request: unknown): CleanStartResult {
    if (!isObject(request)) return { ok: false, message: 'Something went wrong. Nothing was removed.' };
    if (request['confirmed'] !== true) return { ok: false, message: 'Confirm the removal first. Nothing was removed.' };
    if (typeof request['planId'] !== 'string' || typeof request['hash'] !== 'string') return { ok: false, message: 'Something went wrong. Nothing was removed.' };
    const plan = this.phonePlans.get(request['planId']);
    if (!plan) return { ok: false, message: 'That plan is not known any more. Make a new plan. Nothing was removed.' };
    if (planIsStale(plan.createdAt, this.now())) {
      this.phonePlans.delete(plan.id);
      return { ok: false, message: 'That plan is more than 30 minutes old and the phone may have changed. Make a new plan. Nothing was removed.' };
    }
    if (request['hash'] !== plan.hash || hashPhoneCleanPlan(plan) !== plan.hash) return { ok: false, message: 'The list on screen is not the list Backup Hub made. Make a new plan. Nothing was removed.' };
    const selected = selectPhoneFiles(plan, request['indexes'], request['expectCount'], request['expectBytes']);
    if (!selected.ok) return selected;
    if (this.busy(PHONE_JOB_KINDS)) return { ok: false, message: 'The phone is busy with another job. Watch it in Jobs and try again. Nothing was removed.' };
    this.phonePlans.delete(plan.id);
    const phoneFiles = selected.items.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256!, vouchers: f.vouchers }));
    const params: PhoneCleanJobParams = { serial: plan.serial, model: plan.model, listId: plan.id, listHash: hashConfirmed(phoneConfirmed(plan.serial, phoneFiles)), files: phoneFiles };
    const jobId = this.deps.jobs.create(CLEAN_PHONE_JOB_KIND, `Free up space on ${plan.model} (${plural(selected.items.length, 'file')}, ${formatGb(selected.bytes)})`, params, 'Started by you: Free up phone space');
    this.deps.log?.info(`cleanup: started phone job ${jobId} for plan ${plan.id}: ${selected.items.length} files`);
    return { ok: true, jobId };
  }

  /** "Put back on phone": copies removed files back from the drive copy. */
  putBack(request: unknown): CleanStartResult {
    if (!isObject(request) || request['confirmed'] !== true) return { ok: false, message: 'Confirm first. Nothing was changed.' };
    const serial = request['serial'];
    const ids = request['removalIds'];
    if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(serial)) return { ok: false, message: 'Choose a phone first.' };
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > FREEUP_MAX_PUT_BACK || ids.some((i) => !Number.isInteger(i))) return { ok: false, message: 'Choose the files to put back.' };
    const unique = [...new Set(ids as number[])];
    // One count per 500 ids (primary-key lookups, nothing read from the log lines): 50,000 ids take a few milliseconds, not a line-by-line read.
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const ok = this.deps.db.prepare(`SELECT count(*) FROM removal_log WHERE +kind = 'phone' AND +undone_at IS NULL AND id IN (${part.map(() => '?').join(',')})`).pluck().get(...part) as number;
      if (ok !== part.length) return { ok: false, message: 'One of those files is not a removed phone file that can be put back.' };
    }
    if (this.busy(PHONE_JOB_KINDS)) return { ok: false, message: 'The phone is busy with another job. Watch it in Jobs and try again.' };
    const jobId = this.deps.jobs.create(PUT_BACK_JOB_KIND, `Put ${plural(unique.length, 'file')} back on the phone`, { serial, removalIds: unique } satisfies PutBackJobParams, 'Started by you: Put back on phone');
    return { ok: true, jobId };
  }

  // ---- 5b Laptop duplicates ----

  async laptopPlan(): Promise<LaptopCleanPlanResult> {
    if (this.planningLaptop) return { ok: false, message: 'A plan is already being made. Please wait a moment.' };
    this.planningLaptop = true;
    try {
      const result = await buildLaptopCleanPlan(this.deps.laptop);
      if (result.ok) {
        this.laptopPlans.set(result.plan.id, result.plan);
        while (this.laptopPlans.size > KEEP_PLANS) this.laptopPlans.delete(this.laptopPlans.keys().next().value as string);
        this.deps.log?.info(`cleanup: laptop plan ${result.plan.id}: ${result.plan.groups.length} groups`);
      }
      return result;
    } catch (err) {
      this.deps.log?.info('cleanup: the laptop plan failed', err instanceof Error ? err.message : String(err));
      return { ok: false, message: 'The plan could not be made. Nothing was changed.' };
    } finally {
      this.planningLaptop = false;
    }
  }

  laptopStart(request: unknown): CleanStartResult {
    if (!isObject(request)) return { ok: false, message: 'Something went wrong. Nothing was moved.' };
    if (request['confirmed'] !== true) return { ok: false, message: 'Confirm the move first. Nothing was moved.' };
    if (typeof request['planId'] !== 'string' || typeof request['hash'] !== 'string') return { ok: false, message: 'Something went wrong. Nothing was moved.' };
    const plan = this.laptopPlans.get(request['planId']);
    if (!plan) return { ok: false, message: 'That plan is not known any more. Make a new plan. Nothing was moved.' };
    if (planIsStale(plan.createdAt, this.now())) {
      this.laptopPlans.delete(plan.id);
      return { ok: false, message: 'That plan is more than 30 minutes old and the files may have changed. Make a new plan. Nothing was moved.' };
    }
    if (plan.stale) return { ok: false, message: 'The laptop was not checked in the last 24 hours. Check it first. Nothing was moved.' };
    if (request['hash'] !== plan.hash || hashLaptopCleanPlan(plan) !== plan.hash) return { ok: false, message: 'The list on screen is not the list Backup Hub made. Make a new plan. Nothing was moved.' };
    const selected = selectDuplicateGroups(plan, request['groups'], request['expectCount'], request['expectBytes']);
    if (!selected.ok) return selected;
    if (this.busy([CLEAN_LAPTOP_JOB_KIND])) return { ok: false, message: 'A clean-up is already waiting or running. Watch it in Jobs. Nothing was moved.' };
    this.laptopPlans.delete(plan.id);
    const files: LaptopCleanJobParams['files'] = [];
    for (const item of selected.items) {
      const keep = item.group.members.find((m) => m.relPath === item.keep)!;
      for (const rel of item.remove) {
        const m = item.group.members.find((x) => x.relPath === rel)!;
        files.push({ relPath: rel, size: item.group.size, sha256: item.group.id, mtime: m.mtime, keep: item.keep, keepSize: item.group.size, keepMtime: keep.mtime });
      }
    }
    const laptopParams: LaptopCleanJobParams = { listId: plan.id, listHash: hashConfirmed(laptopConfirmed(files)), files };
    const jobId = this.deps.jobs.create(CLEAN_LAPTOP_JOB_KIND, `Move ${plural(files.length, 'duplicate')} to the quarantine (${formatGb(selected.bytes)})`, laptopParams);
    this.deps.log?.info(`cleanup: started laptop job ${jobId} for plan ${plan.id}: ${files.length} files`);
    return { ok: true, jobId };
  }

  async undo(removalId: unknown): Promise<UndoResult> {
    if (typeof removalId !== 'number' || !Number.isInteger(removalId)) return { ok: false, message: 'That is not a removed file.' };
    const r = await undoLaptopRemoval({ now: this.now, ...this.deps.quarantine }, this.store, removalId);
    if (r.ok) this.deps.changed?.();
    return r;
  }

  async emptyQuarantine(request: unknown): Promise<EmptyQuarantineResult> {
    if (!isObject(request) || request['confirmed'] !== true) return { ok: false, message: 'Confirm first. Nothing was emptied.' };
    if (typeof request['date'] !== 'string' || typeof request['expectCount'] !== 'number' || typeof request['expectBytes'] !== 'number') return { ok: false, message: 'Something went wrong. Nothing was emptied.' };
    const r = await emptyQuarantine({ now: this.now, ...this.deps.quarantine }, this.store, request['date'], request['expectCount'], request['expectBytes']);
    if (r.ok) this.deps.changed?.();
    return r;
  }
}
