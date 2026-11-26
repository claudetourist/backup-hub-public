/**
 * What the app calls for "Copy to Google" (G3 / R1.4). `status` and `preview` only read the file list (in slices, never on the window's thread for long); `start`
 * saves the person's choice of kinds and makes the job; the job (`google.copy`) is only ever made here, from the person's click. Nothing in Google is deleted.
 */
import type { JobRecord } from '../../shared/jobs';
import { isFileKind, KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import {
  accountRoomBytes,
  DEFAULT_GOOGLE_KINDS,
  ACCOUNT_SIGNIN_REASON,
  ACCOUNTS_FULL_MESSAGE,
  accountPick,
  GOOGLE_COPY_JOB_KIND,
  googleBytes,
  kindRank,
  Placer,
  shortLine,
  sortKindRows,
  type GoogleCopyPreview,
  type GoogleCopyPreviewResult,
  type GoogleCopyReport,
  type GoogleCopyStartRequest,
  type GoogleCopyStartResult,
  type GoogleCopyStatusResult,
  type GoogleAccountPick,
  type GoogleCopyAddAccountsRequest,
  type GoogleCopyMoreResult,
  type GoogleCopyPlan,
  type GoogleCopyPlanRequest,
  type GoogleCopyPlanResult,
  type GoogleAccountActionResult,
  type GoogleKindRow,
  type GoogleSentLine,
  type PlacerAccount,
} from '../../shared/googleCopy';
import { GoogleApiError, NetworkError, RequestAborted } from '../google/googleHttp';
import { NeedsSignInError, NO_CLIENT_MESSAGE, VaultNotReadyError, type GoogleAuth } from '../google/auth';
import { JobFailure, type JobHandler } from '../jobs/jobService';
import { finishSliced, sortSteps, turn, type Steps } from '../sliceWork';
import { emptyCheckpoint, GoogleCopyRun, withoutInFlight, type GoogleCopyCheckpoint, type GoogleCopyDeps } from './googleCopyRun';
import { candidatesSteps, leftOutKinds, loadAccountTicks, loadJobAccounts, loadReport, loadSent, saveAccountTicks, saveJobAccounts, saveKindChoices, saveReport, saveSent, scanKindsSteps, sourceOf, type BackupSource, type Candidate, type Scan } from './googleCopyStore';

export interface GoogleCopyJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface GoogleCopyServiceDeps extends GoogleCopyDeps {
  jobs: GoogleCopyJobs;
  auth: Pick<GoogleAuth, 'assertVaultReady' | 'hasRefreshToken' | 'clientCredentials'>;
  /** The drives plugged in right now. */
  pluggedPlaces(): Promise<ReadonlySet<string>>;
}

const ACTIVE: JobRecord['state'][] = ['queued', 'running', 'needs_you'];
/** A count of a backup is used for this long; it is counted again after a run or a change of choice. */
const SCAN_MAX_AGE_MS = 60_000;

interface AccountRow {
  id: string;
  label: string;
  status: string;
  identity_json: string;
}

const quotaOf = (json: string): { limit: number | null; usage: number | null; removed: boolean; email: string | null } => {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      limit: typeof o['quotaLimit'] === 'number' ? o['quotaLimit'] : null,
      usage: typeof o['quotaUsage'] === 'number' ? o['quotaUsage'] : null,
      removed: typeof o['removedAt'] === 'number',
      email: typeof o['email'] === 'string' ? o['email'] : null,
    };
  } catch {
    return { limit: null, usage: null, removed: false, email: null };
  }
};

/** The room of an account is asked from Google on the capacity screen, at most this many accounts at a time and this long each. */
const LIVE_QUOTA_AT_ONCE = 4;
const LIVE_QUOTA_MS = 10_000;
/** The plan reuses an answer that is not older than this; the start always asks again. */
const RECENT_CHECK_MS = 5 * 60_000;
/** A ticked account that lost less than this (or 1% of what it showed, if that is smaller) since the screen was drawn does not stop the start. */
const ROOM_NOISE_BYTES = 1_000_000;

type AccountCheck = { ok: true; limit: number | null; usage: number | null; at: number } | { ok: false; needsSignIn: boolean; why: string };

/** The two switches of "Copy to Google" for a phone backup. */
interface CopyFlags {
  /** Only files whose content is still on the phone. */
  onlyOnPhone: boolean;
  /** Only what the ticked accounts have room for, biggest files first. */
  fit: boolean;
}

