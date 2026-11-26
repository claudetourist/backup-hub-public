import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DpapiUnprotect } from './decrypt';
import { FOLDER_MIME } from './paths';

/** Synthetic Fleet Manager v1 data for tests. Nothing here is real. */

export const CLIENT_ID = 'synthetic-client-id.apps.example.invalid';
export const CLIENT_SECRET = 'SYNTHETIC-CLIENT-SECRET-0001';

export interface FixtureAccount {
  id: number;
  email: string;
  nickname?: string | null;
  /** Plain refresh token to encrypt, or 'CORRUPT' for an undecryptable value, or null for none. */
  token: string | null;
  status?: string;
  quotaLimit?: number | null;
  quotaUsage?: number | null;
  completedAt?: number | null;
}

export interface FixtureFile {
  account: number;
  id: string;
  name: string;
  mime?: string | null;
  size?: number | null;
  md5?: string | null;
  modified?: string | null;
  link?: string | null;
  trashed?: boolean;
  parent?: string | null;
}

export interface Fixture {
  dir: string;
  key: Buffer;
  dpapi: DpapiUnprotect;
  fakeBlob: Buffer;
  encrypt: (plain: string) => string;
}

export function encryptV10(plain: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]).toString('base64');
}

export function makeFixture(
  dir: string,
  options: { accounts: FixtureAccount[]; files: FixtureFile[]; omitLocalState?: boolean; clientSecret?: string | null; readOnly?: boolean },
): Fixture {
  fs.mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  const fakeBlob = randomBytes(40);
  const dpapi: DpapiUnprotect = async (blob) => {
    if (!blob.equals(fakeBlob)) throw new Error('not this user');
    return Buffer.from(key);
  };
  const encrypt = (plain: string) => encryptV10(plain, key);

  const db = new Database(path.join(dir, 'fleet.db'));
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, nickname TEXT, color TEXT, group_tag TEXT,
      refresh_token_enc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', status_message TEXT,
      quota_limit INTEGER, quota_usage INTEGER, quota_usage_drive INTEGER, quota_usage_trash INTEGER,
      last_quota_at INTEGER, added_at INTEGER NOT NULL
    );
    CREATE TABLE files_cache (
      account_id INTEGER NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT, size INTEGER, md5 TEXT,
      modified_time TEXT, web_view_link TEXT, trashed INTEGER DEFAULT 0, parent_id TEXT,
      PRIMARY KEY (account_id, file_id)
    );
    CREATE TABLE index_state (account_id INTEGER PRIMARY KEY, page_token TEXT, completed_at INTEGER, changes_cursor TEXT);
  `);
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  setSetting.run('clientId', CLIENT_ID);
  if (options.clientSecret !== null) setSetting.run('clientSecretEnc', encrypt(options.clientSecret ?? CLIENT_SECRET));
  for (const a of options.accounts) {
    const enc = a.token === null ? '' : a.token === 'CORRUPT' ? Buffer.concat([Buffer.from('v10'), randomBytes(60)]).toString('base64') : encrypt(a.token);
    db.prepare(
      `INSERT INTO accounts (id, email, nickname, refresh_token_enc, status, quota_limit, quota_usage, quota_usage_drive, quota_usage_trash, last_quota_at, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 100, 5, 1700000000000, 1690000000000)`,
    ).run(a.id, a.email, a.nickname ?? null, enc, a.status ?? 'ok', a.quotaLimit ?? 15_000_000_000, a.quotaUsage ?? 2_000_000_000);
    if (a.completedAt !== undefined) db.prepare('INSERT INTO index_state (account_id, completed_at) VALUES (?, ?)').run(a.id, a.completedAt);
  }
  const insertFile = db.prepare(
    `INSERT INTO files_cache (account_id, file_id, name, mime_type, size, md5, modified_time, web_view_link, trashed, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of options.files) {
    insertFile.run(f.account, f.id, f.name, f.mime ?? null, f.size ?? null, f.md5 ?? null, f.modified ?? null, f.link ?? null, f.trashed ? 1 : 0, f.parent ?? null);
  }
  db.close();

  if (!options.omitLocalState) {
    const localState = { os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), fakeBlob]).toString('base64') } };
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify(localState));
  }
  if (options.readOnly) {
    fs.chmodSync(path.join(dir, 'fleet.db'), 0o444);
    if (!options.omitLocalState) fs.chmodSync(path.join(dir, 'Local State'), 0o444);
  }
  return { dir, key, dpapi, fakeBlob, encrypt };
}

export const folder = (account: number, id: string, name: string, parent: string | null = null): FixtureFile => ({
  account,
  id,
  name,
  mime: FOLDER_MIME,
  parent,
});
