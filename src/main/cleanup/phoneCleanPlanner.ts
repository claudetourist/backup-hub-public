/**
 * The plan for "Free up phone space" (the phone and the catalog are only READ).
 * Phone backup rule (`judgeForDestinations`): a phone file is SAFE only when EVERY enabled place of the Phone backup holds a verified
 * copy of the same content. Without a `destinations` dep (tests of the old rule) it stays a copy on a named drive AND one in the cloud,
 * same SHA-256 (`judgePhoneFile`).
 * The phone's own fingerprint is asked with `sha256sum`, only for files whose size matches some drive file (a file with no
 * same-size drive copy cannot have the same SHA-256); fingerprints are remembered for the session so a second run goes on.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_PHONE_FOLDERS,
  type PhoneDevice,
} from '../../shared/phone';
import {
  MAX_PHONE_FINGERPRINTS,
  MAX_PHONE_PLAN_ROWS,
  plural,
  type Bucket,
  type PhoneCleanFile,
  type PhoneCleanPlan,
  type CleanDestination,
  type PhoneCleanPlanResult,
  type StalePlace,
} from '../../shared/cleanup';
import type { Db } from '../db/connection';
import type { AdbPort } from '../adb/adbPort';
import { cleanFolders, skipReason } from '../adb/phoneModel';
import { CleanStore } from './cleanStore';
import { FolderCopies } from './folderCopies';
import { isFresh, isRemovablePhonePath, judgeForDestinations, judgePhoneFile, monthOf, toVoucher, type FolderCopy, type Judgement } from './safety';

export interface PhoneCleanPlannerDeps {
  db: Db;
  adb: AdbPort;
  /** Where a named drive's folders are now, or null when it is not plugged in. */
  baseOf(placeId: string): Promise<string | null>;
  /** Size of a catalog file on disk (null when it is not there). Used for named-drive copies only. */
  diskSize(placeId: string, relPath: string): Promise<number | null>;
  now?: () => number;
  yieldNow?: () => Promise<void>;
  /** Fingerprints the phone gave earlier in this session (key: serial|path|size|mtime). */
  cache?: Map<string, string | null>;
  onProgress?: (done: number, total: number) => void;
  /** The enabled places of the Phone backup now. When given, the Phone backup rule applies (an empty list: nothing is safe). */
  destinations?: () => CleanDestination[];
  /** SHA-256 of laptop folder files remembered for the session. */
  folderHashes?: Map<string, string>;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function hashPhoneCleanPlan(plan: Pick<PhoneCleanPlan, 'serial' | 'files'>): string {
  const body = JSON.stringify({ s: plan.serial, f: plan.files.map((f) => [f.index, f.path, f.size, f.sha256, f.verdict, f.vouchers.map((v) => [v.placeId, v.relPath, v.size, v.sha256, v.md5, v.destinationId ?? null])]) });
  return createHash('sha256').update(body).digest('hex');
}

const emptyBucket = (): Bucket => ({ files: 0, bytes: 0 });
const add = (b: Bucket, size: number): void => {
  b.files += 1;
  b.bytes += size;
};

