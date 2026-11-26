/**
 * Free up phone space: the one place the window reaches it. A check is a job (`freeup.check`); its result stays in memory here, the window
 * only ever sees counts and pages of names. A removal starts only for a result main made itself, fresh, with the hash and the exact count
 * and size the person confirmed; the window never sends a path to remove. Keep rules (Keep on the phone) are applied to the held results
 * at once and again by the removal job for every file.
 */
import { formatGb } from '../../shared/cloudCopy';
import type { CleanStartResult } from '../../shared/cleanup';
import {
  FREEUP_CHECK_JOB_KIND,
  FREEUP_MAX_REMOVE,
  FREEUP_PAGE,
  FREEUP_REMOVE_JOB_KIND,
  FREEUP_RESULT_LIFETIME_MS,
  freeLine,
  isFreeUpGroup,
  isFreeUpMode,
  type FreeUpFilesRequest,
  type FreeUpFilesResult,
  type FreeUpKeepRequest,
  type FreeUpKeepResult,
  type FreeUpOverviewResult,
  type FreeUpPrepareRequest,
  type FreeUpPrepareResult,
  type FreeUpRemoveJobParams,
  type FreeUpResultResult,
  type FreeUpShowCopyRequest,
  type FreeUpStartResult,
  type FreeUpTickResult,
  type FreeUpGroupId,
  type FreeUpRemoved,
  FREEUP_MAX_PUT_BACK,
  FREEUP_REMOVED_PAGE,
  type FreeUpRemovedIdsResult,
  type FreeUpRemovedPageResult,
} from '../../shared/freeUp';
import type { JobRecord } from '../../shared/jobs';
import { CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND } from '../../shared/cleanup';
import type { Db } from '../db/connection';
import { hashConfirmed } from '../danger';
import fs from 'node:fs';
import { driveFilePath, type BaseOf } from '../cleanup/diskAccess';
import { freeUpConfirmed, freeUpListHash } from './freeUpRemove';
import { groupViews, loadBackupContext, type FreeUpResults, type StoredCheck } from './freeUpCheck';
import { KeepStore } from './keepStore';
import { scanRemoved } from './removedList';
import { finishSliced } from '../sliceWork';

export interface FreeUpJobs {
  create(kind: string, title: string, params: unknown, startedBy?: string | null): number;
  list(filter: { states: JobRecord['state'][] }): JobRecord[];
}

export interface FreeUpServiceDeps {
  db: Db;
  jobs: FreeUpJobs;
  results: FreeUpResults;
  /** Where a drive is mounted now (for "Show in folder"). */
  baseOf?: BaseOf;
  /** Starts "Put back" (the clean-up service's job: copies removed files back from the first drive, checked on the phone). */
  putBack: (request: unknown) => CleanStartResult;
  now?: () => number;
  log?: { info(...args: unknown[]): void };
}

const BUSY_KINDS = new Set<string>(['phone.look', 'phone.backup', 'phone.checkOld', CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND, FREEUP_CHECK_JOB_KIND, FREEUP_REMOVE_JOB_KIND]);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Takes the files a keep rule names out of a held check and moves their size to "locked". */
export function applyKeepToCheck(check: StoredCheck, kept: (path: string) => boolean): void {
  const dropReady = check.ready.filter((r) => kept(r.path));
  for (const r of dropReady) check.unticked.delete(r.path);
  const dropNot = check.notReady.filter((r) => kept(r.path));
  if (dropReady.length === 0 && dropNot.length === 0) return;
  check.ready = check.ready.filter((r) => !kept(r.path));
  check.notReady = check.notReady.filter((r) => !kept(r.path));
  const v = check.view;
  v.locked.keepFiles += dropReady.length + dropNot.length;
  v.locked.keepBytes += [...dropReady, ...dropNot].reduce((n, r) => n + r.size, 0);
  if (v.blocked.length === 0) {
    v.groups = groupViews(check.ready, check.unticked);
    v.readyFiles = check.ready.length;
    v.readyBytes = check.ready.reduce((n, r) => n + r.size, 0);
  }
  v.notReady.files -= dropNot.length;
  v.notReady.bytes -= dropNot.reduce((n, r) => n + r.size, 0);
  for (const r of dropNot) for (const m of r.missing) {
    const reason = v.notReady.reasons.find((x) => x.what === m);
    if (reason) reason.files -= 1;
  }
  v.notReady.reasons = v.notReady.reasons.filter((x) => x.files > 0);
}

