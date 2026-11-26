/**
 * Database side of Clean up: the catalog lookups the safety rules need, the 30-day locks and the removal log.
 * Thin on purpose: every decision is made by the pure functions in `safety.ts`.
 */
import { DAY_MS, type CleanupOverview, type LockView, type QuarantineBatch, type RemovalView, type Voucher } from '../../shared/cleanup';
import type { Db } from '../db/connection';
import { canAskToEmpty, canUndoEntry, lockExpiry, quarantineDate, quarantineRootFor, type CatalogRow, type LockRow } from './safety';

interface CatalogSqlRow {
  place_id: string;
  kind: string;
  label: string;
  rel_path: string;
  size: number | null;
  sha256: string | null;
  md5: string | null;
  cloud_only: number;
  gone_at: number | null;
  mtime: number | null;
}

const SELECT_ROW = `SELECT f.place_id, p.kind, p.label, f.rel_path, f.size, f.sha256, f.md5, f.cloud_only, f.gone_at, f.mtime
                      FROM files f JOIN places p ON p.id = f.place_id`;

const toCatalog = (r: CatalogSqlRow): CatalogRow => ({
  placeId: r.place_id,
  placeKind: r.kind,
  placeLabel: r.label,
  relPath: r.rel_path,
  size: r.size,
  sha256: r.sha256,
  md5: r.md5,
  cloudOnly: r.cloud_only === 1,
  goneAt: r.gone_at,
  mtime: r.mtime,
});

export interface RemovalRow {
  id: number;
  runId: number | null;
  kind: 'phone' | 'laptop';
  placeId: string | null;
  device: string | null;
  path: string;
  size: number;
  sha256: string;
  vouchers: Voucher[];
  quarantinePath: string | null;
  removedAt: number;
  undoneAt: number | null;
  emptiedAt: number | null;
}

interface RemovalSqlRow {
  id: number;
  run_id: number | null;
  kind: 'phone' | 'laptop';
  place_id: string | null;
  device: string | null;
  path: string;
  size: number;
  sha256: string;
  vouchers_json: string;
  quarantine_path: string | null;
  removed_at: number;
  undone_at: number | null;
  emptied_at: number | null;
}

function parseVouchers(json: string): Voucher[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as Voucher[]) : [];
  } catch {
    return [];
  }
}

const toRemoval = (r: RemovalSqlRow): RemovalRow => ({
  id: r.id,
  runId: r.run_id,
  kind: r.kind,
  placeId: r.place_id,
  device: r.device,
  path: r.path,
  size: r.size,
  sha256: r.sha256,
  vouchers: parseVouchers(r.vouchers_json),
  quarantinePath: r.quarantine_path,
  removedAt: r.removed_at,
  undoneAt: r.undone_at,
  emptiedAt: r.emptied_at,
});

export interface NewRemoval {
  runId: number | null;
  kind: 'phone' | 'laptop';
  placeId: string | null;
  device: string | null;
  path: string;
  size: number;
  sha256: string;
  vouchers: readonly Voucher[];
  quarantinePath: string | null;
}

