/**
 * Jobs of "Free up phone space".
 *
 * `clean.phone` removes exactly the ticked files from the phone. For EVERY file, right before `rm`:
 *   1. the vouching copies are checked again in the catalog (same fingerprints), the named-drive copy is on the drive with its
 *      size, and every vouching place was looked at in the last 24 h;
 *   2. the file on the phone still has the planned size and the planned SHA-256 (read from the phone now);
 *   3. the vouching copies are checked once more (the fingerprint above can take a while);
 *   4. the vouching copies are LOCKED for 30 days, the removal is written to the log, then `rm` of that one file.
 * Any mismatch skips that file and nothing else. `adb kill-server` runs when the job ends.
 *
 * `clean.putBack` copies removed files back from the drive copy (`adb push`, never over an existing file), checked by SHA-256.
 */
import fs from 'node:fs';
import { CLEAN_PHONE_JOB_KIND, PUT_BACK_JOB_KIND, plural, type CleanDestination, type PhoneCleanJobParams, type PutBackJobParams, type Voucher } from '../../shared/cleanup';
import type { Db } from '../db/connection';
import { JobAborted, JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import type { AdbCleanPort } from './adbClean';
import { CleanStore } from './cleanStore';
import { driveFilePath, type BaseOf } from './diskAccess';
import { sha256OfFile } from './hashLocal';
import { hashConfirmed, runDanger, type ConfirmedEntry, type DangerEnv, type Survivor } from '../danger';
import { isInsideFolder } from './folderCopies';
import { isFolderVoucher, isRemovablePhonePath, recheckDestinationVouchers, recheckVouchers, type VoucherNow } from './safety';

export interface PhoneCleanDeps {
  db: Db;
  log: JobServiceLogger;
  adb: AdbCleanPort;
  baseOf: BaseOf;
  /** Size on disk of a named-drive catalog file, null when it is not there. */
  diskSize(placeId: string, relPath: string): Promise<number | null>;
  now?: () => number;
  /** Told when the catalog changed (the counts must be counted again). */
  changed?: () => void;
  /** The enabled places of the Phone backup NOW. When given, the Phone backup rule applies: every one must hold a verified copy. */
  destinations?: () => CleanDestination[];
}

const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);
const SHA = /^[0-9a-f]{64}$/;

export function phoneCleanHandler(deps: PhoneCleanDeps): JobHandler {
  return {
    kind: CLEAN_PHONE_JOB_KIND,
    heavy: true,
    resumable: false,
    run: async (ctx) => {
      try {
        return await runPhoneClean(deps, ctx);
      } finally {
        await deps.adb.killServer();
      }
    },
  };
}

async function recheck(deps: PhoneCleanDeps, store: CleanStore, vouchers: readonly Voucher[], turn: () => Promise<void>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const nowTime = (deps.now ?? Date.now)();
  const sizes = new Map<Voucher, number | null>();
  for (const v of vouchers) if (v.placeKind === 'drive') sizes.set(v, await deps.diskSize(v.placeId, v.relPath));
  const lookup = (v: Voucher): VoucherNow => ({ row: store.row(v.placeId, v.relPath), lastLookedAt: store.lastLooked(v.placeId), ...(v.placeKind === 'drive' ? { onDiskSize: sizes.get(v) ?? null } : {}) });
  const dests = deps.destinations?.();
  if (dests === undefined) return recheckVouchers(vouchers, lookup, nowTime);
  const checked = recheckDestinationVouchers(vouchers, dests, lookup, nowTime);
  if (!checked.ok) return checked;
  // A laptop folder copy is not in the catalog: the file must be inside that folder, with the size, and read now it must give the SHA-256.
  for (const v of vouchers.filter(isFolderVoucher)) {
    const dest = dests.find((d) => d.id === v.destinationId);
    if (!dest || dest.kind !== 'laptop' || !dest.folder || !isInsideFolder(dest.folder, v.relPath)) return { ok: false, reason: `The copy in ${v.placeLabel} is not inside the folder any more.` };
    try {
      if (fs.statSync(v.relPath).size !== v.size) return { ok: false, reason: `The copy in ${v.placeLabel} changed size.` };
      if (v.sha256 === null || (await sha256OfFile(v.relPath, turn)) !== v.sha256) return { ok: false, reason: `The copy in ${v.placeLabel} does not match the checksum any more.` };
    } catch {
      return { ok: false, reason: `The copy in ${v.placeLabel} is not there.` };
    }
  }
  return { ok: true };
}

