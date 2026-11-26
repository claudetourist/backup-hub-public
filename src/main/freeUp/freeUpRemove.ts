/**
 * The removal of Free up phone space (job `freeup.remove`): exactly the files the person confirmed, in batches (one adb call looks at the sizes of
 * a batch, one removes it; each file still has its own proof and log rows), in the mode the person picked (params.removeMode; FULL unless told otherwise). For EVERY file, right before the phone is told to remove it:
 *   1. the file is still on the phone with the planned size, and not on the "Keep on the phone" list;
 *   2. the guarded path (`danger`) asks three fresh survivors, all of which must hold:
 *      FULL: re-reads the copy on the first drive and on the second drive and asks Google again; all three must equal the file's checksum
 *      (Google by MD5 against the MD5 of the first drive's copy just read).
 *      QUICK: reads nothing in full: each drive copy is there at exactly the planned size (its checksum is the one proved when it was
 *      copied, from the index) and Google, asked now, gives the MD5 and size the index holds.
 *   3. FULL: the phone's own SHA-256 of the file is read once more, immediately before the remove command; if it changed, the file is skipped.
 *      QUICK: the phone's file size is checked once more instead (a same-size change is not seen; that is the price of not reading).
 * The removal is logged first (`removal_log`, `danger_log`), the copies that vouched for it are locked for 30 days, and the file is
 * checked to be gone. At the end the phone's gallery is asked to refresh so it shows no ghosts. Any mismatch skips that file only.
 */
import { createHash } from 'node:crypto';
import { plural } from '../../shared/cleanup';
import { FREEUP_REMOVE_JOB_KIND, type FreeUpMode, type FreeUpRemoveFile, type FreeUpRemoveJobParams } from '../../shared/freeUp';
import { JobAborted, JobFailure, turnOf, type JobContext, type JobHandler } from '../jobs/jobService';
import { CleanStore } from '../cleanup/cleanStore';
import { driveFilePath } from '../cleanup/diskAccess';
import { isRemovablePhonePath } from '../cleanup/safety';
import { phoneConfirmed } from '../cleanup/phoneCleanJob';
import { hashConfirmed, runDanger, type AdbRemoveManyAnswer, type ConfirmedEntry, type DangerEnv, type RemoveManyStatus, type Survivor } from '../danger';
import type { GoogleAnswer, GoogleAsk } from './googleAsk';
import { KeepStore } from './keepStore';
import { phoneHashes, realFileSize, realHashFile, type FreeUpDeps } from './freeUpCheck';

const SHA = /^[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export interface FreeUpRemoveDeps extends FreeUpDeps {
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export function freeUpRemoveHandler(deps: FreeUpRemoveDeps): JobHandler {
  return {
    kind: FREEUP_REMOVE_JOB_KIND,
    heavy: true,
    resumable: false,
    run: async (ctx) => {
      try {
        return await runRemove(deps, ctx);
      } finally {
        await deps.adb.killServer();
      }
    },
  };
}

/** The hash a confirmed list is made of: the same entries the guarded path hashes. */
export const freeUpConfirmed = (serial: string, files: readonly FreeUpRemoveFile[]): ConfirmedEntry[] => phoneConfirmed(serial, files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, vouchers: f.vouchers })));

/** The hash the window is shown when the person confirms (it covers the paths, sizes and checksums of the list). */
export function freeUpListHash(files: readonly { path: string; size: number; sha256: string }[]): string {
  return createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.size, f.sha256]))).digest('hex');
}

const QUICK_BATCH = 25;
/** Full: every file of a batch is read in full on both drives right before the phone is told, so the batch stays small and light. */
const FULL_BATCH = 6;
const FULL_BATCH_BYTES = 1_000_000_000;
/** One adb line holds the paths of a batch (three times each in the remove line): the batch is cut when they would make it too long. */
const BATCH_PATH_CHARS = 6000;
const GOOGLE_PARALLEL = 6;

