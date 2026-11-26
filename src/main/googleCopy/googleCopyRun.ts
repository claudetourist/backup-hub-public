/**
 * The run of "Copy to Google" (job `google.copy`): the files of one backup that the person ticked are sent to Google accounts, up to 6 at the same time
 * (GOOGLE_COPY_AT_ONCE) and up to 4 into the same account (GOOGLE_COPY_PER_ACCOUNT), and a file only counts once Google's own checksum says it arrived whole. The files are handed out in the upload order, by one dispatcher: it reserves the file's size
 * in its account BEFORE the file is read or sent (so files picked together, also several into one account, can never overfill the 25% keep-free line) and gives the room back when the
 * file is not sent. When the ticked accounts have no room the dispatcher first lets the files on their way finish, then asks the person. Per file:
 *   1. already on Google (same SHA-256 in a checked Google row)? skipped.
 *   2. an account with room for the WHOLE file while it stays at or below 75% used (never split), not busy with another file; none: the copy waits (needs you).
 *   3. the copy on the T7 is read ONCE, as the chunks for the upload (SHA-256 and MD5 are worked out on the hashing worker while they are read): its SHA-256
 *      must equal the file list's. A file that fits in one chunk is checked BEFORE anything is sent (a damaged copy is never sent); a bigger file is checked
 *      when its last chunk is read: a mismatch is not counted and not recorded (it is in Google; nothing is deleted).
 *   4. the folders "Backup Hub / <backup name> / ..." are made in the account first; if that fails the file is stopped, never put in the root.
 *   5. a resumable upload: a NEW read stream for every try of a chunk, waits of 1, 2, 4 ... seconds that honour Retry-After, and Google is asked how far it
 *      got after a failure before anything is sent again.
 *   6. Google's md5Checksum and size must equal the MD5 and size read in step 3: else the file is NOT counted, nothing is deleted, the report says so.
 *   7. only then the row of the Google copy is written (the contract in shared/googleCopy.ts).
 * Pause, Stop and Continue come from the job service (every wait goes through `ctx.yield()`): a pause holds the files on their way at their next chunk
 * (each chunk is read again from the file, so a continue sends the rest from where Google says it got) and starts no new one; a stop aborts them and
 * nothing is recorded for a file that did not finish. Nothing in Google is ever deleted or changed.
 */
import path from 'node:path';
import type { Db } from '../db';
import { ACCOUNT_ROOM_STALE_MS, ACCOUNTS_FULL_MESSAGE, accountRoomBytes, chooseAccount, GOOGLE_COPY_AT_ONCE, GOOGLE_COPY_PER_ACCOUNT, kindRank, Placer, type GoogleCopyReport, type GoogleSentLine, type PoolAccount } from '../../shared/googleCopy';
import type { FileKind } from '../../shared/fileKinds';
import { NeedsSignInError, VaultNotReadyError, type GoogleAuth } from '../google/auth';
import type { DriveUploader } from '../google/driveUpload';
import { backoffDelayMs, GoogleApiError, isRetryable, NetworkError, RequestAborted, type GoogleHttp } from '../google/googleHttp';
import { safeMessage } from '../google/redact';
import { DEFAULT_CHUNK_BYTES, MAX_FAILURES_IN_A_ROW, nextChunkLength } from '../google/uploadModel';
import { JobAborted, JobFailure, type JobServiceLogger } from '../jobs/jobService';
import { lines, note, type Reasons } from '../mirror/mirrorRun';
import type { MirrorCtx } from '../mirror/mirrorTypes';
import { finishSliced, sortSteps, type Steps } from '../sliceWork';
import { readChunk } from './chunkRead';
import { FolderMaker } from './folderMaker';
import { StreamHash } from './streamHash';
import { candidatesSteps, googleFolderPath, isOnGoogle, recordGoogleCopy, safeName, type BackupSource, type Candidate } from './googleCopyStore';

