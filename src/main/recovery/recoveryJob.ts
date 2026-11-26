/**
 * Job `recovery.toDrive` (heavy): an encrypted recovery copy of the database in ONE Google Drive account the person chose.
 * OFF by default (`recoveryToGoogle`), and it never runs without a chosen account.
 *
 * Steps: copy the database to a scratch folder (SQLite online backup), compress and encrypt it with the vault's data key (so the
 * recovery passphrase opens it on a new laptop), upload it WHOLE to `BackupHub Recovery` in that account, and count it only when
 * Drive's MD5 and size equal what was sent. The scratch folder is always removed.
 *
 * Backup Hub never deletes or updates anything in Drive, so "keep 7" is kept by STOPPING at 7 recovery copies: when the folder
 * already holds 7, the job says so and uploads nothing until the person removes old ones by hand in Drive. At most one copy a
 * week unless started with Save now (`params.force`). The local database is only read.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECOVERY_DRIVE_DAYS, RECOVERY_DRIVE_KEEP } from '../../shared/settings';
import { copyDatabase, type Db } from '../db';
import { assertWritable } from '../fsutil';
import { NeedsSignInError, VaultNotReadyError, type GoogleAuth } from '../google/auth';
import type { DriveUploader } from '../google/driveUpload';
import { backoffDelayMs, GoogleApiError, isRetryable, NetworkError, RequestAborted, type GoogleHttp } from '../google/googleHttp';
import { safeMessage } from '../google/redact';
import { MAX_FAILURES_IN_A_ROW, nextChunkLength, DEFAULT_CHUNK_BYTES } from '../google/uploadModel';
import { JobAborted, JobFailure, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import type { SettingsStore } from '../settings/settingsStore';
import type { VaultService } from '../vault/vaultService';
import { readRange } from '../hashing/readRange';
import { writeRecoveryFile } from './recoveryFile';
import { ownRemove } from '../danger/ownFiles';

export const RECOVERY_JOB_KIND = 'recovery.toDrive';
export const RECOVERY_TITLE = 'Save a recovery copy to Google Drive';
export const RECOVERY_FOLDER = 'BackupHub Recovery';
export const RECOVERY_PREFIX = 'backuphub-recovery-';
const META_LAST = 'recovery.drive.last';

const pad = (n: number): string => String(n).padStart(2, '0');
export function recoveryFileName(at: Date): string {
  return `${RECOVERY_PREFIX}${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.bhrc`;
}

export interface RecoveryJobDeps {
  db: Db;
  settings: SettingsStore;
  vault: Pick<VaultService, 'recoveryKit'>;
  uploader: Pick<DriveUploader, 'findFolder' | 'createFolder' | 'listChildren' | 'startSession' | 'putChunk' | 'status'>;
  auth: Pick<GoogleAuth, 'assertVaultReady' | 'hasRefreshToken'>;
  http: Pick<GoogleHttp, 'wait'>;
  /** Free and used bytes of the account (limit null = unlimited), or null when Google could not be asked. */
  room(placeId: string, signal: AbortSignal): Promise<{ limit: number | null; usage: number | null } | null>;
  /** Is this place a Google Drive account of this app? */
  isGoogleAccount(placeId: string): boolean;
  /** Free bytes where the scratch files go, or null when unknown. */
  freeBytes(dir: string): number | null;
  scratchRoot: string;
  appVersion: string;
  log: JobServiceLogger;
  now?: () => number;
  chunkBytes?: number;
}