/** The end (exclusive) of the batch that starts at `start`. */
function batchEnd(files: readonly FreeUpRemoveFile[], start: number, mode: FreeUpMode): number {
  let bytes = 0;
  let chars = 0;
  let end = start;
  while (end < files.length) {
    const f = files[end]!;
    const size = Number.isFinite(f.size) ? f.size : 0;
    const len = typeof f.path === 'string' ? f.path.length : 0;
    const n = end - start;
    if (n > 0 && (n >= (mode === 'quick' ? QUICK_BATCH : FULL_BATCH) || chars + len > BATCH_PATH_CHARS || (mode === 'full' && bytes + size > FULL_BATCH_BYTES))) break;
    bytes += size;
    chars += len;
    end += 1;
  }
  return end;
}

/** What Google said, or why it could not be asked (kept so a failed ask is only seen by the file it belongs to). */
type Asked = { ok: true; answer: GoogleAnswer } | { ok: false; err: unknown };

/** Asks Google about these files at once, at most `limit` at the same time; one answer per file. Never rejects. */
function startAsks(google: GoogleAsk, entries: readonly { i: number; f: FreeUpRemoveFile }[], signal: AbortSignal, limit: number): Map<number, Promise<Asked>> {
  const out = new Map<number, Promise<Asked>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  for (const { i, f } of entries) {
    out.set(
      i,
      (async (): Promise<Asked> => {
        if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
        running += 1;
        try {
          return { ok: true, answer: await google.ask({ placeId: f.google.placeId, fileId: f.google.fileId, name: f.google.name, parentId: f.google.parentId }, signal) };
        } catch (err) {
          return { ok: false, err };
        } finally {
          running -= 1;
          waiting.shift()?.();
        }
      })(),
    );
  }
  return out;
}

/** Google's answer for one file: the one asked ahead (with the others of its batch), else asked now. */
async function googleAnswerOf(deps: FreeUpDeps, f: FreeUpRemoveFile, signal: AbortSignal, asked: Promise<Asked> | undefined): Promise<GoogleAnswer | null> {
  if (deps.google === null) return null;
  if (asked === undefined) return deps.google.ask({ placeId: f.google.placeId, fileId: f.google.fileId, name: f.google.name, parentId: f.google.parentId }, signal);
  const a = await asked;
  if (!a.ok) throw a.err;
  return a.answer;
}

const WHY: Record<Exclude<RemoveManyStatus, 'removed'>, string> = {
  changed: 'its size changed on the phone just before the removal, so it was left alone',
  missing: 'it was not on the phone any more',
  still: 'it is still on the phone after the removal',
  failed: 'the phone would not remove it',
};

/**
 * The phone's part of a batch, called by the guarded path once every file of the batch has its proof: FULL reads the phone's own SHA-256 of the batch once
 * more (one call) and leaves a file whose checksum changed; then ONE call removes the rest, each file only if its size is still exactly the planned one
 * (the size check and the remove are back to back in that call) and says whether it is gone. QUICK goes straight to that call: its last look is the size.
 * When the call fails as a whole the phone is asked which files are gone, so a removed file is never reported as left.
 */