export async function buildPhoneCleanPlan(deps: PhoneCleanPlannerDeps, serial: string, folders?: readonly unknown[], signal?: AbortSignal): Promise<PhoneCleanPlanResult> {
  const { db, adb } = deps;
  const now = deps.now ?? Date.now;
  const tick = deps.yieldNow ?? defaultYield;
  const cache = deps.cache ?? new Map<string, string | null>();
  const store = new CleanStore(db, now);
  const dests = deps.destinations?.() ?? null;
  const folderCopyIndex = new FolderCopies(deps.folderHashes);

  if (!adb.available()) return { ok: false, message: 'adb.exe was not found on this computer, so the phone cannot be read. Nothing was changed.' };
  let device: PhoneDevice | undefined;
  try {
    device = (await adb.devices()).find((d) => d.serial === serial);
  } catch {
    return { ok: false, message: 'The phone could not be reached. Nothing was changed.' };
  }
  if (!device) return { ok: false, message: 'The phone is not connected. Plug it in with a cable and try again.' };
  if (device.state === 'unauthorized') return { ok: false, message: 'The phone is asking to allow this computer. Unlock it and tap Allow, then try again.' };
  if (device.state !== 'device') return { ok: false, message: `The phone is not ready (it says "${device.state}"). Unlock it and set the USB mode to File transfer.` };

  const wanted = cleanFolders(folders ?? DEFAULT_PHONE_FOLDERS);
  if (wanted.length === 0) return { ok: false, message: 'No phone folder is chosen.' };
  let listed;
  try {
    listed = await adb.listFiles(serial, wanted, signal);
  } catch {
    return { ok: false, message: 'The phone stopped answering while its files were being read. Nothing was changed.' };
  }
  if (listed.length === 0) return { ok: false, message: 'No files were found in the chosen phone folders. Is the phone unlocked and set to File transfer?' };

  const seen = new Set<string>();
  const wantedFiles = listed
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .filter((f) => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    })
    .filter((f) => f.size > 0 && isRemovablePhonePath(f.path) && skipReason(f.path) === null);

  // 1. Cheap filter: only files whose size some drive file has can possibly be backed up.
  const onlyOnPhone = emptyBucket();
  const candidates: { path: string; size: number; mtimeSec: number }[] = [];
  let probes = 0;
  for (const f of wantedFiles) {
    probes += 1;
    if (probes % 500 === 0) await tick();
    // A file no drive holds by size cannot be backed up there. A backup with only a laptop folder has no drive to ask.
    if (store.driveHasSize(f.size) || (dests !== null && dests.length > 0 && dests.every((d) => d.kind === 'laptop'))) candidates.push(f);
    else add(onlyOnPhone, f.size);
  }

  // 2. Fingerprint the candidates on the phone (remembered ones are free), a limited number per plan.
  const key = (f: { path: string; size: number; mtimeSec: number }): string => `${serial}|${f.path}|${f.size}|${f.mtimeSec}`;
  const todo = candidates.filter((f) => !cache.has(key(f)));
  const batch = todo.slice(0, MAX_PHONE_FINGERPRINTS);
  const total = batch.length;
  for (let i = 0; i < batch.length; i += 1) {
    const f = batch[i]!;
    deps.onProgress?.(i, total);
    if (signal?.aborted) return { ok: false, message: 'The plan was stopped. Nothing was changed.' };
    try {
      cache.set(key(f), await adb.sha256(serial, f.path, signal));
    } catch {
      return { ok: false, message: 'The phone stopped answering while its files were being checked. Nothing was changed.' };
    }
    if (i % 20 === 19) await tick();
  }
  deps.onProgress?.(total, total);
  const notFingerprinted = todo.length - batch.length;

  // 3. Judge each candidate.
  const placeInfo = new Map<string, { label: string; kind: string; last: number | null }>();
  const info = (placeId: string): { label: string; kind: string; last: number | null } => {
    let p = placeInfo.get(placeId);
    if (!p) {
      p = { label: store.placeLabel(placeId), kind: store.placeKind(placeId) ?? '', last: store.lastLooked(placeId) };
      placeInfo.set(placeId, p);
    }
    return p;
  };
  const plugged = new Map<string, boolean>();
  for (const p of db.prepare("SELECT id FROM places WHERE kind = 'drive'").all() as { id: string }[]) plugged.set(p.id, (await deps.baseOf(p.id)) !== null);
  const stalePlaces = new Map<string, StalePlace>();
  const safe = emptyBucket();
  const waiting = emptyBucket();
  const stale = emptyBucket();
  const unreadable = emptyBucket();
  const rows: Omit<PhoneCleanFile, 'index'>[] = [];
  let judged = 0;
  for (const f of candidates) {
    judged += 1;
    if (judged % 200 === 0) await tick();
    const k = key(f);
    if (!cache.has(k)) continue; // not fingerprinted yet: counted in notFingerprinted
    const sha = cache.get(k) ?? null;
    const slash = f.path.lastIndexOf('/');
    const base = { path: f.path, folder: f.path.slice(0, slash), month: monthOf(f.mtimeSec), name: f.path.slice(slash + 1), size: f.size, mtimeSec: f.mtimeSec, sha256: sha };
    if (sha === null) {
      add(unreadable, f.size);
      continue;
    }
    const pool = store.poolFor(sha, f.size);
    const ctx = {
      fresh: (placeId: string) => isFresh(info(placeId).last, now()),
      drivePluggedIn: (placeId: string) => plugged.get(placeId) === true,
    };
    let j: Judgement;
    if (dests === null) j = judgePhoneFile({ sha256: sha, size: f.size }, pool, ctx);
    else {
      const folderCopies = new Map<number, FolderCopy | null>();
      for (const d of dests) {
        if (d.kind !== 'laptop' || !d.folder) continue;
        const hit = await folderCopyIndex.find(d.folder, sha, f.size, () => tick());
        folderCopies.set(d.id, hit === null ? null : { path: hit, size: f.size, sha256: sha });
      }
      j = judgeForDestinations({ sha256: sha, size: f.size }, pool, dests, ctx, folderCopies);
    }
    if (j.verdict === 'none') {
      add(onlyOnPhone, f.size);
      continue;
    }
    if (j.verdict === 'stale') {
      add(stale, f.size);
      for (const id of j.stalePlaceIds) {
        const p = info(id);
        stalePlaces.set(id, { placeId: id, label: p.label, kind: p.kind, why: p.kind === 'drive' && plugged.get(id) !== true ? 'Not plugged in.' : 'Not checked in the last 24 hours.' });
      }
      rows.push({ ...base, verdict: 'stale', reason: j.reason, vouchers: [] });
      continue;
    }
    if (j.verdict === 'safe') {
      // Every drive copy must really be on its drive right now.
      let missingCopy: (typeof j.vouchers)[number] | null = null;
      for (const v of j.vouchers) {
        if (v.placeKind === 'drive' && (await deps.diskSize(v.placeId, v.relPath)) !== v.size) {
          missingCopy = v;
          break;
        }
      }
      if (missingCopy) {
        add(stale, f.size);
        stalePlaces.set(missingCopy.placeId, { placeId: missingCopy.placeId, label: missingCopy.placeLabel, kind: 'drive', why: 'A copy on it is not on the drive any more: check it again.' });
        rows.push({ ...base, verdict: 'stale', reason: `The copy on ${missingCopy.placeLabel} is not on the drive. Check it first.`, vouchers: [] });
        continue;
      }
      add(safe, f.size);
      rows.push({ ...base, verdict: 'safe', reason: j.reason, vouchers: j.vouchers.map(toVoucher) });
      continue;
    }
    add(waiting, f.size);
    rows.push({ ...base, verdict: 'waiting', reason: j.reason, vouchers: j.vouchers.map(toVoucher) });
  }

  const notes: string[] = [];
  if (notFingerprinted > 0) notes.push(`${plural(notFingerprinted, 'file')} still need to be checked on the phone. Make the plan again to go on (finished ones are remembered).`);
  if (unreadable.files > 0) notes.push(`${plural(unreadable.files, 'file')} could not be checked by the phone and are left alone.`);
  const sorted = rows
    .toSorted((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'safe' ? -1 : b.verdict === 'safe' ? 1 : 0) || a.folder.localeCompare(b.folder) || b.month.localeCompare(a.month) || a.name.localeCompare(b.name));
  const numbered: PhoneCleanFile[] = [];
  for (const r of sorted) numbered.push(Object.assign({}, r, { index: numbered.length }));
  if (numbered.length > MAX_PHONE_PLAN_ROWS) {
    notes.push(`Only the first ${MAX_PHONE_PLAN_ROWS.toLocaleString('en-US')} files are shown. Remove some, then make the plan again.`);
    numbered.length = MAX_PHONE_PLAN_ROWS;
  }
  const plan: PhoneCleanPlan = {
    id: randomUUID(),
    hash: '',
    createdAt: now(),
    serial,
    model: device.model,
    files: numbered,
    onlyOnPhone,
    safe,
    waiting,
    stale,
    unreadable,
    stalePlaces: [...stalePlaces.values()],
    ...(dests === null ? {} : { requires: dests.map((d) => d.label) }),
    notFingerprinted,
    notes,
  };
  plan.hash = hashPhoneCleanPlan(plan);
  return { ok: true, plan };
}
