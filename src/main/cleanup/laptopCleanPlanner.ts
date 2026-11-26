/**
 * The plan for "Laptop duplicates" (the catalog is only READ). Groups of live laptop files with the same SHA-256 (and size).
 * One copy per group is kept (default: the one inside a collection, else the oldest, else the shortest path; the person can
 * switch). Files in a protected folder, a OneDrive-synced folder, on a named drive, or locked are never offered for moving: they
 * can only be the copy that is kept.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MAX_DUPLICATE_GROUPS, plural, type DuplicateGroup, type DuplicateMember, type LaptopCleanPlan, type LaptopCleanPlanResult } from '../../shared/cleanup';
import type { Db } from '../db/connection';
import { CleanStore } from './cleanStore';
import { chooseKeeper, isFresh, movability, removalsFor } from './safety';

export interface LaptopCleanPlannerDeps {
  db: Db;
  /** Where the OneDrive folders are on this PC. */
  oneDriveRoots(): string[];
  /** Roots of the named drives that are plugged in (nothing there is ever moved). */
  driveRoots(): Promise<string[]>;
  /** The Windows profile folder(s) whose files are NOT offered (the setting is off); empty when "Also look in my C: folders" is on. */
  userFolderRoots?(): string[];
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

/** Duplicate contents looked at before the biggest groups are chosen. */
const MAX_CANDIDATE_HASHES = 20_000;
const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function hashLaptopCleanPlan(plan: Pick<LaptopCleanPlan, 'groups'>): string {
  const body = JSON.stringify(plan.groups.map((g) => [g.id, g.size, g.keep, g.members.map((m) => [m.relPath, m.mtime, m.removable])]));
  return createHash('sha256').update(body).digest('hex');
}

interface CollectionRoot {
  relPath: string;
  name: string;
}

function collectionOf(roots: readonly CollectionRoot[], relPath: string): string | null {
  let best: CollectionRoot | null = null;
  for (const r of roots) {
    const inside = r.relPath === '' || relPath === r.relPath || relPath.startsWith(`${r.relPath}/`);
    if (inside && (best === null || r.relPath.length > best.relPath.length)) best = r;
  }
  return best?.name ?? null;
}

export async function buildLaptopCleanPlan(deps: LaptopCleanPlannerDeps): Promise<LaptopCleanPlanResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const tick = deps.yieldNow ?? defaultYield;
  const store = new CleanStore(db, now);
  const laptop = store.laptopPlaceId();
  if (laptop === null) return { ok: false, message: 'This laptop is not known to Backup Hub yet. Nothing was changed.' };
  const stale = !isFresh(store.lastLooked(laptop), now());

  // 1. Contents held by two or more live laptop files (stopping after a generous number).
  const hashes: string[] = [];
  let capped = false;
  for (const row of db
    .prepare('SELECT sha256 FROM files WHERE place_id = ? AND gone_at IS NULL AND sha256 IS NOT NULL GROUP BY sha256 HAVING count(*) > 1')
    .raw()
    .iterate(laptop) as Iterable<[string]>) {
    if (hashes.length >= MAX_CANDIDATE_HASHES) {
      capped = true;
      break;
    }
    hashes.push(row[0]);
  }

  const collectionRoots = (db.prepare('SELECT cr.rel_path AS relPath, c.name FROM collection_roots cr JOIN collections c ON c.id = cr.collection_id WHERE cr.place_id = ?').all(laptop) as CollectionRoot[]).filter((r) => r.relPath !== undefined);
  const ctx = { oneDriveRoots: deps.oneDriveRoots(), locks: store.activeLocks(), laptopPlaceId: laptop, now: now(), otherPlaceRoots: await deps.driveRoots(), userFolderRoots: deps.userFolderRoots?.() ?? [] };
  const members = db.prepare('SELECT rel_path AS relPath, size, mtime FROM files WHERE place_id = ? AND sha256 = ? AND gone_at IS NULL AND cloud_only = 0');

  const groups: DuplicateGroup[] = [];
  let looked = 0;
  for (const sha of hashes) {
    looked += 1;
    if (looked % 200 === 0) await tick();
    const rows = members.all(laptop, sha) as { relPath: string; size: number | null; mtime: number | null }[];
    const size = rows[0]?.size ?? 0;
    const same = rows.filter((r) => r.size === size);
    if (size <= 0 || same.length < 2) continue;
    const list: DuplicateMember[] = same
      .toSorted((a, b) => (a.relPath < b.relPath ? -1 : 1))
      .map((r) => {
        const m = movability(r.relPath, ctx);
        return { relPath: r.relPath, mtime: r.mtime, collection: collectionOf(collectionRoots, r.relPath), removable: m.ok, why: m.ok ? null : m.why };
      });
    if (!list.some((m) => m.removable)) continue;
    const keep = chooseKeeper(list.map((m) => ({ relPath: m.relPath, mtime: m.mtime, inCollection: m.collection !== null })));
    const r = removalsFor(list, keep);
    if (!r.ok || r.remove.length === 0) {
      // The default keeper cannot be the only removable file: keep a protected copy if there is one, else the first removable one stays.
      const alt = list.find((m) => !m.removable)?.relPath ?? list.find((m) => m.removable)!.relPath;
      const again = removalsFor(list, alt);
      if (!again.ok || again.remove.length === 0) continue;
      groups.push({ id: sha, size, members: list, keep: alt, freeable: again.remove.length * size });
      continue;
    }
    groups.push({ id: sha, size, members: list, keep, freeable: r.remove.length * size });
  }

  const ranked = groups.toSorted((a, b) => b.freeable - a.freeable || (a.id < b.id ? -1 : 1));
  const shown = ranked.slice(0, MAX_DUPLICATE_GROUPS);
  const notes: string[] = [];
  if (ranked.length > shown.length || capped) notes.push(`Only the ${plural(shown.length, 'biggest group')} ${shown.length === 1 ? 'is' : 'are'} shown. Move some, then make the plan again for the rest.`);
  if (stale) notes.push('The laptop was not checked in the last 24 hours. Check it first (Devices), then make the plan again.');
  if (shown.length === 0) return { ok: false, message: stale ? 'The laptop was not checked in the last 24 hours. Check it first, then try again. Nothing was changed.' : 'No identical files were found on the laptop that Backup Hub may tidy. Nothing was changed.' };
  const freeable = shown.reduce((s, g) => s + g.freeable, 0);
  const files = shown.reduce((s, g) => s + g.freeable / g.size, 0);
  const plan: LaptopCleanPlan = { id: randomUUID(), hash: '', createdAt: now(), groups: shown, more: ranked.length > shown.length, total: { files, bytes: freeable }, stale, notes };
  plan.hash = hashLaptopCleanPlan(plan);
  return { ok: true, plan };
}
