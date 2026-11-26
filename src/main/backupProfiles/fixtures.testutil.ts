import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, type Db } from '../db';

/** Shared by the backup profile tests: a migrated temp database, places, index rows and old history (ledger.db) files. */
export interface Rig {
  dir: string;
  db: Db;
  close(): void;
}

export function makeRig(): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-profiles-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  runMigrations(db);
  return {
    dir,
    db,
    close() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function addPlace(db: Db, id: string, kind: 'laptop' | 'drive' | 'phone' | 'onedrive', label: string, identity: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, ?, ?, ?, 1)").run(id, kind, label, JSON.stringify(identity));
}

export interface IndexRow {
  place: string;
  rel: string;
  size: number;
  mtime?: number | null;
  sha?: string | null;
  md5?: string | null;
  gone?: number | null;
  goneReason?: string | null;
  expected?: string | null;
  verifiedHow?: string | null;
}

export function addIndexRows(db: Db, rows: readonly IndexRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at, gone_reason, expected_sha256, verified_how)
     VALUES (@place, @rel, @size, @mtime, @sha, @md5, 1000, 2000, @gone, @goneReason, @expected, @verifiedHow)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run({ mtime: 5, sha: null, md5: null, gone: null, goneReason: null, expected: null, verifiedHow: null, ...r });
    }
  })();
}

export interface LedgerFixtureRow {
  filename?: string | null;
  file_size?: number | null;
  file_hash?: string | null;
  local_path?: string | null;
  original_phone_path?: string | null;
  file_mtime?: number | null;
  cloud_account?: string | null;
  cloud_path?: string | null;
}

export interface LedgerOptions {
  /** Leave out the columns an old PhoneBackup ledger did not have yet. */
  withMtime?: boolean;
  withCloud?: boolean;
  /** Paths for the excluded_paths table; null leaves the table out. */
  excluded?: { path: string; addedAt: string }[] | null;
}

/** An old PhoneBackup ledger.db, as v3_engine.py init_db makes it. */
export function makeLedger(file: string, rows: readonly LedgerFixtureRow[], options: LedgerOptions = {}): void {
  const withMtime = options.withMtime ?? true;
  const withCloud = options.withCloud ?? true;
  const db = new Database(file);
  db.exec(
    `CREATE TABLE ledger (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       filename TEXT, file_size INTEGER, file_hash TEXT, local_path TEXT, original_phone_path TEXT UNIQUE
       ${withMtime ? ', file_mtime INTEGER' : ''}
       ${withCloud ? ', cloud_account TEXT, cloud_path TEXT' : ''}
     )`,
  );
  const cols = ['filename', 'file_size', 'file_hash', 'local_path', 'original_phone_path', ...(withMtime ? ['file_mtime'] : []), ...(withCloud ? ['cloud_account', 'cloud_path'] : [])];
  const stmt = db.prepare(`INSERT INTO ledger (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  db.transaction(() => {
    for (const r of rows) {
      const base: Record<string, unknown> = { filename: null, file_size: null, file_hash: null, local_path: null, original_phone_path: null, file_mtime: null, cloud_account: null, cloud_path: null, ...r };
      stmt.run(Object.fromEntries(cols.map((c) => [c, base[c]])));
    }
  })();
  if (options.excluded) {
    db.exec('CREATE TABLE excluded_paths (original_phone_path TEXT PRIMARY KEY, added_at TEXT)');
    const ins = db.prepare('INSERT INTO excluded_paths VALUES (?, ?)');
    for (const e of options.excluded) ins.run(e.path, e.addedAt);
  }
  db.close();
}

export const sha = (n: number): string => n.toString(16).padStart(64, '0');
