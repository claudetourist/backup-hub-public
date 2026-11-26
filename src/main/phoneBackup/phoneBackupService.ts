/**
 * What the app calls for the phone backup (R1.2a). Every method is a direct answer to a click; nothing here starts by itself (no timer,
 * no start-up call, no plug-in trigger). `startLook` makes the look-and-plan job, `confirm` starts the copy only for a plan main itself made
 * (found again by id and hash) that the person confirmed, `connected` only reads which phones are plugged in (for the "back up now?" prompt).
 */
import { randomUUID } from 'node:crypto';
import type { JobRecord } from '../../shared/jobs';
import { ALLOW_PHONE_HINT, COPIED_FILES_LIMIT, PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND, PHONE_CHECK_OLD_TITLE, PHONE_LOOK_JOB_KIND, PHONE_LOOK_TITLE, type CheckOldCountsResult, type CheckOldPlanResult, type CheckOldReport, type CheckOldRequest, type ConnectedPhones, type CreatePhoneBackupRequest, type CreatePhoneBackupResult, type LinkPhoneResult, type NewBackupChoices, type CopiedFiles, type PhoneBackupProgress, type PhoneBackupReport, type PhoneBackupSelection, type PhoneBackupStartResult, type PhoneLookResult, type SafeUnplugResult } from '../../shared/phoneBackup';
import type { PhoneDevice } from '../../shared/phone';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { JobFailure, type JobHandler } from '../jobs/jobService';
import type { DecisionKind } from '../look/lookGuard';
import { loadDestinations } from '../look/lookStore';
import { createForPhone, newBackupChoices, type NewBackupContext } from './newPhoneBackup';
import { clearRefusal, LOOK_REFUSAL_KINDS, saveRefusal } from './lookRefusals';
import { PhoneBackupRun, type RunCheckpoint } from './runEngine';
import type { RunProgress } from './runProgress';
import { checkPhone, planPhoneBackup, refusal } from './planJob';
import { checkOldCountsSteps, classifyPhoneFilesSteps, loadPhoneBackup, uncheckedFolders, uncheckedItems, type PhoneBackupInfo } from './checkOld';
import { CheckOldRun, type CheckOldCheckpoint } from './checkOldRun';
import { dropInput, loadInput, loadReport as loadCheckOldReport, saveInput } from './checkOldStore';
import type { DestinationRef } from '../look/compare';
import { assignNames, type PlanItem } from './planModel';
import { placeOnDrive } from './pathMap';
import type { EffectFile } from '../rules/effect';
import { RulesStore } from '../rules/rulesStore';
import { dropConfirmed, loadConfirmedSteps, loadReport, runListCount, runListRows, saveConfirmedSteps, takenUnder, type ConfirmedRun } from './runStore';
import { finishSliced, finishSync, STEP_ITEMS, turn, type Steps } from '../sliceWork';
import type { PhoneBackupDeps, StoredPlan } from './phoneBackupTypes';
import { CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND } from '../../shared/cleanup';
import { AdbHold } from '../adb/adbHold';

/** Every job kind that uses adb: while one is queued or running, adb is never let go. */
const PHONE_JOB_KINDS: ReadonlySet<string> = new Set([PHONE_LOOK_JOB_KIND, PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND, CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND, 'freeup.check', 'freeup.remove']);

export interface PhoneBackupJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

/** A plan older than this is not started: the phone and the drive may have changed (the run looks again anyway). */
export const PLAN_LIFETIME_MS = 60 * 60 * 1000;
const KEEP_PLANS = 3;
/** Live progress kept for this many runs (the running one and the last finished one); older ones are dropped. */
const KEEP_PROGRESS = 2;
const ACTIVE: JobRecord['state'][] = ['queued', 'running', 'needs_you'];