const cacheKey = (src: BackupSource, onlyOnPhone: boolean): string => `${src.backupId}:${onlyOnPhone ? 'phone' : 'all'}`;

/** Sizes into one list per kind, a turn for the window every few thousand files. */
function* groupSteps(list: readonly Candidate[], byKind: Map<FileKind, number[]>): Steps<void> {
  let n = 0;
  for (const c of list) {
    const sizes = byKind.get(c.kind);
    if (sizes) sizes.push(c.size);
    else byKind.set(c.kind, [c.size]);
    n += 1;
    if (n % 5000 === 0) yield;
  }
}

function* placeSteps(placer: Placer, lists: readonly (readonly number[])[]): Steps<void> {
  let n = 0;
  for (const sizes of lists) {
    for (const size of sizes) {
      placer.put(size);
      n += 1;
      if (n % 2000 === 0) yield;
    }
  }
}

export class GoogleCopyService {
  private readonly now: () => number;
  /** The live per-account numbers of the copies running now (job id to lines). */
  private readonly liveSent = new Map<number, GoogleSentLine[]>();
  /** The counts and the sizes per kind, one per backup and per "only what is still on the phone" setting. */
  private readonly scans = new Map<string, { at: number; version: number; scan: Scan }>();
  private readonly sizes = new Map<string, { at: number; version: number; byKind: Map<FileKind, number[]> }>();
  /** The last good answer of Google about each account's room. */
  private readonly lastCheck = new Map<string, Extract<AccountCheck, { ok: true }>>();
  private version = 0;
  private starting = false;

