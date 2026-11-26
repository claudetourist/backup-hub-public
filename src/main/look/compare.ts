import { finishSync, STEP_ITEMS, type Steps } from '../sliceWork';

/**
 * The compare of "look > compare > plan" (PLAN.md section 3c rule 1, section 7 R1.0a): what the phone shows NOW against what the index
 * remembers, as new / changed / gone / came back, plus whether each phone file is backed up at each destination. Pure functions: no
 * database, no files, no adb. The caller passes in rows it read and writes nothing back from here.
 *
 * Words. A phone file has ONE row in `files` (unique per place and path) that is updated in place when the file changes. Each backed-up
 * version is its own row at a destination (another dated folder, so another path), linked to the phone row by `origin_file_id`, with
 * `expected_sha256` = the content at copy time and its date set to the source date. Old versions are never touched.
 */

/** Dates within 2 seconds are the same date (section 3c "Comparing honestly"). */
export const DATE_TOLERANCE_MS = 2000;
const HOUR_MS = 3_600_000;

/** Phones: a change is size AND date. Folders: size OR date (section 2, "Changed rule"). */
export type ChangeRule = 'size_and_date' | 'size_or_date';

/** A phone file's row in the index. `relPath` is the phone path without its leading slash ("sdcard/DCIM/a.jpg"); `mtimeMs` is milliseconds. */
export interface IndexedPhoneFile {
  id: number;
  relPath: string;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  goneAt: number | null;
}

/** A row at a destination (or any other row) that points at a phone row. */
export interface CopyRow {
  id: number;
  placeId: string;
  relPath: string;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  expectedSha256: string | null;
  originFileId: number | null;
  verifiedHow: string | null;
  goneAt: number | null;
}

/** A backup folder on a drive: `root` is below the drive (forward slashes, no letter); `position` 1 = from the source, 2 = mirror of 1. */
export interface DestinationRef {
  id: number;
  placeId: string;
  root: string;
  position: number;
}

export interface PhoneListedFile {
  /** "/sdcard/DCIM/a.jpg" */
  path: string;
  size: number;
  mtimeSec: number;
}

export type EntryKind = 'new' | 'changed' | 'came_back' | 'same';
/** verified: read_both. unverified: imported, name_size or anything else; it stops a recopy but never counts for clean-up ("Check old copies" of R1.4b raises it). A copy marked 'differs' is no copy at all. */
export type CopyWorth = 'verified' | 'unverified';

export interface DestinationState {
  destinationId: number;
  backedUp: boolean;
  worth: CopyWorth | null;
  copyId: number | null;
}

export interface LookEntry {
  kind: EntryKind;
  path: string;
  relPath: string;
  size: number;
  mtimeSec: number;
  indexId: number | null;
  /** What the index remembered (changed and came_back only). */
  previous: { size: number | null; mtimeMs: number | null } | null;
  /** Same size and a date off by whole hours (time zone, daylight saving): a folder rule case that only a checksum can settle. */
  needsChecksum: boolean;
  destinations: DestinationState[];
}

export interface CompareCounts {
  new: number;
  changed: number;
  cameBack: number;
  same: number;
  gone: number;
  /** Live index rows in the places that were looked at: the base of the 30% rule. */
  indexedLive: number;
  listed: number;
}

export interface CompareResult {
  entries: LookEntry[];
  gone: IndexedPhoneFile[];
  counts: CompareCounts;
  /** Groups of phone paths that are one and the same name once written in normal form (NFC): nothing is decided about them. */
  clashes: string[][];
}

export interface CompareInput {
  listed: readonly PhoneListedFile[];
  indexed: readonly IndexedPhoneFile[];
  /** The phone folders that were listed ("/sdcard/DCIM"). Index rows outside them are not part of this look. */
  folders: readonly string[];
  /** Refused folders (the filters drop them): rows below them are neither gone nor anything else. */
  unreadable?: readonly string[];
  changeRule?: ChangeRule;
  destinations?: readonly DestinationRef[];
  copies?: readonly CopyRow[];
}

/** "/sdcard/DCIM/a.jpg" -> "sdcard/DCIM/a.jpg" (the form of `files.rel_path` for a phone). */
export const phoneRel = (phonePath: string): string => phonePath.replace(/^\/+/, '');

