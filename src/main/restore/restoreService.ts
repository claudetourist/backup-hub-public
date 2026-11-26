/**
 * "Get files back": looks at a backup's copies in the index (sliced, read only), makes the list for the preview, and starts the restore job for a list main made
 * itself (found again by id, and confirmed). The window never sends a file list or a path it made up: only what to pick, and a folder main handed out.
 */
import os from 'node:os';
import path from 'node:path';
import { rawFs as fs } from '../rawFs';
import type { Db } from '../db';
import { sessionDate } from '../backupProfiles/history';
import { finishSliced, STEP_ITEMS, turn, type Steps } from '../sliceWork';
import {
  RESTORE_JOB_KIND,
  RESTORE_PLAN_LIFETIME_MS,
  RESTORE_TITLE,
  RESTORE_FOLDER,
  type RestoreBrowseRequest,
  type RestoreBrowseResult,
  type RestoreChooseFolderResult,
  type RestoreDatesResult,
  type RestoreInfoResult,
  type RestorePlanRequest,
  type RestorePlanResult,
  type RestorePlanView,
  type RestoreSourceView,
  type RestoreStartResult,
} from '../../shared/restore';
import { browseSteps, copiesOf, listDatesSteps, loadBackup, rankPlaces, type BackupDest, type BackupInfo, type RestoreItem } from './restoreIndex';
import { expandPick, type RestoreJobParams } from './restoreJob';
import { bytesText, filesText, heldReason, heldText, knownSha, NO_COPY_WORDS, preferredSources, protectedReason, restoreFolderName, safeParts } from './restoreModel';

export interface RestoreJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
}

export interface RestoreServiceDeps {
  db: Db;
  jobs: RestoreJobs;
  /** The named drives that are plugged in right now. */
  drives(): Promise<{ placeId: string; label: string; root: string }[]>;
  /** The folder a restore goes into unless the person chooses another (D:\Restored when there is a D: drive). */
  defaultParent(): Promise<string>;
  freeBytes(dir: string): Promise<number | null>;
  now?: () => number;
  pause?: () => Promise<void>;
  log?: { info(...args: unknown[]): void };
}

interface StoredPlan {
  id: string;
  params: RestoreJobParams;
  expires: number;
}

const KEEP_PLANS = 5;
const MAX_ITEMS = 500;
const MAX_FILE_IDS = 5000;
const MAX_EXAMPLES = 5;
const key = (p: string): string => path.resolve(p).toLowerCase();

export function planWordsFrom(labels: readonly string[], fromGoogle = 0): string {
  const all = fromGoogle > 0 ? [...labels, 'Google'] : [...labels];
  return all.length === 0 ? 'a drive' : all.length === 1 ? all[0]! : all.slice(0, -1).join(', ') + ' and ' + all[all.length - 1]!;
}