  constructor(private readonly deps: GoogleCopyServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The counts are old (a run ended, a choice changed). */
  countsChanged(): void {
    this.version += 1;
  }

  private busy(): boolean {
    return this.deps.jobs.list({ states: ACTIVE }).some((j) => j.kind === GOOGLE_COPY_JOB_KIND);
  }

  /** The accounts of the backup's owner that can take files: signed in, not taken off the list. Size and room are read from Google when the run starts. */
  accountsFor(personId: number): { placeId: string; label: string; email: string | null; limit: number | null; usage: number | null }[] {
    const rows = this.deps.db.prepare("SELECT id, label, status, identity_json FROM places WHERE kind = 'gdrive' AND profile_id = ? ORDER BY label").all(personId) as AccountRow[];
    const out: { placeId: string; label: string; email: string | null; limit: number | null; usage: number | null }[] = [];
    for (const r of rows) {
      const q = quotaOf(r.identity_json);
      if (q.removed || r.status === 'needs_signin' || !this.deps.auth.hasRefreshToken(r.id)) continue;
      out.push({ placeId: r.id, label: r.label, email: q.email, limit: q.limit, usage: q.usage });
    }
    return out;
  }

  /** Asks Google how much room an account has right now (the allowed `about` call). The fresh numbers are saved into the account's row like the refresh does. */
  private async check(placeId: string): Promise<AccountCheck> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIVE_QUOTA_MS);
    try {
      const q = await this.deps.room(placeId, abort.signal);
      if (!q) return { ok: false, needsSignIn: false, why: 'Google did not answer' };
      this.saveQuota(placeId, q);
      return { ok: true, limit: q.limit, usage: q.usage, at: this.now() };
    } catch (err) {
      if (err instanceof NeedsSignInError) return { ok: false, needsSignIn: true, why: ACCOUNT_SIGNIN_REASON };
      if (abort.signal.aborted || err instanceof RequestAborted) return { ok: false, needsSignIn: false, why: 'Google did not answer in time' };
      if (err instanceof NetworkError) return { ok: false, needsSignIn: false, why: 'no internet connection' };
      if (err instanceof GoogleApiError) return { ok: false, needsSignIn: false, why: 'Google said no' };
      return { ok: false, needsSignIn: false, why: 'Google did not answer' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The room of several accounts right now, at most LIVE_QUOTA_AT_ONCE questions at a time (network, never the window's thread). */
  private async checkMany(placeIds: readonly string[]): Promise<Map<string, AccountCheck>> {
    const out = new Map<string, AccountCheck>();
    for (let i = 0; i < placeIds.length; i += LIVE_QUOTA_AT_ONCE) {
      const group = placeIds.slice(i, i + LIVE_QUOTA_AT_ONCE);
      const answers = await Promise.all(group.map((id) => this.check(id)));
      group.forEach((id, n) => {
        const a = answers[n]!;
        out.set(id, a);
        if (a.ok) this.lastCheck.set(id, a);
      });
    }
    return out;
  }

  /** The fresh quota goes into the account's row (the same keys the refresh writes), so Devices shows it too. */
  private saveQuota(placeId: string, q: { limit: number | null; usage: number | null; usageInDrive?: number | null; usageInDriveTrash?: number | null }): void {
    try {
      const row = this.deps.db.prepare("SELECT identity_json FROM places WHERE id = ? AND kind = 'gdrive'").pluck().get(placeId) as string | undefined;
      if (row === undefined) return;
      const identity = JSON.parse(row) as Record<string, unknown>;
      identity['quotaLimit'] = q.limit;
      identity['quotaUsage'] = q.usage;
      if (q.usageInDrive !== undefined) identity['quotaUsageDrive'] = q.usageInDrive;
      if (q.usageInDriveTrash !== undefined) identity['quotaUsageTrash'] = q.usageInDriveTrash;
      identity['lastQuotaAt'] = this.now();
      this.deps.db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify(identity), placeId);
    } catch {
      // The numbers are still used for this screen; the row keeps its old ones.
    }
  }

  /**
   * Every Google account of the owner that is not taken off the list, as rows of the "Which accounts?" step. The numbers of EVERY signed-in account are
   * asked from Google now, not read from the last refresh; an account Google cannot be asked about is greyed and cannot be ticked.
   */
  private async picksFor(personId: number, backupId: number): Promise<GoogleAccountPick[]> {
    const rows = this.deps.db.prepare("SELECT id, label, status, identity_json FROM places WHERE kind = 'gdrive' AND profile_id = ? ORDER BY label").all(personId) as AccountRow[];
    const remembered = new Set(loadAccountTicks(this.deps.db, backupId));
    const listed = rows
      .map((r) => ({ r, q: quotaOf(r.identity_json) }))
      .filter((x) => !x.q.removed)
      .map((x) => ({ placeId: x.r.id, label: x.r.label, email: x.q.email, needsSignIn: x.r.status === 'needs_signin' || !this.deps.auth.hasRefreshToken(x.r.id) }));
    const checks = await this.checkMany(listed.filter((a) => !a.needsSignIn).map((a) => a.placeId));
    return listed.map((a) => {
      const c = checks.get(a.placeId);
      return accountPick({
        placeId: a.placeId,
        label: a.label,
        email: a.email,
        limit: c?.ok ? c.limit : null,
        usage: c?.ok ? c.usage : null,
        needsSignIn: a.needsSignIn || (c !== undefined && !c.ok && c.needsSignIn),
        remembered: remembered.has(a.placeId),
        checkedNow: c?.ok === true,
        checkFailed: c && !c.ok && !c.needsSignIn ? c.why : null,
      });
    });
  }

  /** The ticked accounts as the plan sees them, with their room: from a fresh question, or from the last answer when it is not older than a few minutes. */
  private async placerAccounts(personId: number, ids: readonly string[], fresh: boolean): Promise<{ accounts: PlacerAccount[]; failed: { label: string; why: string }[] }> {
    const known = this.accountsFor(personId).filter((a) => ids.includes(a.placeId));
    const need = known.filter((a) => fresh || !this.lastCheck.has(a.placeId) || this.now() - this.lastCheck.get(a.placeId)!.at > RECENT_CHECK_MS).map((a) => a.placeId);
    const results = await this.checkMany(need);
    const accounts: PlacerAccount[] = [];
    const failed: { label: string; why: string }[] = [];
    for (const a of known) {
      const c = results.get(a.placeId) ?? this.lastCheck.get(a.placeId);
      if (!c || !c.ok) {
        failed.push({ label: a.email ?? a.label, why: c && !c.ok ? c.why : 'Google did not answer' });
        continue;
      }
      accounts.push({ placeId: a.placeId, label: a.label, email: a.email, limit: c.limit, usage: c.usage, room: accountRoomBytes(c.limit, c.usage) });
    }
    return { accounts, failed };
  }

  /** The sizes of the files still to go, per kind, biggest first: the real material of the plan (cached for a minute, built in slices). */
  private async sizesFor(src: BackupSource, onlyOnPhone: boolean): Promise<Map<FileKind, number[]>> {
    const key = cacheKey(src, onlyOnPhone);
    const cached = this.sizes.get(key);
    if (cached && cached.version === this.version && this.now() - cached.at < SCAN_MAX_AGE_MS) return cached.byKind;
    const scan = await this.scan(src, onlyOnPhone);
    const list = await finishSliced(candidatesSteps(this.deps.db, src, new Set(scan.kinds.keys()), onlyOnPhone), turn);
    const byKind = new Map<FileKind, number[]>();
    await finishSliced(groupSteps(list, byKind), turn);
    for (const sizes of byKind.values()) await finishSliced(sortSteps(sizes, (a, b) => b - a), turn);
    this.sizes.set(key, { at: this.now(), version: this.version, byKind });
    return byKind;
  }

  /**
   * Where every file of the ticked kinds would go, file by file, with the same rule as the run. In "fit" mode the files of all ticked kinds are taken
   * biggest first and only the ones that fit the ticked accounts are planned (the rest wait for another account), like the run chooses them.
   */
  private async planFor(src: BackupSource, kinds: ReadonlySet<FileKind>, accounts: readonly PlacerAccount[], flags: CopyFlags): Promise<GoogleCopyPlan> {
    const sizes = await this.sizesFor(src, flags.onlyOnPhone);
    const placer = new Placer(accounts, flags.fit);
    let lists: (readonly number[])[];
    if (flags.fit) {
      const all = [...kinds].flatMap((k) => sizes.get(k) ?? []);
      await finishSliced(sortSteps(all, (a, b) => b - a), turn);
      lists = [all];
    } else lists = [...kinds].toSorted((a, b) => kindRank(a) - kindRank(b)).map((k) => sizes.get(k) ?? []);
    await finishSliced(placeSteps(placer, lists), turn);
    return placer.result();
  }

  /** The two switches of a request, as they apply to this backup: "only what is still on the phone" means something only for a phone backup. */
  private flagsOf(src: BackupSource, request: { onlyOnPhone?: unknown; fitBiggest?: unknown }): CopyFlags {
    return { onlyOnPhone: src.isPhone && request.onlyOnPhone === true, fit: request.fitBiggest === true };
  }

  /** "Where would the files go?" for the ticked kinds and accounts (the numbers are at most a few minutes old; the start asks again). */
  async plan(request: GoogleCopyPlanRequest): Promise<GoogleCopyPlanResult> {
    if (!request || !Number.isInteger(request.backupId) || request.backupId <= 0 || !Array.isArray(request.kinds) || !Array.isArray(request.accountIds)) return { ok: false, message: 'That is not a valid request.' };
    const src = sourceOf(this.deps.db, request.backupId);
    if (!src) return { ok: false, message: 'That backup has no folder on a drive yet.' };
    const chosen = this.validAccounts(src.personId, request.accountIds);
    if (typeof chosen === 'string') return { ok: false, message: chosen };
    const kinds = new Set<FileKind>(request.kinds.filter(isFileKind));
    const { accounts } = await this.placerAccounts(src.personId, chosen, false);
    return { ok: true, plan: await this.planFor(src, kinds, accounts, this.flagsOf(src, request)) };
  }

  private async scan(src: BackupSource, onlyOnPhone: boolean): Promise<Scan> {
    const key = cacheKey(src, onlyOnPhone);
    const cached = this.scans.get(key);
    if (cached && cached.version === this.version && this.now() - cached.at < SCAN_MAX_AGE_MS) return cached.scan;
    const scan = await finishSliced(scanKindsSteps(this.deps.db, src, onlyOnPhone), turn);
    this.scans.set(key, { at: this.now(), version: this.version, scan });
    return scan;
  }

  private blocker(src: BackupSource, accounts: number): string | null {
    try {
      this.deps.auth.assertVaultReady();
      this.deps.auth.clientCredentials();
    } catch (err) {
      if (err instanceof VaultNotReadyError) return err.message === NO_CLIENT_MESSAGE ? 'The Google app key is not saved yet. Enter it in Settings, then come back here.' : err.message;
      throw err;
    }
    if (accounts === 0) {
      const person = (this.deps.db.prepare('SELECT name FROM profiles WHERE id = ?').pluck().get(src.personId) as string | undefined) ?? 'this person';
      return `No Google account of ${person} is signed in. Add one on the Devices page (or set whose account it is there).`;
    }
    return null;
  }

  /** "N files, X GB on Google, M to go" for the Google section's first line. */
  async status(backupId: unknown): Promise<GoogleCopyStatusResult> {
    const src = typeof backupId === 'number' && Number.isInteger(backupId) && backupId > 0 ? sourceOf(this.deps.db, backupId) : null;
    if (!src) return { ok: false, message: 'That backup has no folder on a drive yet.' };
    const scan = await this.scan(src, false);
    const left = leftOutKinds(this.deps.db, src.backupId);
    let onFiles = 0;
    let onBytes = 0;
    let goFiles = 0;
    let goBytes = 0;
    for (const [kind, t] of scan.kinds) {
      onFiles += t.onFiles;
      onBytes += t.onBytes;
      if (left.has(kind)) continue;
      goFiles += t.files - t.onFiles;
      goBytes += t.bytes - t.onBytes;
    }
    return { ok: true, status: { backupId: src.backupId, filesOnGoogle: onFiles, bytesOnGoogle: onBytes, filesToGo: goFiles, bytesToGo: goBytes } };
  }

  /** The capacity screen: the kinds (videos first, then screenshots, photos, the rest), what is ticked, and the room in the accounts. */
  async preview(backupId: unknown, onlyOnPhoneRequest?: unknown): Promise<GoogleCopyPreviewResult> {
    const src = typeof backupId === 'number' && Number.isInteger(backupId) && backupId > 0 ? sourceOf(this.deps.db, backupId) : null;
    if (!src) return { ok: false, message: 'That backup has no folder on a drive yet.' };
    const onlyOnPhone = src.isPhone && onlyOnPhoneRequest === true;
    const scan = await this.scan(src, onlyOnPhone);
    const left = leftOutKinds(this.deps.db, src.backupId);
    const rows: GoogleKindRow[] = [];
    for (const [kind, t] of scan.kinds) {
      const leftOut = left.has(kind);
      rows.push({
        kind,
        label: KIND_LABELS[kind],
        files: t.files,
        bytes: t.bytes,
        onGoogleFiles: t.onFiles,
        onGoogleBytes: t.onBytes,
        toGoFiles: t.files - t.onFiles,
        toGoBytes: t.bytes - t.onBytes,
        repeatFiles: t.repeatFiles,
        ticked: !leftOut && DEFAULT_GOOGLE_KINDS.includes(kind),
        leftOut,
      });
    }
    const accounts = this.accountsFor(src.personId);
    const picks = await this.picksFor(src.personId, src.backupId);
    const plugged = await this.deps.pluggedPlaces();
    const preview: GoogleCopyPreview = {
      backupId: src.backupId,
      backupName: src.name,
      isPhone: src.isPhone,
      onlyOnPhone,
      driveLabel: src.placeLabel,
      driveConnected: plugged.has(src.placeId),
      kinds: sortKindRows(rows),
      room: { accounts: picks.filter((a) => a.canTake).length, roomBytes: picks.reduce((s, a) => s + a.room, 0) },
      noChecksumFiles: scan.noChecksum,
      blocker: this.blocker(src, accounts.length),
      accounts: picks,
    };
    return { ok: true, preview };
  }

  /** Saves the choice of kinds and starts the copy. Only ever from the person's click. */
  async start(request: GoogleCopyStartRequest): Promise<GoogleCopyStartResult> {
    const no = (message: string, changed = false): GoogleCopyStartResult => ({ ok: false, message: `${message} Nothing was sent.`, ...(changed ? { changed: true } : {}) });
    if (!request || !Number.isInteger(request.backupId) || request.backupId <= 0 || !Array.isArray(request.kinds) || !Array.isArray(request.accountIds)) return no('That is not a valid request.');
    if (request.confirmedAccounts !== true) return no('The accounts were not confirmed.');
    const src = sourceOf(this.deps.db, request.backupId);
    if (!src) return no('That backup has no folder on a drive yet.');
    if (this.busy() || this.starting) return no('A copy to Google is already waiting or running. Watch it in Activity.');
    const flags = this.flagsOf(src, request);
    this.starting = true;
    try {
      const accounts = this.accountsFor(src.personId);
      const blocked = this.blocker(src, accounts.length);
      if (blocked) return no(blocked);
      const chosen = this.validAccounts(src.personId, request.accountIds);
      if (typeof chosen === 'string') return no(chosen);
      const plugged = await this.deps.pluggedPlaces();
      if (!plugged.has(src.placeId)) return no(`Plug in ${src.placeLabel} first: the files are read from it.`);
      this.countsChanged();
      const scan = await this.scan(src, flags.onlyOnPhone);
      const offered = [...scan.kinds.keys()];
      const ticked = new Set<FileKind>(request.kinds.filter((k): k is FileKind => isFileKind(k) && scan.kinds.has(k)));
      if (ticked.size === 0) return no('Nothing is ticked.');
      let files = 0;
      let bytes = 0;
      for (const k of ticked) {
        const t = scan.kinds.get(k)!;
        files += t.files - t.onFiles;
        bytes += t.bytes - t.onBytes;
      }
      if (files === 0) return no(flags.onlyOnPhone ? 'Everything that is ticked and still on the phone is already on Google.' : 'Everything that is ticked is already on Google.');
      // The ticked accounts are asked again right now: the plan is made with these numbers, and the copy starts only when every file fits.
      const rooms = await this.placerAccounts(src.personId, chosen, true);
      if (rooms.failed.length > 0) return no(`${rooms.failed.map((f) => `${f.label} could not be checked just now (${f.why})`).join('; ')}. Check the ticks and press the button again.`, true);
      const seen = request.seenRoom && typeof request.seenRoom === 'object' ? request.seenRoom : {};
      const lost = rooms.accounts.find((a) => typeof seen[a.placeId] === 'number' && a.room < seen[a.placeId]! - Math.min(ROOM_NOISE_BYTES, seen[a.placeId]! * 0.01));
      if (lost) return no(`${lost.email ?? lost.label} has less room now: ${googleBytes(lost.room)} instead of ${googleBytes(seen[lost.placeId]!)}. The plan was updated: please look at it again.`, true);
      const plan = await this.planFor(src, ticked, rooms.accounts, flags);
      if (flags.fit) {
        // Only what fits is sent, so the numbers of the job are the planned ones.
        if (plan.toPlaceFiles === 0) return no('Not even the smallest file fits in the ticked accounts: tick another account.', true);
        files = plan.toPlaceFiles;
        bytes = plan.toPlaceBytes;
      } else if (plan.unplacedFiles > 0) return no(shortLine(plan.unplacedBytes) + '.', true);
      if (this.busy()) return no('A copy to Google is already waiting or running.');
      saveKindChoices(this.deps.db, src.backupId, offered, ticked, this.now());
      saveAccountTicks(this.deps.db, src.backupId, chosen);
      this.countsChanged();
      const title = `Copy ${src.name} to Google (${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}, ${googleBytes(bytes)})`;
      const switches = { ...(flags.onlyOnPhone ? { onlyOnPhone: true } : {}), ...(flags.fit ? { fitBiggest: true } : {}) };
      const jobId = this.deps.jobs.create(GOOGLE_COPY_JOB_KIND, title, { backupId: src.backupId, backupIds: [src.backupId], kinds: [...ticked], accountIds: chosen, placeIds: [src.placeId], ...switches }, `Started by you: Copy ${src.name} to Google`);
      this.deps.log.info(`google copy: started job ${jobId} for backup ${src.backupId}: ${files} files, ${bytes} bytes, kinds ${[...ticked].join(',')}, ${chosen.length} accounts${flags.onlyOnPhone ? ', only what is still on the phone' : ''}${flags.fit ? ', biggest first as far as it fits' : ''}`);
      saveJobAccounts(this.deps.db, jobId, { backupId: src.backupId, kinds: [...ticked], accountIds: chosen, moreIds: [], ...switches });
      return { ok: true, jobId, message: '' };
    } finally {
      this.starting = false;
    }
  }

  /** The copy is waiting because the ticked accounts are full (the question the run asks). */
  private waiting(jobId: number): boolean {
    return this.deps.jobs.list({ states: ['needs_you'] }).some((j) => j.id === jobId && j.kind === GOOGLE_COPY_JOB_KIND && j.message === ACCOUNTS_FULL_MESSAGE);
  }

  /** The picker again for a copy that waits because its accounts are full: the live rows, the accounts in use, and how much is still to go. */
  async more(jobId: unknown): Promise<GoogleCopyMoreResult> {
    const record = typeof jobId === 'number' && Number.isInteger(jobId) && this.waiting(jobId) ? loadJobAccounts(this.deps.db, jobId) : null;
    const src = record ? sourceOf(this.deps.db, record.backupId) : null;
    if (!record || !src) return { ok: false, message: 'This copy is not waiting for more accounts.' };
    this.countsChanged();
    const scan = await this.scan(src, record.onlyOnPhone === true);
    let needBytes = 0;
    for (const kind of record.kinds) {
      const t = scan.kinds.get(kind as FileKind);
      if (t) needBytes += t.bytes - t.onBytes;
    }
    const shown = await this.preview(record.backupId, record.onlyOnPhone === true);
    if (!shown.ok) return { ok: false, message: shown.message };
    return { ok: true, preview: shown.preview, inUse: [...record.accountIds, ...record.moreIds], kinds: record.kinds, needBytes, ...(record.onlyOnPhone === true ? { onlyOnPhone: true } : {}), ...(record.fitBiggest === true ? { fitBiggest: true } : {}) };
  }

  /**
   * The person confirmed more accounts for a copy that waits. They are added to the copy only here (checked like at the start: this person's, signed in,
   * not removed; asked again about their room; everything still to go must fit). The window then presses Continue.
   */
  async addAccounts(request: GoogleCopyAddAccountsRequest): Promise<GoogleAccountActionResult> {
    if (!request || !Number.isInteger(request.jobId) || !Array.isArray(request.accountIds)) return { ok: false, message: 'That is not a valid request.' };
    if (request.confirmedAccounts !== true) return { ok: false, message: 'The accounts were not confirmed.' };
    const record = this.waiting(request.jobId) ? loadJobAccounts(this.deps.db, request.jobId) : null;
    const src = record ? sourceOf(this.deps.db, record.backupId) : null;
    if (!record || !src) return { ok: false, message: 'This copy is not waiting for more accounts.' };
    const chosen = this.validAccounts(src.personId, request.accountIds);
    if (typeof chosen === 'string') return { ok: false, message: chosen };
    const all = [...new Set([...record.accountIds, ...record.moreIds, ...chosen])];
    this.countsChanged();
    const rooms = await this.placerAccounts(src.personId, all, true);
    if (rooms.failed.length > 0) return { ok: false, message: `${rooms.failed.map((f) => `${f.label} could not be checked just now (${f.why})`).join('; ')}. Check the ticks and try again.` };
    const plan = await this.planFor(src, new Set(record.kinds.filter((k): k is FileKind => isFileKind(k))), rooms.accounts, { onlyOnPhone: record.onlyOnPhone === true, fit: record.fitBiggest === true });
    if (plan.unplacedFiles > 0) return { ok: false, message: shortLine(plan.unplacedBytes) + '.' };
    saveJobAccounts(this.deps.db, request.jobId, { ...record, moreIds: all.filter((id) => !record.accountIds.includes(id)) });
    saveAccountTicks(this.deps.db, record.backupId, all);
    return { ok: true, message: '' };
  }

  /**
   * The ticked accounts, checked: every one must be an account of the backup's owner that is signed in and not taken off the list (the same rule that
   * lists the accounts). Anything else (someone else's account, an unknown id, a signed-out one) refuses the whole request: a string is the plain reason.
   */
  private validAccounts(personId: number, ids: readonly unknown[]): string[] | string {
    const allowed = new Set(this.accountsFor(personId).map((a) => a.placeId));
    const chosen: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !allowed.has(id)) return 'One of the ticked accounts cannot be used for this backup (it is not this person\'s, is not signed in, or was removed).';
      if (!chosen.includes(id)) chosen.push(id);
    }
    if (chosen.length === 0) return 'Tick at least one Google account.';
    return chosen;
  }

