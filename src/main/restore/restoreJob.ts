/**
 * Job `restore.files` (heavy, resumable): "Get files back". Copies the picked files from the best copy there is into a NEW folder on the laptop, or back to where they
 * were: the T7 first, then the Seagate, then a download from Google when no plugged-in drive has a usable copy. Every copy only reads its source; a drive copy goes through
 * `verifiedCopy` (temp name, flush, read back without the Windows cache, checksum compared with the one the index holds, then a link that can never replace), a Google
 * download goes to the same kind of temp name and through `adoptVerifiedTemp` (size, flush, read back, checksum, link). A copy that does not match the known SHA-256 is thrown
 * away and the next copy is tried. Nothing is ever overwritten, moved or deleted, and nothing on a drive or in Google is changed:
 *   - a file whose name is already there stays as it is ("already there, kept as is");
 *   - a file with no known checksum, found different, or with no copy that matches is held back and listed;
 *   - nothing is written under a drive's MyData folder or in Backup Hub's own folders (`restoreModel.protectedReason`).
 * The temp files live in a work folder next to what is restored (never on the drive the backups are on, never under MyData).
 * After a restart the job continues at the file it was on; a file that was already put back counts as "already there".
 */
import path from 'node:path';
import { rawFs as fs } from '../rawFs';
import type { Db } from '../db';
import { ownRemoveAsync } from '../danger/ownFiles';
import { assertWritable, DriveWriteProtectedError } from '../fsutil';
import { NeedsSignInError, VaultNotReadyError } from '../google/auth';
import { DownloadShortError, type DownloadOptions } from '../google/driveDownload';
import { GoogleApiError, NetworkError, RequestAborted } from '../google/googleHttp';
import { absolutePathFor } from '../hashing/paths';
import { JobAborted, JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { driveTmpFolder } from '../places/appFolders';
import { adoptVerifiedTemp, existsAsync, hashFileOnce, settleLeftover, sweepStaleTemps, tempPathFor, verifiedCopy } from '../localCopy/verifiedCopy';
import { LOCAL_MIN_FREE_BYTES } from '../../shared/localCopy';
import { HELD_WORDS, RESTORE_FOLDER, RESTORE_JOB_KIND, type RestoreOutcome, type RestorePick } from '../../shared/restore';
import { finishSliced } from '../sliceWork';
import { copiesOf, expandBackupSteps, expandFilesSteps, loadAllRoots, loadBackup, type BackupInfo, type RestoreCopy, type RestoreItem } from './restoreIndex';
import { bytesText, filesText, heldReason, heldText, knownSha, NO_COPY_WORDS, numberedName, preferredSources, protectedReason, reasonsText, safeParts } from './restoreModel';

export interface RestoreJobParams {
  backupId?: number;
  backupIds: number[];
  pick: RestorePick;
  /** The drives that were plugged in when the list was made, best first (the job holds them while it reads). */
  preferPlaces: string[];
  /** A day or newest pick: the drive whose index rows name the files (the first plugged one, else the backup's first drive: the index is still there). */
  listPlaceId?: string;
  /** A Files pick: every drive of the backups, the plugged-in ones first. */
  rankPlaces?: string[];
  destination: { mode: 'new' | 'original'; /** The folder the new folder goes into ('new' only). */ parent: string; /** The new folder's name before any " (2)". */ folderName: string };
}

export interface RestoreJobDeps {
  db: Db;
  log: JobServiceLogger;
  /** Where a drive's files are right now (its letter root), or null when it is not plugged in. */
  baseOf(placeId: string): Promise<string | null>;
  freeBytes(dir: string): Promise<number | null>;
  /** Downloads one Google Drive file into a temp file (`google/driveDownload.ts`). Without it Google copies are never used. */
  download?: (placeId: string, extId: string, tmpFile: string, o: DownloadOptions) => Promise<number>;
  chunkBytes?: number;
  /** Where the temp files go (tests; the real one is the work folder described above). */
  tmpDirFor?: (final: string) => string;
}

interface Checkpoint {
  next: number;
  folder: string | null;
  counts: Record<RestoreOutcome, number>;
  copiedBytes: number;
  bytesDone: number;
  /** Of the copied files: how many came from Google, and how many from a later drive copy because the first did not match. */
  fromGoogle: number;
  fromNextCopy: number;
}

const emptyCounts = (): Record<RestoreOutcome, number> => ({ copied: 0, there: 0, no_checksum: 0, differs: 0, damaged: 0, missing: 0, protected: 0, failed: 0, no_space: 0 });
const emptyCheckpoint = (): Checkpoint => ({ next: 0, folder: null, counts: emptyCounts(), copiedBytes: 0, bytesDone: 0, fromGoogle: 0, fromNextCopy: 0 });
const CHECKPOINT_EVERY = 50;
const MAX_NOTES = 100;
/** After this many Google answers in a row that it cannot be reached (or is not signed in), the rest of the run does not ask again. */
const GOOGLE_GIVE_UP = 3;

export function restoreHandler(deps: RestoreJobDeps): JobHandler {
  return { kind: RESTORE_JOB_KIND, heavy: true, resumable: true, run: (ctx) => new RestoreRun(deps, ctx).run() };
}

/** The items of the pick, in the same order every time (a continued job finds its place by number). */
export async function expandPick(deps: Pick<RestoreJobDeps, 'db'>, params: RestoreJobParams, pause: () => Promise<void>): Promise<{ items: RestoreItem[]; notAvailable: number; backupNames: string[] }> {
  const { db } = deps;
  const pick = params.pick;
  if (pick.kind === 'files') {
    const out = await finishSliced(expandFilesSteps(db, loadAllRoots(db), params.rankPlaces ?? params.preferPlaces, pick.fileIds), pause);
    return { items: out.items, notAvailable: out.notAvailable, backupNames: out.backups.map((b) => b.name) };
  }
  const backup = loadBackup(db, pick.backupId);
  const placeId = params.listPlaceId ?? params.preferPlaces[0];
  if (!backup || placeId === undefined) return { items: [], notAvailable: 0, backupNames: [] };
  const items = await finishSliced(expandBackupSteps(db, backup, placeId, pick.kind === 'newest' ? { kind: 'newest' } : { kind: 'date', folder: pick.folder, items: pick.items }), pause);
  return { items, notAvailable: 0, backupNames: [backup.name] };
}

/** How a try at one copy ended: done, already there, or a reason to go on to the next copy (`stop`: no other copy can help). */
type Attempt = { done: 'copied' | 'there' } | { fail: RestoreOutcome; text: string; stop?: boolean };

/** The most telling reason when no copy worked: a copy that did not match beats one that was not there. */
const WORST: readonly RestoreOutcome[] = ['damaged', 'failed', 'missing'];

class RestoreRun {
  private cp = emptyCheckpoint();
  private readonly params: RestoreJobParams;
  private stopped = false;
  private warned = 0;
  private bases = new Map<string, string | null>();
  private bytesTotal = 0;
  private readonly backups = new Map<number, { backup: BackupInfo; plugged: string[] } | null>();
  private googleMisses = 0;
  private googleOff = false;

  constructor(
    private readonly deps: RestoreJobDeps,
    private readonly ctx: JobContext,
  ) {
    this.params = ctx.params as RestoreJobParams;
  }

  private warn(text: string): void {
    this.warned += 1;
    if (this.warned <= MAX_NOTES) this.ctx.warn(text);
    else if (this.warned === MAX_NOTES + 1) this.ctx.warn('More files were not brought back. They are counted in the report.');
  }

  async run(): Promise<string> {
    const { ctx, deps, params } = this;
    if (params?.pick === undefined || params.destination === undefined) throw new JobFailure('This restore is not valid. Nothing was copied.');
    ctx.progress(0, 0, { message: 'Making the list of files' });
    const { items, notAvailable } = await expandPick(deps, params, () => ctx.yield());
    if (items.length === 0) throw new JobFailure('There is nothing to bring back: the files are not on the backup any more. Nothing was copied.');

    // Held back before anything is copied.
    const go: RestoreItem[] = [];
    const counts0 = emptyCounts();
    for (const item of items) {
      const why = heldReason({ size: item.size, sha256: item.sha256, expected: item.expected, verifiedHow: item.verifiedHow });
      if (why === null) go.push(item);
      else {
        counts0[why] += 1;
        this.warn(`${item.destRel}: ${heldText(why)} It was not brought back.`);
      }
    }

    const resume = ctx.resume as Partial<Checkpoint> | null;
    this.cp = { ...emptyCheckpoint(), ...resume };
    if (resume === null) for (const k of ['no_checksum', 'differs'] as const) this.cp.counts[k] = counts0[k];
    this.cp.counts = { ...emptyCounts(), ...this.cp.counts };
    this.bytesTotal = go.reduce((sum, f) => sum + f.size, 0);
    if (this.cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(this.cp.next + 1, go.length)} of ${go.length}`);

    const dest = await this.prepareDestination();
    ctx.checkpoint(this.cp);
    for (let i = this.cp.next; i < go.length; i += 1) {
      const item = go[i]!;
      await ctx.yield();
      const outcome: RestoreOutcome = this.stopped ? 'no_space' : await this.copyOne(item, dest.folder, i, go.length);
      this.cp.counts[outcome] += 1;
      this.cp.bytesDone += item.size;
      if (outcome === 'copied') this.cp.copiedBytes += item.size;
      this.cp.next = i + 1;
      if (this.cp.next % CHECKPOINT_EVERY === 0) ctx.checkpoint(this.cp);
      ctx.progress(i + 1, go.length, { bytesDone: this.cp.bytesDone, bytesTotal: this.bytesTotal });
    }
    ctx.checkpoint(this.cp);
    return this.summary(dest.words, notAvailable);
  }

  /** The new folder (the first free name), or nothing for "back to where it was". */
  private async prepareDestination(): Promise<{ folder: string | null; words: string }> {
    const { params, ctx } = this;
    if (params.destination.mode === 'original') return { folder: null, words: 'back where they were' };
    const parent = params.destination.parent;
    const refused = protectedReason(parent);
    if (refused !== null) throw new JobFailure(refused);
    try {
      assertWritable(path.join(parent, '.guard'));
    } catch (err) {
      if (err instanceof DriveWriteProtectedError) throw new JobFailure(err.message);
      throw err;
    }
    if (this.cp.folder !== null && (await existsAsync(this.cp.folder))) return { folder: this.cp.folder, words: this.cp.folder };
    try {
      await fs.promises.mkdir(parent, { recursive: true });
    } catch {
      throw new JobFailure('The folder for the restored files could not be made. Nothing was copied.');
    }
    for (let n = 1; n < 1000; n += 1) {
      const folder = path.join(parent, numberedName(params.destination.folderName, n));
      try {
        await fs.promises.mkdir(folder); // not recursive: it fails when the name is taken, so an existing folder is never reused
        this.cp.folder = folder;
        ctx.log('info', `Put in the new folder ${folder}`);
        return { folder, words: folder };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new JobFailure('The folder for the restored files could not be made. Nothing was copied.');
      }
    }
    throw new JobFailure('Too many folders with that name already exist. Nothing was copied.');
  }

  private tmpDirOf(final: string, folder: string | null): string {
    if (this.deps.tmpDirFor) return this.deps.tmpDirFor(final);
    const work = folder !== null ? path.join(path.dirname(folder), '.work') : path.join(path.parse(path.resolve(final)).root, RESTORE_FOLDER, '.work');
    return driveTmpFolder(work);
  }

  private async baseOf(placeId: string): Promise<string | null> {
    if (!this.bases.has(placeId)) this.bases.set(placeId, await this.deps.baseOf(placeId));
    return this.bases.get(placeId) ?? null;
  }

  /** A backup and its drives that are plugged in right now, the T7 first (asked once per backup). */
  private async backupOf(backupId: number): Promise<{ backup: BackupInfo; plugged: string[] } | null> {
    if (!this.backups.has(backupId)) {
      const backup = loadBackup(this.deps.db, backupId);
      const plugged: string[] = [];
      if (backup) for (const d of preferredSources(backup.destinations)) if (((await this.baseOf(d.placeId)) ?? '') !== '') plugged.push(d.placeId);
      this.backups.set(backupId, backup ? { backup, plugged } : null);
    }
    return this.backups.get(backupId) ?? null;
  }

  private hold(item: RestoreItem, outcome: RestoreOutcome, text?: string): RestoreOutcome {
    this.warn(`${item.destRel}: ${text ?? HELD_WORDS[outcome as keyof typeof HELD_WORDS]} It was not brought back.`);
    return outcome;
  }

  /** One copy from a plugged-in drive, through the checked copy. */
  private async fromDrive(copy: Extract<RestoreCopy, { kind: 'drive' }>, item: RestoreItem, final: string, sha: string, tmpDir: string, index: number, total: number): Promise<Attempt> {
    const { ctx, deps } = this;
    const base = await this.baseOf(copy.placeId);
    const abs = base === null || base === '' ? null : absolutePathFor('drive', base, copy.rel);
    if (abs === null) return { fail: 'missing', text: HELD_WORDS.missing };
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return { fail: 'missing', text: HELD_WORDS.missing };
      if (st.size !== item.size) return { fail: 'damaged', text: HELD_WORDS.damaged };
    } catch {
      return { fail: 'missing', text: HELD_WORDS.missing };
    }
    try {
      const result = await verifiedCopy({
        source: abs,
        final,
        size: item.size,
        ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
        tmpDir,
        yieldNow: () => ctx.yield(),
        onProgress: (done, checking) => ctx.progress(index, total, { bytesDone: this.cp.bytesDone + (checking ? 0 : done), bytesTotal: this.bytesTotal, message: checking ? `Checking ${item.destRel}` : `Getting back ${item.destRel} (${index + 1} of ${total})` }),
        // The copy on the drive must still be what the index says it is.
        acceptSource: (h) => h.sha256 === sha,
      });
      if (result.ok) return { done: 'copied' };
      if (result.reason === 'source_changed') return { fail: 'damaged', text: HELD_WORDS.damaged };
      if (result.reason === 'exists') return { done: 'there' };
      if (result.reason === 'protected_name') return { fail: 'protected', text: HELD_WORDS.protected, stop: true };
      return { fail: 'failed', text: 'The copy did not match after it was written, so it was thrown away. Try again; if it repeats, check the drive.' };
    } catch (err) {
      if (err instanceof JobAborted || err instanceof DriveWriteProtectedError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw err;
      if (code === 'ENOENT' || code === 'EIO' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EMFILE' || code === 'ENOTDIR' || code === 'EEXIST') {
        return { fail: 'failed', text: `The file could not be read or written (${code}).` };
      }
      throw err;
    }
  }

  /** One Google copy: downloaded into the temp name, then checked and linked like every other copy. */
  private async fromGoogle(copy: Extract<RestoreCopy, { kind: 'google' }>, item: RestoreItem, final: string, sha: string, tmpDir: string, index: number, total: number): Promise<Attempt> {
    const { ctx, deps } = this;
    if (!deps.download) return { fail: 'missing', text: 'Google is not available here.' };
    if (this.googleOff) return { fail: 'missing', text: 'Google could not be reached, so it was not asked again.' };
    const tmp = tempPathFor(final, tmpDir);
    assertWritable(tmp);
    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
    try {
      await deps.download(copy.placeId, copy.extId, tmp, {
        size: item.size,
        signal: ctx.signal,
        yieldNow: () => ctx.yield(),
        onProgress: (done) => ctx.progress(index, total, { bytesDone: this.cp.bytesDone + done, bytesTotal: this.bytesTotal, message: `Downloading ${item.destRel} from Google (${index + 1} of ${total})` }),
      });
      this.googleMisses = 0;
    } catch (err) {
      await ownRemoveAsync(tmp).catch(() => undefined);
      if (err instanceof JobAborted) throw err;
      if (ctx.signal.aborted || err instanceof RequestAborted) throw new JobAborted();
      return this.googleFailure(err);
    }
    if (item.mtime !== null) await fs.promises.utimes(tmp, new Date(), new Date(item.mtime)).catch(() => undefined);
    ctx.progress(index, total, { bytesDone: this.cp.bytesDone, bytesTotal: this.bytesTotal, message: `Checking ${item.destRel}` });
    const adopted = await adoptVerifiedTemp({ tmp, final, size: item.size, expectedSha256: sha, yieldNow: () => ctx.yield() });
    if (adopted.ok) return { done: 'copied' };
    if (adopted.reason === 'exists') return { done: 'there' };
    if (adopted.reason === 'protected_name') return { fail: 'protected', text: HELD_WORDS.protected, stop: true };
    return { fail: 'damaged', text: "The copy in Google does not match the checksum, so it was thrown away." };
  }

  private googleFailure(err: unknown): Attempt {
    if (err instanceof NeedsSignInError || err instanceof VaultNotReadyError) {
      this.googleMisses += 1;
      this.giveUpGoogleIfNeeded();
      return { fail: 'missing', text: 'The Google account is not signed in. Sign in again in Settings, then try again.' };
    }
    if (err instanceof NetworkError) {
      this.googleMisses += 1;
      this.giveUpGoogleIfNeeded();
      return { fail: 'missing', text: 'Google could not be reached.' };
    }
    if (err instanceof GoogleApiError && err.status === 404) return { fail: 'missing', text: 'Google does not have this file any more.' };
    if (err instanceof DownloadShortError) return { fail: 'damaged', text: 'The file from Google was not the size it should be, so it was thrown away.' };
    if (err instanceof GoogleApiError) return { fail: 'failed', text: err.message };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') throw err;
    return { fail: 'failed', text: typeof code === 'string' ? `The file from Google could not be written (${code}).` : 'The file could not be got from Google.' };
  }

  private giveUpGoogleIfNeeded(): void {
    if (this.googleMisses >= GOOGLE_GIVE_UP && !this.googleOff) {
      this.googleOff = true;
      this.warn('Google could not be reached (or is not signed in), so files that only Google has were not brought back.');
    }
  }

  private async copyOne(item: RestoreItem, folder: string | null, index: number, total: number): Promise<RestoreOutcome> {
    const { ctx, deps } = this;
    const sha = knownSha(item);
    if (sha === null) return this.hold(item, 'no_checksum');

    let final: string;
    if (folder !== null) {
      const parts = safeParts(item.destRel);
      final = parts === null ? '' : path.join(folder, ...parts);
      if (parts === null || path.relative(folder, final).startsWith('..')) return this.hold(item, 'failed', 'The name of this file cannot be kept here.');
    } else {
      if (item.original === null) return this.hold(item, 'failed', 'This file cannot be put back where it was.');
      final = item.original;
    }
    const refused = protectedReason(final);
    if (refused !== null) return this.hold(item, 'protected', refused);

    try {
      assertWritable(final);
      await fs.promises.mkdir(path.dirname(final), { recursive: true });
      const tmpDir = this.tmpDirOf(final, folder);
      if (await existsAsync(final)) {
        // Never replaced. A file that a cut-off run linked but did not finish is finished first; then it stays as it is.
        await settleLeftover(final, {
          tmpDir,
          isExpected: async () => {
            const h = await hashFileOnce(final, { ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }), yieldNow: () => ctx.yield() });
            return h.sha256 === sha;
          },
        });
        ctx.log('info', `${item.destRel} is already there, kept as it is`);
        return 'there';
      }
      await sweepStaleTemps(tmpDir);
      const free = await deps.freeBytes(path.dirname(final));
      if (free !== null && free - item.size < LOCAL_MIN_FREE_BYTES) return this.noRoom();

      const known = await this.backupOf(item.backupId);
      const copies = known ? copiesOf(deps.db, known.backup, item, known.plugged, sha, deps.download !== undefined) : [];
      if (copies.length === 0) return this.hold(item, 'missing', NO_COPY_WORDS);
      const failures: { fail: RestoreOutcome; text: string }[] = [];
      for (const [n, copy] of copies.entries()) {
        const attempt = copy.kind === 'drive' ? await this.fromDrive(copy, item, final, sha, tmpDir, index, total) : await this.fromGoogle(copy, item, final, sha, tmpDir, index, total);
        if ('done' in attempt) {
          if (attempt.done === 'there') return 'there';
          if (copy.kind === 'google') this.cp.fromGoogle += 1;
          else if (n > 0) this.cp.fromNextCopy += 1;
          if (n > 0) ctx.log('info', `${item.destRel}: the first copy could not be used, so the ${copy.kind === 'google' ? 'copy in Google' : 'next copy'} was used`);
          ctx.log('info', `${item.destRel}: brought back and checked against its SHA-256`);
          return 'copied';
        }
        failures.push(attempt);
        if (attempt.stop) break;
      }
      const worst = WORST.map((k) => failures.find((f) => f.fail === k)).find((f) => f !== undefined) ?? failures[0]!;
      const other = failures.find((f) => f.fail === 'protected');
      const chosen = other ?? worst;
      return this.hold(item, chosen.fail, failures.length > 1 && !other ? `No copy could be used (${[...new Set(failures.map((f) => f.text))].join(' ')})` : chosen.text);
    } catch (err) {
      if (err instanceof JobAborted) throw err;
      if (err instanceof DriveWriteProtectedError) return this.hold(item, 'protected', err.message);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') return this.noRoom();
      if (code === 'ENOENT' || code === 'EIO' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EMFILE' || code === 'ENOTDIR' || code === 'EEXIST') {
        return this.hold(item, 'failed', `The file could not be read or written (${code}).`);
      }
      throw err;
    }
  }

  private noRoom(): RestoreOutcome {
    this.stopped = true;
    this.warn('There is no room left where the files go. The rest were not brought back.');
    return 'no_space';
  }

  private summary(where: string, notAvailable: number): string {
    const { ctx } = this;
    const c = this.cp.counts;
    const held = c.no_checksum + c.differs + c.damaged + c.missing + c.protected + c.failed + c.no_space;
    const bits: string[] = [];
    if (c.copied > 0) {
      const from = [this.cp.fromGoogle > 0 ? `${this.cp.fromGoogle.toLocaleString('en-US')} from Google` : '', this.cp.fromNextCopy > 0 ? `${this.cp.fromNextCopy.toLocaleString('en-US')} from the next drive because the first copy did not match` : ''].filter((s) => s !== '');
      bits.push(`Got back ${filesText(c.copied)} (${bytesText(this.cp.copiedBytes)})${from.length > 0 ? `, ${from.join(', ')}` : ''}`);
    }
    if (c.there > 0) bits.push(`${filesText(c.there)} already there, kept as ${c.there === 1 ? 'it is' : 'they are'}`);
    if (held > 0) bits.push(`${filesText(held)} not brought back (${reasonsText(c)})`);
    if (notAvailable > 0) bits.push(`${filesText(notAvailable)} not on a drive of this backup`);
    const line = bits.join('. ');
    if (c.copied === 0 && c.there === 0) throw new JobFailure(`${line === '' ? 'Nothing was brought back' : line}. Nothing was copied. See the warnings above.`);
    ctx.log('info', line);
    return `${line}. ${where === 'back where they were' ? 'Files already there were not touched.' : `Put in ${where}.`} Nothing was overwritten or deleted.`;
  }
}
