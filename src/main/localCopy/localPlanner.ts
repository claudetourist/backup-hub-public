/**
 * The plan for "Back up now" to a plugged-in drive (read only). For one collection: find the contents (same MD5 and size)
 * the drive does not hold yet, pick ONE local copy of each to read from (the laptop first, then another drive), and give each
 * file its place under `<the app's backups folder>/<collection>/...` on the drive. Nothing is written and no file is opened: a source is only
 * checked with stat. The drive's free space is checked, and what does not fit is listed, never split.
 */
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { formatGb } from '../../shared/cloudCopy';
import type { CollectionRoot } from '../../shared/collections';
import {
  LOCAL_ESTIMATE_BYTES_PER_SECOND,
  LOCAL_MIN_FREE_BYTES,
  MAX_LOCAL_PLAN_FILES,
  type LocalCopyPlan,
  type LocalPlanFile,
  type LocalPlanResult,
  type LocalPlanSkipped,
} from '../../shared/localCopy';
import { belowRoot, rootOf, sourceRank } from '../planning/planModel';
import { rootCondition } from '../query/collectionsQuery';
import type { Db } from '../db/connection';
import { absolutePathFor } from '../hashing/paths';
import { existsAsync } from './verifiedCopy';
import { hashLocalPlan, localDestinationFor, newLocalPlanId, taggedName } from './localModel';

