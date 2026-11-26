/**
 * The plan of one phone backup (PLAN.md section 7, R1.2): from what the look found, what the backup's filters and exclusions say and
 * what the drive already holds, which files to copy, which are left out (and by which filter, in which folder) and which files may
 * already be on the drive (a name-and-size match is only a CANDIDATE: the caller confirms it with the phone's checksum). Pure.
 * Nothing is written and nothing is read from outside; the caller passes in everything.
 */
import { createHash } from 'node:crypto';
import type { Filters } from '../backupProfiles/filters';
import type { BackupRule } from '../../shared/rules';
import type { CompiledRules } from '../rules/ruleMatcher';
import type { LookEntry } from '../look/compare';
import type { LeftOutFilter } from '../../shared/phoneBackup';
import { groupFolderOf, leftOutBy, nomediaDirsOf } from './filterModel';
import { finishSync, sortSteps, STEP_ITEMS, type Steps } from '../sliceWork';
import { driveKey, nameTag, placeOnDrive, timedName } from './pathMap';

/** A row on the drive under the backup folder that no phone row points at (PhoneBackup's "loose" rows). */
export interface LooseRow {
  id: number;
  relPath: string;
  size: number;
  sha256: string | null;
}

export interface PlanItem {
  path: string;
  size: number;
  mtimeSec: number;
  kind: 'new' | 'changed';
  /** The phone's row in the index (set by the look). */
  rowId: number | null;
  /** Where it will go on the drive, relative to the drive root. */
  destRel: string;
  candidates: LooseRow[];
}

export interface LeftOutFile {
  path: string;
  size: number;
  mtimeSec: number;
  rowId: number | null;
}

export interface LeftOutBucket {
  /** "<filter>|<folder>" for a built-in filter, "rule:<id>" for a choice of the person. */
  key: string;
  filter: LeftOutFilter;
  folder: string;
  /** The choice of the person that left these files out (one group per choice), or null for a built-in filter. */
  rule: Pick<BackupRule, 'id' | 'scope' | 'pattern' | 'choice'> | null;
  files: LeftOutFile[];
  bytes: number;
}

export interface PlanInput {
  entries: readonly LookEntry[];
  filters: Filters;
  /** The person's choices (never back up / always include), compiled once for this plan. They come BEFORE the built-in filters. */
  rules: CompiledRules;
  /** The backup folder on the drive ("MyData/POCO"). */
  root: string;
  sessionFolder: string;
  /** The moment of the plan (names of a second version on the same day carry its time). */
  now: Date;
  rowIdOf(relPath: string): number | null;
  /** Rows at the drive under the backup folder (not gone): the case-insensitive path key -> the phone row id they came from (null: none). */
  taken: ReadonlyMap<string, number | null>;
  /** Loose rows on the drive with this name and size, best first. */
  looseFor(name: string, size: number): LooseRow[];
  /** All listed phone paths (the .nomedia folders are read from them). */
  listedPaths: readonly string[];
}