/** Takes the files handed to a removal out of a held check and works out its groups and totals again. */
export function dropReadyFromCheck(check: StoredCheck, paths: ReadonlySet<string>): void {
  check.ready = check.ready.filter((r) => !paths.has(r.path));
  for (const p of paths) check.unticked.delete(p);
  const v = check.view;
  v.groups = groupViews(check.ready, check.unticked);
  v.readyFiles = check.ready.length;
  v.readyBytes = check.ready.reduce((n, r) => n + r.size, 0);
}

export class FreeUpService {
  private readonly now: () => number;
  private readonly keepStore: KeepStore;
  /** Each held check's ready files by group, biggest first (see groupRows). */
  private readonly sortedGroups = new WeakMap<StoredCheck, { ready: StoredCheck['ready']; byGroup: Map<FreeUpGroupId, StoredCheck['ready']> }>();

  constructor(private readonly deps: FreeUpServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.keepStore = new KeepStore(deps.db, this.now);
  }

  private busy(): boolean {
    return this.deps.jobs.list({ states: ['queued', 'running', 'needs_you'] }).some((j) => BUSY_KINDS.has(j.kind));
  }

  private fresh(check: StoredCheck): boolean {
    return this.now() - check.at <= FREEUP_RESULT_LIFETIME_MS;
  }

  async overview(backupId: unknown): Promise<FreeUpOverviewResult> {
    if (!isId(backupId)) return { ok: false, message: 'Choose a backup first.' };
    const bk = loadBackupContext(this.deps.db, backupId);
    if (!bk) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    const latest = this.deps.results.latestFor(backupId);
    const scan = await finishSliced(scanRemoved(this.deps.db, bk.first));
    return { ok: true, backupId, backupName: bk.name, serial: bk.serial, checkId: latest && this.fresh(latest) ? latest.checkId : null, keep: this.keepStore.list(backupId), removedTotal: { files: scan.ids.length, bytes: scan.totalBytes } };
  }