/** What the person confirmed, in the form the guarded path hashes: one entry per file, in the order of the list. */
export function phoneConfirmed(serial: string, files: PhoneCleanJobParams['files']): ConfirmedEntry[] {
  return files.map((f, i) => ({ id: String(i), action: 'adb-rm' as const, target: String(f.path), contentHash: typeof f.sha256 === 'string' ? f.sha256 : null, serial }));
}

/** The surviving copies of a vouched file, each read fresh from the disk when asked (drive copies and laptop folder copies). Google copies cannot be read from here. */
async function freshSurvivors(deps: PhoneCleanDeps, vouchers: readonly Voucher[], turn: () => Promise<void>): Promise<Survivor[]> {
  const out: Survivor[] = [];
  for (const v of vouchers) {
    const local = isFolderVoucher(v) ? v.relPath : v.placeKind === 'drive' ? await driveFilePath(deps.db, deps.baseOf, v.placeId, v.relPath) : null;
    if (local === null) continue;
    out.push({ where: `${v.placeLabel}: ${v.relPath}`, ref: local, readFresh: () => sha256OfFile(local, turn).catch(() => null) });
  }
  return out;
}

async function runPhoneClean(deps: PhoneCleanDeps, ctx: JobContext): Promise<string> {
  const params = ctx.params as Partial<PhoneCleanJobParams> | null;
  const files = params?.files;
  const serial = params?.serial;
  if (!Array.isArray(files) || files.length === 0 || typeof serial !== 'string') throw new JobFailure('This clean-up has no files in it. Make a new plan. Nothing was removed.');
  const confirmed = phoneConfirmed(serial, files);
  if (typeof params?.listId !== 'string' || typeof params.listHash !== 'string' || hashConfirmed(confirmed) !== params.listHash) throw new JobFailure('The list is not the one that was confirmed. Make a new plan. Nothing was removed.');
  const dangerEnv: DangerEnv = { db: deps.db, ...(deps.now ? { now: deps.now } : {}), signal: ctx.signal, adbRemove: (s, p, sig) => deps.adb.remove(s, p, sig) };
  if (!deps.adb.available()) throw new JobFailure('adb.exe was not found, so the phone cannot be reached. Nothing was removed.');
  const phone = (await deps.adb.devices().catch(() => [])).find((d) => d.serial === serial);
  if (!phone || phone.state !== 'device') throw new JobFailure('The phone is not connected or not unlocked. Plug it in, unlock it and start again. Nothing was removed.');
  const store = new CleanStore(deps.db, deps.now);
  const total = files.length;
  let removed = 0;
  let removedBytes = 0;
  let skipped = 0;
  const skip = (name: string, why: string): void => {
    skipped += 1;
    ctx.warn(`${name}: skipped (${why}). It stays on the phone.`);
  };

  for (let i = 0; i < total; i += 1) {
    await ctx.yield();
    const f = files[i]!;
    const name = typeof f.path === 'string' ? f.path.slice(f.path.lastIndexOf('/') + 1) : 'file';
    ctx.progress(i, total, { message: `Checking ${name} (${i + 1} of ${total})` });
    if (!isRemovablePhonePath(f.path) || typeof f.sha256 !== 'string' || !SHA.test(f.sha256) || !Number.isInteger(f.size) || f.size <= 0 || !Array.isArray(f.vouchers)) {
      skip(name, 'its details are not valid');
      continue;
    }
    try {
      // 1. The vouching copies, now.
      const first = await recheck(deps, store, f.vouchers, () => ctx.yield());
      if (!first.ok) {
        skip(name, first.reason);
        continue;
      }
      // 2. The file on the phone, now.
      const size = await deps.adb.statSize(serial, f.path, ctx.signal);
      if (size === null) {
        skip(name, 'it is not on the phone any more');
        continue;
      }
      if (size !== f.size) {
        skip(name, 'its size on the phone changed');
        continue;
      }
      const sha = await deps.adb.sha256(serial, f.path, ctx.signal);
      if (sha !== f.sha256) {
        skip(name, sha === null ? 'the phone gave no checksum' : 'its checksum on the phone changed');
        continue;
      }
      // 3. Once more, right before the removal.
      const second = await recheck(deps, store, f.vouchers, () => ctx.yield());
      if (!second.ok) {
        skip(name, second.reason);
        continue;
      }
      // 4. Lock, log, remove exactly this file.
      const lockIds = store.addLocks(f.vouchers.filter((v) => !isFolderVoucher(v)), `Vouched for ${f.path} removed from ${phone.model}`);
      const logId = store.logRemoval({ runId: ctx.jobId, kind: 'phone', placeId: null, device: phone.model, path: f.path, size: f.size, sha256: f.sha256, vouchers: f.vouchers, quarantinePath: null });
      store.attachLocks(lockIds, logId);
      // The removal goes through the guarded path: the confirmed list, copies read fresh from the disk now, a log row, then the rm.
      const removal = (
        await runDanger(dangerEnv, {
          listId: params.listId,
          confirmedHash: params.listHash,
          confirmed,
          items: [{ ...confirmed[i]!, size: f.size, survivors: await freshSurvivors(deps, f.vouchers, () => ctx.yield()) }],
        })
      )[0];
      if (ctx.signal.aborted) throw new JobAborted();
      if (removal?.outcome === 'refused') {
        store.dropLog(logId);
        skip(name, removal.reason ?? 'the copies could not be proved');
        continue;
      }
      if (removal?.outcome === 'failed') {
        // The phone said no: if the file is still there, nothing was removed and the log line goes.
        if ((await deps.adb.statSize(serial, f.path).catch(() => 0)) !== null) {
          store.dropLog(logId);
          skip(name, `the phone would not remove it (${removal.reason?.slice(0, 100) ?? 'unknown'})`);
          continue;
        }
      }
      if ((await deps.adb.statSize(serial, f.path, ctx.signal)) !== null) {
        store.dropLog(logId);
        skip(name, 'it is still on the phone after the removal');
        continue;
      }
      removed += 1;
      removedBytes += f.size;
      ctx.log('info', `${f.path} removed from the phone (${mb(f.size)}); vouched for by ${[...new Set(f.vouchers.map((v) => v.placeLabel))].join(' and ')}`);
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
      skip(name, `the phone did not answer (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'})`);
    }
  }
  ctx.progress(total, total, {});
  deps.changed?.();
  const line = `Removed ${plural(removed, 'file')} (${mb(removedBytes)}) from ${phone.model}${skipped > 0 ? `; ${plural(skipped, 'file')} skipped and left on the phone` : ''}`;
  if (removed === 0) throw new JobFailure(`${line}. Nothing was removed. See the warnings above.`);
  ctx.log('info', line);
  return `${line}. The copies that vouched for them are locked for 30 days and "Put back on phone" restores them.`;
}

