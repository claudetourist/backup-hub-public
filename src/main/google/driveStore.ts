/**
 * Database side of the Drive refresh: `drive_items` (raw names and parents of live owned items),
 * `drive_sync` (changes bookmark) and the `files` rows of a Google account. Nothing here is ever
 * deleted from `files`: items that disappeared get `gone_at`. `drive_items` is the app's own
 * derived table, so its rows may be dropped when Drive says an item is gone.
 */
import { makeKindResolver } from '../classify/sortKinds';
import type { Db } from '../db';
import { FolderPaths, withIdSuffix } from '../import/fleetV1/paths';
import { FOLDER_MIME, type DriveChange, type DriveFileInfo } from './driveApi';

/** Rows written per transaction; callers yield between chunks. */
export const WRITE_CHUNK = 2000;

export interface DriveItem {
  extId: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
}

export interface SyncRow {
  changesToken: string | null;
  fullListedAt: number | null;
  changesAt: number | null;
}

export function getSync(db: Db, placeId: string): SyncRow {
  const row = db.prepare('SELECT changes_token, full_listed_at, changes_at FROM drive_sync WHERE place_id = ?').get(placeId) as
    | { changes_token: string | null; full_listed_at: number | null; changes_at: number | null }
    | undefined;
  return { changesToken: row?.changes_token ?? null, fullListedAt: row?.full_listed_at ?? null, changesAt: row?.changes_at ?? null };
}

export function setSync(db: Db, placeId: string, token: string | null, patch: { fullListedAt?: number; changesAt?: number }): void {
  db.prepare(
    `INSERT INTO drive_sync (place_id, changes_token, full_listed_at, changes_at) VALUES (@place, @token, @full, @changes)
     ON CONFLICT(place_id) DO UPDATE SET
       changes_token = excluded.changes_token,
       full_listed_at = COALESCE(excluded.full_listed_at, drive_sync.full_listed_at),
       changes_at = COALESCE(excluded.changes_at, drive_sync.changes_at)`,
  ).run({ place: placeId, token, full: patch.fullListedAt ?? null, changes: patch.changesAt ?? null });
}

export function clearChangesToken(db: Db, placeId: string): void {
  db.prepare('UPDATE drive_sync SET changes_token = NULL WHERE place_id = ?').run(placeId);
}

export function readItems(db: Db, placeId: string): DriveItem[] {
  return (db.prepare('SELECT ext_id, parent_ext_id, name, is_folder FROM drive_items WHERE place_id = ?').all(placeId) as {
    ext_id: string;
    parent_ext_id: string | null;
    name: string;
    is_folder: number;
  }[]).map((r) => ({ extId: r.ext_id, parentId: r.parent_ext_id, name: r.name, isFolder: r.is_folder === 1 }));
}

export const toItem = (f: DriveFileInfo): DriveItem => ({ extId: f.id, parentId: f.parent, name: f.name, isFolder: f.mimeType === FOLDER_MIME });

/**
 * rel_path of every file, from the raw names and parents. Same rules as the Fleet Manager v1
 * import (P4a): "My Drive/..." paths, "(unknown folder)" for unknown parents, and a file that
 * would get the same path as an earlier one (ordered by Drive id) gets its id added.
 */
export function computePaths(items: readonly DriveItem[]): Map<string, string> {
  const folders = items.filter((i) => i.isFolder);
  const files = items.filter((i) => !i.isFolder).toSorted((a, b) => (a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0));
  const tree = new FolderPaths(
    folders.map((f) => ({ id: f.extId, name: f.name, parentId: f.parentId })),
    items.map((i) => i.parentId),
  );
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const file of files) {
    let relPath = tree.pathOf(file.name === '' ? '(untitled)' : file.name, file.parentId);
    if (used.has(relPath)) relPath = withIdSuffix(relPath, file.extId);
    used.add(relPath);
    out.set(file.extId, relPath);
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}

interface PathRow {
  extId: string;
  relPath: string;
}

/**
 * Writes rows that carry a rel_path in chunks. A row whose path is taken by another row (often one
 * that moves away later in the same pass) is tried again after the others; what still clashes gets
 * its Drive id added. `write` runs inside a transaction and must throw on a unique clash.
 */
