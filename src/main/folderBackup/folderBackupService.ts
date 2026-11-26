/**
 * What the app calls for folder backups (R2.1) and the Google Keep notes backup (R2.8). Every method is a direct answer to a click; nothing here starts
 * by itself (no timer, no start-up call). `startLook` makes the look-and-plan job, `confirm` starts the copy only for a plan main itself made (found again
 * by id and hash) that the person confirmed, `addKeepSync` makes the notes backup (database only) when the person clicks its button.
 */
import type { JobRecord } from '../../shared/jobs';
import {
  FOLDER_BACKUP_JOB_KIND,
  FOLDER_LOOK_JOB_KIND,
  FOLDER_LOOK_TITLE,
  KEEP_SYNC_KEY,
  KEEP_SYNC_NAME,
  type FolderBackupCard,
  type FolderBackupCards,
  type FolderBackupProgress,
  type FolderBackupReport,
  type FolderBackupSelection,
  type FolderBackupStartResult,
  type FolderCopiedFiles,
  type FolderLookResult,
  type KeepSyncAddResult,
} from '../../shared/folderBackup';
import { COPIED_FILES_LIMIT } from '../../shared/phoneBackup';
import { KEEP_SYNC_PARTS } from '../../shared/appFolders';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { JobFailure, type JobHandler } from '../jobs/jobService';
import { loadDestinations } from '../look/lookStore';
import type { PlanItem } from '../phoneBackup/planModel';
import { dropConfirmed, loadConfirmedSteps, saveConfirmedSteps, type ConfirmedRun } from '../phoneBackup/runStore';
import { resolveSourcePlace, rulePathOf } from './folderPaths';
import type { RunProgress } from '../phoneBackup/runProgress';
import type { EffectFile } from '../rules/effect';
import { RulesStore } from '../rules/rulesStore';
import { finishSliced, finishSync, STEP_ITEMS, type Steps } from '../sliceWork';
import { FolderBackupRun, type FolderCheckpoint } from './folderRun';
import { planFolderBackup } from './folderPlan';
import { loadFolderReport } from './folderStore';
import { keepSyncAvailable } from './keepSync';
import type { FolderBackupDeps, StoredFolderPlan } from './folderTypes';

export interface FolderBackupJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface FolderBackupServiceDeps extends FolderBackupDeps {
  /** The ids of the drives plugged in right now (one refresh for all the cards). Absent in tests: each card asks `driveFor`. */
  pluggedPlaces?(): Promise<ReadonlySet<string>>;
  /** Where keep-sync keeps its files (tests point it at a temp folder; the default is %LOCALAPPDATA%). */
  localAppData?: string | undefined;
}