function lastUploadAt(db: Db): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_LAST) as { value: string } | undefined;
  const n = row ? Number(row.value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** True when a new copy is due: none yet, or the last one is older than the interval. */
export function recoveryIsDue(last: number | null, now: number): boolean {
  return last === null || now - last >= RECOVERY_DRIVE_DAYS * 24 * 60 * 60 * 1000;
}

export function recoveryHandler(deps: RecoveryJobDeps): JobHandler {
  const nowFn = deps.now ?? (() => Date.now());
  const chunk = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  return {
    kind: RECOVERY_JOB_KIND,
    heavy: true,
    async run(ctx) {
      const force = (ctx.params as { force?: unknown } | null)?.force === true;
      const settings = deps.settings.get();
      if (!settings.recoveryToGoogle && !force) return 'The recovery copy to Google Drive is switched off';
      const account = settings.recoveryGoogleAccount;
      if (account === null || !deps.isGoogleAccount(account)) throw new JobFailure('No Google account is chosen for the recovery copy. Pick one in Settings. Nothing was sent.');
      if (!force && !recoveryIsDue(lastUploadAt(deps.db), nowFn())) return `A recovery copy was saved less than ${RECOVERY_DRIVE_DAYS} days ago, so nothing was sent`;
      try {
        deps.auth.assertVaultReady();
      } catch (err) {
        if (err instanceof VaultNotReadyError) throw new JobFailure(err.message);
        throw err;
      }
      if (!deps.auth.hasRefreshToken(account)) throw new JobFailure('That Google account is signed out. Sign it in again under Settings, Drives and accounts. Nothing was sent.');
      const kit = deps.vault.recoveryKit();
      if (!kit) throw new JobFailure('Set a recovery passphrase first (Settings, Security). Without it the recovery copy could not be opened on a new laptop. Nothing was sent.');

      assertWritable(path.join(deps.scratchRoot, 'scratch')); // T7 write ban (scratch is the laptop's temp folder)
      const scratch = fs.mkdtempSync(path.join(deps.scratchRoot, 'backuphub-recovery-'));
      try {
        await ctx.yield();
        ctx.progress(0, 4, { message: 'Copying the database' });
        const copy = path.join(scratch, 'copy.db');
        const dbSize = (deps.db.prepare('PRAGMA page_count').pluck().get() as number) * (deps.db.prepare('PRAGMA page_size').pluck().get() as number);
        const free = deps.freeBytes(scratch);
        if (free !== null && free < dbSize * 1.3 + 50_000_000) throw new JobFailure('There is not enough free space on this laptop to prepare the recovery copy. Nothing was sent.');
        await copyDatabase(deps.db, copy);

        ctx.progress(1, 4, { message: 'Compressing and encrypting' });
        const at = new Date(nowFn());
        const name = recoveryFileName(at);
        const file = path.join(scratch, name);
        const size = await writeRecoveryFile(copy, file, kit.key, { createdAt: at.getTime(), appVersion: deps.appVersion, vault: kit.record });
        ownRemove(copy);
        const md5 = await md5Of(file);

        ctx.progress(2, 4, { message: 'Checking the Google account' });
        const room = await deps.room(account, ctx.signal);
        if (room?.limit != null && room.usage != null && room.limit - room.usage < size + 100_000_000) {
          throw new JobFailure(`That Google account has no room for the recovery copy (${Math.ceil(size / 1e6)} MB). Nothing was sent.`);
        }
        const parent = await folderOf(deps, account, ctx.signal);
        const existing = await deps.uploader.listChildren(account, parent, RECOVERY_PREFIX, ctx.signal);
        if (existing.length >= RECOVERY_DRIVE_KEEP) {
          ctx.warn(`Google Drive already holds ${existing.length} recovery copies. Backup Hub never deletes in Drive, so it sent nothing. Remove old ones by hand in the "${RECOVERY_FOLDER}" folder, then run this again.`);
          return `Stopped: ${existing.length} recovery copies are already in Drive. Nothing was sent.`;
        }

        ctx.progress(3, 4, { message: 'Uploading to Google Drive' });
        const done = await upload(deps, ctx, account, parent, name, file, size, chunk);
        if (done.size !== size || done.md5 !== md5) {
          throw new JobFailure(`The copy in Google Drive does not match what was sent, so it was not counted. It is in the "${RECOVERY_FOLDER}" folder as ${name}; remove it by hand if you do not want it.`);
        }
        deps.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_LAST, String(nowFn()));
        ctx.progress(4, 4);
        return `Saved an encrypted recovery copy (${Math.ceil(size / 1e6)} MB, checked against Google) in the "${RECOVERY_FOLDER}" folder. ${existing.length + 1} of ${RECOVERY_DRIVE_KEEP} kept.`;
      } catch (err) {
        if (err instanceof RequestAborted) throw new JobAborted();
        if (err instanceof NeedsSignInError) throw new JobFailure('That Google account needs to be signed in again. Nothing was sent.');
        throw err;
      } finally {
        kit.key.fill(0);
        ownRemove(scratch, { recursive: true });
      }
    },
  };
}

async function folderOf(deps: RecoveryJobDeps, account: string, signal: AbortSignal): Promise<string> {
  return (await deps.uploader.findFolder(account, RECOVERY_FOLDER, 'root', signal)) ?? (await deps.uploader.createFolder(account, RECOVERY_FOLDER, 'root', signal));
}

function md5Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function upload(
  deps: RecoveryJobDeps,
  ctx: { signal: AbortSignal; yield(): Promise<void>; log(level: 'info' | 'warn', text: string): void },
  account: string,
  parent: string,
  name: string,
  file: string,
  size: number,
  chunk: number,
): Promise<{ md5: string | null; size: number | null }> {
  const up = deps.uploader;
  let failures = 0;
  for (let restarts = 0; restarts < 3; restarts += 1) {
    try {
      const uri = await up.startSession(account, name, parent, size, ctx.signal);
      let offset = 0;
      for (;;) {
        await ctx.yield();
        try {
          const length = nextChunkLength(size, offset, chunk);
          const sent = await up.putChunk(account, uri, await readRange(file, offset, length), offset, size, ctx.signal);
          failures = 0;
          if (sent.done) return { md5: sent.file.md5, size: sent.file.size };
          offset = sent.confirmed;
        } catch (err) {
          if (err instanceof RequestAborted || err instanceof JobAborted || err instanceof JobFailure) throw err;
          if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) break; // Google forgot the session: start again
          const waiting = err instanceof NetworkError || (err instanceof GoogleApiError && isRetryable(err.status, err.reason));
          if (!waiting) throw err;
          failures += 1;
          ctx.log('warn', `${safeMessage(err)} (try ${failures} of ${MAX_FAILURES_IN_A_ROW})`);
          if (failures >= MAX_FAILURES_IN_A_ROW) throw new JobFailure('The upload kept failing (no internet, or Google is not answering). Nothing counted; try again later.');
          await deps.http.wait(backoffDelayMs(failures, err instanceof GoogleApiError ? err.retryAfterMs : null), ctx.signal);
          // Ask Google how far it got before sending more.
          const r = await up.status(account, uri, size, ctx.signal);
          if (r.done) return { md5: r.file.md5, size: r.file.size };
          offset = r.confirmed;
        }
      }
    } catch (err) {
      if (err instanceof GoogleApiError && !isRetryable(err.status, err.reason)) {
        const insufficient = err.reason === 'storageQuotaExceeded' || err.reason === 'quotaExceeded';
        throw new JobFailure(insufficient ? 'That Google account is full. Nothing was sent.' : `Google refused the upload (${safeMessage(err)}). Nothing was counted.`);
      }
      throw err;
    }
  }
  throw new JobFailure('Google kept forgetting the upload. Nothing counted; try again later.');
}