export const DRIVE_TROUBLE = new Set(['EIO', 'ENODEV', 'ENXIO', 'UNKNOWN', 'ENOTCONN', 'EBUSY']);
/** A reason Google gives when an account is full or has used its day's upload allowance: that account takes no more files in this run. */
const FULL_REASONS = new Set(['storageQuotaExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'teamDriveFileLimitExceeded']);
/** This many files in a row that failed for lack of internet: the job stops instead of trying the whole list. */
const NETWORK_FAILS_IN_A_ROW = 3;
const PROGRESS_MS = 400;
/** The drive's folder on this PC is asked again after this long. */
const ROOT_TTL_MS = 30_000;
/** The upload sessions and offsets of the files on their way are written to the checkpoint at most this often (the session start, a finished file and a Pause always write at once). */
const FLIGHT_SAVE_MS = 2000;

export interface HashResult {
  sha256: string;
  md5: string | null;
  bytes: number;
}

export interface GoogleCopyDeps {
  db: Db;
  log: JobServiceLogger;
  uploader: Pick<DriveUploader, 'findFolder' | 'createFolder' | 'startSession' | 'putChunk' | 'status'>;
  auth: Pick<GoogleAuth, 'assertVaultReady' | 'hasRefreshToken'>;
  http: Pick<GoogleHttp, 'wait'>;
  /** Limit and usage of an account right now (limit null = unlimited), or null when Google could not be asked. */
  room(placeId: string, signal: AbortSignal): Promise<{ limit: number | null; usage: number | null; usageInDrive?: number | null; usageInDriveTrash?: number | null } | null>;
  /** Accounts the person confirmed AFTER the copy started (when the first ones were full). Never anything the person did not tick. */
  laterAccounts?(): { placeId: string; label: string }[];
  /** The drive's root on this PC while it is plugged in, else null. */
  driveRoot(placeId: string): Promise<string | null>;
  /** SHA-256 and MD5 of a file read as a stream; the hashing is not done on the main thread. */
  hashFile(file: string, yieldNow: () => Promise<void>): Promise<HashResult>;
  fileSize(file: string): Promise<number | null>;
  /** One chunk as a new stream (default: chunkRead.readChunk). */
  readChunk?: (file: string, offset: number, length: number, signal?: AbortSignal) => Promise<Buffer<ArrayBuffer>>;
  /** The live per-account numbers (files on their way included), for the window; called often, keep it cheap. */
  sentLive?: (lines: GoogleSentLine[]) => void;
  /** The same numbers of checked files only, called right after each recorded file: they are written down and survive a restart. */
  sentSaved?: (lines: GoogleSentLine[]) => void;
  now?: () => number;
  chunkBytes?: number;
  keepAwake?: () => () => void;
}

/**
 * A file on its way to Google, as the checkpoint keeps it so a closed app or a restarted laptop does not start a multi-GB file from zero: the file's key (its T7
 * file row id), the account, Google's upload session address, the file's size and the bytes Google had confirmed when this was saved. The session address is
 * secret-like: it is never logged. Google's own answer ("how far did you get?") is what counts when the copy carries on; `sent` is only a note.
 */
export interface InFlightFile {
  key: number;
  accountId: string;
  sessionUri: string;
  size: number;
  sent: number;
}

export interface GoogleCopyCheckpoint {
  copied: { files: number; bytes: number };
  alreadyThere: number;
  /** Files that are repeats of another file of this copy (the same picture in another phone backup): the content is sent once. */
  repeats: number;
  heldBack: Reasons;
  failed: Reasons;
  noRoom: { files: number; bytes: number };
  mismatches: number;
  perAccount: Record<string, { label: string; files: number; bytes: number }>;
  segments: number;
  /** Files on their way when this was saved (empty after a Stop). Missing in checkpoints of older builds. */
  inFlight: InFlightFile[];
}

/** What a Stop keeps of a checkpoint: the counts, but no file on its way (a Stop is abrupt; the upload addresses are forgotten). */
export const withoutInFlight = (resume: unknown): unknown => (resume !== null && typeof resume === 'object' ? { ...resume, inFlight: [] } : resume);

export const emptyCheckpoint = (): GoogleCopyCheckpoint => ({ copied: { files: 0, bytes: 0 }, alreadyThere: 0, repeats: 0, heldBack: {}, failed: {}, noRoom: { files: 0, bytes: 0 }, mismatches: 0, perAccount: {}, segments: 0, inFlight: [] });

/** This account takes no more files in this run. */
class AccountFull extends Error {}
/** The copy on the drive does not match its saved checksum and nothing was sent yet. */
class DamagedCopy extends Error {}
/** The file could not be read from the drive (gone, unreadable): it is held back. */
class ReadProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Where the time of one file went (milliseconds), logged once per file. */
interface Timing {
  readMs: number;
  sessionMs: number;
  uploadMs: number;
  folderMs: number;
}
/** Google refused or kept failing: this file is not sent now (it is tried again at the next run). */
class FileNotSent extends Error {
  constructor(
    message: string,
    readonly network: boolean,
  ) {
    super(message);
  }
}

interface Account extends PoolAccount {
  label: string;
  /** When its room was last asked from Google (ms). */
  checkedAt: number;
  /** Bytes of files that are in this account (sent in this run): an answer of Google that was asked while they were on their way may or may not hold them. */
  landed: number;
}

export interface GoogleItem extends Candidate {
  /** The folders in Google for this file (top first). */
  folders: string[];
}

export function reportOf(cp: GoogleCopyCheckpoint, stopped: boolean): GoogleCopyReport {
  return {
    copied: cp.copied,
    alreadyThere: cp.alreadyThere,
    repeats: cp.repeats,
    heldBack: lines(cp.heldBack),
    failed: lines(cp.failed),
    noRoom: cp.noRoom,
    mismatches: cp.mismatches,
    perAccount: Object.values(cp.perAccount).map((a) => ({ label: a.label, files: a.files, bytes: a.bytes })).toSorted((a, b) => b.bytes - a.bytes),
    stopped,
  };
}

/** The upload order: camera videos, WhatsApp videos, other videos, screenshots, photos, the rest; the biggest files first inside a kind. */
/** "Fit what I have room for" order: the biggest files first, whatever their kind. */
export const biggestFirst = (a: Pick<Candidate, 'size' | 'rel'>, b: Pick<Candidate, 'size' | 'rel'>): number => b.size - a.size || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

export const uploadOrder = (a: Pick<Candidate, 'kind' | 'size' | 'rel'>, b: Pick<Candidate, 'kind' | 'size' | 'rel'>): number => kindRank(a.kind) - kindRank(b.kind) || b.size - a.size || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/** A file on its way: the account that holds its reserved room, and how far it got. */
interface Task {
  account: Account;
  item: GoogleItem;
  index: number;
  name: string;
  /** Bytes of this file Google has confirmed so far. */
  sent: number;
  message: string;
  /** Files ask Google for their upload session in the order they were handed out (the biggest first stays true): `prev` is the file before, `release` lets the next one go. */
  start: { prev: Promise<void>; release: () => void };
  /** The upload this file had on its way when the copy was closed: carried on from where Google has it, when its account still has room. */
  saved?: InFlightFile | undefined;
  /** Bytes of this file Google already held before this part of the copy (a carried-on upload): they are not counted as progress or speed of this part. */
  credit: number;
  /** The file is in Google (whatever the checks after it say): its bytes were sent in this part. */
  landed: boolean;
}

/** The files that fit the accounts, in their order: each file is put through the plan and kept only when it went into an account ("fit what I have room for"). */
function* fitSteps<T extends { size: number }>(items: readonly T[], placer: Placer, out: T[]): Steps<void> {
  let n = 0;
  for (const item of items) {
    if (placer.put(item.size)) out.push(item);
    n += 1;
    if (n % 2000 === 0) yield;
  }
}

/** The files still to go put through the plan, a turn for the window every few thousand (the plan is the live line's "of 144 MB"). */
function* plannedSteps(items: readonly Candidate[], placer: Placer): Steps<void> {
  let n = 0;
  for (const item of items) {
    placer.put(item.size);
    n += 1;
    if (n % 2000 === 0) yield;
  }
}

export class GoogleCopyRun {
  private readonly cp: GoogleCopyCheckpoint;
  private readonly now: () => number;
  private readonly folders: FolderMaker;
  private pool: Account[] = [];
  /** Every account that was ticked (in the pool or not): a later confirmed account is measured once. */
  private readonly known = new Set<string>();
  private readonly dead = new Set<string>();
  /** Stops the files on their way when one of them fails for good (or the dispatcher fails); joined with the job's own stop signal. */
  private readonly halt = new AbortController();
  private readonly signal: AbortSignal;
  /** The first error that ends the run (a stop, a failure): thrown by the dispatcher after every file on its way has settled. */
  private fatal: unknown = null;
  /** Files on their way per account: an account takes up to GOOGLE_COPY_PER_ACCOUNT at a time. */
  private readonly onWay = new Map<string, number>();
  /** The drive's folder on this PC, asked at most every ROOT_TTL_MS (not once per file). */
  /** Settles when the file handed out last has asked for its upload session. */
  private lastStart: Promise<void> = Promise.resolve();
  private rootCache: { at: number; root: string | null } | null = null;
  private readonly running = new Map<Task, Promise<void>>();
  /** SHA-256 of the files on their way: two equal files are never sent together. */
  private readonly shas = new Set<string>();
  /** Files whose account turned out full or signed out: they go again into another ticked account. */
  private readonly redo: { item: GoogleItem; index: number }[] = [];
  /** What each account is planned to get in all (bytes), for the live line (the same plan as the capacity screen's "will get"). */
  private readonly toSend = new Map<string, number>();
  private bytesTotal = 0;
  private bytesFinished = 0;
  private filesFinished = 0;
  private fileTotal = 0;
  private networkFails = 0;
  private lastProgress = 0;
  /** The files on their way right now (what the checkpoint keeps), by T7 file row id. */
  private readonly flight = new Map<number, InFlightFile>();
  /** Files that were on their way when the copy was closed and are not handed out yet: kept in the checkpoint until they are. */
  private readonly savedFlights = new Map<number, InFlightFile>();
  private lastFlightSave = 0;

  constructor(
    private readonly deps: GoogleCopyDeps,
    private readonly ctx: MirrorCtx,
    private readonly src: BackupSource,
    private readonly kinds: ReadonlySet<FileKind>,
    private readonly accountIds: readonly { placeId: string; label: string }[],
    resume: Partial<GoogleCopyCheckpoint> | null,
    private readonly options: { onlyOnPhone?: boolean; fitBiggest?: boolean } = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.cp = { ...emptyCheckpoint(), ...resume };
    this.cp.segments += 1;
    this.signal = AbortSignal.any([ctx.signal, this.halt.signal]);
    this.folders = new FolderMaker(deps.uploader, () => this.turn());
  }

  /** The partial report of a run that stopped (a stop, a failure): what was done so far. */
  partialReport(): GoogleCopyReport {
    return reportOf(this.cp, true);
  }

  async execute(): Promise<GoogleCopyReport> {
    const { deps, ctx } = this;
    const release = deps.keepAwake?.();
    try {
      let items = await this.plan();
      await this.loadPool();
      if (this.options.fitBiggest === true) items = await this.fitting(items);
      items = this.loadSaved(items);
      // A Pause holds the job at a safe point: the sessions and offsets of the files on their way are saved first (the window then says "safe to close").
      ctx.beforeHold?.(() => this.save());
      this.fileTotal = items.length;
      this.bytesTotal = items.reduce((s, i) => s + i.size, 0);
      ctx.log('info', `${items.length} files (${Math.round(this.bytesTotal / 1e6)} MB) to send, ${this.pool.length} accounts with room`);
      await this.planSends(items);
      deps.sentSaved?.(this.lines(false));
      await this.dispatch(items);
      return reportOf(this.cp, false);
    } finally {
      release?.();
    }
  }

  /**
   * The files that were on their way when the last part of this copy was closed: only those still in the list (not on Google yet) and with the size they had. They
   * go first, so their upload sessions do not run out. Anything else in the old checkpoint is forgotten (Google drops an unfinished session by itself).
   */
  private loadSaved(items: readonly GoogleItem[]): GoogleItem[] {
    const wanted = new Map(this.cp.inFlight.map((f) => [f.key, f]));
    this.savedFlights.clear();
    for (const item of items) {
      const f = wanted.get(item.id);
      if (f !== undefined && f.size === item.size && typeof f.sessionUri === 'string' && f.sessionUri !== '') this.savedFlights.set(item.id, f);
    }
    this.cp.inFlight = [...this.savedFlights.values()];
    if (this.savedFlights.size === 0) return [...items];
    this.ctx.log('info', `${this.savedFlights.size} files were on their way when the copy was closed: they carry on from where Google has them.`);
    return [...items.filter((i) => this.savedFlights.has(i.id)), ...items.filter((i) => !this.savedFlights.has(i.id))];
  }

  /** Writes the checkpoint with the files on their way (and the saved ones not handed out yet). */
  private save(): void {
    this.cp.inFlight = [...this.flight.values(), ...this.savedFlights.values()].map((f) => Object.assign({}, f));
    this.lastFlightSave = this.now();
    this.ctx.checkpoint(this.cp);
  }

  private saveSoon(): void {
    if (this.now() - this.lastFlightSave >= FLIGHT_SAVE_MS) this.save();
  }

  private async plan(): Promise<GoogleItem[]> {
    const { deps, ctx, src } = this;
    const stats = { repeats: 0 };
    const list = await finishSliced(candidatesSteps(deps.db, src, this.kinds, this.options.onlyOnPhone === true, stats), () => ctx.yield());
    if (this.cp.segments === 1) this.cp.repeats = stats.repeats; // counted once, at the first part of the copy
    await finishSliced(sortSteps(list, this.options.fitBiggest === true ? biggestFirst : uploadOrder), () => ctx.yield());
    return list.map((c) => Object.assign(c, { folders: googleFolderPath(src.name, c.rel) }));
  }

  /**
   * "Fit what I have room for": of the files (biggest first) only those the ticked accounts can take now are sent, chosen with the same placement rule as the
   * capacity screen's plan, on the rooms just measured. The rest are not sent in this copy (they wait for another account) and are not counted anywhere.
   */
  private async fitting(items: readonly GoogleItem[]): Promise<GoogleItem[]> {
    const placer = new Placer(this.pool.map((a) => ({ placeId: a.placeId, label: a.label, email: null, limit: null, usage: null, room: a.room })), true);
    const chosen: GoogleItem[] = [];
    await finishSliced(fitSteps(items, placer, chosen), () => this.ctx.yield());
    const left = placer.result();
    this.ctx.log('info', `Biggest first as far as it fits: ${chosen.length} of ${items.length} files; ${left.waitingFiles ?? 0} wait for another account.`);
    return chosen;
  }

  /** What each account would get of the files still to go (the placement rule on a copy of the rooms), added to what it was sent in earlier parts of this copy. */
  private async planSends(items: readonly GoogleItem[]): Promise<void> {
    const placer = new Placer(this.pool.map((a) => ({ placeId: a.placeId, label: a.label, email: null, limit: null, usage: null, room: a.room })));
    await finishSliced(plannedSteps(items, placer), () => this.ctx.yield());
    const ahead = new Map(placer.result().lines.map((l) => [l.placeId, l.bytes]));
    for (const a of this.pool) this.toSend.set(a.placeId, (this.cp.perAccount[a.placeId]?.bytes ?? 0) + (ahead.get(a.placeId) ?? 0));
  }

  /** The accounts that can take files now, with the room each has right now (asked from Google; an account Google cannot be asked about is not used). */
  private async loadPool(): Promise<void> {
    const out: Account[] = [];
    for (const a of this.accountIds) {
      this.known.add(a.placeId);
      const account = await this.measure(a);
      if (account) out.push(account);
    }
    this.pool = out;
  }

  /** One account's room now, or null when it cannot be used (needs signing in, Google did not say). */
  private async measure(a: { placeId: string; label: string }): Promise<Account | null> {
    const { deps, ctx } = this;
    await ctx.yield();
    let room: { limit: number | null; usage: number | null } | null = null;
    try {
      room = await deps.room(a.placeId, ctx.signal);
    } catch (err) {
      if (err instanceof RequestAborted || ctx.signal.aborted) throw new JobAborted();
      if (err instanceof NeedsSignInError) {
        ctx.log('warn', `${a.label} needs signing in again, so it is not used.`);
        return null;
      }
      room = null;
    }
    if (room === null) {
      ctx.log('warn', `Google did not say how much room ${a.label} has, so it is not used in this run.`);
      return null;
    }
    return { placeId: a.placeId, label: a.label, room: accountRoomBytes(room.limit, room.usage), checkedAt: this.now(), landed: 0 };
  }

  /** Bytes reserved in this account for the files on their way (they are not in Google's numbers yet). */
  private reservedIn(placeId: string): number {
    let sum = 0;
    for (const task of this.running.keys()) if (task.account.placeId === placeId) sum += task.item.size;
    return sum;
  }

  /**
   * Asks Google again how much room this account has. Google's answer does not know the files on their way, so what is reserved for them is taken off
   * again, and so is whatever landed in the account while the question was out (it may or may not be in the answer: never count it as room). A failed
   * question keeps the old number and tries again after the stale time.
   */
  private async recheck(a: Account): Promise<void> {
    const { deps, ctx } = this;
    try {
      const landedBefore = a.landed;
      const room = await deps.room(a.placeId, ctx.signal);
      if (room) a.room = Math.max(0, accountRoomBytes(room.limit, room.usage) - this.reservedIn(a.placeId) - (a.landed - landedBefore));
    } catch (err) {
      if (err instanceof RequestAborted || ctx.signal.aborted) throw new JobAborted();
      if (err instanceof NeedsSignInError) {
        this.dead.add(a.placeId);
        ctx.warn(`${a.label} needs signing in again, so it is not used for the rest of this run.`);
      } else ctx.log('warn', `Google did not say how much room ${a.label} has now; the last answer is used.`);
    } finally {
      a.checkedAt = this.now();
    }
  }

  /** The ticked accounts have no room for the next file and no file is on its way: the copy waits for the person (never another account on its own), then measures every account again. */
  private async askForMore(): Promise<void> {
    const { deps, ctx } = this;
    await ctx.needsYou(ACCOUNTS_FULL_MESSAGE, ['Continue']);
    for (const later of deps.laterAccounts?.() ?? []) {
      if (this.known.has(later.placeId)) continue;
      this.known.add(later.placeId);
      const account = await this.measure(later);
      if (account) this.pool.push(account);
    }
    for (const a of this.live()) await this.recheck(a);
    // The plan for the live line follows the accounts the person added.
    for (const a of this.pool) if (!this.toSend.has(a.placeId)) this.toSend.set(a.placeId, this.cp.perAccount[a.placeId]?.bytes ?? 0);
  }

  private live(): Account[] {
    return this.pool.filter((a) => !this.dead.has(a.placeId));
  }

  /** Resolves when one file on its way has settled. Never rejects. */
  private async anyDone(): Promise<void> {
    if (this.running.size > 0) await Promise.race(this.running.values());
  }

  private checkFatal(): void {
    if (this.fatal !== null) throw this.fatal;
    if (this.ctx.signal.aborted) throw new JobAborted();
  }

  /** The run ends with this error (the first one wins); the files on their way are told to stop. */
  private failWith(err: unknown): void {
    if (this.fatal === null) this.fatal = err;
    this.halt.abort();
  }

  /** A turn for the window and the pause / stop point; a file on its way also stops when another one failed for good. */
  private async turn(): Promise<void> {
    await this.ctx.yield();
    if (this.halt.signal.aborted) throw new JobAborted();
  }

  /**
   * The account for a file of this size, and its size reserved there: among the ticked accounts that have no file on their way, the one with the least
   * room that still fits it. A free place for a new file means fewer than 3 on their way. When only an account that is busy has room, or when none has
   * room but files are still on their way (a failure gives its room back), it waits for one of them to finish; only with nothing on its way does it ask
   * the person. Asks Google again when the account's last answer is old. A file with a saved upload (`prefer` = its account) goes back into that same
   * account when the account still has room for it (re-reserved like any file); when it has not, the file starts fresh in another ticked account (`resumed` false).
   */
  private async acquire(item: GoogleItem, prefer?: string): Promise<{ account: Account; resumed: boolean }> {
    let keepPrefer = prefer !== undefined;
    for (;;) {
      this.checkFatal();
      if (this.running.size >= GOOGLE_COPY_AT_ONCE) {
        await this.anyDone();
        continue;
      }
      if (keepPrefer) {
        const mine = this.live().find((x) => x.placeId === prefer);
        if (mine === undefined || mine.room < item.size) {
          keepPrefer = false; // no room there any more: a fresh start elsewhere
          continue;
        }
        if ((this.onWay.get(mine.placeId) ?? 0) >= GOOGLE_COPY_PER_ACCOUNT) {
          await this.anyDone();
          continue;
        }
        if (this.now() - mine.checkedAt >= ACCOUNT_ROOM_STALE_MS) {
          await this.recheck(mine);
          continue;
        }
        mine.room -= item.size; // reserved before anything is read or sent
        this.onWay.set(mine.placeId, (this.onWay.get(mine.placeId) ?? 0) + 1);
        return { account: mine, resumed: true };
      }
      const a = chooseAccount(item.size, this.live().filter((x) => (this.onWay.get(x.placeId) ?? 0) < GOOGLE_COPY_PER_ACCOUNT));
      if (a !== null) {
        if (this.now() - a.checkedAt >= ACCOUNT_ROOM_STALE_MS) {
          await this.recheck(a);
          continue;
        }
        a.room -= item.size; // reserved before anything is read or sent
        this.onWay.set(a.placeId, (this.onWay.get(a.placeId) ?? 0) + 1);
        return { account: a, resumed: false };
      }
      if (this.running.size > 0) {
        await this.anyDone();
        continue;
      }
      await this.askForMore();
    }
  }

  private async dispatch(items: readonly GoogleItem[]): Promise<void> {
    const { deps, ctx, cp } = this;
    let next = 0;
    try {
      for (;;) {
        this.checkFatal();
        await ctx.yield();
        const entry = this.redo.shift() ?? (next < items.length ? { item: items[next]!, index: next++ } : null);
        if (entry === null) {
          if (this.running.size === 0) break;
          await this.anyDone();
          continue;
        }
        const { item, index } = entry;
        // Two equal files are never on their way together: the second waits and is then seen as already there.
        while (this.shas.has(item.sha256)) {
          await this.anyDone();
          this.checkFatal();
        }
        if (isOnGoogle(deps.db, item.sha256)) {
          cp.alreadyThere += 1;
          this.finish(item, null);
          continue;
        }
        const saved = this.savedFlights.get(item.id);
        const { account, resumed } = await this.acquire(item, saved?.accountId);
        this.savedFlights.delete(item.id);
        this.begin({ account, item, index, name: item.rel.slice(item.rel.lastIndexOf('/') + 1), sent: 0, message: '', saved: resumed ? saved : undefined });
      }
    } catch (err) {
      this.failWith(err);
    }
    await Promise.allSettled(this.running.values());
    if (this.fatal !== null) throw this.fatal;
  }

  /** Starts a file on its way. Its promise never rejects: a failure for good is kept in `fatal` and stops the others. */
  private begin(input: Omit<Task, 'start' | 'credit' | 'landed'>): void {
    const prev = this.lastStart;
    let release = (): void => {};
    this.lastStart = new Promise<void>((resolve) => (release = resolve));
    const task: Task = { ...input, credit: 0, landed: false, start: { prev, release } };
    this.shas.add(task.item.sha256);
    const settled = (async () => {
      await Promise.resolve(); // the promise is in `running` before anything below can finish
      let outcome: 'done' | 'again' | 'failed';
      try {
        outcome = await this.work(task);
      } catch (err) {
        this.failWith(err);
        outcome = 'failed';
      } finally {
        this.onWay.set(task.account.placeId, Math.max(0, (this.onWay.get(task.account.placeId) ?? 0) - 1));
        this.shas.delete(task.item.sha256);
        this.flight.delete(task.item.id);
        this.running.delete(task);
        task.start.release(); // a file that never got to ask for a session must not hold the next ones
      }
      if (outcome === 'done') this.finish(task.item, task);
      else {
        this.setCredit(task, 0);
        if (outcome === 'again') this.redo.push({ item: task.item, index: task.index });
      }
    })();
    this.running.set(task, settled);
  }

  /** Bytes of the file that Google already held before this part (a carried-on upload) do not count as progress here: they also leave the total. */
  private setCredit(task: Task, bytes: number): void {
    this.bytesTotal += task.credit - bytes;
    task.credit = bytes;
  }

  /**
   * A file is settled (sent, skipped, held back or not sent): it counts in the files done and the checkpoint. The bytes done and the speed count only what
   * Google confirmed in this part of the copy: a file that was sent adds the bytes it sent; a file that was skipped (already there, held back, not sent)
   * adds none and leaves the total instead, so the percentage still reaches 100 without a burst of "speed".
   */
  private finish(item: GoogleItem, task: Task | null): void {
    if (task !== null && task.landed) this.bytesFinished += item.size - task.credit;
    else {
      if (task !== null) this.setCredit(task, 0);
      this.bytesTotal -= item.size;
    }
    this.filesFinished += 1;
    this.save();
    this.emit(`${this.filesFinished} of ${this.fileTotal} files`, true);
  }

  /** The status line: the one file on its way, or how many are on their way. */
  private say(task: Task, message: string, force = false): void {
    task.message = message;
    this.emit(null, force);
  }

  private emit(message: string | null, force: boolean): void {
    const t = this.now();
    if (!force && t - this.lastProgress < PROGRESS_MS) return;
    this.lastProgress = t;
    let sent = 0;
    for (const task of this.running.keys()) sent += Math.max(0, task.sent - task.credit);
    const tasks = [...this.running.keys()];
    const line = tasks.length > 1 ? `Sending ${tasks.length} files at once · ${this.filesFinished} of ${this.fileTotal} files done` : (tasks[0]?.message ?? message ?? `${this.filesFinished} of ${this.fileTotal} files`);
    this.ctx.progress(this.filesFinished, this.fileTotal, { bytesDone: this.bytesFinished + sent, bytesTotal: this.bytesTotal, message: line });
    this.deps.sentLive?.(this.lines(true));
  }

  /** Per account: what it was sent (checked files; with the part of the file on its way when `live`) and what it is planned to get. */
  private lines(live: boolean): GoogleSentLine[] {
    const ids = new Set<string>([...this.toSend.keys(), ...Object.keys(this.cp.perAccount)]);
    const out: GoogleSentLine[] = [];
    for (const placeId of ids) {
      const per = this.cp.perAccount[placeId];
      let bytes = per?.bytes ?? 0;
      if (live) for (const task of this.running.keys()) if (task.account.placeId === placeId) bytes += task.sent;
      out.push({ placeId, label: per?.label ?? this.pool.find((a) => a.placeId === placeId)?.label ?? placeId, files: per?.files ?? 0, bytes, toSend: Math.max(this.toSend.get(placeId) ?? 0, bytes) });
    }
    return out;
  }

  /** The drive's folder on this PC: kept for ROOT_TTL_MS instead of being asked for every file. Null when the drive is not plugged in. */
  private async rootNow(): Promise<string | null> {
    const t = this.now();
    if (this.rootCache !== null && t - this.rootCache.at < ROOT_TTL_MS) return this.rootCache.root;
    const root = await this.deps.driveRoot(this.src.placeId);
    this.rootCache = { at: t, root };
    return root;
  }

  /** A file could not be read: a drive that stopped answering stops the copy; a file that is gone or unreadable is held back. */
  private async readFailed(err: unknown): Promise<never> {
    const { src } = this;
    if (err instanceof JobAborted || err instanceof RequestAborted || this.signal.aborted) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (DRIVE_TROUBLE.has(code)) throw new JobFailure(`${src.placeLabel} stopped answering. Check the cable, then press Continue (or start again).`);
    this.rootCache = null; // the drive may have been unplugged: it is asked again
    if ((await this.rootNow()) === null) throw new JobFailure(`${src.placeLabel} is not plugged in any more. Plug it back in and press Continue (or start again): files already sent are not sent twice.`);
    throw new ReadProblem(code || 'read error');
  }

  /** One file, from the T7's copy to the row. 'again' = its account is full or signed out: it goes into another ticked account. */
  private async work(task: Task): Promise<'done' | 'again'> {
    const { deps, ctx, cp, src } = this;
    const { account, item, name } = task;
    const where = `(${task.index + 1} of ${this.fileTotal})`;
    const started = performance.now();
    const timing: Timing = { readMs: 0, sessionMs: 0, uploadMs: 0, folderMs: 0 };
    // The reserved room is given back unless the file is in Google (or the account is known full).
    let giveBack = true;
    try {
      const root = await this.rootNow();
      if (root === null) throw new JobFailure(`${src.placeLabel} is not plugged in any more. Plug it back in and press Continue (or start again): files already sent are not sent twice.`);
      const abs = path.join(root, ...(src.root + '/' + item.rel).split('/'));
      const size = await deps.fileSize(abs);
      if (size === null) return this.held(item, `It is not on ${src.placeLabel} any more.`);
      if (size !== item.size) return this.held(item, `It changed on ${src.placeLabel} after the list was made. The next look picks it up.`);
      try {
        const folderStart = performance.now();
        const parent = await this.folderFor(account, item.folders);
        timing.folderMs = performance.now() - folderStart;
        this.say(task, `Sending ${name} to Google ${where}`);
        const { file: done, hashed } = await this.send(task, parent, safeName(name), abs, timing);
        giveBack = false; // the file is in Google now, whatever the checks below say
        task.landed = true;
        account.landed += item.size;
        ctx.log('info', `Sent ${name} (${item.size} bytes) to ${account.label}: read and hash ${Math.round(timing.readMs)} ms, folders ${Math.round(timing.folderMs)} ms, session start ${Math.round(timing.sessionMs)} ms, upload ${Math.round(timing.uploadMs)} ms, ${Math.round(performance.now() - started)} ms in all`);
        if (hashed.sha256 !== item.sha256 || hashed.bytes !== item.size || hashed.md5 === null) {
          this.fail(item, `The copy on ${src.placeLabel} did not match its saved checksum when it was read for sending (it may be damaged or have changed), so it was not counted. It is in Google; nothing was deleted.`);
          return 'done';
        }
        if (done.size !== item.size || done.md5 === null || done.md5 !== hashed.md5) {
          cp.mismatches += 1;
          this.fail(item, done.md5 === null ? 'Google did not say the checksum of the file it received, so it was not counted. It is in Google; nothing was deleted.' : 'Google\'s copy came back different from the file on the drive, so it was not counted. It is in Google; nothing was deleted.');
          ctx.warn(`${name}: the copy in Google (${account.label}) does not match. Nothing was deleted.`);
          return 'done';
        }
        recordGoogleCopy(deps.db, {
          accountPlaceId: account.placeId,
          extId: done.id,
          pathInGoogle: [...item.folders, safeName(name)].join('/'),
          size: item.size,
          md5: done.md5,
          sha256: hashed.sha256,
          originFileId: item.id,
          mtime: item.mtime,
          kind: item.kind,
          now: this.now(),
          parentExtId: parent,
          name: safeName(name),
        });
        cp.copied.files += 1;
        cp.copied.bytes += item.size;
        const per = (cp.perAccount[account.placeId] ??= { label: account.label, files: 0, bytes: 0 });
        per.files += 1;
        per.bytes += item.size;
        task.sent = 0;
        deps.sentSaved?.(this.lines(false));
        this.networkFails = 0;
        return 'done';
      } catch (err) {
        if (err instanceof DamagedCopy) {
          ctx.warn(`${name}: the copy on ${src.placeLabel} does not match its saved checksum, so it was not sent.`);
          return this.held(item, `The copy on ${src.placeLabel} does not match its saved checksum (it may be damaged), so it was not sent. Check it with "Check old copies".`);
        }
        if (err instanceof ReadProblem) return this.held(item, `The file could not be read (${err.code}).`);
        if (err instanceof AccountFull) {
          account.room = 0;
          giveBack = false;
          ctx.log('warn', `${account.label} cannot take more files now (Google says it is full or its upload allowance for today is used).`);
          return 'again';
        }
        if (err instanceof NeedsSignInError) {
          this.dead.add(account.placeId);
          ctx.warn(`${account.label} needs signing in again, so it is not used for the rest of this run.`);
          return 'again';
        }
        if (err instanceof FileNotSent) {
          this.fail(item, err.message);
          if (err.network) {
            this.networkFails += 1;
            if (this.networkFails >= NETWORK_FAILS_IN_A_ROW) throw new JobFailure('The internet connection kept failing, so the copy stopped. Nothing was deleted and the files already sent are safe. Check the connection and start again: it carries on with what is left.');
          } else this.networkFails = 0;
          return 'done';
        }
        if (err instanceof VaultNotReadyError) throw new JobFailure(err.message);
        if (err instanceof RequestAborted) throw new JobAborted();
        throw err;
      }
    } finally {
      if (giveBack) account.room += item.size;
    }
  }

  private held(item: GoogleItem, reason: string): 'done' {
    note(this.cp.heldBack, reason, item.rel);
    return 'done';
  }

  private fail(item: GoogleItem, reason: string): void {
    note(this.cp.failed, reason, item.rel);
    this.ctx.warn(`${item.rel.slice(item.rel.lastIndexOf('/') + 1)}: ${reason}`);
  }

  /** The id of the folder "Backup Hub/<backup>/..." in the account, made when it is not there (once per path, even when asked together). Never the root: a failure stops the file. */
  private async folderFor(account: Account, segments: readonly string[]): Promise<string> {
    let parent: string;
    try {
      parent = await this.folders.ensure(account.placeId, segments, this.signal);
    } catch (err) {
      if (err instanceof NeedsSignInError || err instanceof VaultNotReadyError || err instanceof JobAborted || err instanceof RequestAborted) throw err;
      if (err instanceof GoogleApiError && FULL_REASONS.has(err.reason ?? '')) throw new AccountFull();
      throw new FileNotSent(`The folder could not be made in Google (${safeMessage(err)}), so the file was not sent.`, err instanceof NetworkError);
    }
    if (parent === 'root') throw new FileNotSent('There was no folder to put the file in, so it was not sent.', false);
    return parent;
  }

  /** The session of a file on its way is written to the checkpoint at once: it is what lets a closed app carry on instead of starting the file again. */
  private flightStart(task: Task, sessionUri: string, sent: number): void {
    this.flight.set(task.item.id, { key: task.item.id, accountId: task.account.placeId, sessionUri, size: task.item.size, sent });
    this.save();
  }

  /** Bytes of this file Google confirmed: kept for the checkpoint, written with it at most every FLIGHT_SAVE_MS. */
  private flightSent(task: Task, sent: number): void {
    const f = this.flight.get(task.item.id);
    if (f === undefined) return;
    f.sent = sent;
    this.saveSoon();
  }

  /**
   * One resumable upload with retries. Returns what Google says about the finished file and the checksums of the bytes that were read for it (the file
   * is read once: the hashing happens while the chunks are read). A file that fits in one chunk is read and checked BEFORE the session starts.
   */
  private async send(task: Task, parent: string, name: string, file: string, timing: Timing): Promise<{ file: { id: string; md5: string | null; size: number | null }; hashed: HashResult }> {
    const { deps } = this;
    const { account, item } = task;
    const signal = this.signal;
    const up = deps.uploader;
    const read = deps.readChunk ?? readChunk;
    const chunk = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const size = item.size;
    const hash = new StreamHash(size);
    /** A chunk, read as a NEW stream, and hashed on its way. */
    const readHashed = async (offset: number, length: number): Promise<Buffer<ArrayBuffer>> => {
      const t = performance.now();
      try {
        const bytes = await read(file, offset, length, signal);
        await hash.feed(offset, bytes);
        return bytes;
      } catch (err) {
        if (err instanceof JobAborted || err instanceof RequestAborted || err instanceof JobFailure || signal.aborted) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code === 'string' || (err instanceof Error && err.message === 'The file got shorter while it was being read.')) return this.readFailed(err);
        throw err;
      } finally {
        timing.readMs += performance.now() - t;
      }
    };
    const timed = async <T>(key: 'sessionMs' | 'uploadMs', work: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      try {
        return await work();
      } finally {
        timing[key] += performance.now() - t;
      }
    };
    /** The checksums of everything that was read; when the file was not seen whole and in order it is read once more. */
    const checksums = async (): Promise<HashResult> => {
      const streamed = await hash.finish();
      if (streamed !== null) return streamed;
      try {
        return await deps.hashFile(file, () => this.turn());
      } catch (err) {
        return this.readFailed(err);
      }
    };
    try {
      // A file that fits in one chunk is read and checked first: a damaged copy is never sent.
      let first: Buffer<ArrayBuffer> | null = null;
      if (size <= chunk) {
        first = await readHashed(0, size);
        const seen = await hash.finish();
        if (seen !== null && (seen.sha256 !== item.sha256 || seen.bytes !== item.size)) throw new DamagedCopy();
      }
      /** Reads again, from the drive, the part Google already holds (only to work out its SHA-256 and MD5: nothing of it is sent again). */
      const rebuild = async (upTo: number): Promise<void> => {
        for (let at = hash.position; at < upTo; ) {
          const length = nextChunkLength(upTo, at, chunk);
          await this.turn();
          await readHashed(at, length);
          at += length;
        }
      };
      let failures = 0;
      for (let restarts = 0; restarts < 3; restarts += 1) {
        try {
          task.sent = 0;
          this.setCredit(task, 0);
          await this.turn();
          // The upload this file had on its way when the copy was closed (first try only): Google is asked how far it got, no new session is started.
          const saved = restarts === 0 ? task.saved : undefined;
          let uri: string;
          let askFirst = false;
          if (saved !== undefined) {
            uri = saved.sessionUri;
            askFirst = true;
            task.sent = saved.sent;
            this.setCredit(task, Math.min(saved.sent, size));
            this.flightStart(task, uri, saved.sent);
            task.start.release(); // no session is asked for: the next file may go on
          } else {
            if (restarts === 0) await task.start.prev; // in the order the files were handed out
            uri = await timed('sessionMs', () => {
              const asked = up.startSession(account.placeId, name, parent, size, signal);
              task.start.release();
              return asked;
            });
            this.flightStart(task, uri, 0);
          }
          let offset = 0;
          for (;;) {
            await this.turn();
            try {
              if (askFirst) {
                askFirst = false;
                const r = await timed('uploadMs', () => up.status(account.placeId, uri, size, signal));
                if (r.done) {
                  this.setCredit(task, size);
                  await rebuild(size);
                  return { file: r.file, hashed: await checksums() };
                }
                if (r.confirmed > size) break; // makes no sense: a fresh start
                offset = r.confirmed;
                task.sent = offset;
                this.setCredit(task, offset);
                this.flightSent(task, offset);
                await rebuild(offset);
                this.ctx.log('info', `Carrying on ${name} where Google has it: ${Math.round(offset / 1e6)} of ${Math.round(size / 1e6)} MB are not sent again`);
                this.say(task, `Sending ${name} to Google: ${Math.round((offset * 100) / size)}%`, true);
                continue;
              }
              const length = nextChunkLength(size, offset, chunk);
              // A NEW stream for every try: the bytes of a failed try are read again from the file, never from a used stream.
              let bytes: Buffer<ArrayBuffer>;
              if (first !== null && offset === 0) {
                bytes = first; // already read (and checked) for the first try
                first = null;
              } else bytes = await readHashed(offset, length);
              const sent = await timed('uploadMs', () => up.putChunk(account.placeId, uri, bytes, offset, size, signal));
              failures = 0;
              if (sent.done) return { file: sent.file, hashed: await checksums() };
              offset = sent.confirmed;
              task.sent = offset;
              this.flightSent(task, offset);
              this.say(task, `Sending ${name} to Google: ${Math.round((offset * 100) / size)}%`, true);
            } catch (err) {
              if (err instanceof RequestAborted || err instanceof JobAborted || err instanceof JobFailure || err instanceof ReadProblem) throw err;
              if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) break; // Google forgot the session: start again
              const waiting = err instanceof NetworkError || (err instanceof GoogleApiError && isRetryable(err.status, err.reason));
              if (!waiting) throw err;
              failures += 1;
              this.ctx.log('warn', `${safeMessage(err)} (try ${failures} of ${MAX_FAILURES_IN_A_ROW})`);
              if (failures >= MAX_FAILURES_IN_A_ROW) throw new FileNotSent('The upload kept failing (no internet, or Google is not answering). The file was not counted; it is tried again at the next run.', err instanceof NetworkError);
              await deps.http.wait(backoffDelayMs(failures, err instanceof GoogleApiError ? err.retryAfterMs : null), signal);
              const r = await timed('uploadMs', () => up.status(account.placeId, uri, size, signal)); // how far did Google get?
              if (r.done) return { file: r.file, hashed: await checksums() };
              offset = r.confirmed;
              task.sent = offset;
              this.flightSent(task, offset);
            }
          }
        } catch (err) {
          if (err instanceof GoogleApiError && !isRetryable(err.status, err.reason)) {
            if (FULL_REASONS.has(err.reason ?? '')) throw new AccountFull();
            throw new FileNotSent(`Google refused the file (${safeMessage(err)}).`, false);
          }
          if (err instanceof NetworkError) throw new FileNotSent('There was no internet connection. The file was not counted; it is tried again at the next run.', true);
          throw err;
        }
      }
      throw new FileNotSent('Google kept forgetting the upload. The file was not counted; it is tried again at the next run.', false);
    } finally {
      hash.abort();
    }
  }
}