async function removeBatch(deps: FreeUpDeps, mode: FreeUpMode, serial: string, items: readonly { path: string; size: number }[], shaOf: ReadonlyMap<string, string>, signal: AbortSignal | undefined): Promise<AdbRemoveManyAnswer[]> {
  const answers: AdbRemoveManyAnswer[] = items.map(() => ({ ok: false, reason: 'it was not removed' }));
  let todo = items.map((_, i) => i);
  if (mode === 'full') {
    const hashes = await phoneHashes(deps.adb, serial, items.map((x) => x.path), signal, 0);
    todo = todo.filter((i) => {
      const h = hashes.get(items[i]!.path);
      if (h?.kind === 'sha256' && h.sha256 === shaOf.get(items[i]!.path)) return true;
      answers[i] = { ok: false, reason: 'it changed on the phone just before the removal, so it was left alone' };
      return false;
    });
  }
  if (todo.length === 0) return answers;
  const asked = todo.map((i) => items[i]!);
  let statuses: RemoveManyStatus[];
  let didNotAnswer: string | null = null;
  try {
    statuses = await deps.adb.removeMany(serial, asked, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    didNotAnswer = `the phone did not answer (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'})`;
    statuses = asked.map(() => 'failed' as const);
    try {
      statuses = (await deps.adb.statSizes(serial, asked.map((x) => x.path), signal)).map((s) => (s === null ? 'removed' : 'failed'));
    } catch {
      // The phone cannot say which files are gone: they stay reported as not removed, with the reason below.
    }
  }
  todo.forEach((i, k) => {
    const s = statuses[k]!;
    answers[i] = s === 'removed' ? { ok: true } : { ok: false, reason: didNotAnswer ?? WHY[s] };
  });
  return answers;
}

/** The three survivors of one file, each read fresh when the guarded path asks. The first drive's read also gives the MD5 Google must match. */
function survivorsOf(deps: FreeUpDeps, f: FreeUpRemoveFile, signal: AbortSignal, turn: () => Promise<void>, mode: FreeUpMode, asked: Promise<Asked> | undefined): Survivor[] {
  if (mode === 'quick') return quickSurvivorsOf(deps, f, signal, asked);
  const hashFile = deps.hashFile ?? realHashFile;
  let t7Md5: string | null = null;
  const driveSurvivor = (v: FreeUpRemoveFile['vouchers'][number], wantMd5: boolean): Survivor => ({
    where: `${v.placeLabel}: ${v.relPath}`,
    ref: `${v.placeId}:${v.relPath}`,
    readFresh: async () => {
      const abs = await driveFilePath(deps.db, deps.baseOf, v.placeId, v.relPath);
      if (abs === null) return null;
      const h = await hashFile(abs, { md5: wantMd5, yieldNow: turn });
      if (h.bytes !== f.size) return null;
      if (wantMd5) t7Md5 = h.md5?.toLowerCase() ?? null;
      return h.sha256;
    },
  });
  const [first, second] = f.vouchers.filter((v) => v.placeKind === 'drive');
  const out: Survivor[] = [];
  if (first) out.push(driveSurvivor(first, true));
  if (second) out.push(driveSurvivor(second, false));
  out.push({
    where: `Google: ${f.google.name}`,
    ref: `google:${f.google.placeId}:${f.google.fileId}`,
    readFresh: async () => {
      if (deps.google === null || t7Md5 === null || !MD5.test(t7Md5)) return null;
      const a = await googleAnswerOf(deps, f, signal, asked);
      if (a === null) return null;
      // The proof compares one checksum: Google counts only when its own MD5 and size equal those of the first drive's copy just read.
      return a.kind === 'found' && a.md5 !== null && a.md5 === t7Md5 && a.size === f.size ? f.sha256 : null;
    },
  });
  return out;
}

/** Quick: nothing is read in full. A drive copy counts when it is there at exactly the planned size (the index holds the checksum proved when it was copied); Google when it says the MD5 and size the index holds. */
function quickSurvivorsOf(deps: FreeUpDeps, f: FreeUpRemoveFile, signal: AbortSignal, asked: Promise<Asked> | undefined): Survivor[] {
  const fileSize = deps.fileSize ?? realFileSize;
  const drives = f.vouchers.filter((v) => v.placeKind === 'drive').map(
    (v): Survivor => ({
      where: `${v.placeLabel}: ${v.relPath}`,
      ref: `${v.placeId}:${v.relPath}`,
      readFresh: async () => {
        const abs = await driveFilePath(deps.db, deps.baseOf, v.placeId, v.relPath);
        if (abs === null) return null;
        return (await fileSize(abs)) === f.size ? v.sha256 : null;
      },
    }),
  );
  return [
    ...drives,
    {
      where: `Google: ${f.google.name}`,
      ref: `google:${f.google.placeId}:${f.google.fileId}`,
      readFresh: async () => {
        const a = await googleAnswerOf(deps, f, signal, asked);
        if (a === null) return null;
        return a.kind === 'found' && a.md5 !== null && a.md5 === f.google.md5.toLowerCase() && a.size === f.size ? f.sha256 : null;
      },
    },
  ];
}

async function runRemove(deps: FreeUpRemoveDeps, ctx: JobContext): Promise<string> {
  const params = ctx.params as Partial<FreeUpRemoveJobParams> | null;
  const serial = params?.serial;
  const backupId = params?.backupId;
  if (typeof params?.listId !== 'string' || typeof serial !== 'string' || typeof backupId !== 'number') throw new JobFailure('This clean-up has no files in it. Check again. Nothing was removed.');
  const files = deps.results.takeRemoval(params.listId);
  if (files === null || files.length === 0) throw new JobFailure('The confirmed list is not kept any more (the app was restarted). Check again. Nothing was removed.');
  const confirmed = freeUpConfirmed(serial, files);
  if (typeof params.listHash !== 'string' || hashConfirmed(confirmed) !== params.listHash) throw new JobFailure('The list is not the one that was confirmed. Check again. Nothing was removed.');
  const mode: FreeUpMode = params.removeMode === 'quick' ? 'quick' : 'full';
  const shaOf = new Map(files.map((x) => [x.path, x.sha256]));
  const dangerEnv: DangerEnv = {
    db: deps.db,
    ...(deps.now ? { now: deps.now } : {}),
    signal: ctx.signal,
    adbRemoveMany: (s, items, sig) => removeBatch(deps, mode, s, items, shaOf, sig),
  };
  if (!deps.adb.available()) throw new JobFailure('adb.exe was not found, so the phone cannot be reached. Nothing was removed.');
  const phone = (await deps.adb.devices().catch(() => [])).find((d) => d.serial === serial);
  if (!phone || phone.state !== 'device') throw new JobFailure('The phone is not connected or not unlocked. Plug it in, unlock it and start again. Nothing was removed.');
  const store = new CleanStore(deps.db, deps.now);
  const keep = new KeepStore(deps.db);
  const now = deps.now ?? Date.now;
  const phonePlaceId = deps.db.prepare('SELECT source_place_id FROM backup_profiles WHERE id = ?').pluck().get(backupId) as string | null | undefined;
  const markGone = deps.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'phone_cleaned' WHERE place_id = ? AND rel_path IN (?, ?) AND gone_at IS NULL");
  const total = files.length;
  const bytesTotal = files.reduce((n, f) => n + (Number.isFinite(f.size) ? f.size : 0), 0);
  let removed = 0;
  let removedBytes = 0;
  let skipped = 0;
  const skip = (name: string, why: string): void => {
    skipped += 1;
    ctx.warn(`${name}: skipped (${why}). It stays on the phone.`);
  };

  const turn = turnOf(ctx);
  let galleryWarned = false;
  const forget = (p: string): void => {
    if (typeof phonePlaceId === 'string') markGone.run(now(), phonePlaceId, p, p.replace(/^\/+/, '')); // the index keeps phone rows without the leading slash
  };

  // The files go in batches: one adb call looks at the sizes of a batch, one removes it (each file's size checked right before its own remove, in the same
  // call), one refreshes the gallery. EVERY file still has its own three fresh survivors through the guarded path, its own removal_log row and danger_log row.
  // The Pause point (ctx.yield) is between batches; inside one the job only takes turns (ctx.turn).
  for (let start = 0; start < total; ) {
    await ctx.yield();
    const end = batchEnd(files, start, mode);
    const nameAt = (i: number): string => {
      const p = files[i]!.path;
      return typeof p === 'string' ? p.slice(p.lastIndexOf('/') + 1) : 'file';
    };
    ctx.progress(start, total, { bytesDone: removedBytes, bytesTotal, message: end - start === 1 ? `Checking ${nameAt(start)} (${start + 1} of ${total})` : `Checking ${end - start} files (${start + 1} to ${end} of ${total})` });
    const keepMatches = keep.matcher(backupId);
    // 1. what needs no phone: the details, the Keep list.
    const ready: number[] = [];
    for (let i = start; i < end; i += 1) {
      const f = files[i]!;
      const name = nameAt(i);
      if (!isRemovablePhonePath(f.path) || typeof f.sha256 !== 'string' || !SHA.test(f.sha256) || !Number.isInteger(f.size) || f.size <= 0 || !Array.isArray(f.vouchers) || f.vouchers.filter((v) => v.placeKind === 'drive').length < 2 || typeof f.google?.fileId !== 'string' || f.google.fileId === '') skip(name, 'its details are not valid');
      else if (keepMatches(f.path)) skip(name, 'it is on the Keep on the phone list');
      else ready.push(i);
    }
    // 2. one adb call: the sizes now.
    const sized: number[] = [];
    if (ready.length > 0) {
      try {
        const sizes = await deps.adb.statSizes(serial, ready.map((i) => files[i]!.path), ctx.signal);
        ready.forEach((i, k) => {
          if (sizes[k] === null) skip(nameAt(i), 'it is not on the phone any more');
          else if (sizes[k] !== files[i]!.size) skip(nameAt(i), 'its size on the phone changed');
          else sized.push(i);
        });
      } catch (err) {
        if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
        for (const i of ready) skip(nameAt(i), `the phone did not answer (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'})`);
      }
    }
    // 3. the guarded path for the batch: a log row and locks per file, three fresh survivors per file (Google asked for several files at once), the proof,
    //    then ONE phone call that checks each file's size again right before its own remove.
    const drops = new Map<number, () => void>();
    const dropAll = (): void => {
      for (const d of drops.values()) d();
      drops.clear();
    };
    if (sized.length > 0) {
      let results: Awaited<ReturnType<typeof runDanger>> = [];
      try {
        for (const i of sized) {
          const f = files[i]!;
          const lockIds = store.addLocks(f.vouchers, `Vouched for ${f.path} removed from ${phone.model}`);
          const logId = store.logRemoval({ runId: ctx.jobId, kind: 'phone', placeId: null, device: phone.model, path: f.path, size: f.size, sha256: f.sha256, vouchers: f.vouchers, quarantinePath: null });
          store.attachLocks(lockIds, logId);
          drops.set(i, () => {
            store.dropLog(logId);
            deps.db.prepare('DELETE FROM clean_locks WHERE removal_id = ?').run(logId);
          });
        }
        const asked = deps.google === null ? new Map<number, Promise<Asked>>() : startAsks(deps.google, sized.map((i) => ({ i, f: files[i]! })), ctx.signal, GOOGLE_PARALLEL);
        results = await runDanger(dangerEnv, {
          listId: params.listId,
          confirmedHash: params.listHash,
          confirmed,
          minSurvivors: 3,
          items: sized.map((i) => ({ ...confirmed[i]!, size: files[i]!.size, survivors: survivorsOf(deps, files[i]!, ctx.signal, turn, mode, asked.get(i)) })),
        });
      } catch (err) {
        dropAll();
        if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
        for (const i of sized) skip(nameAt(i), `the phone did not answer (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'})`);
        start = end;
        continue;
      }
      // 4. what happened to each file.
      const goneNow: string[] = [];
      sized.forEach((i, k) => {
        const f = files[i]!;
        const result = results[k];
        if (result?.outcome !== 'done') {
          drops.get(i)?.();
          skip(nameAt(i), result?.outcome === 'refused' ? 'the three copies could not all be proved right now' : (result?.reason ?? 'the phone would not remove it'));
          return;
        }
        removed += 1;
        removedBytes += f.size;
        goneNow.push(f.path);
        forget(f.path);
        ctx.log('info', `${f.path} removed from the phone (${mb(f.size)}); ${mode === 'quick' ? 'checked quickly: copies there at their size on' : 'read in full on'} ${[...new Set(f.vouchers.map((v) => v.placeLabel))].join(', ')}`);
      });
      if (ctx.signal.aborted) throw new JobAborted();
      // 5. the gallery: ask the phone to look at this batch's removed paths again so it keeps no ghosts. A failure here removes nothing and costs nothing.
      if (goneNow.length > 0 && deps.adb.scanMedia) {
        try {
          await deps.adb.scanMedia(serial, goneNow, ctx.signal);
        } catch (err) {
          if (ctx.signal.aborted) throw new JobAborted();
          if (!galleryWarned) ctx.warn(`The gallery on the phone could not be refreshed (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'}). It may show empty pictures until the phone is restarted.`);
          galleryWarned = true;
        }
      }
    }
    start = end;
    ctx.progress(start, total, { bytesDone: removedBytes, bytesTotal });
  }
  ctx.progress(total, total, { bytesDone: removedBytes, bytesTotal });
  deps.changed?.();
  const line = `Removed ${plural(removed, 'file')} (${mb(removedBytes)}) from ${phone.model} (${mode === 'quick' ? 'checked quickly: nothing was read again' : 'every file read in full again'})${skipped > 0 ? `; ${plural(skipped, 'file')} skipped and left on the phone` : ''}`;
  if (removed === 0) throw new JobFailure(`${line}. Nothing was removed. See the warnings above.`);
  ctx.log('info', line);
  return `${line}. The copies that vouched for them are locked for 30 days and "Put back" restores them.`;
}