/** Names are compared in one normal form (NFC). Case is kept: Android tells "A.jpg" and "a.jpg" apart. */
const nameKey = (rel: string): string => rel.normalize('NFC');

const prefixOf = (folder: string): string => `${phoneRel(folder).replace(/\/+$/, '')}/`;
const lowerUnder = (rel: string, root: string): boolean => {
  const r = (rel.includes('//') ? rel.replace(/\/+/g, '/') : rel).toLowerCase();
  const base = (root.includes('//') ? root.replace(/\/+/g, '/') : root).replace(/^\/+|\/+$/g, '').toLowerCase();
  return base === '' || r === base || r.startsWith(`${base}/`);
};

interface Version {
  size: number | null;
  mtimeMs: number | null;
}

type Verdict = 'same' | 'changed' | 'confirm';

/**
 * Is `now` a change of `before` under the rule? A missing size or date counts as different (copying again costs space, never data).
 * 'confirm': the folder rule, same size, date off by exact whole hours: not called a change until a checksum says so.
 */
export function judgeChange(rule: ChangeRule, before: Version, now: Version): Verdict {
  const sizeDiffers = before.size === null || now.size === null || before.size !== now.size;
  const delta = before.mtimeMs === null || now.mtimeMs === null ? null : Math.abs(before.mtimeMs - now.mtimeMs);
  const dateDiffers = delta === null || delta > DATE_TOLERANCE_MS;
  if (rule === 'size_and_date') return sizeDiffers && dateDiffers ? 'changed' : 'same';
  if (!sizeDiffers && delta !== null && delta > DATE_TOLERANCE_MS) {
    const off = delta % HOUR_MS;
    if (off <= DATE_TOLERANCE_MS || HOUR_MS - off <= DATE_TOLERANCE_MS) return 'confirm';
  }
  return sizeDiffers || dateDiffers ? 'changed' : 'same';
}

/**
 * Is this phone file backed up at this destination? Yes when a row exists there with origin_file_id = the phone row, under the
 * destination's root, not gone, and matching the phone file's CURRENT version: same size, and where both checksums are known the same
 * checksum (else the backup's own change rule decides). Old versions never match a changed file. `worth` says what the copy is worth.
 */
export function backedUpAt(
  phoneRowId: number,
  current: Version & { sha256: string | null },
  destination: DestinationRef,
  copiesOfRow: readonly CopyRow[],
  rule: ChangeRule,
): DestinationState {
  let best: { row: CopyRow; worth: CopyWorth } | null = null;
  for (const c of copiesOfRow) {
    if (c.originFileId !== phoneRowId || c.goneAt !== null) continue;
    // "Check old copies" read this copy and found it different from the phone's file: it never counts as backed up (the next backup copies the file again).
    if (c.verifiedHow === 'differs') continue;
    if (c.placeId !== destination.placeId || !lowerUnder(c.relPath, destination.root)) continue;
    if (c.size === null || current.size === null || c.size !== current.size) continue;
    const copySha = c.sha256 ?? c.expectedSha256;
    const matches = current.sha256 !== null && copySha !== null ? current.sha256 === copySha : judgeChange(rule, c, current) === 'same';
    if (!matches) continue;
    const worth: CopyWorth = c.verifiedHow === 'read_both' ? 'verified' : 'unverified';
    if (best === null || (worth === 'verified' && best.worth !== 'verified') || (worth === best.worth && c.id > best.row.id)) best = { row: c, worth };
  }
  return best ? { destinationId: destination.id, backedUp: true, worth: best.worth, copyId: best.row.id } : { destinationId: destination.id, backedUp: false, worth: null, copyId: null };
}

/** The compare. Reads nothing from outside, changes nothing; gone is computed only for the looked-at folders. */
export function compareLook(input: CompareInput): CompareResult {
  return finishSync(compareLookSteps(input));
}