export class RestoreService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly handedOut = new Set<string>();
  private counter = 0;
  private readonly now: () => number;
  private readonly pause: () => Promise<void>;

  constructor(private readonly deps: RestoreServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.pause = deps.pause ?? turn;
  }

  private async connected(backup: BackupInfo): Promise<{ all: RestoreSourceView[]; ready: { placeId: string; label: string; position: number }[] }> {
    const plugged = new Map((await this.deps.drives()).map((d) => [d.placeId, d] as const));
    const all = backup.destinations.map((d) => ({ placeId: d.placeId, label: d.label, connected: plugged.has(d.placeId) }));
    const ready = preferredSources(backup.destinations.filter((d) => plugged.has(d.placeId)).map((d) => ({ placeId: d.placeId, label: d.label, position: d.position })));
    return { all, ready };
  }

  /** Without a drive there is nothing to look at; with one that is not plugged in, the index still knows its files (and Google may have copies). */
  private noDriveMessage(backup: BackupInfo): string {
    return backup.destinations.length === 0 ? 'This backup has no drive yet, so there is nothing to get back.' : 'No drive of this backup is plugged in. Files that are also in Google can still come back.';
  }

  /** The drive whose index rows name the files: the first plugged-in one, else the backup's first drive (the T7 first). */
  private listPlace(backup: BackupInfo, ready: readonly { placeId: string }[]): BackupDest | null {
    const wanted = ready[0]?.placeId;
    return backup.destinations.find((d) => d.placeId === wanted) ?? preferredSources(backup.destinations)[0] ?? null;
  }

  async info(backupId: unknown): Promise<RestoreInfoResult> {
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.' };
    const backup = loadBackup(this.deps.db, backupId);
    if (!backup) return { ok: false, message: 'This backup is not on the list.' };
    const { all, ready } = await this.connected(backup);
    const from = ready[0] ? (all.find((s) => s.placeId === ready[0]!.placeId) ?? null) : null;
    return {
      ok: true,
      backupName: backup.name,
      layout: backup.flat ? 'flat' : 'dated',
      sources: all,
      from,
      originalWords: backup.kind === 'folder' && !backup.flat && /^[A-Za-z]:/.test(backup.sourceRoot) ? backup.sourceRoot : null,
      defaultParent: await this.deps.defaultParent(),
      message: from === null ? this.noDriveMessage(backup) : null,
    };
  }

  async dates(backupId: unknown): Promise<RestoreDatesResult> {
    if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.' };
    const backup = loadBackup(this.deps.db, backupId);
    if (!backup) return { ok: false, message: 'This backup is not on the list.' };
    if (backup.flat) return { ok: true, dates: [] };
    const { ready } = await this.connected(backup);
    const dest = this.listPlace(backup, ready);
    if (!dest) return { ok: false, message: this.noDriveMessage(backup) };
    const dates = await finishSliced(listDatesSteps(this.deps.db, { placeId: dest.placeId, root: dest.root, prefix: backup.prefix }), this.pause);
    return { ok: true, dates };
  }

  async browse(request: unknown): Promise<RestoreBrowseResult> {
    const r = request as Partial<RestoreBrowseRequest> | null;
    if (!r || typeof r.backupId !== 'number' || typeof r.path !== 'string' || (r.folder !== null && typeof r.folder !== 'string')) return { ok: false, message: 'That is not a folder of this backup.' };
    const backup = loadBackup(this.deps.db, r.backupId);
    if (!backup) return { ok: false, message: 'This backup is not on the list.' };
    if (r.path !== '' && safeParts(r.path) === null) return { ok: false, message: 'That is not a folder of this backup.' };
    if (backup.flat ? r.folder !== null : r.folder === null || r.folder.includes('/') || sessionDate(backup.prefix, r.folder) === null) return { ok: false, message: 'That day is not in this backup.' };
    const { ready } = await this.connected(backup);
    const dest = this.listPlace(backup, ready);
    if (!dest) return { ok: false, message: this.noDriveMessage(backup) };
    const out = await finishSliced(browseSteps(this.deps.db, { placeId: dest.placeId, root: dest.root, folder: r.folder, path: r.path }), this.pause);
    return { ok: true, entries: out.entries, moreFiles: out.moreFiles };
  }

  /** "Choose another folder": the picker is in main (it passes what the person picked here); only a folder handed out here can be a destination. */
  chooseFolder(folder: string | null): RestoreChooseFolderResult {
    if (folder === null) return { ok: false, canceled: true, message: 'No folder was chosen.' };
    const refused = protectedReason(folder);
    if (refused !== null) return { ok: false, canceled: false, message: refused };
    this.handedOut.add(key(folder));
    return { ok: true, parent: path.resolve(folder) };
  }

  private async nearestFolder(dir: string): Promise<string | null> {
    let at = path.resolve(dir);
    for (let i = 0; i < 12; i += 1) {
      try {
        if ((await fs.promises.stat(at)).isDirectory()) return at;
      } catch {
        // one level up
      }
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
    return null;
  }

  async plan(request: unknown): Promise<RestorePlanResult> {
    const bad = (): RestorePlanResult => ({ ok: false, message: 'Something went wrong. Nothing was copied.' });
    const r = request as Partial<RestorePlanRequest> | null;
    if (!r || !r.pick || !r.destination || (r.destination.mode !== 'new' && r.destination.mode !== 'original')) return bad();
    const { pick, destination } = r as RestorePlanRequest;
    const { db } = this.deps;

    // What is picked, and which drives are plugged in (best first). A drive that is not plugged in still has its files in the index, and Google may have copies.
    let backup: BackupInfo | null = null;
    let preferred: { placeId: string; label: string; position: number }[] = [];
    let listPlaceId: string | undefined;
    let rank: string[] | undefined;
    if (pick.kind === 'files') {
      if (!Array.isArray(pick.fileIds) || pick.fileIds.length === 0 || pick.fileIds.length > MAX_FILE_IDS || !pick.fileIds.every((n) => Number.isInteger(n) && n > 0)) return bad();
      preferred = preferredSources((await this.deps.drives()).map((d, i) => ({ placeId: d.placeId, label: d.label, position: i + 1 })));
      rank = rankPlaces(db, preferred.map((p) => p.placeId));
    } else {
      if (typeof pick.backupId !== 'number') return bad();
      backup = loadBackup(db, pick.backupId);
      if (!backup) return { ok: false, message: 'This backup is not on the list.' };
      preferred = (await this.connected(backup)).ready;
      const list = this.listPlace(backup, preferred);
      if (!list) return { ok: false, message: this.noDriveMessage(backup) };
      listPlaceId = list.placeId;
      if (pick.kind === 'date') {
        if (!Array.isArray(pick.items) || pick.items.length > MAX_ITEMS || !pick.items.every((s) => typeof s === 'string' && s.length < 1000)) return bad();
        if (backup.flat ? pick.folder !== null : pick.folder === null || typeof pick.folder !== 'string') return { ok: false, message: 'Choose a day first.' };
      }
      if (destination.mode === 'original' && !(backup.kind === 'folder' && !backup.flat && /^[A-Za-z]:/.test(backup.sourceRoot))) return { ok: false, message: 'This backup cannot be put back where it was. Choose a new folder.' };
    }

    // Where it goes.
    const parent = destination.parent ?? (await this.deps.defaultParent());
    if (destination.mode === 'new') {
      if (destination.parent !== undefined && key(destination.parent) !== key(await this.deps.defaultParent()) && !this.handedOut.has(key(destination.parent))) return { ok: false, message: 'Choose the folder with the "Choose another folder" button.' };
      const refused = protectedReason(parent);
      if (refused !== null) return { ok: false, message: refused };
    }

    const params: RestoreJobParams = {
      backupIds: backup ? [backup.id] : [],
      pick,
      preferPlaces: preferred.map((p) => p.placeId),
      destination: { mode: destination.mode, parent: path.resolve(parent), folderName: '' },
    };
    if (listPlaceId !== undefined) params.listPlaceId = listPlaceId;
    if (rank !== undefined) params.rankPlaces = rank;
    if (backup) params.backupId = backup.id;
    const expanded = await expandPick({ db }, params, this.pause);
    if (expanded.items.length === 0) return { ok: false, message: expanded.notAvailable > 0 ? 'These files are not in a backup on a drive.' : 'There is nothing to bring back from this pick.' };
    if (pick.kind === 'files') {
      const ids = [...new Set(expanded.items.map((i) => i.backupId))];
      params.backupIds = ids;
      if (ids.length === 1) params.backupId = ids[0]!;
    }
    params.destination.folderName = restoreFolderName(expanded.backupNames.length === 1 ? expanded.backupNames[0]! : 'Files from Backup Hub', this.now());

    const view = await finishSliced(this.summarySteps(expanded.items, destination.mode, preferred.map((p) => p.placeId)), this.pause);
    const where = destination.mode === 'new' ? path.join(path.resolve(parent), params.destination.folderName) : 'Back to where they were';
    const spot = destination.mode === 'new' ? await this.nearestFolder(parent) : null;
    const free = spot === null ? null : await this.deps.freeBytes(spot);
    const id = `restore-${this.now().toString(36)}-${(this.counter += 1)}`;
    const plan: RestorePlanView = {
      planId: id,
      files: view.files,
      bytes: view.bytes,
      fromWords: planWordsFrom(preferred.map((p) => p.label), view.fromGoogle),
      fromGoogle: view.fromGoogle,
      toWords: where,
      held: { count: view.heldCount, examples: view.examples },
      notAvailable: expanded.notAvailable + view.unreachable,
      freeBytes: free,
    };
    if (view.files === 0) return { ok: false, message: `None of these ${filesText(view.heldCount + view.unreachable)} can be brought back now. ${view.examples[0] ? view.examples[0].why : NO_COPY_WORDS}`.trim() };
    this.plans.set(id, { id, params, expires: this.now() + RESTORE_PLAN_LIFETIME_MS });
    while (this.plans.size > KEEP_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    this.deps.log?.info(`restore: plan ${id}: ${view.files} files (${bytesText(view.bytes)}), ${view.fromGoogle} from Google, ${view.heldCount} held back, ${view.unreachable} with no copy to reach, to ${where}`);
    return { ok: true, plan };
  }

  /** What would come back and what would not (a generator: 100,000 files are never one plain loop). A file comes back when a plugged-in drive or a Google copy has it. */
  private *summarySteps(items: readonly RestoreItem[], mode: 'new' | 'original', plugged: readonly string[]): Steps<{ files: number; bytes: number; heldCount: number; fromGoogle: number; unreachable: number; examples: { path: string; why: string }[] }> {
    const { db } = this.deps;
    const pluggedSet = new Set(plugged);
    const backups = new Map<number, BackupInfo | null>();
    let files = 0;
    let bytes = 0;
    let heldCount = 0;
    let fromGoogle = 0;
    let unreachable = 0;
    const examples: { path: string; why: string }[] = [];
    let n = 0;
    for (const item of items) {
      if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
      const why = heldReason({ size: item.size, sha256: item.sha256, expected: item.expected, verifiedHow: item.verifiedHow });
      const text = why !== null ? heldText(why) : mode === 'original' && item.original === null ? 'This file cannot be put back where it was.' : null;
      let google = false;
      if (text === null && !pluggedSet.has(item.placeId)) {
        // Its own drive is not plugged in: is there another plugged-in drive, or Google? (a few reads by place and path or by checksum)
        if (!backups.has(item.backupId)) backups.set(item.backupId, loadBackup(db, item.backupId));
        const backup = backups.get(item.backupId);
        const first = backup ? copiesOf(db, backup, item, plugged, knownSha(item)!)[0] : undefined;
        if (first === undefined) {
          unreachable += 1;
          if (examples.length < MAX_EXAMPLES) examples.push({ path: item.destRel, why: NO_COPY_WORDS });
          continue;
        }
        google = first.kind === 'google';
      }
      if (text === null) {
        files += 1;
        bytes += item.size;
        if (google) fromGoogle += 1;
      } else {
        heldCount += 1;
        if (examples.length < MAX_EXAMPLES) examples.push({ path: item.destRel, why: text });
      }
    }
    return { files, bytes, heldCount, fromGoogle, unreachable, examples };
  }

  /** Starts the job for a plan main made and the person confirmed. */
  start(request: unknown): RestoreStartResult {
    const r = request as { planId?: unknown; confirmed?: unknown } | null;
    if (!r || r.confirmed !== true) return { ok: false, message: 'Confirm first. Nothing was copied.' };
    if (typeof r.planId !== 'string') return { ok: false, message: 'Something went wrong. Nothing was copied.' };
    const plan = this.plans.get(r.planId);
    if (!plan) return { ok: false, message: 'That list is gone. Make the list again. Nothing was copied.' };
    if (this.now() > plan.expires) {
      this.plans.delete(plan.id);
      return { ok: false, message: 'That list is too old. Make it again. Nothing was copied.' };
    }
    this.plans.delete(plan.id);
    const jobId = this.deps.jobs.create(RESTORE_JOB_KIND, RESTORE_TITLE, plan.params, 'Started by you: Get files back');
    this.deps.log?.info(`restore: started job ${jobId} from plan ${plan.id}`);
    return { ok: true, jobId };
  }
}

/** D:\Restored when the laptop has a D: drive, else a folder of that name in the home folder. */
export async function defaultRestoreParent(exists: (dir: string) => Promise<boolean> = isFolder): Promise<string> {
  return (await exists('D:\\')) ? path.join('D:\\', RESTORE_FOLDER) : path.join(os.homedir(), RESTORE_FOLDER);
}

async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