  report(jobId: unknown): GoogleCopyReport | null {
    return typeof jobId === 'number' ? loadReport(this.deps.db, jobId) : null;
  }

  /**
   * What each ticked account has been sent in this copy, for the live line "email: 60 MB of 144 MB". While the copy runs: the live numbers (the file on
   * its way counted as far as Google confirmed it). Otherwise (after a restart, before Continue): the numbers written down right after every checked
   * file. A small read of one saved line: it never touches the file list.
   */
  sent(jobId: unknown): GoogleSentLine[] {
    if (typeof jobId !== 'number') return [];
    return this.liveSent.get(jobId) ?? loadSent(this.deps.db, jobId);
  }

  /** The job handler (registered once by the app). */
  handlers(): JobHandler[] {
    const deps = this.deps;
    const copy: JobHandler = {
      kind: GOOGLE_COPY_JOB_KIND,
      heavy: true,
      resumable: true,
      // A Stop is abrupt: the files on their way are dropped from the checkpoint (their upload addresses are forgotten).
      onStop: withoutInFlight,
      run: async (ctx) => {
        const params = ctx.params as { backupId?: unknown; kinds?: unknown; accountIds?: unknown; onlyOnPhone?: unknown; fitBiggest?: unknown } | null;
        const src = typeof params?.backupId === 'number' ? sourceOf(deps.db, params.backupId) : null;
        if (!src) throw new JobFailure('This backup has no folder on a drive any more. Nothing was sent.');
        const kinds = new Set<FileKind>((Array.isArray(params?.kinds) ? params.kinds : []).filter(isFileKind));
        if (kinds.size === 0) throw new JobFailure('No kind of file was chosen. Nothing was sent.');
        try {
          deps.auth.assertVaultReady();
          deps.auth.clientCredentials();
        } catch (err) {
          if (err instanceof VaultNotReadyError) throw new JobFailure(`${err.message} Nothing was sent.`);
          throw err;
        }
        // Only the accounts that were ticked (at the start, or confirmed later when the first were full), and only while they are still the owner's, signed in and not removed.
        const record = loadJobAccounts(deps.db, ctx.jobId);
        const ticked = new Set<unknown>([...(Array.isArray(params?.accountIds) ? params.accountIds : []), ...(record?.moreIds ?? [])]);
        if (ticked.size === 0) throw new JobFailure('No Google account was ticked. Nothing was sent. Start the copy again and tick the accounts.');
        const accounts = this.accountsFor(src.personId).filter((a) => ticked.has(a.placeId));
        if (accounts.length === 0) throw new JobFailure('None of the ticked Google accounts can be used now (signed out, removed or not this person\'s). Nothing was sent.');
        const later = (): { placeId: string; label: string }[] => {
          const more = new Set(loadJobAccounts(deps.db, ctx.jobId)?.moreIds ?? []);
          return this.accountsFor(src.personId).filter((a) => more.has(a.placeId));
        };
        const jobId = ctx.jobId;
        const runner = new GoogleCopyRun(
          { ...deps, laterAccounts: later, sentLive: (lines) => void this.liveSent.set(jobId, lines), sentSaved: (lines) => saveSent(deps.db, jobId, lines) },
          ctx,
          src,
          kinds,
          accounts,
          (ctx.resume as Partial<GoogleCopyCheckpoint> | null) ?? emptyCheckpoint(),
          { onlyOnPhone: src.isPhone && params?.onlyOnPhone === true, fitBiggest: params?.fitBiggest === true },
        );
        let report: GoogleCopyReport;
        try {
          report = await runner.execute();
        } catch (err) {
          saveReport(deps.db, ctx.jobId, runner.partialReport());
          throw err;
        }
        saveReport(deps.db, ctx.jobId, report);
        const held = report.heldBack.reduce((s, r) => s + r.count, 0);
        const failed = report.failed.reduce((s, r) => s + r.count, 0);
        const line = `Sent ${report.copied.files.toLocaleString('en-US')} files (${googleBytes(report.copied.bytes)}) to Google, each checked against Google's own checksum${report.alreadyThere > 0 ? `; ${report.alreadyThere.toLocaleString('en-US')} were already there` : ''}${held > 0 ? `; ${held.toLocaleString('en-US')} held back` : ''}${failed > 0 ? `; ${failed.toLocaleString('en-US')} not sent` : ''}${report.noRoom.files > 0 ? `; ${report.noRoom.files.toLocaleString('en-US')} had no room (keeping 25% free)` : ''}`;
        if (report.copied.files === 0 && report.alreadyThere === 0 && held + failed > 0) throw new JobFailure(`${line}. See the report.`);
        return `${line}. Nothing in Google was deleted or changed.`;
      },
    };
    return [
      Object.assign({}, copy, {
        run: async (ctx: Parameters<JobHandler['run']>[0]) => {
          try {
            return await copy.run(ctx);
          } finally {
            this.liveSent.delete(ctx.jobId);
            this.countsChanged();
          }
        },
      }),
    ];
  }
}