async function writeWithRetry<T extends PathRow>(
  db: Db,
  rows: readonly T[],
  write: (row: T, relPath: string) => void,
  onSaved: (row: T) => void,
  yieldFn: () => Promise<void>,
): Promise<number> {
  let pending: T[] = [...rows];
  const run = db.transaction((chunk: T[], useSuffix: boolean, clashed: T[], failed: { n: number }) => {
    for (const row of chunk) {
      try {
        write(row, useSuffix ? withIdSuffix(row.relPath, row.extId) : row.relPath);
        onSaved(row);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (useSuffix) failed.n += 1;
        else clashed.push(row);
      }
    }
  });
  const failed = { n: 0 };
  for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
    const clashed: T[] = [];
    for (let at = 0; at < pending.length; at += WRITE_CHUNK) {
      run(pending.slice(at, at + WRITE_CHUNK), false, clashed, failed);
      await yieldFn();
    }
    if (clashed.length === pending.length) {
      pending = clashed;
      break;
    }
    pending = clashed;
  }
  for (let at = 0; at < pending.length; at += WRITE_CHUNK) {
    run(pending.slice(at, at + WRITE_CHUNK), true, [], failed);
    await yieldFn();
  }
  return failed.n;
}

export interface CommitCounts {
  filesNew: number;
  filesUpdated: number;
  filesFailed: number;
  gone: number;
}

interface FileUpsert extends PathRow {
  info: DriveFileInfo;
}

/** Insert or update file rows by (place_id, ext_id): ids stay the same when a file moves or is renamed. */
async function upsertFileRows(db: Db, placeId: string, rows: readonly FileUpsert[], now: number, yieldFn: () => Promise<void>, counts: CommitCounts): Promise<void> {
  const known = new Set<string>();
  const existing = db.prepare('SELECT 1 FROM files WHERE place_id = ? AND ext_id = ?');
  for (const row of rows) if (existing.get(placeId, row.extId)) known.add(row.extId);
  const upsert = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, md5, ext_id, mime, web_link, first_seen_at, last_seen_at, gone_at, kind)
     VALUES (@place, @path, @size, @mtime, @md5, @ext, @mime, @link, @now, @now, NULL, @kind)
     ON CONFLICT(place_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
       rel_path = excluded.rel_path, size = excluded.size, mtime = excluded.mtime, md5 = excluded.md5,
       mime = excluded.mime, web_link = excluded.web_link, last_seen_at = excluded.last_seen_at, gone_at = NULL,
       -- the stored kind follows the path, the mime type and size 0: a row that changed any of them gets its new kind; a row with none gets one now
       kind = CASE WHEN rel_path IS excluded.rel_path AND mime IS excluded.mime AND (size IS excluded.size OR (size IS NOT 0 AND excluded.size IS NOT 0)) THEN coalesce(kind, excluded.kind) ELSE excluded.kind END`,
  );
  const kindFor = makeKindResolver(db);
  const failed = await writeWithRetry(
    db,
    rows,
    (row, relPath) => {
      const mime = row.info.mimeType === '' ? null : row.info.mimeType;
      upsert.run({
        place: placeId,
        path: relPath,
        size: row.info.size,
        mtime: row.info.mtime,
        md5: row.info.md5,
        ext: row.extId,
        mime,
        link: row.info.webLink,
        now,
        kind: kindFor(placeId, relPath, mime, row.info.size),
      });
    },
    (row) => {
      if (known.has(row.extId)) counts.filesUpdated += 1;
      else counts.filesNew += 1;
    },
    yieldFn,
  );
  counts.filesFailed += failed;
}

export interface LostCopies {
  files: number;
  bytes: number;
  /** The first few names, for the message. */
  names: string[];
}

/**
 * Files of this Drive account that were marked gone at or after `since` and whose content no other live row holds, anywhere
 * (same md5 and size): the Drive copy was the only one, and now there is none. Read only; files without an md5 (Google Docs)
 * cannot be matched and are left out.
 */
export function lostLastCopies(db: Db, placeId: string, since: number, nameLimit = 5): LostCopies {
  const rows = db
    .prepare(
      `SELECT g.name AS name, g.size AS size FROM files g
        WHERE g.place_id = ? AND g.gone_at >= ? AND g.md5 IS NOT NULL AND g.size IS NOT NULL AND g.size > 0
          AND NOT EXISTS (SELECT 1 FROM files o WHERE o.md5 = g.md5 AND o.size = g.size AND o.gone_at IS NULL)
        ORDER BY g.size DESC`,
    )
    .all(placeId, since) as { name: string; size: number }[];
  return { files: rows.length, bytes: rows.reduce((sum, r) => sum + r.size, 0), names: rows.slice(0, nameLimit).map((r) => r.name) };
}

/** Mark rows gone (never delete them). Returns how many were newly marked. */
function markGoneByExtId(db: Db, placeId: string, extIds: readonly string[], now: number): number {
  const stmt = db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND ext_id = ? AND gone_at IS NULL');
  let n = 0;
  db.transaction(() => {
    for (const id of extIds) n += stmt.run(now, placeId, id).changes;
  })();
  return n;
}

async function writeItems(db: Db, placeId: string, items: readonly DriveItem[], yieldFn: () => Promise<void>): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO drive_items (place_id, ext_id, parent_ext_id, name, is_folder) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(place_id, ext_id) DO UPDATE SET parent_ext_id = excluded.parent_ext_id, name = excluded.name, is_folder = excluded.is_folder`,
  );
  const write = db.transaction((chunk: readonly DriveItem[]) => {
    for (const i of chunk) stmt.run(placeId, i.extId, i.parentId, i.name, i.isFolder ? 1 : 0);
  });
  for (let at = 0; at < items.length; at += WRITE_CHUNK) {
    write(items.slice(at, at + WRITE_CHUNK));
    await yieldFn();
  }
}