export interface LocalPlannerDeps {
  db: Db;
  /** Where a local place's folders are right now ('' for the laptop), or null when it is not reachable. */
  baseOf(placeId: string): Promise<string | null>;
  /** Free bytes on the drive that holds `root`, or null when it cannot be read. */
  freeBytes(root: string): number | null | Promise<number | null>;
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

/** The reason shown for a OneDrive file that is only online. It is never downloaded by Backup Hub. */
export const ONLINE_ONLY_REASON = 'Not on this PC (online only). Backup Hub does not download it. Open it in OneDrive to keep it on this PC, then back up again.';
const MAX_ONLINE_ONLY_LISTED = 200;

interface MemberRow {
  id: number;
  place_id: string;
  rel_path: string;
  size: number;
  mtime: number | null;
  md5: string | null;
  cloud_only: number;
}

interface PlaceInfo {
  id: string;
  kind: string;
  label: string;
}

interface Content {
  md5: string;
  size: number;
  members: MemberRow[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** A path in a folder of the drive, as the plan compares it (Windows ignores case). */
const planPath = (folders: readonly string[], name: string): string => [...folders, name].join('/').toLowerCase();
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function sameSizeAt(dir: string, name: string, size: number): Promise<boolean> {
  try {
    const st = await fs.promises.stat(path.join(dir, name));
    return st.isFile() && st.size === size;
  } catch {
    return false;
  }
}

/**
 * `targetFolder` (an absolute folder on this laptop, phone backup only) replaces the drive. A file then counts as already there when
 * the same path in the folder has the same size (the folder is not in the catalog, so there is no content match).
 */
export async function buildLocalCopyPlan(deps: LocalPlannerDeps, collectionId: number, targetPlaceId: string, targetFolder?: string): Promise<LocalPlanResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const tick = deps.yieldNow ?? defaultYield;

  const collection = db.prepare('SELECT id, name FROM collections WHERE id = ?').get(collectionId) as { id: number; name: string } | undefined;
  if (!collection) return { ok: false, message: 'That collection no longer exists.' };
  const roots = db.prepare('SELECT place_id AS placeId, rel_path AS relPath FROM collection_roots WHERE collection_id = ?').all(collectionId) as CollectionRoot[];
  if (roots.length === 0) return { ok: false, message: 'This collection has no folders.' };
  let target: PlaceInfo | undefined;
  let targetBase: string | null;
  if (targetFolder !== undefined) {
    target = { id: '', kind: 'folder', label: 'the laptop folder' };
    targetBase = (await isDirectory(targetFolder)) ? targetFolder : null;
    if (targetBase === null) return { ok: false, message: 'The laptop folder is not there. Choose it again. Nothing was changed.' };
  } else {
    target = db.prepare("SELECT id, kind, label FROM places WHERE id = ? AND kind = 'drive'").get(targetPlaceId) as PlaceInfo | undefined;
    if (!target) return { ok: false, message: 'That drive is not known to Backup Hub. Name it under Settings, Drives and accounts first.' };
    targetBase = await deps.baseOf(target.id);
    if (targetBase === null || targetBase === '') return { ok: false, message: `${target.label} is not plugged in. Plug it in and try again. Nothing was changed.` };
  }

  const places = new Map((db.prepare('SELECT id, kind, label FROM places').all() as PlaceInfo[]).map((p) => [p.id, p]));

  // 1. The members of the collection, grouped by content (md5 + size).
  const conds = roots.map(rootCondition);
  const members = db
    .prepare(`SELECT id, place_id, rel_path, size, mtime, md5, cloud_only FROM files WHERE gone_at IS NULL AND (${conds.map((c) => c.sql).join(' OR ')}) ORDER BY id`)
    .all(...conds.flatMap((c) => c.params)) as MemberRow[];
  const contents = new Map<string, Content>();
  let notChecked = 0;
  // OneDrive "online only" files are never downloaded silently: they are listed as not on this PC and skipped.
  const onlineOnly: { row: MemberRow; label: string }[] = [];
  let onlineOnlyFiles = 0;
  let onlineOnlyBytes = 0;
  for (const row of members) {
    if (row.cloud_only === 1) {
      onlineOnlyFiles += 1;
      onlineOnlyBytes += row.size;
      if (onlineOnly.length < MAX_ONLINE_ONLY_LISTED) onlineOnly.push({ row, label: places.get(row.place_id)?.label ?? 'OneDrive' });
      continue;
    }
    if (!row.md5) {
      notChecked += 1;
      continue;
    }
    const key = `${row.md5}|${row.size}`;
    const found = contents.get(key);
    if (found) found.members.push(row);
    else contents.set(key, { md5: row.md5, size: row.size, members: [row] });
  }

  // 2. Which contents the drive does not hold yet (the delta).
  const there = db.prepare('SELECT 1 FROM files WHERE place_id = ? AND md5 = ? AND size = ? AND gone_at IS NULL LIMIT 1');
  const onlineLine = onlineOnlyFiles > 0 ? `${plural(onlineOnlyFiles, 'file')} (${formatGb(onlineOnlyBytes)}) ${onlineOnlyFiles === 1 ? 'is' : 'are'} not on this PC (online only), so ${onlineOnlyFiles === 1 ? 'it was' : 'they were'} skipped. Backup Hub does not download them.` : null;
  const missing: Content[] = [];
  let alreadyFiles = 0;
  let alreadyBytes = 0;
  let probes = 0;
  for (const content of contents.values()) {
    if (targetFolder === undefined && there.get(target.id, content.md5, content.size)) {
      alreadyFiles += 1;
      alreadyBytes += content.size;
    } else missing.push(content);
    probes += 1;
    if (probes % 500 === 0) await tick();
  }
  const notes: string[] = [];
  if (notChecked > 0) notes.push(`${plural(notChecked, 'file')} not matched yet, so ${notChecked === 1 ? 'it is' : 'they are'} not in this list. Check them first (Home, "need a quick check").`);
  if (onlineLine) notes.push(onlineLine);
  if (missing.length === 0) {
    return { ok: false, message: `${target.label} already holds every checked file in ${collection.name}. There is nothing new to copy.${onlineLine ? ` ${onlineLine}` : ''}` };
  }

  // 3. One local copy of each to read from: the laptop first, then another drive, where it still exists with the catalog size.
  const others = db.prepare('SELECT id, place_id, rel_path, size, mtime, md5, cloud_only FROM files WHERE md5 = ? AND size = ? AND gone_at IS NULL AND cloud_only = 0 ORDER BY id');
  const bases = new Map<string, string | null>();
  const baseOf = async (placeId: string): Promise<string | null> => {
    if (!bases.has(placeId)) bases.set(placeId, await deps.baseOf(placeId));
    return bases.get(placeId) ?? null;
  };
  interface Ready {
    content: Content;
    source: MemberRow;
    sourcePlace: PlaceInfo;
    below: string;
  }
  const ready: Ready[] = [];
  const doesNotFit: LocalPlanSkipped[] = [];
  const shownPath = (placeLabel: string, rel: string): string => `${placeLabel}: ${rel}`;
  let checked = 0;
  for (const content of missing.toSorted((a, b) => byText(a.members[0]!.rel_path, b.members[0]!.rel_path))) {
    checked += 1;
    if (checked % 50 === 0) await tick();
    const anyMember = content.members[0]!;
    const label = places.get(anyMember.place_id)?.label ?? 'a place';
    const skip = (reason: string): void => {
      doesNotFit.push({ name: anyMember.rel_path.split('/').pop() ?? anyMember.rel_path, shown: shownPath(label, anyMember.rel_path), size: content.size, reason });
    };
    if (content.size === 0) {
      skip('It is an empty file. Empty files are not copied.');
      continue;
    }
    const candidates = (others.all(content.md5, content.size) as MemberRow[])
      .map((row) => ({ row, place: places.get(row.place_id) }))
      .filter((c): c is { row: MemberRow; place: PlaceInfo } => c.place !== undefined && c.place.id !== target.id && (c.place.kind === 'laptop' || c.place.kind === 'drive' || c.place.kind === 'onedrive'))
      .toSorted((a, b) => sourceRank(a.place.kind) - sourceRank(b.place.kind) || a.row.id - b.row.id);
    let chosen: { row: MemberRow; place: PlaceInfo } | null = null;
    for (const c of candidates) {
      const base = await baseOf(c.place.id);
      if (base === null) continue;
      const abs = absolutePathFor(c.place.kind as 'laptop' | 'drive' | 'onedrive', base, c.row.rel_path);
      if (abs === null) continue;
      try {
        const st = await fs.promises.stat(abs);
        if (st.isFile() && st.size === c.row.size) {
          chosen = c;
          break;
        }
      } catch {
        // not there (or not readable): try the next copy
      }
    }
    if (!chosen) {
      skip(candidates.length === 0 ? 'No copy of it is on this laptop or another named drive.' : 'No copy of it is plugged in and unchanged. Plug the drive in or look at the place again.');
      continue;
    }
    const pick = chosen;
    const member = content.members.find((m) => m.id === pick.row.id) ?? content.members.toSorted((a, b) => sourceRank(places.get(a.place_id)?.kind ?? '') - sourceRank(places.get(b.place_id)?.kind ?? '') || a.id - b.id)[0]!;
    const root = rootOf(roots, member.place_id, member.rel_path);
    const below = (root ? belowRoot(root, member.rel_path) : null) ?? member.rel_path;
    ready.push({ content, source: chosen.row, sourcePlace: chosen.place, below });
  }

  // 4. Room on the drive (whole files, in path order; what does not fit is listed) and unique names on the drive.
  const freeBefore = await deps.freeBytes(targetBase);
  let room = freeBefore === null ? Infinity : Math.max(0, freeBefore - LOCAL_MIN_FREE_BYTES);
  const taken = new Set<string>();
  const planned: LocalPlanFile[] = [];
  let beyondLimit = 0;
  for (const r of ready.toSorted((a, b) => byText(a.below, b.below))) {
    const dest = localDestinationFor(collection.name, r.below);
    if (r.content.size > room) {
      doesNotFit.push({ name: dest.name, shown: shownPath(r.sourcePlace.label, r.source.rel_path), size: r.content.size, reason: `No room on ${target.label}: ${formatGb(Math.max(0, room))} left after keeping some space free.` });
      continue;
    }
    if (planned.length >= MAX_LOCAL_PLAN_FILES) {
      beyondLimit += 1;
      continue;
    }
    let name = dest.name;
    if (targetFolder !== undefined && (await sameSizeAt(path.join(targetBase, ...dest.folders), name, r.content.size))) {
      alreadyFiles += 1;
      alreadyBytes += r.content.size;
      continue;
    }
    if (taken.has(planPath(dest.folders, name)) || (await existsAsync(path.join(targetBase, ...dest.folders, name)))) name = taggedName(name, r.content.md5);
    taken.add(planPath(dest.folders, name));
    room -= r.content.size;
    planned.push({
      index: planned.length,
      name,
      folder: dest.folders.join('/'),
      sourcePlaceId: r.sourcePlace.id,
      sourcePlaceLabel: r.sourcePlace.label,
      sourceRel: r.source.rel_path,
      sourceShown: shownPath(r.sourcePlace.label, r.source.rel_path),
      size: r.content.size,
      mtime: r.source.mtime,
      md5: r.content.md5,
    });
  }
  if (beyondLimit > 0) notes.push(`${plural(beyondLimit, 'more file')} will be planned in the next run: one plan holds at most ${MAX_LOCAL_PLAN_FILES.toLocaleString('en-US')} files. Run "Back up now" again when this one is done.`);
  for (const o of onlineOnly) {
    doesNotFit.push({ name: o.row.rel_path.split('/').pop() ?? o.row.rel_path, shown: shownPath(o.label, o.row.rel_path), size: o.row.size, reason: ONLINE_ONLY_REASON });
  }
  if (planned.length === 0 && targetFolder !== undefined) {
    return { ok: false, message: `${target.label} already holds every file (same place and size). There is nothing new to copy.${onlineLine ? ` ${onlineLine}` : ''}` };
  }
  const notCopied = doesNotFit.length - onlineOnly.length;
  if (notCopied > 0) {
    const bytes = doesNotFit.filter((f) => f.reason !== ONLINE_ONLY_REASON).reduce((sum, f) => sum + f.size, 0);
    notes.push(`${plural(notCopied, 'file')} (${formatGb(bytes)}) will not be copied. See "Not copied" below.`);
  }
  const totalBytes = planned.reduce((sum, f) => sum + f.size, 0);
  const plan: LocalCopyPlan = {
    id: newLocalPlanId(),
    hash: '',
    createdAt: now(),
    collectionId: collection.id,
    collectionName: collection.name,
    targetPlaceId: target.id,
    targetLabel: target.label,
    ...(targetFolder !== undefined ? { targetFolder } : {}),
    files: planned,
    doesNotFit: doesNotFit.toSorted((a, b) => a.shown.localeCompare(b.shown, 'en', { numeric: true })),
    alreadyThere: { files: alreadyFiles, bytes: alreadyBytes },
    freeBefore,
    freeAfter: freeBefore === null ? null : freeBefore - totalBytes,
    notes,
    totalFiles: planned.length,
    totalBytes,
    estimatedSeconds: Math.ceil(totalBytes / LOCAL_ESTIMATE_BYTES_PER_SECOND),
  };
  plan.hash = hashLocalPlan(plan);
  return { ok: true, plan };
}
