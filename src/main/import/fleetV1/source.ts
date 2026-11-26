import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FOLDER_MIME } from './paths';
import { ownRemove } from '../../danger/ownFiles';

/** There is no built-in place for the archived v1 data (read only; the import works on a temporary copy): the caller names the folder (dev runs: BACKUPHUB_V1_SOURCE_DIR). */
export const V1_ARCHIVE_USERDATA = '';
export const V1_DB_NAME = 'fleet.db';
export const V1_LOCAL_STATE_NAME = 'Local State';

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

/** True when both v1 files are present in `dir` (does not open them). */
export function sourceFilesPresent(dir: string): boolean {
  return fs.existsSync(path.join(dir, V1_DB_NAME)) && fs.existsSync(path.join(dir, V1_LOCAL_STATE_NAME));
}

export interface SourceCopy {
  dir: string;
  dbFile: string;
  localStateFile: string;
}

/**
 * Copy fleet.db (and its -wal/-shm if v1 left them) and Local State into a fresh folder under
 * `tempRoot`. Only reads from `sourceDir`; the copy is what gets opened. The copy is made writable
 * so it can be deleted afterwards (the archive files carry the read-only attribute).
 */
export function copySource(sourceDir: string, tempRoot: string): SourceCopy {
  const dbSource = path.join(sourceDir, V1_DB_NAME);
  const stateSource = path.join(sourceDir, V1_LOCAL_STATE_NAME);
  if (!fs.existsSync(dbSource)) throw new SourceError(`The Fleet Manager v1 database was not found in ${sourceDir}`);
  if (!fs.existsSync(stateSource)) throw new SourceError(`The Fleet Manager v1 "Local State" file was not found in ${sourceDir}`);
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'fleetv1-'));
  const copy = (name: string): string => {
    const target = path.join(dir, name);
    fs.copyFileSync(path.join(sourceDir, name), target);
    fs.chmodSync(target, 0o666);
    return target;
  };
  const dbFile = copy(V1_DB_NAME);
  for (const extra of [`${V1_DB_NAME}-wal`, `${V1_DB_NAME}-shm`]) {
    if (fs.existsSync(path.join(sourceDir, extra))) copy(extra);
  }
  return { dir, dbFile, localStateFile: copy(V1_LOCAL_STATE_NAME) };
}

/** Remove a copy made by `copySource` (only ever our own temp folder). */
export function removeCopy(copy: SourceCopy | null, tempRoot: string): void {
  if (!copy) return;
  const rel = path.relative(path.resolve(tempRoot), path.resolve(copy.dir));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
  ownRemove(copy.dir, { recursive: true });
}

export interface V1Account {
  id: number;
  email: string;
  nickname: string | null;
  /** Encrypted base64 text. Never logged. */
  refreshTokenEnc: string | null;
  status: string | null;
  quotaLimit: number | null;
  quotaUsage: number | null;
  quotaUsageDrive: number | null;
  quotaUsageTrash: number | null;
  lastQuotaAt: number | null;
  addedAt: number | null;
}

export interface V1FileRow {
  fileId: string;
  name: string;
  mime: string | null;
  size: number | null;
  md5: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  trashed: boolean;
  parentId: string | null;
}

const REQUIRED: Record<string, readonly string[]> = {
  accounts: ['id', 'email', 'refresh_token_enc'],
  settings: ['key', 'value'],
  files_cache: ['account_id', 'file_id', 'name'],
};
const OPTIONAL_ACCOUNT = ['nickname', 'status', 'quota_limit', 'quota_usage', 'quota_usage_drive', 'quota_usage_trash', 'last_quota_at', 'added_at'] as const;
const OPTIONAL_FILE = ['mime_type', 'size', 'md5', 'modified_time', 'web_view_link', 'trashed', 'parent_id'] as const;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The v1 database, opened read only. Every query reads; nothing here writes. */
export class FleetV1Source {
  private readonly db: Database.Database;
  private readonly accountCols: Set<string>;
  private readonly fileCols: Set<string>;
  private readonly hasIndexState: boolean;

