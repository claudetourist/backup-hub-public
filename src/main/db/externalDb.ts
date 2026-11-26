import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ownRemove } from '../danger/ownFiles';

/**
 * SQLite files that are NOT Backup Hub's own database (an old v1 ledger on a drive, a phone ledger, a catalog that sits on a drive)
 * must never be opened in a way that lets SQLite write next to them. A plain read-only open of a WAL-mode file can still create
 * `-shm` and `-wal` files, and a leftover `-journal` can be rolled back (a write). That is forbidden on a protected drive (T7).
 *
 * Two safe ways, both here:
 *  - `openImmutable`: the file's bytes are read into memory and the copy is opened. Nothing is created beside the file. A `-wal` /
 *    `-journal` that exists is ignored, so use it only for a checkpointed file or when a slightly old view is fine.
 *  - `withTempCopy`: copy the file (and its side files) to the system temp folder, open the COPY, remove it afterwards. Always
 *    complete, never touches the original except to read it.
 */
export type ExternalDb = Database.Database;

/** Largest file `openImmutable` will read into memory; bigger ones must use `withTempCopy`. */
export const MAX_IN_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * Read `file` into memory and open THAT (better-sqlite3 here is built without `file:...?immutable=1` URIs, so the same effect is
 * had by opening the bytes). Nothing is created, locked or written beside the file; a `-wal` or `-journal` next to it is ignored
 * (rows only in a `-wal` are not seen: use `withTempCopy` when that matters). Writes to the in-memory copy are refused.
 */
export function openImmutable(file: string): ExternalDb {
  const size = fs.statSync(file).size;
  if (size > MAX_IN_MEMORY_BYTES) throw new Error('This database is too big to open in memory; use withTempCopy.');
  const bytes = fs.readFileSync(file);
  // A WAL-mode file (header bytes 18 and 19 are 2) cannot be opened from memory; the in-memory copy is switched to rollback format.
  if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  const db = new Database(bytes);
  db.pragma('query_only = ON');
  return db;
}

/** Copy `file` (+ `-wal`, `-shm`, `-journal` if present) to a fresh temp folder, run `fn` on a read-only connection to the copy, clean up. */
export function withTempCopy<T>(file: string, fn: (db: ExternalDb) => T, tempRoot: string = os.tmpdir()): T {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'backuphub-extdb-'));
  let db: ExternalDb | null = null;
  try {
    const copy = path.join(dir, 'copy.db');
    fs.copyFileSync(file, copy);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
    }
    db = new Database(copy, { readonly: true, fileMustExist: true });
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {
      // Only our own copy.
    }
    ownRemove(dir, { recursive: true });
  }
}
