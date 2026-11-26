import type { Db } from '../db';
import { LOSE_PAGE_SIZE, type LoseBackup, type LoseFile, type LoseKind, type LoseSection, type OnlyHereSummary, type WouldLoseDetail, type WouldLoseFilesPage, type WouldLoseFilesRequest } from '../../shared/insights';
import { KIND_LABELS } from '../../shared/fileKinds';

/**
 * "What would I lose?" Read only; it runs on the query worker (the catalog has over a million rows), never on the main thread.
 *
 * A file of a device has a CHECKED copy when another device holds a live row with the same SHA-256. A file without one is
 * "only here", unless a live row with the same name and size sits on another device: then it is "maybe copied" (shown apart, never
 * counted as safe). Empty files are left out (they are not a loss), a file with no size (a Google Doc) counts with 0 bytes.
 *
 * Both probes are index lookups: `idx_files_sha256_live` (sha256, place_id) and `idx_files_size_name` (size, name). INDEXED BY is
 * deliberate: without it a lookup once walked a whole folder per file (CLAUDE.md, 23 Nov 2026). No new index is needed.
 */
const NO_CHECKED_COPY = `
  f.gone_at IS NULL AND f.size IS NOT 0
  AND (f.sha256 IS NULL OR NOT EXISTS (
    SELECT 1 FROM files o INDEXED BY idx_files_sha256_live
     WHERE o.sha256 = f.sha256 AND o.gone_at IS NULL AND o.place_id <> f.place_id))`;

const MAYBE_COPIED = `
  EXISTS (SELECT 1 FROM files m INDEXED BY idx_files_size_name
           WHERE m.size = f.size AND m.name = f.name AND m.gone_at IS NULL AND m.place_id <> f.place_id)`;

/**
 * The summary of the named drives: how many files and bytes have no checked copy anywhere else (the "only here" and the "maybe copied" of the
 * detail together: a file is only counted as safe with a checked copy). Drives only, because Home and the drive cards are what read it, and
 * one pass over 1.1 million rows with a second probe per file took 100 s on a generated catalog; the drives' rows take a fraction of that.
 */
export const ONLY_HERE_SUMMARY_SQL = `
SELECT f.place_id, count(*) AS files, coalesce(sum(f.size), 0) AS bytes
  FROM files f WHERE f.place_id IN (SELECT id FROM places WHERE kind = 'drive') AND ${NO_CHECKED_COPY}
 GROUP BY f.place_id`;

/** Every file of ONE place without a checked copy, with what the lists need. */
export const WOULD_LOSE_ROWS_SQL = `
SELECT f.rel_path, f.size, f.kind, f.sha256 IS NULL AS unchecked, ${MAYBE_COPIED} AS maybe
  FROM files f WHERE f.place_id = @placeId AND ${NO_CHECKED_COPY}`;

/** How many folders of one kind are listed by name; the rest are lumped together. */
export const FOLDERS_PER_KIND = 6;

/** The summary for every named drive that has any file without a checked copy (one pass; the card line and Home read it). */
export function onlyHereSummaryOf(db: Db): OnlyHereSummary[] {
  return (db.prepare(ONLY_HERE_SUMMARY_SQL).all() as { place_id: string; files: number; bytes: number }[]).map((row) => ({ placeId: row.place_id, files: row.files, bytes: row.bytes }));
}

/** The first `depth` folders of a path ("Pictures/2023" for "Pictures/2023/Trip/a.jpg"); "(top level)" for a file in the root. */
export function folderOf(relPath: string, depth: number): string {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash < 0) return '(top level)';
  const parts = relPath.slice(0, lastSlash).split('/');
  return parts.slice(0, depth).join('/');
}

interface Tally {
  files: number;
  bytes: number;
}

/** The folder of a backup on one place (its backup folder on a drive; everything on a phone that is the source of a phone backup). */
interface BackupRoot {
  backupId: number;
  name: string;
  /** Lower case, forward slashes, no slash at the ends; '' = the whole place. */
  root: string;
}

const NOT_IN_A_BACKUP = 'Not part of any backup';

/** The backups that have a folder on this place, the longest folder first (so "MyData/POCO/IMP" wins over "MyData/POCO"). A few rows. */
function backupRootsOf(db: Db, placeId: string): BackupRoot[] {
  const clean = (root: string): string => root.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const out: BackupRoot[] = [];
  for (const row of db
    .prepare('SELECT d.backup_profile_id AS id, p.name, d.root FROM backup_destinations d JOIN backup_profiles p ON p.id = d.backup_profile_id WHERE d.place_id = ? AND p.archived_at IS NULL')
    .all(placeId) as { id: number; name: string; root: string }[]) {
    out.push({ backupId: row.id, name: row.name, root: clean(row.root) });
  }
  for (const row of db.prepare("SELECT id, name FROM backup_profiles WHERE source_kind = 'phone' AND source_place_id = ? AND archived_at IS NULL").all(placeId) as { id: number; name: string }[]) {
    out.push({ backupId: row.id, name: row.name, root: '' });
  }
  return out.toSorted((a, b) => b.root.length - a.root.length);
}

/** Which backup a path belongs to, or null. */
function backupOf(roots: readonly BackupRoot[], relPath: string): BackupRoot | null {
  if (roots.length === 0) return null;
  const lower = relPath.toLowerCase();
  for (const r of roots) if (r.root === '' || lower === r.root || lower.startsWith(r.root + '/')) return r;
  return null;
}

/** Collects files by kind and folder, then lists the biggest first. */
class Grouping {
  files = 0;
  bytes = 0;
  private readonly kinds = new Map<string, { files: number; bytes: number; folders: Map<string, Tally> }>();
  private readonly backups = new Map<number | null, LoseBackup>();

