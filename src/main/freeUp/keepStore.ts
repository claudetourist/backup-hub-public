/**
 * "Keep on the phone": files and folders of one phone backup that Free up phone space never offers. The ONLY writer of `phone_keep`
 * (migration 0028). Also reads which kinds the person left out of Google (`backup_rules`, destination google), because those are never
 * offered either.
 */
import type { Db } from '../db/connection';
import type { FreeUpKeepRule } from '../../shared/freeUp';
import { parentFolders } from './freeUpRules';

// A phone path never holds a quote or a control character (the same rule as cleanup/safety.ts `isRemovablePhonePath`).
// oxlint-disable-next-line no-control-regex
const SAFE_PATH = /^\/[^'\x00-\x1f]*$/;

export class KeepStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(backupId: number): FreeUpKeepRule[] {
    return (this.db.prepare('SELECT id, scope, path FROM phone_keep WHERE backup_id = ? ORDER BY id').all(backupId) as FreeUpKeepRule[]).map((r) => ({ id: r.id, scope: r.scope, path: r.path }));
  }

  /** Adds a keep rule (a repeat adds nothing). Returns false when the path is not an acceptable phone path. */
  add(backupId: number, scope: 'file' | 'folder', path: string): boolean {
    const clean = scope === 'folder' ? path.replace(/\/+$/, '') : path;
    if (!SAFE_PATH.test(clean) || clean.split('/').some((s) => s === '..') || (scope === 'folder' && clean === '')) return false;
    this.db.prepare('INSERT OR IGNORE INTO phone_keep (backup_id, scope, path, created_at) VALUES (?, ?, ?, ?)').run(backupId, scope, clean, this.now());
    return true;
  }

  remove(backupId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM phone_keep WHERE id = ? AND backup_id = ?').run(id, backupId).changes > 0;
  }

  /** A fast test for many paths ("is this path kept?"): a set of files and a set of folders, checked up the path. */
  matcher(backupId: number): (path: string) => boolean {
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const r of this.list(backupId)) (r.scope === 'file' ? files : folders).add(r.path);
    if (files.size === 0 && folders.size === 0) return () => false;
    return (path) => files.has(path) || (folders.size > 0 && parentFolders(path).some((f) => folders.has(f)));
  }
}

interface RuleRow {
  scope: 'file' | 'folder' | 'pattern';
  pattern: string;
}

/**
 * What the person left out of Google for this backup: "leave out of one destination" rules whose destination is Google
 * (`backup_rules.destination` = 'google' or 'gdrive'). A pattern is either a kind ("kind:video-camera") or a type of file ("*.mp4"); a
 * file or a folder is a phone path. Returns a test on a path and its kind. A kind that is not sent to Google can never be removed.
 */
export function googleLeftOut(db: Db, backupId: number): (path: string, kind: string) => boolean {
  const rows = db
    .prepare("SELECT scope, pattern FROM backup_rules WHERE (backup_id = ? OR backup_id IS NULL) AND choice = 'leave_out' AND destination IS NOT NULL AND (lower(destination) LIKE 'google%' OR lower(destination) LIKE 'gdrive%')")
    .all(backupId) as RuleRow[];
  if (rows.length === 0) return () => false;
  const kinds = new Set<string>();
  const exts = new Set<string>();
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const r of rows) {
    if (r.scope === 'pattern') {
      const k = /^kind:([a-z-]+)$/.exec(r.pattern);
      const e = /^\*(\.[^./\\]+)$/.exec(r.pattern);
      if (k) kinds.add(k[1]!);
      else if (e) exts.add(e[1]!.toLowerCase());
    } else (r.scope === 'file' ? files : folders).add(r.pattern.replace(/\/+$/, ''));
  }
  return (path, kind) => {
    if (kinds.has(kind) || files.has(path)) return true;
    const dot = path.lastIndexOf('.');
    if (dot > path.lastIndexOf('/') && exts.has(path.slice(dot).toLowerCase())) return true;
    return folders.size > 0 && parentFolders(path).some((f) => folders.has(f));
  };
}