  /** Opens `file` read only and checks it looks like a Fleet Manager v1 database. Throws SourceError. */
  constructor(file: string) {
    try {
      this.db = new Database(file, { readonly: true, fileMustExist: true });
    } catch {
      throw new SourceError('The Fleet Manager v1 database could not be opened');
    }
    try {
      const columnsOf = (table: string): Set<string> =>
        new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [table, cols] of Object.entries(REQUIRED)) {
        const have = columnsOf(table);
        if (have.size === 0) throw new SourceError(`This is not a Fleet Manager v1 database (table "${table}" is missing)`);
        const missing = cols.filter((c) => !have.has(c));
        if (missing.length > 0) throw new SourceError(`This is not a Fleet Manager v1 database (table "${table}" lacks ${missing.join(', ')})`);
      }
      this.accountCols = columnsOf('accounts');
      this.fileCols = columnsOf('files_cache');
      this.hasIndexState = columnsOf('index_state').has('completed_at');
    } catch (err) {
      this.db.close();
      throw err instanceof SourceError ? err : new SourceError('The Fleet Manager v1 database could not be read');
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private col(have: Set<string>, name: string, alias?: string): string {
    return have.has(name) ? name : `NULL AS ${alias ?? name}`;
  }

  /** A raw setting (clientId is plain, clientSecretEnc is encrypted). */
  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
    return text(row?.value);
  }

  accounts(): V1Account[] {
    const select = [
      'id',
      'email',
      'refresh_token_enc',
      ...OPTIONAL_ACCOUNT.map((c) => this.col(this.accountCols, c)),
    ].join(', ');
    const rows = this.db.prepare(`SELECT ${select} FROM accounts ORDER BY id`).all() as Record<string, unknown>[];
    return rows
      .filter((r) => typeof r['email'] === 'string' && r['email'] !== '' && typeof r['id'] === 'number')
      .map((r) => ({
        id: r['id'] as number,
        email: (r['email'] as string).trim(),
        nickname: text(r['nickname'])?.trim() ?? null,
        refreshTokenEnc: text(r['refresh_token_enc']),
        status: text(r['status']),
        quotaLimit: num(r['quota_limit']),
        quotaUsage: num(r['quota_usage']),
        quotaUsageDrive: num(r['quota_usage_drive']),
        quotaUsageTrash: num(r['quota_usage_trash']),
        lastQuotaAt: num(r['last_quota_at']),
        addedAt: num(r['added_at']),
      }));
  }

  /** When v1 last finished listing this account's files (epoch ms), or null. */
  catalogCompletedAt(accountId: number): number | null {
    if (!this.hasIndexState) return null;
    const row = this.db.prepare('SELECT completed_at FROM index_state WHERE account_id = ?').get(accountId) as
      | { completed_at: number | null }
      | undefined;
    return num(row?.completed_at);
  }

  /** Counts for progress: items that will become files (not folders, not trashed), of one account or of all. */
  importableCount(accountId?: number): number {
    const mime = this.fileCols.has('mime_type') ? "AND COALESCE(mime_type, '') <> ?" : 'AND ? IS NOT NULL';
    const trashed = this.fileCols.has('trashed') ? 'AND COALESCE(trashed, 0) = 0' : '';
    const row = (
      accountId === undefined
        ? this.db.prepare(`SELECT count(*) AS n FROM files_cache WHERE 1 = 1 ${trashed} ${mime}`).get(FOLDER_MIME)
        : this.db.prepare(`SELECT count(*) AS n FROM files_cache WHERE account_id = ? ${trashed} ${mime}`).get(accountId, FOLDER_MIME)
    ) as { n: number };
    return row.n;
  }

  /** Every cached row of one account (folders and trashed rows included: the caller classifies them). */
  files(accountId: number): V1FileRow[] {
    const select = ['file_id', 'name', ...OPTIONAL_FILE.map((c) => this.col(this.fileCols, c))].join(', ');
    const rows = this.db.prepare(`SELECT ${select} FROM files_cache WHERE account_id = ?`).all(accountId) as Record<string, unknown>[];
    return rows
      .filter((r) => typeof r['file_id'] === 'string' && r['file_id'] !== '')
      .map((r) => ({
        fileId: r['file_id'] as string,
        name: typeof r['name'] === 'string' ? r['name'] : '',
        mime: text(r['mime_type']),
        size: num(r['size']),
        md5: text(r['md5'])?.toLowerCase() ?? null,
        modifiedTime: text(r['modified_time']),
        webViewLink: text(r['web_view_link']),
        trashed: Number(r['trashed'] ?? 0) !== 0,
        parentId: text(r['parent_id']),
      }));
  }
}