  /** One page of the files removed from this phone and not put back (newest first), with when each was taken where the phone's file row still knows it. */
  async removedPage(request: unknown): Promise<FreeUpRemovedPageResult> {
    if (!isObject(request) || !isId(request['backupId']) || typeof request['offset'] !== 'number' || !Number.isInteger(request['offset']) || request['offset'] < 0 || typeof request['limit'] !== 'number' || !Number.isInteger(request['limit']) || request['limit'] < 1) return { ok: false, message: 'Something went wrong.' };
    const bk = loadBackupContext(this.deps.db, request['backupId']);
    if (!bk) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    const offset = request['offset'];
    const limit = Math.min(request['limit'], FREEUP_REMOVED_PAGE);
    const scan = await finishSliced(scanRemoved(this.deps.db, bk.first));
    const ids = scan.ids.slice(offset, offset + limit);
    const found = ids.length === 0 ? [] : (this.deps.db.prepare(`SELECT id, path, size, removed_at AS removedAt FROM removal_log WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`).all(...ids) as Omit<FreeUpRemoved, 'takenSec'>[]);
    // The phone's own row of the file keeps its date (the row stays, marked gone); one lookup by (place, path) per row of the page.
    const taken = this.deps.db.prepare('SELECT mtime FROM files WHERE place_id = ? AND rel_path IN (?, ?) AND mtime IS NOT NULL ORDER BY (rel_path = ?) DESC LIMIT 1').pluck();
    const place = bk.phonePlaceId;
    return {
      ok: true,
      total: scan.ids.length,
      totalBytes: scan.totalBytes,
      offset,
      rows: found.map((r) => {
        const mtime = place ? (taken.get(place, r.path, r.path.replace(/^\//, ''), r.path) as number | undefined) : undefined;
        return { id: r.id, path: r.path, size: r.size, removedAt: r.removedAt, takenSec: typeof mtime === 'number' && mtime > 0 ? Math.floor(mtime / 1000) : 0 };
      }),
    };
  }

  /** Every removed file not put back, as ids and sizes (newest first), for "Tick all". */
  async removedIds(request: unknown): Promise<FreeUpRemovedIdsResult> {
    if (!isObject(request) || !isId(request['backupId'])) return { ok: false, message: 'Something went wrong.' };
    const bk = loadBackupContext(this.deps.db, request['backupId']);
    if (!bk) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    const scan = await finishSliced(scanRemoved(this.deps.db, bk.first));
    return { ok: true, total: scan.ids.length, totalBytes: scan.totalBytes, ids: scan.ids.slice(0, FREEUP_MAX_PUT_BACK), sizes: scan.sizes.slice(0, FREEUP_MAX_PUT_BACK) };
  }

  /** Quick unless the window says full. */
  startCheck(backupId: unknown, mode?: unknown): CleanStartResult {
    if (!isId(backupId)) return { ok: false, message: 'Choose a backup first.' };
    const bk = loadBackupContext(this.deps.db, backupId);
    if (!bk) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    if (this.busy()) return { ok: false, message: 'The phone is busy with another job. Watch it in Activity and try again.' };
    const how = isFreeUpMode(mode) ? mode : 'quick';
    const jobId = this.deps.jobs.create(FREEUP_CHECK_JOB_KIND, `Check what can leave ${bk.name} (${how === 'full' ? 'full' : 'quick'})`, { backupId, mode: how }, 'Started by you: Free up phone space');
    this.deps.log?.info(`freeUp: ${how} check job ${jobId} for backup ${backupId}`);
    return { ok: true, jobId };
  }

  result(checkId: unknown): FreeUpResultResult {
    const check = isId(checkId) ? this.deps.results.get(checkId) : null;
    if (!check) return { ok: false, message: 'That check is not kept any more. Check again.' };
    return { ok: true, result: check.view };
  }

  files(request: unknown): FreeUpFilesResult {
    if (!isObject(request) || !isId(request['checkId']) || typeof request['offset'] !== 'number' || !Number.isInteger(request['offset']) || request['offset'] < 0) return { ok: false, message: 'Something went wrong.' };
    const check = this.deps.results.get(request['checkId']);
    if (!check) return { ok: false, message: 'That check is not kept any more. Check again.' };
    const req = request as unknown as FreeUpFilesRequest;
    if (req.list === 'notReady') {
      const page = check.notReady.slice(req.offset, req.offset + FREEUP_PAGE);
      return { ok: true, total: check.view.notReady.files, offset: req.offset, rows: page.map((r) => ({ path: r.path, name: r.name, folder: r.folder, size: r.size, mtimeSec: r.mtimeSec, missing: r.missing, hasCopy: r.t7 !== null })) };
    }
    if (!isFreeUpGroup(req.list)) return { ok: false, message: 'Something went wrong.' };
    const rows = this.groupRows(check, req.list);
    return { ok: true, total: rows.length, offset: req.offset, rows: rows.slice(req.offset, req.offset + FREEUP_PAGE).map((r) => ({ path: r.path, name: r.name, folder: r.folder, size: r.size, mtimeSec: r.mtimeSec, missing: [], hasCopy: true, ticked: !check.unticked.has(r.path) })) };
  }

  /** Every file of a group, biggest first (kept sorted while the check's ready list does not change: a page asks for it again and again). */
  private groupRows(check: StoredCheck, group: FreeUpGroupId): StoredCheck['ready'] {
    let held = this.sortedGroups.get(check);
    if (held === undefined || held.ready !== check.ready) {
      held = { ready: check.ready, byGroup: new Map() };
      this.sortedGroups.set(check, held);
    }
    let rows = held.byGroup.get(group);
    if (rows === undefined) {
      rows = check.ready.filter((r) => r.group === group).toSorted((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      held.byGroup.set(group, rows);
    }
    return rows;
  }

  /**
   * Ticks or unticks files of one group: "stays this time" (not "Keep on the phone", which is never offered). Only paths of the group's ready files count.
   * The group lines of the result and the confirm step follow at once; the removal takes only ticked files.
   */
  tick(request: unknown): FreeUpTickResult {
    if (!isObject(request) || !isId(request['checkId']) || !isFreeUpGroup(request['list']) || typeof request['ticked'] !== 'boolean') return { ok: false, message: 'Something went wrong. Nothing was changed.' };
    const check = this.deps.results.get(request['checkId']);
    if (!check) return { ok: false, message: 'That check is not kept any more. Check again.' };
    const group = request['list'];
    const ticked = request['ticked'];
    const rows = this.groupRows(check, group);
    if (request['all'] === true) {
      for (const r of rows) {
        if (ticked) check.unticked.delete(r.path);
        else check.unticked.add(r.path);
      }
    } else {
      const paths = request['paths'];
      if (!Array.isArray(paths) || paths.length > FREEUP_PAGE || !paths.every((p) => typeof p === 'string')) return { ok: false, message: 'Something went wrong. Nothing was changed.' };
      const inGroup = new Set(rows.map((r) => r.path));
      for (const p of paths as string[]) {
        if (!inGroup.has(p)) continue;
        if (ticked) check.unticked.delete(p);
        else check.unticked.add(p);
      }
    }
    check.view.groups = groupViews(check.ready, check.unticked);
    const g = check.view.groups.find((x) => x.id === group);
    return { ok: true, files: g?.files ?? 0, bytes: g?.bytes ?? 0, leftOut: g?.leftOutFiles ?? 0 };
  }

  /** The first drive's copy of one file of a held check, as a path on this computer, for "Show in folder". One lookup, no scan. */
  async copyPath(request: unknown): Promise<{ ok: true; abs: string } | { ok: false; message: string }> {
    if (!isObject(request) || !isId(request['checkId']) || typeof request['path'] !== 'string') return { ok: false, message: 'Something went wrong.' };
    const req = request as unknown as FreeUpShowCopyRequest;
    const check = this.deps.results.get(req.checkId);
    if (!check) return { ok: false, message: 'That check is not kept any more. Check again.' };
    const ready = check.ready.find((r) => r.path === req.path);
    const v = ready?.remove.vouchers.find((x) => x.placeKind === 'drive');
    const ref = v ? { placeId: v.placeId, relPath: v.relPath, label: v.placeLabel } : (() => {
      const n = check.notReady.find((r) => r.path === req.path);
      return n?.t7 ? { ...n.t7, label: loadBackupContext(this.deps.db, check.backupId)?.first?.label ?? 'The first drive' } : null;
    })();
    if (!ref) return { ok: false, message: 'There is no copy on the first drive to show.' };
    if (!this.deps.baseOf) return { ok: false, message: 'The drives cannot be reached right now.' };
    const abs = await driveFilePath(this.deps.db, this.deps.baseOf, ref.placeId, ref.relPath);
    if (abs === null) return { ok: false, message: `${ref.label} is not plugged in.` };
    try {
      await fs.promises.stat(abs);
    } catch {
      return { ok: false, message: `The copy is not on ${ref.label} any more.` };
    }
    return { ok: true, abs };
  }

  /** The files of the ticked groups, as the removal would take them (a Keep rule saved since the check leaves a file out). */
  private selection(check: StoredCheck, groups: readonly FreeUpGroupId[]): StoredCheck['ready'] {
    const kept = this.keepStore.matcher(check.backupId);
    return check.ready.filter((r) => groups.includes(r.group) && !kept(r.path) && !check.unticked.has(r.path));
  }

  prepare(request: unknown): FreeUpPrepareResult {
    if (!isObject(request) || !isId(request['checkId']) || !Array.isArray(request['groups']) || !request['groups'].every(isFreeUpGroup)) return { ok: false, message: 'Something went wrong. Nothing was removed.' };
    const check = this.deps.results.get(request['checkId']);
    if (!check) return { ok: false, message: 'That check is not kept any more. Check again. Nothing was removed.' };
    if (check.view.blocked.length > 0) return { ok: false, message: 'Nothing can be offered until what is missing is fixed. Check again then.' };
    const req = request as unknown as FreeUpPrepareRequest;
    const rows = this.selection(check, req.groups);
    if (rows.length === 0) return { ok: false, message: 'Tick at least one group first.' };
    if (rows.length > FREEUP_MAX_REMOVE) return { ok: false, message: `That is more than ${FREEUP_MAX_REMOVE.toLocaleString('en-US')} files at once. Tick fewer groups.` };
    const groups = groupViews(rows);
    return { ok: true, prepare: { checkId: check.checkId, groups, files: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0), places: check.view.places, hash: freeUpListHash(rows) } };
  }

  start(request: unknown): FreeUpStartResult {
    if (!isObject(request)) return { ok: false, message: 'Something went wrong. Nothing was removed.' };
    if (request['confirmed'] !== true) return { ok: false, message: 'Confirm the removal first. Nothing was removed.' };
    const prepared = this.prepare({ checkId: request['checkId'], groups: request['groups'] });
    if (!prepared.ok) return prepared;
    const check = this.deps.results.get(request['checkId'] as number)!;
    if (!this.fresh(check)) {
      this.deps.results.delete(check.checkId);
      return { ok: false, message: 'That check is more than 30 minutes old and the phone may have changed. Check again. Nothing was removed.' };
    }
    const p = prepared.prepare;
    if (request['hash'] !== p.hash) return { ok: false, message: 'The list on screen is not the list Backup Hub made. Check again. Nothing was removed.' };
    if (request['expectFiles'] !== p.files || request['expectBytes'] !== p.bytes) return { ok: false, message: `The list changed: it is now ${freeLine(p.files, p.bytes)}. Look at it again. Nothing was removed.` };
    if (this.busy()) return { ok: false, message: 'The phone is busy with another job. Watch it in Activity and try again. Nothing was removed.' };
    const rows = this.selection(check, request['groups'] as FreeUpGroupId[]);
    const files = rows.map((r) => r.remove);
    const removeMode = isFreeUpMode(request['removeMode']) ? request['removeMode'] : 'full';
    const listId = `freeup-${check.checkId}-${this.now()}`;
    const params: FreeUpRemoveJobParams = { backupId: check.backupId, serial: check.serial, model: check.model, listId, listHash: hashConfirmed(freeUpConfirmed(check.serial, files)), count: p.files, bytes: p.bytes, removeMode };
    this.deps.results.holdRemoval(listId, files);
    // The check stays (the rest of its list is still offered while it is fresh); the files handed to the removal leave it. The removal
    // re-checks every one of its files itself, and a later start re-checks the rest the same way.
    dropReadyFromCheck(check, new Set(rows.map((r) => r.path)));
    const jobId = this.deps.jobs.create(FREEUP_REMOVE_JOB_KIND, `Free up space on ${check.view.phoneName} (${p.files.toLocaleString('en-US')} files, ${formatGb(p.bytes)}${removeMode === 'quick' ? ', checked quickly' : ''})`, params, 'Started by you: Free up phone space');
    this.deps.log?.info(`freeUp: ${removeMode} removal job ${jobId} for check ${check.checkId}: ${p.files} files`);
    return { ok: true, jobId };
  }

  keep(request: unknown): FreeUpKeepResult {
    if (!isObject(request) || !isId(request['backupId']) || (request['scope'] !== 'file' && request['scope'] !== 'folder') || typeof request['path'] !== 'string') return { ok: false, message: 'Something went wrong. Nothing was changed.' };
    const req = request as unknown as FreeUpKeepRequest;
    if (!loadBackupContext(this.deps.db, req.backupId)) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    if (!this.keepStore.add(req.backupId, req.scope, req.path)) return { ok: false, message: 'That is not a place on the phone. Nothing was changed.' };
    const kept = this.keepStore.matcher(req.backupId);
    for (const check of this.deps.results.forBackup(req.backupId)) applyKeepToCheck(check, kept);
    return { ok: true, keep: this.keepStore.list(req.backupId) };
  }

  unkeep(request: unknown): FreeUpKeepResult {
    if (!isObject(request) || !isId(request['backupId']) || !isId(request['id'])) return { ok: false, message: 'Something went wrong. Nothing was changed.' };
    this.keepStore.remove(request['backupId'], request['id']);
    return { ok: true, keep: this.keepStore.list(request['backupId']) };
  }

  putBack(request: unknown): CleanStartResult {
    if (!isObject(request) || request['confirmed'] !== true || !isId(request['backupId']) || !Array.isArray(request['removalIds'])) return { ok: false, message: 'Confirm first. Nothing was changed.' };
    const bk = loadBackupContext(this.deps.db, request['backupId']);
    if (!bk) return { ok: false, message: 'Free up phone space is only for a phone backup.' };
    return this.deps.putBack({ confirmed: true, serial: bk.serial, removalIds: request['removalIds'] });
  }
}