/** `compareLook` as slices (60,000 files take about half a second in one go; see sliceWork.ts). The answer is the same. */
export function* compareLookSteps(input: CompareInput): Steps<CompareResult> {
  const rule = input.changeRule ?? 'size_and_date';
  const destinations = (input.destinations ?? []).toSorted((a, b) => a.position - b.position || a.id - b.id);
  const inScope = input.folders.map(prefixOf);
  const blind = (input.unreadable ?? []).map(prefixOf);
  const scoped = (rel: string): boolean => inScope.some((p) => rel.startsWith(p));
  const seeable = (rel: string): boolean => !blind.some((p) => rel.startsWith(p));

  const copiesByOrigin = new Map<number, CopyRow[]>();
  let n = 0;
  for (const c of input.copies ?? []) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (c.originFileId === null) continue;
    const list = copiesByOrigin.get(c.originFileId);
    if (list) list.push(c);
    else copiesByOrigin.set(c.originFileId, [c]);
  }

  // Index rows of this look by name in normal form; two rows (or two listed paths) with one name are a clash, never guessed.
  const indexByKey = new Map<string, IndexedPhoneFile[]>();
  let indexedLive = 0;
  for (const row of input.indexed) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (!scoped(row.relPath)) continue;
    if (row.goneAt === null && seeable(row.relPath)) indexedLive += 1;
    const k = nameKey(row.relPath);
    const list = indexByKey.get(k);
    if (list) list.push(row);
    else indexByKey.set(k, [row]);
  }
  const listedByKey = new Map<string, PhoneListedFile[]>();
  for (const f of input.listed) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const k = nameKey(phoneRel(f.path));
    const list = listedByKey.get(k);
    if (list) list.push(f);
    else listedByKey.set(k, [f]);
  }

  const clashKeys = new Set<string>();
  const clashes: string[][] = [];
  for (const [k, list] of listedByKey) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (list.length > 1 || (indexByKey.get(k)?.length ?? 0) > 1) {
      clashKeys.add(k);
      clashes.push([...new Set([...list.map((f) => f.path), ...(indexByKey.get(k) ?? []).map((r) => `/${r.relPath}`)])]);
    }
  }

  const entries: LookEntry[] = [];
  for (const [k, list] of listedByKey) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (clashKeys.has(k)) continue;
    const f = list[0]!;
    const row = indexByKey.get(k)?.[0] ?? null;
    const now: Version = { size: f.size, mtimeMs: f.mtimeSec * 1000 };
    let kind: EntryKind = 'new';
    let needsChecksum = false;
    if (row !== null) {
      const verdict = judgeChange(rule, row, now);
      needsChecksum = verdict === 'confirm';
      kind = row.goneAt !== null ? 'came_back' : verdict === 'changed' ? 'changed' : 'same';
    }
    // The phone row's checksum describes the file only while the file is still the one it was read from.
    const unchanged = row !== null && row.size === now.size && row.mtimeMs !== null && Math.abs(row.mtimeMs - (now.mtimeMs ?? 0)) <= DATE_TOLERANCE_MS;
    const current = { ...now, sha256: unchanged ? row.sha256 : null };
    entries.push({
      kind,
      path: f.path,
      relPath: row?.relPath ?? phoneRel(f.path),
      size: f.size,
      mtimeSec: f.mtimeSec,
      indexId: row?.id ?? null,
      previous: row !== null && (kind === 'changed' || kind === 'came_back') ? { size: row.size, mtimeMs: row.mtimeMs } : null,
      needsChecksum,
      destinations: destinations.map((d) => (row === null ? { destinationId: d.id, backedUp: false, worth: null, copyId: null } : backedUpAt(row.id, current, d, copiesByOrigin.get(row.id) ?? [], rule))),
    });
  }

  const gone: IndexedPhoneFile[] = [];
  for (const [k, rows] of indexByKey) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (clashKeys.has(k) || listedByKey.has(k)) continue;
    const row = rows[0]!;
    if (row.goneAt === null && seeable(row.relPath)) gone.push(row);
  }

  const tally = { new: 0, changed: 0, came_back: 0, same: 0 };
  for (const e of entries) tally[e.kind] += 1;
  return {
    entries,
    gone,
    clashes,
    counts: { new: tally.new, changed: tally.changed, cameBack: tally.came_back, same: tally.same, gone: gone.length, indexedLive, listed: input.listed.length },
  };
}
