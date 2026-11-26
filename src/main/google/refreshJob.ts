/**
 * Job `drive.refresh` (light, resumable). For each Google account, one after another: ask Google
 * who it is and how much space is used (about), then either read the complete list of owned
 * files (the first time, or when Google's bookmark expired) or only what changed since the last
 * bookmark. Read only toward Google. Nothing in `files` is ever deleted: items that disappeared
 * get `gone_at`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DRIVE_REFRESH_JOB_KIND, LOST_LAST_COPY_PREFIX, type DriveRefreshParams } from '../../shared/drive';
import type { Db } from '../db';
import { JobAborted, JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { NeedsSignInError, VaultNotReadyError, type GoogleAuth } from './auth';
import type { DriveApi, DriveChange, DriveFileInfo } from './driveApi';
import { clearChangesToken, commitChanges, commitFullList, getSync, lostLastCopies, setSync, type CommitCounts } from './driveStore';
import { GoogleApiError, NetworkError, RequestAborted, RequestNotAllowedError } from './googleHttp';
import { safeMessage } from './redact';
import { ownRemove } from '../danger/ownFiles';

export const REFRESH_TITLE = 'Refresh Google Drive';
export const V1_SOURCE_TAG = 'fleet-manager-v1';
export const API_SOURCE_TAG = 'drive-api';

export interface RefreshDeps {
  db: Db;
  api: DriveApi;
  auth: GoogleAuth;
  log: JobServiceLogger;
  /** Folder for the scratch file that holds a long list while it is being read (inside the data folder). */
  tempRoot: string;
  now?: () => number;
  /** Called after each account finished (the screen refreshes its counts). */
  accountDone?: (placeId: string) => void;
  /** A job for these places started running (so Sources can show it after a restart). */
  started?: (jobId: number, placeIds: string[]) => void;
}

interface PlaceRow {
  id: string;
  label: string;
  identity_json: string;
  status: string;
}

interface ListProgress {
  placeId: string;
  startToken: string;
  /** Token of the next page to ask for; null once the last page was read. */
  pageToken: string | null;
  complete: boolean;
  /** Bytes of the scratch file that belong to pages already read. */
  bytes: number;
  count: number;
}

interface Totals {
  refreshed: number;
  needSignIn: number;
  failed: number;
  skipped: number;
  filesNew: number;
  gone: number;
}

interface Checkpoint {
  nextIndex: number;
  totals: Totals;
  itemsSeen: number;
  list: ListProgress | null;
}

const zeroTotals = (): Totals => ({ refreshed: 0, needSignIn: 0, failed: 0, skipped: 0, filesNew: 0, gone: 0 });
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function summaryText(t: Totals, accounts: number): string {
  const parts = [`Refreshed ${t.refreshed} of ${plural(accounts, 'Google account')}`];
  if (t.refreshed > 0) parts.push(`${plural(t.filesNew, 'new file')} and ${plural(t.gone, 'file')} no longer in Drive`);
  if (t.needSignIn > 0) parts.push(`${t.needSignIn} need${t.needSignIn === 1 ? 's' : ''} signing in again`);
  if (t.failed > 0) parts.push(`${t.failed} could not be refreshed (nothing was changed for ${t.failed === 1 ? 'it' : 'them'})`);
  if (t.skipped > 0) parts.push(`${plural(t.skipped, 'account')} skipped`);
  return `${parts.join('. ')}.`;
}

export function refreshHandler(deps: RefreshDeps): JobHandler {
  return {
    kind: DRIVE_REFRESH_JOB_KIND,
    heavy: false,
    resumable: true,
    run: (ctx) => new RefreshRun(deps, ctx).run(),
  };
}

class RefreshRun {
  private readonly db: Db;
  private readonly now: () => number;
  private totals = zeroTotals();
  private itemsSeen = 0;

  constructor(
    private readonly deps: RefreshDeps,
    private readonly ctx: JobContext,
  ) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const params = ctx.params as Partial<DriveRefreshParams> | null;
    const placeIds = Array.isArray(params?.placeIds) ? params.placeIds.filter((x): x is string => typeof x === 'string') : [];
    if (placeIds.length === 0) throw new JobFailure('This refresh has no Google account to look at. Press Start on Home to try again.');
    deps.started?.(ctx.jobId, placeIds);