export interface PlanResult {
  items: PlanItem[];
  leftOut: LeftOutBucket[];
  alreadyBackedUp: number;
  /** Phone files with no usable name on Windows (cannot be placed). */
  unplaceable: string[];
  /** For every file a choice of the person names: the built-in filter that would have left it out (null: none). Lets a later change be counted. */
  ruledBuiltin: Map<string, LeftOutFilter | null>;
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function buildPlan(input: PlanInput): PlanResult {
  return finishSync(buildPlanSteps(input));
}

/** `buildPlan` as slices (60,000 files take over a second in one go; see sliceWork.ts). The answer is the same. */
export function* buildPlanSteps(input: PlanInput): Steps<PlanResult> {
  const nomedia = nomediaDirsOf(input.listedPaths);
  const items: PlanItem[] = [];
  const buckets = new Map<string, LeftOutBucket>();
  const unplaceable: string[] = [];
  let alreadyBackedUp = 0;

  const ruledBuiltin = new Map<string, LeftOutFilter | null>();
  const leave = (filter: LeftOutFilter, e: LookEntry, rule: BackupRule | null = null): void => {
    const folder = rule === null ? groupFolderOf(e.path) : rule.pattern;
    const key = rule === null ? `${filter}|${folder}` : `rule:${rule.id}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { key, filter, folder, rule: rule === null ? null : { id: rule.id, scope: rule.scope, pattern: rule.pattern, choice: rule.choice }, files: [], bytes: 0 }));
    b.files.push({ path: e.path, size: e.size, mtimeSec: e.mtimeSec, rowId: input.rowIdOf(e.relPath) });
    b.bytes += e.size;
  };

  let n = 0;
  for (const e of input.entries) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    if (e.destinations[0]?.backedUp === true) {
      alreadyBackedUp += 1;
      continue;
    }
    // A choice of the person comes before the built-in filters: "never back up" leaves the file out, "always include" brings back a file a filter would drop.
    const rule = input.rules.match(e.path);
    const by = leftOutBy(e.path, input.filters, nomedia);
    if (rule !== null) {
      ruledBuiltin.set(e.path, by);
      if (rule.choice === 'leave_out') {
        leave('your_rule', e, rule);
        continue;
      }
    } else if (by !== null) {
      leave(by, e);
      continue;
    }
    const where = placeOnDrive({ root: input.root, sessionFolder: input.sessionFolder, phonePath: e.path });
    if (where === null) {
      unplaceable.push(e.path);
      continue;
    }
    const rowId = input.rowIdOf(e.relPath);
    items.push({
      path: e.path,
      size: e.size,
      mtimeSec: e.mtimeSec,
      kind: e.kind === 'changed' ? 'changed' : 'new',
      rowId,
      destRel: where.rel,
      candidates: e.kind === 'changed' ? [] : input.looseFor(baseName(e.path), e.size),
    });
  }

  yield* assignNamesSteps(items, new Map(input.taken), input.now);

  const leftOut = [...buckets.values()].toSorted((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : 1));
  return { items, leftOut, alreadyBackedUp, unplaceable, ruledBuiltin };
}

/**
 * Two files must never land on one drive name (a name is compared without regard to case, like Windows does), and a file that is already
 * there is never replaced: the second version of the same phone file on one day gets its time in the name, a different phone file gets a
 * short tag. `used` is every name already taken (path key -> phone row id); it grows as names are given out.
 */
export function assignNames(items: PlanItem[], used: Map<string, number | null>, now: Date): void {
  finishSync(assignNamesSteps(items, used, now));
}

export function* assignNamesSteps(items: PlanItem[], used: Map<string, number | null>, now: Date): Steps<void> {
  yield* sortSteps(items, (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let n = 0;
  for (const item of items) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    let rel = item.destRel;
    const owner = used.get(driveKey(rel));
    if (used.has(driveKey(rel))) {
      const slash = rel.lastIndexOf('/');
      const dir = rel.slice(0, slash + 1);
      const name = rel.slice(slash + 1);
      rel = owner !== null && owner === item.rowId ? dir + timedName(name, now) : dir + tagName(name, item.path);
      if (used.has(driveKey(rel))) rel = dir + tagName(timedName(name, now), item.path);
    }
    item.destRel = rel;
    used.set(driveKey(rel), item.rowId);
  }
}

function tagName(name: string, phonePath: string): string {
  const dot = name.lastIndexOf('.');
  const tag = nameTag(phonePath);
  return dot > 0 ? `${name.slice(0, dot)} [${tag}]${name.slice(dot)}` : `${name} [${tag}]`;
}

/** SHA-256 over everything the person will be asked to confirm. */
export function hashPlan(parts: HashParts): string {
  return finishSync(hashPlanSteps(parts));
}

interface HashParts {
  items: readonly PlanItem[];
  relinks: readonly { path: string; copyRowId: number }[];
  leftOut: readonly { key: string; files: number }[];
  folder: string;
}

/**
 * `hashPlan` in slices. The text fed to the hash is exactly what `JSON.stringify({ f, i, r, l })` writes, written piece by piece, so the
 * checksum is the same as before; 60,000 files made one stringify of over 100 ms.
 */
export function* hashPlanSteps(parts: HashParts): Steps<string> {
  const hash = createHash('sha256');
  hash.update(`{"f":${JSON.stringify(parts.folder)},"i":[`);
  for (let a = 0; a < parts.items.length; a += STEP_ITEMS) {
    const piece = parts.items.slice(a, a + STEP_ITEMS).map((i) => JSON.stringify([i.path, i.size, i.mtimeSec, i.destRel])).join(',');
    hash.update(a === 0 ? piece : `,${piece}`);
    yield;
  }
  hash.update(`],"r":${JSON.stringify(parts.relinks.map((r) => [r.path, r.copyRowId]))},"l":${JSON.stringify(parts.leftOut.map((l) => [l.key, l.files]))}}`);
  return hash.digest('hex');
}
