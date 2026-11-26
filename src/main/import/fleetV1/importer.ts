import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { makeKindResolver } from '../../classify/sortKinds';
import type { Db } from '../../db';
import { JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../../jobs/jobService';
import { DecryptError, decryptV10, dpapiUnprotectWindows, readOsCryptKey, type DpapiUnprotect } from './decrypt';
import { FOLDER_MIME, FolderPaths, withIdSuffix } from './paths';
import { copySource, FleetV1Source, removeCopy, SourceError, V1_ARCHIVE_USERDATA, type SourceCopy, type V1Account, type V1FileRow } from './source';

export const KIND_IMPORT_FLEET_V1 = 'import.fleetV1';
export const IMPORT_TITLE = 'Bring in Google accounts from Fleet Manager v1';
/** Vault names (PLAN: the only places these live). */
export const SECRET_CLIENT_ID = 'google.clientId';
export const SECRET_CLIENT_SECRET = 'google.clientSecret';
export const refreshTokenSecretName = (placeId: string): string => `gdrive.refreshToken.${placeId}`;
export const V1_SOURCE_TAG = 'fleet-manager-v1';
/** Rows written per transaction; the job yields between chunks. */
export const FILE_CHUNK = 2000;

/** The slice of the vault the import needs (the real VaultService fits). */
export interface ImportVault {
  status(): { state: string };
  putSecret(name: string, value: string | Buffer): void;
  listSecretNames(): string[];
}

export interface ImportCounts {
  accounts: number;
  /** Accounts Backup Hub has already refreshed or signed in again itself: left completely alone. */
  accountsSkipped: number;
  placesCreated: number;
  placesUpdated: number;
  tokensOk: number;
  tokensFailed: number;
  filesNew: number;
  filesUpdated: number;
  foldersSkipped: number;
  trashedSkipped: number;
  orphans: number;
  renamedDuplicates: number;
  filesFailed: number;
}

export const zeroCounts = (): ImportCounts => ({
  accounts: 0,
  accountsSkipped: 0,
  placesCreated: 0,
  placesUpdated: 0,
  tokensOk: 0,
  tokensFailed: 0,
  filesNew: 0,
  filesUpdated: 0,
  foldersSkipped: 0,
  trashedSkipped: 0,
  orphans: 0,
  renamedDuplicates: 0,
  filesFailed: 0,
});

interface Checkpoint {
  /** Index into the account list of the next account to do. */
  nextIndex: number;
  filesDone: number;
  counts: ImportCounts;
}

export interface FleetV1ImportDeps {
  db: Db;
  vault: ImportVault;
  /** Folder for the temporary copy of the archive files (inside the data folder). */
  tempRoot: string;
  log: JobServiceLogger;
  /** Where the archived v1 files are. Defaults to the frozen archive; tests and dev runs point elsewhere. */
  sourceDir?: string | (() => string);
  dpapiUnprotect?: DpapiUnprotect;
  now?: () => number;
  uuid?: () => string;
}

export function resolveSourceDir(dir: FleetV1ImportDeps['sourceDir']): string {
  return (typeof dir === 'function' ? dir() : dir) ?? V1_ARCHIVE_USERDATA;
}

interface PlaceRow {
  id: string;
  label: string;
  identity_json: string;
  last_looked_at: number | null;
  status: string;
}

/** Job parameter: the person confirmed the import. Without it the job refuses to start. */
export interface FleetV1Params {
  confirmed?: boolean;
}

/**
 * Has Backup Hub itself touched this Google account since it was first brought in from v1? If so its sign-in, space
 * numbers and file rows are newer than the v1 archive and a re-import must change NOTHING for it. Any one of these
 * means "touched" (the safest reading: when in doubt, skip):
 * - `drive_sync.full_listed_at` or `changes_at` is set: a v2 Drive refresh finished for it;
 * - `identity.signedInAt` is set: the person used "Sign in again" (new token, possibly a different client);
 * - the place has a looked-at date that did not come from the v1 import (`identity.catalog.from` is not the v1 tag).
 * A place that exists but none of these apply to (for example created by an earlier import and never refreshed) is
 * still refreshed from v1 as before.
 */
export function touchedByBackupHub(db: Db, place: { id: string; identity_json: string; last_looked_at: number | null }): boolean {
  const sync = db.prepare('SELECT full_listed_at, changes_at FROM drive_sync WHERE place_id = ?').get(place.id) as
    | { full_listed_at: number | null; changes_at: number | null }
    | undefined;
  if (sync && (sync.full_listed_at !== null || sync.changes_at !== null)) return true;
  const identity = parseObject(place.identity_json);
  if (typeof identity['signedInAt'] === 'number') return true;
  const catalog = identity['catalog'] as { from?: unknown } | undefined;
  return place.last_looked_at !== null && catalog?.from !== V1_SOURCE_TAG;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}

interface PreparedFile {
  extId: string;
  relPath: string;
  size: number | null;
  mtime: number | null;
  md5: string | null;
  mime: string | null;
  webLink: string | null;
}

/** Sentence for the job message and final log event. Counts only. */
export function summaryText(c: ImportCounts): string {
  const files = c.filesNew + c.filesUpdated;
  const parts = [
    `Brought in ${plural(c.accounts, 'Google account')} (${c.tokensOk} sign-ins unlocked, ${c.tokensFailed} need signing in again) and ${plural(files, 'file')} (${c.filesNew.toLocaleString('en-US')} new)`,
    `Skipped ${plural(c.foldersSkipped, 'folder')} and ${plural(c.trashedSkipped, 'trashed item')}`,
  ];
  if (c.accountsSkipped > 0) parts.push(`Skipped ${plural(c.accountsSkipped, 'account')} that Backup Hub has already refreshed itself`);
  if (c.orphans > 0) parts.push(`${plural(c.orphans, 'file')} sit under "(unknown folder)"`);
  if (c.filesFailed > 0) parts.push(`${plural(c.filesFailed, 'file')} could not be saved`);
  return `${parts.join('. ')}.`;
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Job `import.fleetV1` (heavy, resumable per account). Reads ONLY a temporary copy of the archived
 * Fleet Manager v1 files, decrypts v1's safeStorage values with this Windows user's DPAPI key,
 * stores the Google client id/secret and each account's refresh token in the vault, creates one
 * `gdrive` place per account and adds the Drive file list to `files`. Reruns update rows by email
 * and by Drive file id; nothing is ever deleted. No network.
 */
export function fleetV1Handler(deps: FleetV1ImportDeps): JobHandler {
  return {
    kind: KIND_IMPORT_FLEET_V1,
    heavy: true,
    resumable: true,
    run: (ctx) => new FleetV1Run(deps, ctx).run(),
  };
}

class FleetV1Run {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly unprotect: DpapiUnprotect;
  private counts = zeroCounts();
  private key: Buffer | null = null;
  private existingSecrets = new Set<string>();
  private placeByEmail = new Map<string, PlaceRow>();

  constructor(
    private readonly deps: FleetV1ImportDeps,
    private readonly ctx: JobContext,
  ) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
    this.unprotect = deps.dpapiUnprotect ?? dpapiUnprotectWindows;
  }

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const resume = (ctx.resume ?? null) as Checkpoint | null;
    let copy: SourceCopy | null = null;
    let source: FleetV1Source | null = null;
    if ((ctx.params as FleetV1Params | null)?.confirmed !== true) {
      throw new JobFailure('The import was not confirmed, so nothing was done. Start it again from Settings and choose "Yes, bring them in".');
    }
    try {
      // 1. Copy and open (read only), then check it is a v1 database.
      ctx.log('info', 'Copying the archived Fleet Manager v1 files to a temporary folder (the archive itself is only read)');
      try {
        copy = copySource(resolveSourceDir(deps.sourceDir), deps.tempRoot);
        source = new FleetV1Source(copy.dbFile);
      } catch (err) {
        if (err instanceof SourceError) throw new JobFailure(`${err.message}. Nothing was changed.`);
        throw new JobFailure('The archived Fleet Manager v1 files could not be copied. Nothing was changed.', (err as Error).message);
      }
      await ctx.yield();
      const accounts = source.accounts();
      const totalFiles = source.importableCount();
      ctx.log('info', `Found ${plural(accounts.length, 'account')} and ${plural(totalFiles, 'file')} to bring in`);

      // 2. The vault must be usable before anything is decrypted.
      const vaultState = deps.vault.status().state;
      if (vaultState !== 'unlocked') {
        throw new JobFailure(
          vaultState === 'locked'
            ? 'The saved sign-ins are locked. Type your recovery passphrase in Settings > Security first, then bring the accounts in again.'
            : 'Backup Hub cannot save sign-ins on this computer right now. Open Settings > Security, then try again.',
        );
      }

      // 3. Unlock v1's key with this Windows user's DPAPI.
      try {
        this.key = await readOsCryptKey(fs.readFileSync(copy.localStateFile, 'utf8'), this.unprotect);
        ctx.log('info', 'Unlocked the Fleet Manager v1 key with Windows');
      } catch (err) {
        const problem = err instanceof DecryptError ? err.message : 'The Fleet Manager v1 key could not be unlocked';
        ctx.warn(`${problem}. Accounts and files are still brought in, but every account will need signing in again.`);
      }

      // 4. Google client id and secret (only when the vault has none yet: v2's own sign-ins are tied to the ones it holds).
      this.existingSecrets = new Set(deps.vault.listSecretNames());
      this.storeClient(source);

      // 5. Accounts.
      for (const row of this.db.prepare("SELECT id, label, identity_json, last_looked_at, status FROM places WHERE kind = 'gdrive'").all() as PlaceRow[]) {
        const email = parseObject(row.identity_json)['email'];
        if (typeof email === 'string') this.placeByEmail.set(email.toLowerCase(), row);
      }
      const profileId = this.profileId();
      if (resume) this.counts = { ...zeroCounts(), ...resume.counts };
      let filesDone = resume?.filesDone ?? 0;
      const start = Math.min(resume?.nextIndex ?? 0, accounts.length);
      if (start > 0) ctx.log('info', `Continuing after account ${start} of ${accounts.length}`);

      for (let i = start; i < accounts.length; i += 1) {
        const account = accounts[i]!;
        const label = `account ${i + 1} of ${accounts.length}`;
        ctx.progress(filesDone, totalFiles, { message: `Bringing in ${label}` });
        await ctx.yield();

        const known = this.placeByEmail.get(account.email.toLowerCase());
        if (known && touchedByBackupHub(this.db, known)) {
          // Newer than the archive: no token, no space numbers, no file rows.
          this.counts.accountsSkipped += 1;
          ctx.log('info', `${label}: Backup Hub has already refreshed this account itself, so it was left exactly as it is`);
          filesDone += source.importableCount(account.id);
          ctx.checkpoint({ nextIndex: i + 1, filesDone, counts: this.counts } satisfies Checkpoint);
          ctx.progress(filesDone, totalFiles, { message: `Left ${label} as it is` });
          continue;
        }
        const placeId = this.upsertPlace(account, i + 1, profileId);
        const result = await this.importFiles(source, account, placeId, filesDone, totalFiles, label);
        filesDone += result.rowsSeen;

        const v1Completed = source.catalogCompletedAt(account.id);
        const lookedAt = v1Completed ?? (result.imported > 0 ? this.now() : null);
        this.finishPlace(placeId, lookedAt, v1Completed);
        this.counts.accounts += 1;
        ctx.checkpoint({ nextIndex: i + 1, filesDone, counts: this.counts } satisfies Checkpoint);
        ctx.progress(filesDone, totalFiles, { message: `Finished ${label}` });
      }

      if (this.counts.accountsSkipped > 0) {
        ctx.warn(
          `Skipped ${plural(this.counts.accountsSkipped, 'account')} that Backup Hub has already refreshed itself. Their sign-ins, space numbers and file lists were left exactly as they are; the old v1 copy would be out of date.`,
        );
      }
      const summary = summaryText(this.counts);
      ctx.log('info', summary);
      deps.log.info(`import.fleetV1: ${summary}`);
      return summary;
    } finally {
      this.key?.fill(0);
      this.key = null;
      try {
        source?.close();
      } catch {
        // The copy is deleted next; nothing else to do.
      }
      try {
        removeCopy(copy, deps.tempRoot);
      } catch (err) {
        deps.log.warn('import.fleetV1: could not remove the temporary copy', (err as Error).message);
      }
    }
  }

  private profileId(): number {
    const row =
      (this.db.prepare("SELECT id FROM profiles WHERE name = 'You' COLLATE NOCASE").get() as { id: number } | undefined) ??
      (this.db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get() as { id: number } | undefined);
    if (!row) throw new JobFailure('There is no profile to own the accounts. Nothing was changed.');
    return row.id;
  }

  /** Decrypt one v1 value, or null (with the reason in `reason`) when it cannot be unlocked. */
  private decrypt(valueBase64: string | null): { value: Buffer } | { reason: string } {
    if (valueBase64 === null) return { reason: 'nothing was saved' };
    if (!this.key) return { reason: 'the Fleet Manager v1 key was not available' };
    try {
      return { value: decryptV10(valueBase64, this.key) };
    } catch (err) {
      return { reason: err instanceof DecryptError ? err.message : 'it could not be unlocked' };
    }
  }

  private putSecret(name: string, value: string | Buffer): void {
    try {
      this.deps.vault.putSecret(name, value);
    } catch (err) {
      // Plain text of the vault error never contains the value; the name is not secret.
      throw new JobFailure('Backup Hub could not save a sign-in securely, so the import stopped. Open Settings > Security, then try again.', (err as Error).message);
    }
  }

  private storeClient(source: FleetV1Source): void {
    const { ctx } = this;
    const clientId = source.setting('clientId');
    const keepId = this.existingSecrets.has(SECRET_CLIENT_ID);
    const keepSecret = this.existingSecrets.has(SECRET_CLIENT_SECRET);
    if (keepId && keepSecret) {
      ctx.log('info', 'Google client: Backup Hub already has its own, so it was kept');
      return;
    }
    if (keepId !== keepSecret) ctx.warn('Backup Hub has only half of a Google client saved; the missing half is filled in from v1.');
    if (clientId && !keepId) this.putSecret(SECRET_CLIENT_ID, clientId.trim());
    else if (!clientId && !keepId) ctx.warn('Fleet Manager v1 had no Google client id saved; it will need to be entered again.');
    if (keepSecret) {
      ctx.log('info', `Google client: id ${keepId || clientId ? 'saved' : 'missing'}, secret already saved`);
      return;
    }
    const secret = this.decrypt(source.setting('clientSecretEnc'));
    if ('value' in secret) {
      try {
        this.putSecret(SECRET_CLIENT_SECRET, secret.value);
      } finally {
        secret.value.fill(0);
      }
    } else {
      ctx.warn(`The Google client secret was not brought in (${secret.reason}); it will need to be entered again.`);
    }
    ctx.log('info', `Google client: id ${clientId ? 'saved' : 'missing'}, secret ${'value' in secret ? 'saved' : 'missing'}`);
  }

  /** Create or update the place for one account and store its refresh token. Returns the place id. */
  private upsertPlace(account: V1Account, ordinal: number, profileId: number): string {
    const { ctx } = this;
    const token = this.decrypt(account.refreshTokenEnc);
    const emailKey = account.email.toLowerCase();
    const existing = this.placeByEmail.get(emailKey);
    const placeId = existing?.id ?? this.uuid();
    const secretName = refreshTokenSecretName(placeId);
    const needsReauthInV1 = account.status === 'reauth_needed';
    const hadToken = this.existingSecrets.has(secretName);

    let tokenOk = false;
    this.db.transaction(() => {
      if ('value' in token) {
        try {
          this.putSecret(secretName, token.value);
          tokenOk = true;
        } finally {
          token.value.fill(0);
        }
      }

      let status: string;
      if (!tokenOk) status = hadToken && existing ? existing.status : 'needs_signin';
      else if (needsReauthInV1) status = 'needs_signin';
      else status = existing && existing.status !== 'needs_signin' ? existing.status : 'unknown';

      const quota = {
        email: account.email,
        accountId: account.id,
        quotaLimit: account.quotaLimit,
        quotaUsage: account.quotaUsage,
        quotaUsageDrive: account.quotaUsageDrive,
        quotaUsageTrash: account.quotaUsageTrash,
        lastQuotaAt: account.lastQuotaAt,
      };
      if (existing) {
        const identity = { ...parseObject(existing.identity_json), ...quota };
        this.db.prepare('UPDATE places SET identity_json = ?, status = ? WHERE id = ?').run(JSON.stringify(identity), status, existing.id);
        this.counts.placesUpdated += 1;
      } else {
        const label = (account.nickname || account.email).slice(0, 60);
        this.db
          .prepare(
            `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
             VALUES (?, ?, 'gdrive', ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(placeId, profileId, label, JSON.stringify(quota), status, this.now());
        this.placeByEmail.set(emailKey, { id: placeId, label, identity_json: JSON.stringify(quota), last_looked_at: null, status });
        this.counts.placesCreated += 1;
      }
    })();

    if (tokenOk) {
      this.counts.tokensOk += 1;
      this.existingSecrets.add(secretName);
    } else {
      this.counts.tokensFailed += 1;
      const reason = 'reason' in token ? token.reason : 'it could not be unlocked';
      ctx.warn(`Account ${ordinal}: the saved sign-in could not be brought in (${reason}); it is marked "needs sign-in".`);
    }
    return placeId;
  }

  /** Classify, path-rebuild and upsert the account's files in chunks. */
  private async importFiles(
    source: FleetV1Source,
    account: V1Account,
    placeId: string,
    filesDoneBefore: number,
    totalFiles: number,
    label: string,
  ): Promise<{ rowsSeen: number; imported: number }> {
    const { ctx } = this;
    const rows = source.files(account.id);
    const folders: V1FileRow[] = [];
    const items: V1FileRow[] = [];
    let trashed = 0;
    for (const row of rows) {
      if (row.mime === FOLDER_MIME) folders.push(row);
      if (row.trashed) {
        if (row.mime !== FOLDER_MIME) trashed += 1;
      } else if (row.mime !== FOLDER_MIME) {
        items.push(row);
      }
    }
    this.counts.foldersSkipped += folders.length;
    this.counts.trashedSkipped += trashed;

    const tree = new FolderPaths(
      folders.map((f) => ({ id: f.fileId, name: f.name, parentId: f.parentId })),
      rows.map((r) => r.parentId),
    );
    const prepared = this.prepare(items, tree);
    if (tree.orphans > 0) {
      this.counts.orphans += tree.orphans;
      ctx.warn(`${label}: ${plural(tree.orphans, 'file')} are in folders that v1 did not list; they are shown under "(unknown folder)".`);
    }

    const known = new Set(
      (this.db.prepare('SELECT ext_id FROM files WHERE place_id = ? AND ext_id IS NOT NULL').all(placeId) as { ext_id: string }[]).map((r) => r.ext_id),
    );
    const stamp = this.now();
    const seenAt = source.catalogCompletedAt(account.id) ?? stamp;
    const upsert = this.db.prepare(
      `INSERT INTO files (place_id, rel_path, size, mtime, md5, ext_id, mime, web_link, first_seen_at, last_seen_at, kind)
       VALUES (@place, @path, @size, @mtime, @md5, @ext, @mime, @link, @first, @seen, @kind)
       ON CONFLICT(place_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
         rel_path = excluded.rel_path, size = excluded.size, mtime = excluded.mtime, md5 = excluded.md5,
         mime = excluded.mime, web_link = excluded.web_link, last_seen_at = excluded.last_seen_at,
         kind = CASE WHEN rel_path IS excluded.rel_path AND mime IS excluded.mime THEN coalesce(kind, excluded.kind) ELSE excluded.kind END`,
    );
    const kindFor = makeKindResolver(this.db);
    let imported = 0;
    const write = this.db.transaction((chunk: PreparedFile[]) => {
      for (const file of chunk) {
        const params = (relPath: string) => ({
          place: placeId,
          path: relPath,
          size: file.size,
          mtime: file.mtime,
          md5: file.md5,
          ext: file.extId,
          mime: file.mime,
          link: file.webLink,
          first: stamp,
          seen: seenAt,
          kind: kindFor(placeId, relPath, file.mime, file.size),
        });
        let saved = false;
        for (const attempt of [file.relPath, withIdSuffix(file.relPath, file.extId)]) {
          try {
            upsert.run(params(attempt));
            if (attempt !== file.relPath) this.counts.renamedDuplicates += 1;
            saved = true;
            break;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
        }
        if (!saved) {
          this.counts.filesFailed += 1;
          continue;
        }
        imported += 1;
        if (known.has(file.extId)) this.counts.filesUpdated += 1;
        else this.counts.filesNew += 1;
      }
    });

    let done = 0;
    for (let at = 0; at < prepared.length; at += FILE_CHUNK) {
      write(prepared.slice(at, at + FILE_CHUNK));
      done = Math.min(prepared.length, at + FILE_CHUNK);
      ctx.progress(filesDoneBefore + done, totalFiles, { message: `Bringing in ${label}: ${done.toLocaleString('en-US')} of ${prepared.length.toLocaleString('en-US')} files` });
      await ctx.yield();
    }
    if (this.counts.filesFailed > 0) ctx.log('warn', `${label}: ${plural(this.counts.filesFailed, 'file')} could not be saved so far`);
    return { rowsSeen: items.length, imported };
  }

  /** Build rel_paths; two files with the same path get their Drive id added so nothing is lost. */
  private prepare(items: V1FileRow[], tree: FolderPaths): PreparedFile[] {
    const sorted = items.toSorted((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
    const used = new Set<string>();
    const out: PreparedFile[] = [];
    for (const item of sorted) {
      let relPath = tree.pathOf(item.name === '' ? '(untitled)' : item.name, item.parentId);
      if (used.has(relPath)) {
        relPath = withIdSuffix(relPath, item.fileId);
        this.counts.renamedDuplicates += 1;
      }
      used.add(relPath);
      out.push({
        extId: item.fileId,
        relPath,
        size: item.size,
        mtime: parseTime(item.modifiedTime),
        md5: item.md5,
        mime: item.mime,
        webLink: item.webViewLink,
      });
    }
    return out;
  }

  /** After the files: when this account was last looked at, and where that date came from. */
  private finishPlace(placeId: string, lookedAt: number | null, v1CompletedAt: number | null): void {
    const row = this.db.prepare('SELECT identity_json, last_looked_at FROM places WHERE id = ?').get(placeId) as
      | { identity_json: string; last_looked_at: number | null }
      | undefined;
    if (!row) return;
    const identity = parseObject(row.identity_json);
    const catalog = identity['catalog'] as { from?: unknown } | undefined;
    // A date written by a later, real refresh (P4c) is never replaced by the older v1 one.
    const mayReplace = row.last_looked_at === null || catalog?.from === V1_SOURCE_TAG;
    if (!mayReplace || lookedAt === null) return;
    identity['catalog'] = { from: V1_SOURCE_TAG, importedAt: this.now(), v1CompletedAt };
    this.db.prepare('UPDATE places SET identity_json = ?, last_looked_at = ? WHERE id = ?').run(JSON.stringify(identity), lookedAt, placeId);
  }
}