/** The last counts of a backup are shown at once for this long; after it they are shown and counted again. */
const COUNTS_MAX_AGE_MS = 5 * 60 * 1000;

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export class PhoneBackupService {
  private readonly plans = new Map<string, StoredPlan>();
  /** Plans whose confirm is being written right now (the sliced confirm gives the window turns, so a second click could arrive). */
  private readonly confirming = new Set<string>();
  /** The answer of each look job, for the preview screen (the plan itself stays here, in memory). */
  private readonly results = new Map<number, PhoneLookResult & { planId?: string }>();
  /** What each run is doing right now, for the window (read only). */
  private readonly progresses = new Map<number, RunProgress>();
  private readonly now: () => number;
  private readonly store: BackupProfileStore;
  private readonly rules: RulesStore;
  /** The last counts per backup for the Backups card, kept in memory (not saved): shown at once while a fresh count runs. */
  private readonly countsCache = new Map<number, { at: number; version: number; result: Extract<CheckOldCountsResult, { ok: true }> }>();
  private readonly countsRunning = new Map<number, { version: number; promise: Promise<CheckOldCountsResult> }>();
  /** Goes up whenever something the counts are made of changed (a look, a backup, a check, a rule, a decision): the cached counts are then old. */
  private countsVersion = 0;
  /** The "Safe to unplug" state: while it lasts adb is not asked about phones (see adb/adbHold.ts). */
  private readonly hold = new AdbHold();

  constructor(
    private readonly deps: PhoneBackupDeps,
    private readonly jobs: PhoneBackupJobs,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = new BackupProfileStore(deps.db, this.now);
    this.rules = new RulesStore(deps.db, this.now);
  }

  /**
   * The plan main holds for a backup, as the files "your choices" counts over (read only): the one with this id, else the newest one still
   * fresh. Null when there is none, or when the id belongs to another backup.
   */
  effectFiles(backupId: number, planId?: string): { backupName: string; files: Iterable<EffectFile> } | null {
    let plan: StoredPlan | undefined;
    if (planId !== undefined) plan = this.plans.get(planId);
    else for (const p of this.plans.values()) if (p.base.backupId === backupId) plan = p;
    if (!plan || plan.base.backupId !== backupId || this.now() - plan.createdAt > PLAN_LIFETIME_MS) return null;
    const held = plan;
    function* files(): Generator<EffectFile> {
      for (const i of held.items) yield { path: i.path, size: i.size, builtin: held.ruledBuiltin.get(i.path) ?? null };
      for (const b of held.buckets) for (const f of b.files) yield { path: f.path, size: f.size, builtin: b.rule === null ? b.filter : (held.ruledBuiltin.get(f.path) ?? null) };
    }
    return { backupName: held.base.backupName, files: { [Symbol.iterator]: files } };
  }

  /** The phone job that uses adb right now (queued, running or waiting for the person), or null. */
  private phoneJob(): JobRecord | null {
    return this.jobs.list({ states: ACTIVE }).find((j) => PHONE_JOB_KINDS.has(j.kind)) ?? null;
  }

  private busy(): boolean {
    // Every job that talks to a phone: adb must not be let go (kill-server) under any of them, including the clean-up and put-back jobs
    // (the Devices poll reads adb devices every 30 s and lets go afterwards).
    return this.jobs.list({ states: ACTIVE }).some((j) => PHONE_JOB_KINDS.has(j.kind));
  }

  /** The one adb question in flight: Home, Backups and the Devices poll share it. */
  private devicesInflight: Promise<PhoneDevice[] | null> | null = null;

  /**
   * What adb reports right now (read only; the phone is let go afterwards), or null when adb is not there. One question at a time:
   * two at once raced (one's kill-server cut the other's answer short, so a plugged-in phone looked unplugged for 30 s).
   */
  private readDevices(): Promise<PhoneDevice[] | null> {
    if (!this.devicesInflight) {
      this.devicesInflight = this.readDevicesOnce().finally(() => {
        this.devicesInflight = null;
      });
    }
    return this.devicesInflight;
  }

  private async readDevicesOnce(): Promise<PhoneDevice[] | null> {
    const { adb } = this.deps;
    if (this.hold.isHeld()) {
      // The person pressed "Safe to unplug": a phone job that starts, or a phone that was unplugged and plugged in again, ends it; otherwise adb is not asked at all.
      if (this.phoneJob() !== null || (await this.hold.checkReplug(this.deps.phonePlugged, this.now()))) this.endHold();
      else {
        this.deps.phonesSeen?.([]);
        this.deps.phonesReleased?.(this.hold.held().map((p) => p.serial));
        return [];
      }
    }
    let devices: PhoneDevice[] | null = null;
    try {
      devices = await adb.devices();
    } catch {
      devices = null;
    }
    // adb is kept running between these questions: from cold it takes about 5.5 s to answer, warm about 0.5 s (timed on the real
    // laptop, 24 Nov). It is let go when a phone job ends and when the app closes.
    // The Devices screen shows a phone as connected from the same answer, so every screen agrees.
    this.deps.phonesSeen?.((devices ?? []).filter((d) => d.state === 'device').map((d) => d.serial));
    return devices;
  }

  private endHold(): void {
    this.hold.release();
    this.deps.phonesReleased?.([]);
  }

  /**
   * "Safe to unplug the phone": lets go of adb (adb kill-server through the adb port) and stops asking about phones until one is plugged in again, so Windows
   * can eject it. It does not wait: a phone job that still uses the phone refuses it and names the job. Nothing on the phone is touched.
   */
  async safeUnplug(): Promise<SafeUnplugResult> {
    const job = this.phoneJob();
    if (job !== null) return { ok: false, message: `"${job.title}" is still using the phone. Wait until it has finished (or stop it in Activity), then press Safe to unplug again. adb was not let go.`, busyJob: job.title };
    if (this.hold.isHeld()) return { ok: true, message: 'Safe to unplug the phone' };
    // An answer from adb that is on its way must not be cut short by the kill-server (and must not start adb again after it).
    await this.devicesInflight?.catch(() => undefined);
    let phones: { serial: string; name: string }[] = [];
    try {
      phones = ((await this.deps.adb.devices()) ?? []).filter((d) => d.state === 'device' || d.state === 'unauthorized').map((d) => ({ serial: d.serial, name: d.state === 'device' ? d.model : 'a phone' }));
    } catch {
      phones = [];
    }
    if (this.busy()) return { ok: false, message: 'A phone job started just now. Try again when it has finished. adb was not let go.', busyJob: this.phoneJob()?.title ?? null };
    try {
      await this.deps.adb.killServer(); // the adb port's own kill-server: nothing else is sent to the phone
    } catch {
      // nothing was running
    }
    if (phones.length === 0) return { ok: true, message: 'Safe to unplug the phone' }; // adb knew no phone: nothing to hold
    this.hold.hold(phones);
    this.deps.phonesSeen?.([]);
    this.deps.phonesReleased?.(phones.map((p) => p.serial));
    this.deps.log.info('phoneBackup: adb let go for "Safe to unplug"');
    return { ok: true, message: 'Safe to unplug the phone' };
  }

  /** Ends the "Safe to unplug" state: adb is asked about phones again from the next question on. */
  async useAgain(): Promise<void> {
    if (this.hold.isHeld()) this.endHold();
  }

  /** The serials of the phones adb reports as ready right now (read only: adb devices, nothing else). Null when adb is not there. */
  async pluggedSerials(): Promise<string[] | null> {
    const devices = await this.readDevices();
    return devices === null ? null : devices.filter((d) => d.state === 'device').map((d) => d.serial);
  }

  /**
   * Which phones with a backup are plugged in right now (a read only call: adb devices, then the phone is let go), plus the phones
   * plugged in that belong to no backup and the phone backups with no phone. Nothing is linked here.
   */
  async connected(): Promise<ConnectedPhones> {
    const { db } = this.deps;
    const devices = await this.readDevices();
    if (devices === null) return { adb: 'missing', phones: [], hint: null, newPhones: [], backupsWithoutPhone: [] };
    const profiles = db.prepare("SELECT id, name, phone_serial FROM backup_profiles WHERE source_kind = 'phone' AND enabled = 1 AND phone_serial IS NOT NULL").all() as { id: number; name: string; phone_serial: string }[];
    const phones: ConnectedPhones['phones'] = [];
    for (const p of profiles) {
      const d = devices.find((x) => x.serial === p.phone_serial && x.state === 'device');
      if (!d) continue;
      const dest = loadDestinations(db, p.id)[0];
      phones.push({ backupId: p.id, backupName: p.name, phoneName: d.model, serial: p.phone_serial, driveConnected: dest ? (await this.deps.driveFor(dest.placeId)) !== null : false });
    }
    const waiting = devices.find((x) => x.state === 'unauthorized' && profiles.some((p) => p.phone_serial === x.serial));
    const owned = new Set(db.prepare('SELECT phone_serial FROM backup_profiles WHERE phone_serial IS NOT NULL').pluck().all() as string[]);
    const newPhones: ConnectedPhones['newPhones'] = devices
      .filter((d) => (d.state === 'device' || d.state === 'unauthorized') && !owned.has(d.serial))
      .map((d) => (d.state === 'device' ? { serial: d.serial, phoneName: d.model, ready: true, hint: null } : { serial: d.serial, phoneName: 'a phone', ready: false, hint: ALLOW_PHONE_HINT }));
    const backupsWithoutPhone = (db.prepare("SELECT id, name FROM backup_profiles WHERE source_kind = 'phone' AND enabled = 1 AND phone_serial IS NULL ORDER BY id").all() as { id: number; name: string }[]).map((r) => ({ backupId: r.id, backupName: r.name }));
    return { adb: 'ready', phones, hint: waiting ? ALLOW_PHONE_HINT : null, newPhones, backupsWithoutPhone, ...(this.hold.isHeld() ? { released: this.hold.held().map((p) => ({ serial: p.serial, phoneName: p.name })) } : {}) };
  }

  /**
   * "Yes, this is <backup>": the person says the phone plugged in now is the phone of a phone backup. Only a phone backup, only a phone
   * that adb reports right now and that has allowed this computer, never a phone that belongs to another backup. Records the phone in
   * the backup's phone place too (when it has one).
   */
  async linkPhone(backupId: unknown, serial: unknown): Promise<LinkPhoneResult> {
    const no = (message: string): LinkPhoneResult => ({ ok: false, message: `${message} Nothing was changed.` });
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0 || typeof serial !== 'string' || serial.trim() === '') return no('That is not a valid request.');
    const profile = this.store.get(backupId);
    if (!profile) return no('That backup does not exist.');
    if (profile.sourceKind !== 'phone') return no(`${profile.name} is not a phone backup.`);
    if (profile.phoneSerial !== null && profile.phoneSerial !== serial) return no(`${profile.name} already has a phone. Use Change phone first.`);
    const devices = await this.readDevices();
    if (devices === null) return no('Backup Hub cannot find the program it needs to talk to a phone (adb).');
    const device = devices.find((d) => d.serial === serial);
    if (!device) return no('That phone is not plugged in any more.');
    if (device.state !== 'device') return no('Unlock the phone and tap Allow on its screen first.');
    return this.deps.db.transaction((): LinkPhoneResult => {
      const done = this.store.update(backupId, { phoneSerial: serial });
      if (!done.ok) return no(done.message);
      this.writePlaceIdentity(profile.sourcePlaceId, { serial, model: device.model });
      this.deps.log.info(`phoneBackup: linked backup ${backupId} to a phone (${device.model})`);
      return { ok: true, message: `${device.model} is now the phone for ${profile.name}.` };
    })();
  }

  private newBackupContext(): NewBackupContext {
    return {
      deps: this.deps,
      store: this.store,
      busy: () => this.busy(),
      readDevices: () => this.readDevices(),
      writePlaceIdentity: (placeId, phone) => this.writePlaceIdentity(placeId, phone),
    };
  }

  /** What the "Make a new backup for this phone" form offers: the suggested name and the drives (with their folders) that may be picked. Read only. */
  newBackupChoices(serial: unknown): Promise<NewBackupChoices> {
    return newBackupChoices(this.newBackupContext(), serial);
  }

  /** "Make a new backup for this phone": a backup of its own for a phone that belongs to no backup. Database only; nothing is written to the drive. */
  createForPhone(request: CreatePhoneBackupRequest, personId?: number): Promise<CreatePhoneBackupResult> {
    return createForPhone(this.newBackupContext(), request, personId);
  }

  /** "Change phone": the backup forgets which phone it is for (nothing on the phone or the drive changes). The person confirmed in the window. */
  unlinkPhone(backupId: unknown, confirmed: unknown): LinkPhoneResult {
    const no = (message: string): LinkPhoneResult => ({ ok: false, message: `${message} Nothing was changed.` });
    if (confirmed !== true) return no('Please confirm first.');
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return no('That is not a valid request.');
    const profile = this.store.get(backupId);
    if (!profile) return no('That backup does not exist.');
    if (profile.sourceKind !== 'phone') return no(`${profile.name} is not a phone backup.`);
    if (this.busy()) return no('A phone backup is already waiting or running. Watch it in Activity.');
    return this.deps.db.transaction((): LinkPhoneResult => {
      const done = this.store.update(backupId, { phoneSerial: null });
      if (!done.ok) return no(done.message);
      this.writePlaceIdentity(profile.sourcePlaceId, null);
      this.deps.log.info(`phoneBackup: backup ${backupId} no longer has a phone`);
      return { ok: true, message: `${profile.name} has no phone now. Plug the phone in and say which backup it is for.` };
    })();
  }

  /** The serial and model in the identity of the backup's phone place (kind 'phone'), if it has one; `null` takes them out again. */
  private writePlaceIdentity(placeId: string | null, phone: { serial: string; model: string } | null): void {
    if (placeId === null) return;
    const row = this.deps.db.prepare("SELECT identity_json FROM places WHERE id = ? AND kind = 'phone'").get(placeId) as { identity_json: string } | undefined;
    if (!row) return;
    let identity: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.identity_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) identity = parsed as Record<string, unknown>;
    } catch {
      identity = {};
    }
    if (phone) identity = { ...identity, serial: phone.serial, model: phone.model };
    else {
      const { serial: _serial, model: _model, ...rest } = identity;
      identity = rest;
    }
    this.deps.db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify(identity), placeId);
  }

  startLook(backupId: unknown, accept?: unknown): PhoneBackupStartResult {
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.', jobId: null };
    if (this.busy()) return { ok: false, message: 'A phone backup is already waiting or running. Watch it in Activity.', jobId: null };
    const acceptKinds = Array.isArray(accept) ? accept.filter((k): k is DecisionKind => k === 'look_empty' || k === 'look_mass_change') : [];
    const name = (this.deps.db.prepare('SELECT name FROM backup_profiles WHERE id = ?').pluck().get(backupId) as string | undefined) ?? null;
    if (name === null) return { ok: false, message: 'That backup does not exist.', jobId: null };
    const jobId = this.jobs.create(PHONE_LOOK_JOB_KIND, `${PHONE_LOOK_TITLE}: ${name}`, { backupId, accept: acceptKinds }, `Started by you: Back up ${name} now`);
    return { ok: true, message: '', jobId };
  }

  /** The answer of a look job: the plan for the preview, or why there is none. Null while the job is still going. */
  preview(jobId: unknown): PhoneLookResult | null {
    if (typeof jobId !== 'number') return null;
    return this.results.get(jobId) ?? null;
  }

  report(jobId: unknown): PhoneBackupReport | null {
    return typeof jobId === 'number' ? loadReport(this.deps.db, jobId) : null;
  }

  /** What the copy of a job is doing now (the file, the files waiting and done), or null for a job that is not known. Read only. */
  progress(jobId: unknown): PhoneBackupProgress | null {
    if (typeof jobId !== 'number') return null;
    return this.progresses.get(jobId)?.snapshot(jobId) ?? null;
  }

  /** Every file a finished run copied, from the index (the rows the list on the drive is made from). Read only. */
  copied(jobId: unknown): CopiedFiles | null {
    const report = this.report(jobId);
    if (report === null) return null;
    const rows = runListRows(this.deps.db, report.runId, COPIED_FILES_LIMIT);
    return { files: rows.map((r) => ({ path: r.phonePath, size: r.size, mtimeMs: r.mtimeMs })), total: runListCount(this.deps.db, report.runId) };
  }

  // ---- "Check old copies" (R1.4b): the copies the old tool made, read on the phone and on the drive and compared ----------------------------------

  /** Something the Backups card's counts are made of changed (a look, a backup or a check ended, a rule or a decision changed): count again at the next ask. */
  countsChanged(): void {
    this.countsVersion += 1;
  }

  /**
   * The headline numbers and the "By folder" lines for the backup's card. Answers from the index alone: no phone, no drive, nothing is read.
   * The count runs on a worker thread (200,000 copy rows took seconds on the main thread); if none can start it runs here in slices.
   * The last answer is kept: it comes back at once (`stale: true` when it is old, with a fresh count already running) so the card never waits.
   */
  async checkOldCounts(backupId: unknown): Promise<CheckOldCountsResult> {
    const loaded = loadPhoneBackup(this.deps.db, backupId);
    if (!loaded.ok) return loaded;
    const id = loaded.backup.id;
    const hit = this.countsCache.get(id);
    if (hit && hit.version === this.countsVersion && this.now() - hit.at < COUNTS_MAX_AGE_MS) return hit.result;
    const counting = this.countNow(id);
    return hit ? { ...hit.result, stale: true } : counting;
  }

  /** One count per backup at a time; asked again while it runs, the same answer is awaited. Never rejects. */
  private countNow(id: number): Promise<CheckOldCountsResult> {
    const version = this.countsVersion;
    const running = this.countsRunning.get(id);
    if (running && running.version === version) return running.promise;
    const promise = this.countOnce(id).then((result) => {
      if (this.countsRunning.get(id)?.promise === promise) this.countsRunning.delete(id);
      if (result.ok) this.countsCache.set(id, { at: this.now(), version, result });
      return result;
    });
    this.countsRunning.set(id, { version, promise });
    return promise;
  }

  private async countOnce(id: number): Promise<CheckOldCountsResult> {
    try {
      const answered = this.deps.countsInWorker ? await this.deps.countsInWorker(id) : null;
      if (answered) return answered;
      if (this.deps.countsInWorker) this.deps.log.warn('phone backup: the counts worker could not start; counting in the main process, in slices');
      await turn();
      return await finishSliced(checkOldCountsSteps(this.deps.db, id), turn);
    } catch (err) {
      this.deps.log.warn('phone backup: the counts could not be read', err);
      return { ok: false, message: 'The numbers for this backup could not be read.' };
    }
  }

  /** Why a check cannot start right now (the phone or the drive is not ready), in plain words, else the names to show. Reads nothing but the device list. */
  private async checkOldReady(backup: PhoneBackupInfo, dest: DestinationRef): Promise<{ ok: true; driveLabel: string; phoneName: string; serial: string } | { ok: false; message: string }> {
    try {
      if (backup.serial === null) return { ok: false, message: 'This backup has no phone yet. Plug the phone in and say which backup it is for.' };
      const target = await this.deps.driveFor(dest.placeId);
      if (!target) return { ok: false, message: 'The drive for this backup is not plugged in. Plug it in and try again.' };
      const checked = await checkPhone(this.deps, backup.serial);
      if (checked.problem !== null) return { ok: false, message: checked.problem };
      return { ok: true, driveLabel: target.label, phoneName: checked.model ?? backup.name, serial: backup.serial };
    } finally {
      if (!this.busy()) await this.deps.adb.killServer().catch(() => undefined);
    }
  }

  /** The preview of "Check old copies": the folders that hold copies not checked yet, largest first. Nothing is read from the files themselves. */
  async checkOldPlan(backupId: unknown): Promise<CheckOldPlanResult> {
    const loaded = loadPhoneBackup(this.deps.db, backupId);
    if (!loaded.ok) return loaded;
    const ready = await this.checkOldReady(loaded.backup, loaded.dest);
    if (!ready.ok) return ready;
    const folders = uncheckedFolders(await finishSliced(classifyPhoneFilesSteps(this.deps.db, loaded.backup, loaded.dest), turn));
    if (folders.length === 0) return { ok: false, message: `Every copy of this phone's files on ${ready.driveLabel} has been checked already. Nothing to do.` };
    return { ok: true, backupId: loaded.backup.id, phoneName: ready.phoneName, driveLabel: ready.driveLabel, folders, totals: folders.reduce((a, f) => ({ files: a.files + f.files, bytes: a.bytes + f.bytes }), { files: 0, bytes: 0 }) };
  }

  /** Confirm: starts the check for the ticked folders. Main finds the copies again itself; the window only says which folders. Reads only. */
  async startCheckOld(request: CheckOldRequest): Promise<PhoneBackupStartResult> {
    const no = (message: string): PhoneBackupStartResult => ({ ok: false, message: `${message} Nothing was checked.`, jobId: null });
    if (this.busy()) return no('A phone backup is already waiting or running. Watch it in Activity.');
    const loaded = loadPhoneBackup(this.deps.db, request.backupId);
    if (!loaded.ok) return no(loaded.message);
    const ready = await this.checkOldReady(loaded.backup, loaded.dest);
    if (!ready.ok) return no(ready.message);
    if (this.busy()) return no('A phone backup is already waiting or running. Watch it in Activity.');
    const items = uncheckedItems(await finishSliced(classifyPhoneFilesSteps(this.deps.db, loaded.backup, loaded.dest), turn), new Set(request.folders));
    if (items.length === 0) return no('No old copies are left to check in the ticked folders.');
    const key = randomUUID();
    saveInput(this.deps.db, {
      key,
      backupId: loaded.backup.id,
      backupName: loaded.backup.name,
      phoneName: ready.phoneName,
      serial: ready.serial,
      destPlaceId: loaded.dest.placeId,
      driveLabel: ready.driveLabel,
      items: items.map((i) => ({ copyId: i.copyId!, phoneRowId: i.rowId, path: i.path, size: i.size, copyRel: i.copyRel!, group: i.group })),
    });
    const bytes = items.reduce((s, i) => s + i.size, 0);
    const title = `${PHONE_CHECK_OLD_TITLE}: ${loaded.backup.name} (${items.length.toLocaleString('en-US')} ${items.length === 1 ? 'file' : 'files'}, ${gb(bytes)})`;
    const jobId = this.jobs.create(PHONE_CHECK_OLD_JOB_KIND, title, { backupId: loaded.backup.id, key, destPlaceId: loaded.dest.placeId }, `Started by you: Check old copies of ${loaded.backup.name}`);
    this.deps.log.info(`phoneBackup: started check job ${jobId} for ${loaded.backup.name}: ${items.length} files, ${gb(bytes)}`);
    return { ok: true, message: '', jobId };
  }

  /** The report of a finished check (kept with the job in Activity), or null. */
  checkOldReport(jobId: unknown): CheckOldReport | null {
    return typeof jobId === 'number' ? loadCheckOldReport(this.deps.db, jobId) : null;
  }

  private track(jobId: number, progress: RunProgress): void {
    this.progresses.delete(jobId);
    this.progresses.set(jobId, progress);
    while (this.progresses.size > KEEP_PROGRESS) this.progresses.delete(this.progresses.keys().next().value as number);
  }

  /** The copy, all at once (tests and scripts that have no window to freeze). Anything that does not match what main computed is refused and nothing is written. */
  confirm(selection: PhoneBackupSelection): PhoneBackupStartResult {
    return finishSync(this.confirmSteps(selection));
  }

  /** The copy as the window asks for it: the same steps, cut into short turns so a plan of 60,000 files does not freeze the window. */
  confirmSliced(selection: PhoneBackupSelection): Promise<PhoneBackupStartResult> {
    return finishSliced(this.confirmSteps(selection));
  }

  private *confirmSteps(selection: PhoneBackupSelection): Steps<PhoneBackupStartResult> {
    const no = (message: string): PhoneBackupStartResult => ({ ok: false, message: `${message} Nothing was copied.`, jobId: null });
    const plan = this.plans.get(selection.planId);
    if (!plan) return no('That plan is not known any more. Make a new one.');
    if (this.now() - plan.createdAt > PLAN_LIFETIME_MS) {
      this.plans.delete(plan.planId);
      return no('That plan is more than an hour old. Make a new one.');
    }
    if (selection.hash !== plan.hash) return no('The list on screen is not the list Backup Hub made.');
    if (this.busy()) return no('A phone backup is already waiting or running.');
    if (this.confirming.has(plan.planId)) return no('This backup is already being started.');
    const guarded = this.deps.writeProtected?.(plan.base.destPlaceId) ?? null;
    if (guarded) return no(guarded);

    this.confirming.add(plan.planId);
    try {
      const unticked = new Set(selection.unticked);
      const folders = selection.untickedFolders.map((f) => f.replace(/\/+$/, '') + '/');
      // A "never back up" saved after the plan was made still counts: the person's choices are read again here (the unticks of the window are not the only guard).
      const choices = this.rules.compiled(plan.base.backupId);
      const out = (path: string): boolean => unticked.has(path) || folders.some((f) => path.startsWith(f)) || choices.match(path)?.choice === 'leave_out';
      const items: PlanItem[] = [];
      let seen = 0;
      for (const i of plan.items) {
        if (!out(i.path)) items.push(i);
        if (++seen % STEP_ITEMS === 0) yield;
      }
      const extra: PlanItem[] = [];
      let leftOut = { files: 0, bytes: 0 };
      for (const b of plan.buckets) {
        if (selection.included.includes(b.key) && plan.canInclude.has(b.filter)) {
          for (const f of b.files) {
            if (++seen % STEP_ITEMS === 0) yield;
            if (out(f.path)) continue;
            const where = placeOnDrive({ root: plan.base.destRoot, sessionFolder: plan.base.sessionFolder, phonePath: f.path });
            if (where === null) continue;
            extra.push({ path: f.path, size: f.size, mtimeSec: f.mtimeSec, kind: 'new', rowId: f.rowId, destRel: where.rel, candidates: [] });
          }
        } else leftOut = { files: leftOut.files + b.files.length, bytes: leftOut.bytes + b.bytes };
      }
      if (extra.length > 0) {
        const used = takenUnder(this.deps.db, plan.base.destPlaceId, `${plan.base.destRoot}/${plan.base.sessionFolder}`);
        for (const i of items) used.set(i.destRel.normalize('NFC').toLowerCase(), i.rowId);
        assignNames(extra, used, new Date(this.now()));
        items.push(...extra);
        yield;
      }
      const relinks: StoredPlan['relinks'] = [];
      for (const r of plan.relinks) {
        if (!out(r.path)) relinks.push(r);
        if (++seen % STEP_ITEMS === 0) yield;
      }
      if (items.length + relinks.length === 0) return no('Nothing is ticked.');
      let bytes = 0;
      const runItems: ConfirmedRun['items'] = [];
      for (const i of items) {
        bytes += i.size;
        runItems.push({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId });
        if (runItems.length % STEP_ITEMS === 0) yield;
      }
      const run: ConfirmedRun = { ...plan.base, items: runItems, relinks, leftOut };
      yield* saveConfirmedSteps(this.deps.db, plan.planId, run);
      // Nothing yielded since this check: another start cannot slip in between it and the job.
      if (this.busy()) {
        dropConfirmed(this.deps.db, plan.planId);
        return no('A phone backup is already waiting or running.');
      }
      this.plans.delete(plan.planId);
      const title = `Back up ${plan.base.backupName} now (${items.length.toLocaleString('en-US')} ${items.length === 1 ? 'file' : 'files'}, ${gb(bytes)})`;
      const jobId = this.jobs.create(PHONE_BACKUP_JOB_KIND, title, { planId: plan.planId, backupId: plan.base.backupId, destPlaceId: plan.base.destPlaceId }, `Started by you: Back up ${plan.base.backupName} now`);
      this.deps.log.info(`phoneBackup: started job ${jobId} for plan ${plan.planId}: ${items.length} files, ${gb(bytes)}, ${relinks.length} to link`);
      return { ok: true, message: '', jobId };
    } finally {
      this.confirming.delete(plan.planId);
    }
  }

  /** The job handlers (registered once by the app). */
  handlers(): JobHandler[] {
    const deps = this.deps;
    const results = this.results;
    const track = (jobId: number, progress: RunProgress): void => this.track(jobId, progress);
    const keep = (planId: string, stored: StoredPlan): void => {
      this.plans.set(planId, stored);
      while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    };
    const look: JobHandler = {
      kind: PHONE_LOOK_JOB_KIND,
      heavy: false,
      async run(ctx) {
        const params = ctx.params as { backupId: number; accept?: DecisionKind[] };
        try {
          const outcome = await planPhoneBackup(deps, { backupId: params.backupId, ...(params.accept ? { accept: params.accept } : {}) }, ctx);
          if (!outcome.result.ok || outcome.stored === null) {
            results.set(ctx.jobId, outcome.result);
            // A refused look is kept per backup, so it shows in "Needs your decision" until a later look settles it.
            const d = outcome.result.ok ? null : outcome.result.decision;
            const kind = d === null ? undefined : LOOK_REFUSAL_KINDS.find((k) => k === d.kind);
            if (d !== null && kind !== undefined && !outcome.result.ok) saveRefusal(deps.db, { backupId: params.backupId, jobId: ctx.jobId, kind, canAccept: d.canAccept, message: outcome.result.message, at: (deps.now ?? Date.now)() });
            throw refusal(outcome);
          }
          clearRefusal(deps.db, params.backupId);
          keep(outcome.stored.planId, outcome.stored);
          results.set(ctx.jobId, { ...outcome.result, planId: outcome.stored.planId });
          const t = outcome.stored.total;
          return `${t.files.toLocaleString('en-US')} files (${gb(t.bytes)}) are ready to copy. Nothing was copied.`;
        } finally {
          await deps.adb.killServer().catch(() => undefined);
        }
      },
    };
    const backup: JobHandler = {
      kind: PHONE_BACKUP_JOB_KIND,
      heavy: true,
      resumable: true,
      async run(ctx) {
        const params = ctx.params as { planId?: string };
        const run = typeof params.planId === 'string' ? await finishSliced(loadConfirmedSteps(deps.db, params.planId), () => ctx.yield()) : null;
        if (!run) throw new JobFailure('The list of files for this backup is not there any more. Start a new backup.');
        try {
          const runner = new PhoneBackupRun(deps, ctx, run, ctx.jobId, (ctx.resume as Partial<RunCheckpoint> | null) ?? null);
          track(ctx.jobId, runner.progress);
          const report = await runner.execute();
          dropConfirmed(deps.db, params.planId!);
          const failed = report.failed.reduce((s, r) => s + r.count, 0);
          const line = `Copied and checked ${report.copied.files.toLocaleString('en-US')} files (${gb(report.copied.bytes)}); ${report.linked.toLocaleString('en-US')} already on the drive${failed > 0 ? `; ${failed} failed` : ''}`;
          if (report.copied.files + report.linked === 0 && failed > 0) throw new JobFailure(`${line}. Nothing was copied. See the warnings.`);
          return `${line}. Nothing was deleted or overwritten.`;
        } finally {
          await deps.adb.killServer().catch(() => undefined);
        }
      },
    };
    const checkOld: JobHandler = {
      kind: PHONE_CHECK_OLD_JOB_KIND,
      heavy: true,
      resumable: true,
      async run(ctx) {
        const params = ctx.params as { key?: string };
        const input = typeof params.key === 'string' ? loadInput(deps.db, params.key) : null;
        if (!input) throw new JobFailure('The list of files to check is not there any more. Start the check again.');
        try {
          const report = await new CheckOldRun(deps, ctx, input, ctx.jobId, (ctx.resume as Partial<CheckOldCheckpoint> | null) ?? null).execute();
          dropInput(deps.db, params.key!);
          const unread = report.couldNotRead.reduce((s, r) => s + r.count, 0);
          const line = `Checked ${report.asked.toLocaleString('en-US')} files: ${report.verified.files.toLocaleString('en-US')} are the same on the phone and the drive${report.differCount > 0 ? `; ${report.differCount} differ (they will be copied again by the next backup)` : ''}${report.missingCount > 0 ? `; ${report.missingCount} are missing on the drive` : ''}${report.noLongerOnPhone > 0 ? `; ${report.noLongerOnPhone} are no longer on the phone` : ''}${unread > 0 ? `; ${unread} could not be read` : ''}`;
          if (report.asked > 0 && unread === report.asked) throw new JobFailure(`${line}. Nothing could be checked. See the warnings.`);
          return `${line}. Nothing on the phone or the drive was changed.`;
        } finally {
          await deps.adb.killServer().catch(() => undefined);
        }
      },
    };
    // Whatever the job did (even when it failed half way), the cached counts of the Backups card are old afterwards.
    return [look, backup, checkOld].map((h): JobHandler =>
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