    try {
      deps.auth.assertVaultReady();
      deps.auth.clientCredentials();
    } catch (err) {
      if (err instanceof VaultNotReadyError) throw new JobFailure(err.message);
      throw err;
    }

    const resume = (ctx.resume ?? null) as Checkpoint | null;
    let list: ListProgress | null = null;
    let start = 0;
    if (resume) {
      this.totals = { ...zeroTotals(), ...resume.totals };
      this.itemsSeen = resume.itemsSeen ?? 0;
      list = resume.list ?? null;
      start = Math.min(resume.nextIndex ?? 0, placeIds.length);
      if (start > 0) ctx.log('info', `Continuing after account ${start} of ${placeIds.length}`);
    }

    for (let i = start; i < placeIds.length; i += 1) {
      const row = this.db.prepare('SELECT id, label, identity_json, status FROM places WHERE id = ?').get(placeIds[i]) as PlaceRow | undefined;
      if (!row) {
        this.totals.skipped += 1;
        ctx.log('warn', `Account ${i + 1} no longer exists, so it was skipped`);
        continue;
      }
      ctx.progress(i, placeIds.length, { message: `Refreshing ${row.label}: ${this.itemsSeen.toLocaleString('en-US')} items` });
      await ctx.yield();
      let networkDown = false;
      try {
        await this.account(row, i, placeIds.length, list?.placeId === row.id ? list : null);
        this.totals.refreshed += 1;
      } catch (err) {
        networkDown = this.handleFailure(row, err);
      }
      list = null;
      deps.accountDone?.(row.id);
      if (networkDown) {
        const left = placeIds.length - i - 1;
        if (left > 0) {
          this.totals.skipped += left;
          ctx.warn(`No internet connection; nothing was changed for the other ${plural(left, 'account')} either.`);
        }
        break;
      }
      ctx.checkpoint({ nextIndex: i + 1, totals: this.totals, itemsSeen: this.itemsSeen, list: null } satisfies Checkpoint);
    }