export class CleanStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- Catalog ----

  row(placeId: string, relPath: string): CatalogRow | null {
    const r = this.db.prepare(`${SELECT_ROW} WHERE f.place_id = ? AND f.rel_path = ?`).get(placeId, relPath) as CatalogSqlRow | undefined;
    return r ? toCatalog(r) : null;
  }

  lastLooked(placeId: string): number | null {
    return (this.db.prepare('SELECT last_looked_at AS t FROM places WHERE id = ?').get(placeId) as { t: number | null } | undefined)?.t ?? null;
  }

  placeLabel(placeId: string): string {
    return (this.db.prepare('SELECT label FROM places WHERE id = ?').get(placeId) as { label: string } | undefined)?.label ?? placeId;
  }

  laptopPlaceId(): string | null {
    return (this.db.prepare("SELECT id FROM places WHERE kind = 'laptop' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
  }

  /** True when some named drive holds a live, fingerprinted file of exactly this size (a cheap filter: no match means no SHA-256 can match). */
  driveHasSize(size: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM files f JOIN places p ON p.id = f.place_id WHERE f.size = ? AND p.kind = 'drive' AND f.sha256 IS NOT NULL AND f.gone_at IS NULL AND f.cloud_only = 0 LIMIT 1")
        .get(size) !== undefined
    );
  }

  /**
   * Live rows that could vouch for a file: every live row with this SHA-256 (drive and OneDrive copies, the laptop too, the
   * rules pick), plus the Google Drive rows (no SHA-256) with the MD5 + size of any such row.
   */
  poolFor(sha256: string, size: number): CatalogRow[] {
    const bySha = (this.db.prepare(`${SELECT_ROW} WHERE f.sha256 = ? AND f.gone_at IS NULL`).all(sha256) as CatalogSqlRow[]).map(toCatalog);
    const md5s = [...new Set(bySha.map((r) => r.md5).filter((m): m is string => m !== null))];
    const byMd5 = md5s.flatMap((m) => (this.db.prepare(`${SELECT_ROW} WHERE f.md5 = ? AND f.size = ? AND f.gone_at IS NULL AND f.sha256 IS NULL`).all(m, size) as CatalogSqlRow[]).map(toCatalog));
    return [...bySha, ...byMd5];
  }

  placeKind(placeId: string): string | null {
    return (this.db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined)?.kind ?? null;
  }

  oneDriveRoots(): string[] {
    return (this.db.prepare("SELECT root_hint FROM places WHERE kind = 'onedrive' AND root_hint IS NOT NULL AND root_hint <> ''").all() as { root_hint: string }[]).map((r) => r.root_hint);
  }

  // ---- Locks ----

  activeLocks(): LockRow[] {
    return (this.db.prepare('SELECT place_id, rel_path, expires_at FROM clean_locks WHERE expires_at > ?').all(this.now()) as { place_id: string; rel_path: string; expires_at: number }[]).map((l) => ({
      placeId: l.place_id,
      relPath: l.rel_path,
      expiresAt: l.expires_at,
    }));
  }

  /** Locks the copies that vouch for a removal for 30 days. Written BEFORE the removal. Returns the lock ids. */
  addLocks(vouchers: readonly Voucher[], reason: string): number[] {
    const now = this.now();
    const insert = this.db.prepare('INSERT INTO clean_locks (place_id, rel_path, sha256, reason, locked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
    return this.db.transaction(() => vouchers.map((v) => Number(insert.run(v.placeId, v.relPath, v.sha256, reason, now, lockExpiry(now)).lastInsertRowid)))();
  }

  attachLocks(lockIds: readonly number[], removalId: number): void {
    const stmt = this.db.prepare('UPDATE clean_locks SET removal_id = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of lockIds) stmt.run(removalId, id);
    })();
  }

  // ---- Log ----

  logRemoval(r: NewRemoval): number {
    return Number(
      this.db
        .prepare('INSERT INTO removal_log (run_id, kind, place_id, device, path, size, sha256, vouchers_json, quarantine_path, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.runId, r.kind, r.placeId, r.device, r.path, r.size, r.sha256, JSON.stringify(r.vouchers), r.quarantinePath, this.now()).lastInsertRowid,
    );
  }

  /** Takes back a log line for a removal that did not happen (the file is still there). */
  dropLog(id: number): void {
    this.db.prepare('DELETE FROM removal_log WHERE id = ? AND undone_at IS NULL AND emptied_at IS NULL').run(id);
  }

  removal(id: number): RemovalRow | null {
    const r = this.db.prepare('SELECT * FROM removal_log WHERE id = ?').get(id) as RemovalSqlRow | undefined;
    return r ? toRemoval(r) : null;
  }

  markUndone(id: number): void {
    this.db.prepare('UPDATE removal_log SET undone_at = ? WHERE id = ?').run(this.now(), id);
  }

  markEmptied(id: number): void {
    this.db.prepare('UPDATE removal_log SET emptied_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** Laptop files waiting in the quarantine that were moved on this local date. */
  waitingOnDate(date: string): RemovalRow[] {
    return (this.db.prepare("SELECT * FROM removal_log WHERE kind = 'laptop' AND undone_at IS NULL AND emptied_at IS NULL ORDER BY id").all() as RemovalSqlRow[]).map(toRemoval).filter((r) => quarantineDate(r.removedAt) === date);
  }

  /** Marks the catalog row of a laptop file as no longer there (it was moved) or back again (undo). */
  setGone(placeId: string, relPath: string, gone: boolean): void {
    this.db.prepare('UPDATE files SET gone_at = ? WHERE place_id = ? AND rel_path = ?').run(gone ? this.now() : null, placeId, relPath);
  }

  overview(): CleanupOverview {
    const now = this.now();
    const since = now - 90 * DAY_MS;
    const rows = (this.db.prepare('SELECT * FROM removal_log WHERE removed_at >= ? ORDER BY id DESC LIMIT 300').all(since) as RemovalSqlRow[]).map(toRemoval);
    const removals: RemovalView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      path: r.path,
      size: r.size,
      removedAt: r.removedAt,
      undoneAt: r.undoneAt,
      emptiedAt: r.emptiedAt,
      vouchedBy: [...new Set(r.vouchers.map((v) => v.placeLabel))].join(', '),
      quarantinePath: r.quarantinePath,
      canUndo: r.kind === 'laptop' && canUndoEntry(r, r.quarantinePath === null ? null : quarantineRootFor(r.path)),
    }));
    const locks: LockView[] = (
      this.db
        .prepare('SELECT l.id, l.place_id, p.label, l.rel_path, l.locked_at, l.expires_at FROM clean_locks l JOIN places p ON p.id = l.place_id WHERE l.expires_at > ? ORDER BY l.expires_at DESC LIMIT 500')
        .all(now) as { id: number; place_id: string; label: string; rel_path: string; locked_at: number; expires_at: number }[]
    ).map((l) => ({ id: l.id, placeId: l.place_id, placeLabel: l.label, relPath: l.rel_path, lockedAt: l.locked_at, expiresAt: l.expires_at }));
    const batches = new Map<string, QuarantineBatch>();
    const newest = new Map<string, number>();
    for (const r of (this.db.prepare("SELECT * FROM removal_log WHERE kind = 'laptop' AND undone_at IS NULL AND emptied_at IS NULL").all() as RemovalSqlRow[]).map(toRemoval)) {
      const date = quarantineDate(r.removedAt);
      const b = batches.get(date) ?? { date, files: 0, bytes: 0, oldestAt: r.removedAt, canAskToEmpty: false };
      b.files += 1;
      b.bytes += r.size;
      b.oldestAt = Math.min(b.oldestAt, r.removedAt);
      batches.set(date, b);
      newest.set(date, Math.max(newest.get(date) ?? 0, r.removedAt));
    }
    const quarantine = [...batches.values()].toSorted((a, b) => (a.date < b.date ? 1 : -1));
    for (const b of quarantine) b.canAskToEmpty = canAskToEmpty(newest.get(b.date) ?? b.oldestAt, now);
    return { removals, locks, quarantine };
  }
}