/** A plan older than this is not started: the folder and the drive may have changed. */
export const PLAN_LIFETIME_MS = 60 * 60 * 1000;
const KEEP_PLANS = 3;
const KEEP_PROGRESS = 2;
const ACTIVE: JobRecord['state'][] = ['queued', 'running', 'needs_you'];
const KINDS: ReadonlySet<string> = new Set([FOLDER_LOOK_JOB_KIND, FOLDER_BACKUP_JOB_KIND]);

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export class FolderBackupService {
  private readonly plans = new Map<string, StoredFolderPlan>();
  private readonly confirming = new Set<string>();
  private readonly results = new Map<number, FolderLookResult & { planId?: string }>();
  private readonly progresses = new Map<number, RunProgress>();
  private readonly now: () => number;
  private readonly store: BackupProfileStore;
  private readonly rules: RulesStore;

  constructor(
    private readonly deps: FolderBackupServiceDeps,
    private readonly jobs: FolderBackupJobs,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = new BackupProfileStore(deps.db, this.now);
    this.rules = new RulesStore(deps.db, this.now);
  }

  /** The plan main holds for a backup, as the files "your choices" counts over (read only). Null when there is none. */
  effectFiles(backupId: number, planId?: string): { backupName: string; files: Iterable<EffectFile> } | null {
    let plan: StoredFolderPlan | undefined;
    if (planId !== undefined) plan = this.plans.get(planId);
    else for (const p of this.plans.values()) if (p.base.backupId === backupId) plan = p;
    if (!plan || plan.base.backupId !== backupId || this.now() - plan.createdAt > PLAN_LIFETIME_MS) return null;
    const held = plan;
    function* files(): Generator<EffectFile> {
      for (const i of held.items) yield { path: i.path, size: i.size, builtin: null };
      for (const b of held.buckets) for (const f of b.files) yield { path: f.path, size: f.size, builtin: null };
    }
    return { backupName: held.base.backupName, files: { [Symbol.iterator]: files } };
  }

  private busy(): boolean {
    return this.jobs.list({ states: ACTIVE }).some((j) => KINDS.has(j.kind));
  }

  /** The folder backups that are switched on (for their "Back up now" cards) and whether the keep-sync notes can be offered. Read only. */
  async cards(): Promise<FolderBackupCards> {
    const { db } = this.deps;
    const rows = db.prepare("SELECT id, name, source_root, import_key FROM backup_profiles WHERE source_kind = 'folder' AND enabled = 1 ORDER BY id").all() as { id: number; name: string; source_root: string; import_key: string | null }[];
    const labelOf = db.prepare('SELECT label FROM places WHERE id = ?').pluck();
    const plugged = this.deps.pluggedPlaces ? await this.deps.pluggedPlaces() : null;
    const cards: FolderBackupCard[] = [];
    for (const r of rows) {
      const dest = loadDestinations(db, r.id)[0];
      const flat = r.import_key === KEEP_SYNC_KEY;
      let connected = false;
      if (dest) connected = plugged ? plugged.has(dest.placeId) : (await this.deps.driveFor(dest.placeId)) !== null;
      cards.push({ backupId: r.id, backupName: r.name, sourceWords: flat ? 'the keep-sync snapshots' : r.source_root, driveLabel: dest ? ((labelOf.get(dest.placeId) as string | undefined) ?? null) : null, driveConnected: connected, layout: flat ? 'flat' : 'dated' });
    }
    const exists = (db.prepare('SELECT 1 FROM backup_profiles WHERE import_key = ?').get(KEEP_SYNC_KEY) as unknown) !== undefined;
    return { cards, keepSync: { available: await keepSyncAvailable(this.deps.localAppData), exists } };
  }

  /**
   * "Add Google Keep notes backup": the person clicked. Makes the backup "Google Keep notes (keep-sync)" for the first person called You (else the first
   * person), saved to the drive NAMED T7 (found by its card, never by a letter), folder keep-sync inside the app's backups folder. Database only: nothing is
   * written to a drive, and its first real run needs the person's own click like any other.
   */
  async addKeepSync(): Promise<KeepSyncAddResult> {
    const { db } = this.deps;
    const no = (message: string): KeepSyncAddResult => ({ ok: false, message: `${message} Nothing was changed.` });
    if (this.store.getByImportKey(KEEP_SYNC_KEY)) return no('The Google Keep notes backup is already there.');
    if (!(await keepSyncAvailable(this.deps.localAppData))) return no('keep-sync has no snapshots folder on this computer.');
    const drives = db.prepare("SELECT id FROM places WHERE kind = 'drive' AND label = 'T7' COLLATE NOCASE").pluck().all() as string[];
    if (drives.length === 0) return no('Backup Hub does not know a drive named T7 yet. Plug the T7 in and open Devices first.');
    if (drives.length > 1) return no('More than one drive is named T7.');
    const you = db.prepare("SELECT id FROM profiles WHERE name = 'You' COLLATE NOCASE ORDER BY id LIMIT 1").pluck().get() as number | undefined;
    return db.transaction((): KeepSyncAddResult => {
      const made = this.store.create({ personId: you, name: KEEP_SYNC_NAME, sourceKind: 'folder', sourceRoot: 'keep-sync snapshots', folderPrefix: 'keep-sync', changeRule: 'size_or_date', importKey: KEEP_SYNC_KEY });
      if (!made.ok) return no(made.message);
      const dest = this.store.addDestination({ profileId: made.id, placeId: drives[0]!, root: KEEP_SYNC_PARTS.join('/'), role: 'primary' });
      if (!dest.ok) throw new Error(dest.message);
      this.deps.log.info(`folderBackup: added the Google Keep notes backup ${made.id}`);
      return { ok: true, backupId: made.id, message: 'Added. Press Back up now on its card to see what would be copied. Nothing is copied until you confirm.' };
    })();
  }

  startLook(backupId: unknown): FolderBackupStartResult {
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.', jobId: null };
    if (this.busy()) return { ok: false, message: 'A folder backup is already waiting or running. Watch it in Activity.', jobId: null };
    const row = this.deps.db.prepare("SELECT name FROM backup_profiles WHERE id = ? AND source_kind = 'folder'").pluck().get(backupId) as string | undefined;
    if (row === undefined) return { ok: false, message: 'That folder backup does not exist.', jobId: null };
    const jobId = this.jobs.create(FOLDER_LOOK_JOB_KIND, `${FOLDER_LOOK_TITLE}: ${row}`, { backupId }, `Started by you: Back up ${row} now`);
    return { ok: true, message: '', jobId };
  }

  /** The answer of a look job: the plan for the preview, or why there is none. Null while the job is still going. */
  preview(jobId: unknown): FolderLookResult | null {
    return typeof jobId === 'number' ? (this.results.get(jobId) ?? null) : null;
  }

  report(jobId: unknown): FolderBackupReport | null {
    return typeof jobId === 'number' ? loadFolderReport(this.deps.db, jobId) : null;
  }

  progress(jobId: unknown): FolderBackupProgress | null {
    return typeof jobId === 'number' ? (this.progresses.get(jobId)?.snapshot(jobId) ?? null) : null;
  }

  /** Every file a finished run copied, from the index (named by its place below the backed-up folder). Read only. */
  copied(jobId: unknown): FolderCopiedFiles | null {
    const report = this.report(jobId);
    if (report === null) return null;
    const { db } = this.deps;
    const run = db.prepare('SELECT backup_profile_id AS backupId FROM backup_runs WHERE id = ?').get(report.runId) as { backupId: number } | undefined;
    const profile = run ? (db.prepare('SELECT source_root, import_key FROM backup_profiles WHERE id = ?').get(run.backupId) as { source_root: string; import_key: string | null } | undefined) : undefined;
    const dest = run ? loadDestinations(db, run.backupId)[0] : undefined;
    const place = profile && profile.import_key !== KEEP_SYNC_KEY ? resolveSourcePlace(db, profile.source_root) : null;
    const rows = db
      .prepare('SELECT c.rel_path AS destRel, p.rel_path AS srcRel, c.size AS size, c.mtime AS mtimeMs FROM files c LEFT JOIN files p ON p.id = c.origin_file_id WHERE c.backup_run_id = ? ORDER BY c.rel_path LIMIT ?')
      .all(report.runId, COPIED_FILES_LIMIT) as { destRel: string; srcRel: string | null; size: number; mtimeMs: number | null }[];
    const base = dest ? dest.root.replace(/\/+$/, '') + '/' : '';
    const srcPrefix = place ? (place.relBase === '' ? '' : place.relBase + '/') : null;
    const named = (r: { destRel: string; srcRel: string | null }): string => {
      if (r.srcRel !== null && srcPrefix !== null && r.srcRel.startsWith(srcPrefix)) return rulePathOf(r.srcRel.slice(srcPrefix.length));
      const below = r.destRel.startsWith(base) ? r.destRel.slice(base.length) : r.destRel;
      return rulePathOf(report.layout === 'flat' ? below : below.slice(below.indexOf('/') + 1));
    };
    const total = db.prepare('SELECT count(*) FROM files WHERE backup_run_id = ?').pluck().get(report.runId) as number;
    return { files: rows.map((r) => ({ path: named(r), size: r.size, mtimeMs: r.mtimeMs })), total };
  }

  confirm(selection: FolderBackupSelection): FolderBackupStartResult {
    return finishSync(this.confirmSteps(selection));
  }

  confirmSliced(selection: FolderBackupSelection): Promise<FolderBackupStartResult> {
    return finishSliced(this.confirmSteps(selection));
  }

  private *confirmSteps(selection: FolderBackupSelection): Steps<FolderBackupStartResult> {
    const no = (message: string): FolderBackupStartResult => ({ ok: false, message: `${message} Nothing was copied.`, jobId: null });
    const plan = this.plans.get(selection.planId);
    if (!plan) return no('That plan is not known any more. Make a new one.');
    if (this.now() - plan.createdAt > PLAN_LIFETIME_MS) {
      this.plans.delete(plan.planId);
      return no('That plan is more than an hour old. Make a new one.');
    }
    if (selection.hash !== plan.hash) return no('The list on screen is not the list Backup Hub made.');
    if (this.busy()) return no('A folder backup is already waiting or running.');
    if (this.confirming.has(plan.planId)) return no('This backup is already being started.');
    const guarded = this.deps.writeProtected?.(plan.base.destPlaceId) ?? null;
    if (guarded) return no(guarded);

    this.confirming.add(plan.planId);
    try {
      const unticked = new Set(selection.unticked);
      const folders = selection.untickedFolders.map((f) => f.replace(/\/+$/, '') + '/');
      // An exclusion saved after the plan was made still counts: the person's choices are read again here (the unticks of the window are not the only guard).
      const choices = this.rules.compiled(plan.base.backupId);
      const out = (path: string): boolean => unticked.has(path) || folders.some((f) => path.startsWith(f)) || choices.match(path)?.choice === 'leave_out';
      const items: PlanItem[] = [];
      let seen = 0;
      for (const i of plan.items) {
        if (!out(i.path)) items.push(i);
        if (++seen % STEP_ITEMS === 0) yield;
      }
      const relinks: StoredFolderPlan['relinks'] = [];
      for (const r of plan.relinks) {
        if (!out(r.path)) relinks.push(r);
        if (++seen % STEP_ITEMS === 0) yield;
      }
      if (items.length + relinks.length === 0) return no('Nothing is ticked.');
      let bytes = 0;
      const runItems: ConfirmedRun['items'] = [];
      for (const i of items) {
        bytes += i.size;
        runItems.push({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId, ...(i.candidates.length > 0 ? { candidates: i.candidates.map((c) => ({ id: c.id, relPath: c.relPath, sha256: c.sha256 })) } : {}) });
        if (runItems.length % STEP_ITEMS === 0) yield;
      }
      const leftOut = plan.buckets.reduce((a, b) => ({ files: a.files + b.files.length, bytes: a.bytes + b.bytes }), { files: 0, bytes: 0 });
      const run: ConfirmedRun = { ...plan.base, items: runItems, relinks, leftOut };
      yield* saveConfirmedSteps(this.deps.db, plan.planId, run);
      // Nothing yielded since this check: another start cannot slip in between it and the job.
      if (this.busy()) {
        dropConfirmed(this.deps.db, plan.planId);
        return no('A folder backup is already waiting or running.');
      }
      this.plans.delete(plan.planId);
      const title = `Back up ${plan.base.backupName} now (${items.length.toLocaleString('en-US')} ${items.length === 1 ? 'file' : 'files'}, ${gb(bytes)})`;
      const jobId = this.jobs.create(FOLDER_BACKUP_JOB_KIND, title, { planId: plan.planId, backupId: plan.base.backupId, destPlaceId: plan.base.destPlaceId }, `Started by you: Back up ${plan.base.backupName} now`);
      this.deps.log.info(`folderBackup: started job ${jobId} for plan ${plan.planId}: ${items.length} files, ${gb(bytes)}, ${relinks.length} to link`);
      return { ok: true, message: '', jobId };
    } finally {
      this.confirming.delete(plan.planId);
    }
  }

  private track(jobId: number, progress: RunProgress): void {
    this.progresses.delete(jobId);
    this.progresses.set(jobId, progress);
    while (this.progresses.size > KEEP_PROGRESS) this.progresses.delete(this.progresses.keys().next().value as number);
  }

  /** The job handlers (registered once by the app). */
  handlers(): JobHandler[] {
    const deps = this.deps;
    const results = this.results;
    const track = (jobId: number, progress: RunProgress): void => this.track(jobId, progress);
    const keep = (stored: StoredFolderPlan): void => {
      this.plans.set(stored.planId, stored);
      while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    };
    const look: JobHandler = {
      kind: FOLDER_LOOK_JOB_KIND,
      heavy: false,
      async run(ctx) {
        const params = ctx.params as { backupId: number };
        const outcome = await planFolderBackup(deps, { backupId: params.backupId }, ctx);
        if (!outcome.result.ok || outcome.stored === null) {
          results.set(ctx.jobId, outcome.result);
          throw new JobFailure(outcome.result.ok ? 'The plan was made.' : outcome.result.message, undefined, 'refused');
        }
        keep(outcome.stored);
        results.set(ctx.jobId, { ...outcome.result, planId: outcome.stored.planId });
        const t = outcome.stored.total;
        return `${t.files.toLocaleString('en-US')} files (${gb(t.bytes)}) are ready to copy. Nothing was copied.`;
      },
    };
    const backup: JobHandler = {
      kind: FOLDER_BACKUP_JOB_KIND,
      heavy: true,
      resumable: true,
      async run(ctx) {
        const params = ctx.params as { planId?: string };
        const run = typeof params.planId === 'string' ? await finishSliced(loadConfirmedSteps(deps.db, params.planId), () => ctx.yield()) : null;
        if (!run) throw new JobFailure('The list of files for this backup is not there any more. Start a new backup.');
        const runner = new FolderBackupRun(deps, ctx, run, ctx.jobId, (ctx.resume as Partial<FolderCheckpoint> | null) ?? null);
        track(ctx.jobId, runner.progress);
        const report = await runner.execute();
        dropConfirmed(deps.db, params.planId!);
        const failed = report.failed.reduce((s, r) => s + r.count, 0);
        const line = `Copied and checked ${report.copied.files.toLocaleString('en-US')} files (${gb(report.copied.bytes)}); ${report.linked.toLocaleString('en-US')} already in the backup${report.inUseCount > 0 ? `; ${report.inUseCount} in use (tried again next time)` : ''}${failed > 0 ? `; ${failed} failed` : ''}`;
        if (report.copied.files + report.linked === 0 && failed > 0) throw new JobFailure(`${line}. Nothing was copied. See the warnings.`);
        return `${line}. Nothing was deleted or overwritten.`;
      },
    };
    return [look, backup];
  }
}