    const summary = summaryText(this.totals, placeIds.length);
    ctx.log('info', summary);
    deps.log.info(`drive.refresh: ${summary}`);
    ctx.progress(placeIds.length, placeIds.length, { message: summary });
    return summary;
  }

  /** Turns an error for one account into a plain warning. Returns true when the internet is down. */
  private handleFailure(row: PlaceRow, err: unknown): boolean {
    const { ctx } = this;
    if (err instanceof RequestAborted || err instanceof JobAborted) throw err;
    if (err instanceof SkippedAccount) return false;
    if (err instanceof VaultNotReadyError) throw new JobFailure(err.message);
    if (err instanceof NetworkError) {
      this.totals.failed += 1;
      ctx.warn(`No internet connection; nothing was changed for ${row.label}.`);
      ctx.log('debug', `network: ${safeMessage(err)}`);
      return true;
    }
    if (err instanceof NeedsSignInError || (err instanceof GoogleApiError && (err.status === 401 || (err.status === 403 && err.reason === 'insufficientPermissions')))) {
      this.db.prepare("UPDATE places SET status = 'needs_signin' WHERE id = ?").run(row.id);
      this.totals.needSignIn += 1;
      ctx.warn(`${row.label} needs signing in again. Use "Sign in again" on its card; nothing was changed for it.`);
      return false;
    }
    this.totals.failed += 1;
    if (err instanceof RequestNotAllowedError) {
      ctx.warn(`${row.label}: ${err.message}`);
    } else if (err instanceof GoogleApiError) {
      ctx.warn(`${row.label}: Google said no (${err.status}). Nothing was changed for it. ${err.reason ? `Reason: ${err.reason}.` : ''}`.trim());
      ctx.log('debug', safeMessage(err));
    } else if (err instanceof StalledError) {
      ctx.warn(`${row.label}: ${err.message} Nothing was changed for it.`);
    } else {
      ctx.warn(`${row.label}: something went wrong, so nothing was changed for it. The job log has the details.`);
      ctx.log('error', safeMessage(err));
    }
    return false;
  }

  private async account(row: PlaceRow, index: number, total: number, resumeList: ListProgress | null): Promise<void> {
    const { ctx, deps } = this;
    const { api } = deps;
    const identity = parseObject(row.identity_json);
    const email = typeof identity['email'] === 'string' ? identity['email'].toLowerCase() : null;

    // 1. About: who is this, and how much space is used.
    const about = await api.about(row.id, ctx.signal);
    if (!email || !about.email) {
      this.totals.failed += 1;
      ctx.warn(`${row.label}: the account's e-mail address could not be checked, so nothing was changed for it.`);
      throw new SkippedAccount();
    }
    if (about.email.toLowerCase() !== email) {
      this.totals.failed += 1;
      ctx.warn(`${row.label}: this sign-in belongs to a different Google account (${about.email}), so nothing was changed for it. Use "Sign in again" with the right account.`);
      throw new SkippedAccount();
    }
    const stamp = this.now();
    const merged = { ...identity, quotaLimit: about.limit, quotaUsage: about.usage, quotaUsageDrive: about.usageInDrive, quotaUsageTrash: about.usageInDriveTrash, lastQuotaAt: stamp };
    this.db.prepare("UPDATE places SET identity_json = ?, status = 'connected' WHERE id = ?").run(JSON.stringify(merged), row.id);

    // 2/3. Full list or changes.
    const sync = getSync(this.db, row.id);
    let counts: CommitCounts;
    if (sync.changesToken === null) {
      counts = await this.fullList(row, index, total, resumeList);
    } else {
      try {
        counts = await this.changes(row, index, total, sync.changesToken);
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 410)) throw err;
        ctx.log('info', `${row.label}: Google no longer knows the saved bookmark, so the whole list is read again`);
        clearChangesToken(this.db, row.id);
        counts = await this.fullList(row, index, total, null);
      }
    }
    this.totals.filesNew += counts.filesNew;
    this.totals.gone += counts.gone;
    if (counts.filesFailed > 0) ctx.warn(`${row.label}: ${plural(counts.filesFailed, 'file')} could not be saved.`);
    ctx.log('info', `${row.label}: ${plural(counts.filesNew, 'new file')}, ${plural(counts.filesUpdated, 'file')} updated, ${plural(counts.gone, 'file')} no longer in Drive`);
    // A file that left Drive while it was the only copy anywhere is the one thing worth an alert of its own.
    if (counts.gone > 0) {
      const lost = lostLastCopies(this.db, row.id, stamp);
      if (lost.files > 0) {
        const more = lost.files > lost.names.length ? ` and ${lost.files - lost.names.length} more` : '';
        ctx.warn(`${LOST_LAST_COPY_PREFIX}${row.label}: ${plural(lost.files, 'file')} (${Math.max(1, Math.round(lost.bytes / 1e6)).toLocaleString('en-US')} MB) left Google Drive and no other place holds a copy: ${lost.names.join(', ')}${more}. Look in the Drive trash, and in Search for the names.`);
      }
    }
  }

  private scratchFile(placeId: string): string {
    return path.join(this.deps.tempRoot, `drive-list-${placeId}.jsonl`);
  }

  private message(label: string): { message: string } {
    return { message: `Refreshing ${label}: ${this.itemsSeen.toLocaleString('en-US')} items` };
  }

  /** Reads every page of owned, untrashed items (a page at a time into a scratch file), then commits. */
  private async fullList(row: PlaceRow, index: number, total: number, resumeList: ListProgress | null): Promise<CommitCounts> {
    const { ctx, deps } = this;
    const file = this.scratchFile(row.id);
    fs.mkdirSync(deps.tempRoot, { recursive: true });

    let progress: ListProgress;
    const usable = resumeList !== null && resumeList.placeId === row.id && fs.existsSync(file) && fs.statSync(file).size >= resumeList.bytes;
    if (usable) {
      progress = { ...resumeList };
      fs.truncateSync(file, progress.bytes);
      ctx.log('info', `${row.label}: continuing the list after ${progress.count.toLocaleString('en-US')} items`);
    } else {
      // The bookmark is taken BEFORE the list: anything that changes while the list is read is picked up by the next changes run.
      const startToken = await deps.api.startPageToken(row.id, ctx.signal);
      fs.writeFileSync(file, '');
      progress = { placeId: row.id, startToken, pageToken: null, complete: false, bytes: 0, count: 0 };
    }

    try {
      while (!progress.complete) {
        const page = await deps.api.listFilesPage(row.id, progress.pageToken, ctx.signal);
        if (page.nextPageToken !== null && page.nextPageToken === progress.pageToken) throw new StalledError('Google kept sending the same page of the list.');
        const text = page.files.map((f) => JSON.stringify(f)).join('\n');
        if (text !== '') fs.appendFileSync(file, `${text}\n`);
        progress = {
          ...progress,
          pageToken: page.nextPageToken,
          complete: page.nextPageToken === null,
          bytes: progress.bytes + Buffer.byteLength(text === '' ? '' : `${text}\n`),
          count: progress.count + page.files.length,
        };
        this.itemsSeen += page.files.length;
        ctx.checkpoint({ nextIndex: index, totals: this.totals, itemsSeen: this.itemsSeen, list: progress } satisfies Checkpoint);
        ctx.progress(index, total, this.message(row.label));
        await ctx.yield();
      }

      const listed: DriveFileInfo[] = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DriveFileInfo);
      const stamp = this.now();
      const counts = await commitFullList(this.db, row.id, listed, stamp, () => ctx.yield());
      setSync(this.db, row.id, progress.startToken, { fullListedAt: stamp, changesAt: stamp });
      this.finishPlace(row.id, stamp);
      ownRemove(file);
      return counts;
    } catch (err) {
      // The scratch list is kept only when the job was stopped (it may be resumed); after a real error it is removed.
      if (!(err instanceof RequestAborted) && !(err instanceof JobAborted) && !ctx.signal.aborted) ownRemove(file);
      throw err;
    }
  }

  /** Changes since the bookmark. The bookmark moves only when the whole run reached Google's new one. */
  private async changes(row: PlaceRow, index: number, total: number, startToken: string): Promise<CommitCounts> {
    const { ctx, deps } = this;
    const all: DriveChange[] = [];
    const seenTokens = new Set<string>([startToken]);
    let token = startToken;
    let newStart: string | null = null;
    while (newStart === null) {
      const page = await deps.api.changesPage(row.id, token, ctx.signal);
      all.push(...page.changes);
      this.itemsSeen += page.changes.length;
      ctx.progress(index, total, this.message(row.label));
      if (page.nextPageToken !== null) {
        // A bookmark that does not move would loop for ever (the Fleet Manager v1 guard).
        if (seenTokens.has(page.nextPageToken)) throw new StalledError('Google did not move on to the next page of changes.');
        seenTokens.add(page.nextPageToken);
        token = page.nextPageToken;
      } else if (page.newStartPageToken !== null) {
        newStart = page.newStartPageToken;
      } else {
        throw new StalledError('Google gave no way to continue the list of changes.');
      }
      await ctx.yield();
    }
    const stamp = this.now();
    const counts = await commitChanges(this.db, row.id, all, stamp, () => ctx.yield());
    setSync(this.db, row.id, newStart, { changesAt: stamp });
    this.finishPlace(row.id, stamp);
    return counts;
  }

  /** "Last looked" moves, and the catalog is no longer "from v1". */
  private finishPlace(placeId: string, stamp: number): void {
    const row = this.db.prepare('SELECT identity_json FROM places WHERE id = ?').get(placeId) as { identity_json: string } | undefined;
    if (!row) return;
    const identity = parseObject(row.identity_json);
    identity['catalog'] = { from: API_SOURCE_TAG, refreshedAt: stamp };
    this.db.prepare('UPDATE places SET identity_json = ?, last_looked_at = ? WHERE id = ?').run(JSON.stringify(identity), stamp, placeId);
  }
}

/** Google answered in a way that cannot be followed; nothing was changed for the account. */
export class StalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalledError';
  }
}

/** The account was skipped on purpose (warning already written). */
class SkippedAccount extends Error {}