  add(kind: string, folder: string, size: number, backup: BackupRoot | null): void {
    this.files += 1;
    this.bytes += size;
    const key = backup?.backupId ?? null;
    const b = this.backups.get(key);
    if (b) {
      b.files += 1;
      b.bytes += size;
    } else this.backups.set(key, { backupId: key, name: backup?.name ?? NOT_IN_A_BACKUP, files: 1, bytes: size });
    let k = this.kinds.get(kind);
    if (!k) {
      k = { files: 0, bytes: 0, folders: new Map() };
      this.kinds.set(kind, k);
    }
    k.files += 1;
    k.bytes += size;
    const f = k.folders.get(folder);
    if (f) {
      f.files += 1;
      f.bytes += size;
    } else k.folders.set(folder, { files: 1, bytes: size });
  }

  section(): LoseSection {
    const kinds: LoseKind[] = [...this.kinds.entries()]
      .map(([kind, k]) => {
        const sorted = [...k.folders.entries()].toSorted((a, b) => b[1].bytes - a[1].bytes || b[1].files - a[1].files || a[0].localeCompare(b[0]));
        const shown = sorted.slice(0, FOLDERS_PER_KIND);
        const rest = sorted.slice(FOLDERS_PER_KIND);
        return {
          kind,
          files: k.files,
          bytes: k.bytes,
          folders: shown.map(([folder, t]) => ({ folder, files: t.files, bytes: t.bytes })),
          rest: { folders: rest.length, files: rest.reduce((s, [, t]) => s + t.files, 0), bytes: rest.reduce((s, [, t]) => s + t.bytes, 0) },
        };
      })
      .toSorted((a, b) => b.bytes - a.bytes || b.files - a.files || a.kind.localeCompare(b.kind));
    const byBackup = [...this.backups.values()].toSorted((a, b) => b.bytes - a.bytes || b.files - a.files || a.name.localeCompare(b.name));
    return { files: this.files, bytes: this.bytes, kinds, byBackup };
  }
}

/** A drive's folders start with the app's own ("MyData/POCO/..."): one level deeper tells more. */
const DEPTH_OF_KIND: Readonly<Record<string, number>> = { drive: 3 };

/** What only lives on one place, grouped by kind and folder, biggest first. */
export function wouldLoseOf(db: Db, placeId: string): WouldLoseDetail {
  const placeKind = db.prepare('SELECT kind FROM places WHERE id = ?').pluck().get(placeId) as string | undefined;
  const depth = DEPTH_OF_KIND[placeKind ?? ''] ?? 2;
  const only = new Grouping();
  const maybe = new Grouping();
  const notChecked: Tally = { files: 0, bytes: 0 };
  const roots = backupRootsOf(db, placeId);
  for (const row of db.prepare(WOULD_LOSE_ROWS_SQL).iterate({ placeId }) as Iterable<{ rel_path: string; size: number | null; kind: string | null; unchecked: number; maybe: number }>) {
    const size = row.size ?? 0;
    (row.maybe === 1 ? maybe : only).add(row.kind !== null && row.kind in KIND_LABELS ? row.kind : 'other', folderOf(row.rel_path, depth), size, backupOf(roots, row.rel_path));
    if (row.unchecked === 1) {
      notChecked.files += 1;
      notChecked.bytes += size;
    }
  }
  const totalFiles = db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NULL AND size IS NOT 0').pluck().get(placeId) as number;
  return { placeId, onlyHere: only.section(), maybeCopied: maybe.section(), notChecked, totalFiles };
}

/** A LIKE pattern that matches the text anywhere ("_" and "%" typed by the person are literal). */
function likeOf(word: string): string {
  return '%' + word.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** The words of a search box (at most 8, each at most 80 characters). */
export function searchWordsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '').slice(0, 8).map((word) => word.slice(0, 80));
}

/**
 * One page of the files that have no checked copy elsewhere (or only a maybe), biggest first, filtered by words of the path and a kind.
 * The same probes as the lists above; the ordering is a top-N sort inside SQLite, off the window's thread (query worker).
 */
export function wouldLoseFilesOf(db: Db, request: WouldLoseFilesRequest): WouldLoseFilesPage {
  const words = searchWordsOf(request.search);
  const params: Record<string, string | number> = { placeId: request.placeId, limit: LOSE_PAGE_SIZE + 1, offset: Math.max(0, Math.floor(request.offset)) };
  const conditions: string[] = [`f.place_id = @placeId AND ${NO_CHECKED_COPY}`, `(${MAYBE_COPIED}) = ${request.part === 'maybeCopied' ? 1 : 0}`];
  words.forEach((word, i) => {
    params[`w${i}`] = likeOf(word);
    conditions.push(`f.rel_path LIKE @w${i} ESCAPE '\\'`);
  });
  if (request.kind !== null) {
    if (request.kind === 'other') conditions.push("(f.kind IS NULL OR f.kind = 'other')");
    else {
      params['kind'] = request.kind;
      conditions.push('f.kind = @kind');
    }
  }
  const rows = db
    .prepare(`SELECT f.rel_path, f.size, f.kind, f.sha256 IS NULL AS unchecked FROM files f WHERE ${conditions.join(' AND ')} ORDER BY f.size DESC, f.rel_path LIMIT @limit OFFSET @offset`)
    .all(params) as { rel_path: string; size: number | null; kind: string | null; unchecked: number }[];
  const files: LoseFile[] = rows.slice(0, LOSE_PAGE_SIZE).map((r) => ({ path: r.rel_path, size: r.size ?? 0, kind: r.kind !== null && r.kind in KIND_LABELS ? r.kind : 'other', unchecked: r.unchecked === 1 }));
  return { files, more: rows.length > LOSE_PAGE_SIZE };
}