async function deleteItems(db: Db, placeId: string, extIds: readonly string[], yieldFn: () => Promise<void>): Promise<void> {
  const stmt = db.prepare('DELETE FROM drive_items WHERE place_id = ? AND ext_id = ?');
  const del = db.transaction((chunk: readonly string[]) => {
    for (const id of chunk) stmt.run(placeId, id);
  });
  for (let at = 0; at < extIds.length; at += WRITE_CHUNK) {
    del(extIds.slice(at, at + WRITE_CHUNK));
    await yieldFn();
  }
}

/**
 * A complete list of the account's owned, untrashed items arrived. Rebuild everything from it:
 * items, paths, file rows; rows of this account that were not in the list get `gone_at`.
 */
export async function commitFullList(db: Db, placeId: string, listed: readonly DriveFileInfo[], now: number, yieldFn: () => Promise<void>): Promise<CommitCounts> {
  const counts: CommitCounts = { filesNew: 0, filesUpdated: 0, filesFailed: 0, gone: 0 };
  // Drive can repeat an item across pages; the last copy wins.
  const byId = new Map<string, DriveFileInfo>();
  for (const f of listed) byId.set(f.id, f);
  const infos = [...byId.values()];
  const items = infos.map(toItem);

  await writeItems(db, placeId, items, yieldFn);
  const keep = new Set(byId.keys());
  const staleItems = (db.prepare('SELECT ext_id FROM drive_items WHERE place_id = ?').all(placeId) as { ext_id: string }[]).map((r) => r.ext_id).filter((id) => !keep.has(id));
  await deleteItems(db, placeId, staleItems, yieldFn);

  const paths = computePaths(items);
  const rows: FileUpsert[] = [];
  for (const info of infos) {
    const relPath = paths.get(info.id);
    if (relPath !== undefined) rows.push({ extId: info.id, relPath, info });
  }
  await upsertFileRows(db, placeId, rows, now, yieldFn, counts);

  const live = (db.prepare('SELECT ext_id FROM files WHERE place_id = ? AND ext_id IS NOT NULL AND gone_at IS NULL').all(placeId) as { ext_id: string }[]).map((r) => r.ext_id);
  const missing = live.filter((id) => !keep.has(id));
  for (let at = 0; at < missing.length; at += WRITE_CHUNK) {
    counts.gone += markGoneByExtId(db, placeId, missing.slice(at, at + WRITE_CHUNK), now);
    await yieldFn();
  }
  return counts;
}