export function putBackHandler(deps: PhoneCleanDeps): JobHandler {
  return {
    kind: PUT_BACK_JOB_KIND,
    heavy: true,
    resumable: false,
    run: async (ctx) => {
      try {
        return await runPutBack(deps, ctx);
      } finally {
        await deps.adb.killServer();
      }
    },
  };
}

async function runPutBack(deps: PhoneCleanDeps, ctx: JobContext): Promise<string> {
  const params = ctx.params as Partial<PutBackJobParams> | null;
  const ids = params?.removalIds;
  const serial = params?.serial;
  if (!Array.isArray(ids) || ids.length === 0 || typeof serial !== 'string') throw new JobFailure('There is nothing to put back.');
  if (!deps.adb.available()) throw new JobFailure('adb.exe was not found, so the phone cannot be reached.');
  const phone = (await deps.adb.devices().catch(() => [])).find((d) => d.serial === serial);
  if (!phone || phone.state !== 'device') throw new JobFailure('The phone is not connected or not unlocked. Plug it in, unlock it and start again.');
  const store = new CleanStore(deps.db, deps.now);
  const dangerEnv: DangerEnv = { db: deps.db, ...(deps.now ? { now: deps.now } : {}), signal: ctx.signal, adbRemove: (s, p, sig) => deps.adb.remove(s, p, sig) };
  let back = 0;
  let skipped = 0;
  const skip = (name: string, why: string): void => {
    skipped += 1;
    ctx.warn(`${name}: not put back (${why}).`);
  };
  for (let i = 0; i < ids.length; i += 1) {
    await ctx.yield();
    const entry = Number.isInteger(ids[i]) ? store.removal(ids[i]!) : null;
    if (!entry || entry.kind !== 'phone' || entry.undoneAt !== null) {
      skip(`#${String(ids[i])}`, 'it is not a removed phone file');
      continue;
    }
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    ctx.progress(i, ids.length, { message: `Putting ${name} back (${i + 1} of ${ids.length})` });
    if (!isRemovablePhonePath(entry.path)) {
      skip(name, 'its path is not valid');
      continue;
    }
    try {
      const source = entry.vouchers.find((v) => v.placeKind === 'drive') ?? entry.vouchers.find(isFolderVoucher);
      const local = source ? (isFolderVoucher(source) ? source.relPath : await driveFilePath(deps.db, deps.baseOf, source.placeId, source.relPath)) : null;
      if (!source || local === null) {
        skip(name, `${source?.placeLabel ?? 'the backup drive'} is not plugged in`);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(local);
      } catch {
        skip(name, `the copy on ${source.placeLabel} is not there`);
        continue;
      }
      if (!st.isFile() || st.size !== entry.size) {
        skip(name, `the copy on ${source.placeLabel} has another size`);
        continue;
      }
      if ((await sha256OfFile(local, () => ctx.yield())) !== entry.sha256) {
        skip(name, `the copy on ${source.placeLabel} does not match the checksum any more`);
        continue;
      }
      const there = await deps.adb.statSize(serial, entry.path, ctx.signal);
      if (there !== null) {
        if (there === entry.size && (await deps.adb.sha256(serial, entry.path, ctx.signal)) === entry.sha256) {
          store.markUndone(entry.id);
          back += 1;
          ctx.log('info', `${entry.path} is already back on the phone`);
        } else skip(name, 'a different file is already at that place on the phone');
        continue;
      }
      await deps.adb.push(serial, local, entry.path, ctx.signal);
      const sizeNow = await deps.adb.statSize(serial, entry.path, ctx.signal);
      const shaNow = sizeNow === entry.size ? await deps.adb.sha256(serial, entry.path, ctx.signal) : null;
      if (shaNow !== entry.sha256) {
        // The place was empty before, so what is there now is this job's own bad copy.
        const badCopy: ConfirmedEntry = { id: String(entry.id), action: 'adb-rm', target: entry.path, contentHash: entry.sha256, serial };
        await runDanger(dangerEnv, { listId: `put-back-${ctx.jobId}`, confirmedHash: hashConfirmed([badCopy]), confirmed: [badCopy], items: [{ ...badCopy, survivors: [{ where: source.placeLabel, ref: local, readFresh: () => sha256OfFile(local).catch(() => null) }] }] }).catch(() => undefined);
        skip(name, 'what arrived on the phone did not match, so that copy was removed again');
        continue;
      }
      store.markUndone(entry.id);
      back += 1;
      ctx.log('info', `${entry.path} put back on the phone and checked`);
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
      skip(name, `the phone did not answer (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'})`);
    }
  }
  ctx.progress(ids.length, ids.length, {});
  const line = `Put ${plural(back, 'file')} back on ${phone.model}${skipped > 0 ? `; ${plural(skipped, 'file')} not put back` : ''}`;
  if (back === 0) throw new JobFailure(`${line}. See the warnings above.`);
  return line;
}