/** Removed, trashed or no longer mine: the item leaves the account's list. */
function isDropped(change: DriveChange): boolean {
  return change.removed || change.file === null || change.file.trashed || change.file.ownedByMe === false;
}

/**
 * A whole changes run arrived (up to the new bookmark). Apply it: removed, trashed and not-mine
 * items leave `drive_items` and their file rows get `gone_at`; new and changed items are written,
 * and all paths are rebuilt (a folder rename or move changes the paths of everything below it).
 */
export async function commitChanges(db: Db, placeId: string, changes: readonly DriveChange[], now: number, yieldFn: () => Promise<void>): Promise<CommitCounts> {
  const counts: CommitCounts = { filesNew: 0, filesUpdated: 0, filesFailed: 0, gone: 0 };
  const latest = new Map<string, DriveChange>();
  for (const c of changes) latest.set(c.fileId, c); // the last change of an item wins
  const before = new Map(readItems(db, placeId).map((i) => [i.extId, i]));

  let structureChanged = false;
  const dropIds: string[] = [];
  const itemWrites: DriveItem[] = [];
  const metaWrites = new Map<string, DriveFileInfo>();
  for (const change of latest.values()) {
    if (isDropped(change)) {
      const old = before.get(change.fileId);
      if (old?.isFolder) structureChanged = true;
      // Marked even if we never held it in drive_items: a file row may exist from the v1 import.
      dropIds.push(change.fileId);
      continue;
    }
    const info: DriveFileInfo = { ...change.file!, id: change.fileId };
    const item = toItem(info);
    const old = before.get(item.extId);
    if (item.isFolder) {
      if (!old || old.name !== item.name || old.parentId !== item.parentId || !old.isFolder) structureChanged = true;
    } else {
      if (old?.isFolder) structureChanged = true;
      metaWrites.set(item.extId, info);
    }
    itemWrites.push(item);
  }

  const dropped = dropIds;
  await deleteItems(db, placeId, dropped, yieldFn);
  await writeItems(db, placeId, itemWrites, yieldFn);
  for (let at = 0; at < dropped.length; at += WRITE_CHUNK) {
    counts.gone += markGoneByExtId(db, placeId, dropped.slice(at, at + WRITE_CHUNK), now);
    await yieldFn();
  }

  if (itemWrites.length === 0 && !structureChanged) return counts;
  const paths = computePaths(readItems(db, placeId));

  const rows: FileUpsert[] = [];
  for (const [id, info] of metaWrites) {
    const relPath = paths.get(id);
    if (relPath !== undefined) rows.push({ extId: id, relPath, info });
  }
  await upsertFileRows(db, placeId, rows, now, yieldFn, counts);

  if (structureChanged) {
    // Everything below a renamed or moved folder has a new path; other rows keep theirs.
    const current = db.prepare('SELECT ext_id, rel_path, mime, size FROM files WHERE place_id = ? AND ext_id IS NOT NULL AND gone_at IS NULL').all(placeId) as { ext_id: string; rel_path: string; mime: string | null; size: number | null }[];
    const moved: (PathRow & { mime: string | null; size: number | null })[] = [];
    for (const row of current) {
      const wanted = paths.get(row.ext_id);
      if (wanted !== undefined && wanted !== row.rel_path && !metaWrites.has(row.ext_id)) moved.push({ extId: row.ext_id, relPath: wanted, mime: row.mime, size: row.size });
    }
    const update = db.prepare('UPDATE files SET rel_path = ?, kind = ? WHERE place_id = ? AND ext_id = ? AND gone_at IS NULL');
    const kindFor = makeKindResolver(db);
    counts.filesFailed += await writeWithRetry(db, moved, (row, relPath) => void update.run(relPath, kindFor(placeId, relPath, row.mime, row.size), placeId, row.extId), () => undefined, yieldFn);
  }
  return counts;
}
