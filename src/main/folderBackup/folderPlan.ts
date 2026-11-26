/**
 * Look and plan (job `folder.look`): the backed-up folder and the backup folder on the drive are looked at now (the listing's quick look, on its own
 * thread), compared with the index, the person's exclusions are applied, and the result is a list for the preview. Nothing is copied. An incomplete
 * look plans nothing and says why. The only writes are the looks' own (names, sizes and dates in the file list).
 *
 * Already backed up = a copy in this backup's folder on the drive of the same path with the same size and date (the change rule), or a copy whose
 * checksum is the file's (found by content: linked, never copied again). OneDrive files that are online only are counted and listed, never read.
 * The Google Keep notes (flat layout) are add-only: a file is copied only when no file of that name is on the drive; one of another size is left alone.
 */
import { randomUUID } from 'node:crypto';
import { LOCAL_MIN_FREE_BYTES } from '../../shared/localCopy';
import type { LeftOutGroup } from '../../shared/phoneBackup';
import { KEEP_SYNC_KEY, type FolderBackupKind, type FolderLookResult, type FolderPlanView, type OnlineOnlyInfo } from '../../shared/folderBackup';
import { ruleWords } from '../../shared/rules';
import { loadDestinations } from '../look/lookStore';
import { prefixUpperBound } from '../listing/skipRules';
import { finishSliced, sortSteps, STEP_ITEMS, type Steps } from '../sliceWork';
import { assignNamesSteps, hashPlanSteps, type LeftOutBucket, type PlanItem } from '../phoneBackup/planModel';
import { sessionFolderName } from '../phoneBackup/pathMap';
import { takenUnder, type ConfirmedRun } from '../phoneBackup/runStore';
import { RulesStore } from '../rules/rulesStore';
import { copiesOf, findCopy, loadDestSteps, type DestIndex } from './destIndex';
import { nameKey, placeInFolder, relOfRulePath, rulePathOf } from './folderPaths';
import { groupMovesSteps, type Move } from './movedGroups';
import type { FolderBackupDeps, FolderSource, RunCtx, SourceEntry, StoredFolderPlan } from './folderTypes';

export interface FolderPlanOutcome {
  result: FolderLookResult;
  stored: StoredFolderPlan | null;
}

interface ProfileRow {
  id: number;
  name: string;
  source_kind: string;
  source_root: string;
  folder_prefix: string;
  change_rule: 'size_and_date' | 'size_or_date';
  import_key: string | null;
  enabled: number;
}

const EXAMPLES = 5;
const CLOUD_BATCH = 1000;
/** Sorts after every character that can appear in a path. */
const AFTER_ALL = String.fromCharCode(0xffff);

/** The rows of the index under the backed-up folder (not gone), a page at a time. */
export function* loadSourceRowsSteps(db: FolderBackupDeps['db'], source: Pick<FolderSource, 'placeId' | 'relBase'>): Steps<SourceEntry[]> {
  if (source.placeId === null) return [];
  const prefix = source.relBase === '' ? '' : source.relBase.replace(/\/+$/, '') + '/';
  const hi = prefix === '' ? AFTER_ALL : prefixUpperBound(prefix);
  const page = db.prepare('SELECT id, rel_path, size, mtime, sha256, cloud_only FROM files WHERE place_id = ? AND rel_path > ? AND rel_path < ? AND gone_at IS NULL AND size IS NOT NULL ORDER BY rel_path LIMIT 5000');
  const out: SourceEntry[] = [];
  let last = prefix;
  for (;;) {
    const rows = page.all(source.placeId, last, hi) as { id: number; rel_path: string; size: number; mtime: number | null; sha256: string | null; cloud_only: number }[];
    for (const r of rows) out.push({ rel: r.rel_path.slice(prefix.length), size: r.size, mtimeMs: r.mtime ?? 0, rowId: r.id, sha256: r.sha256, cloudOnly: r.cloud_only === 1 });
    if (rows.length < 5000) return out;
    last = rows[rows.length - 1]!.rel_path;
    yield;
  }
}

interface Classified {
  items: PlanItem[];
  relinks: ConfirmedRun['relinks'];
  buckets: Map<string, LeftOutBucket>;
  alreadyBackedUp: number;
  sameElsewhere: number;
  differentOnDrive: number;
  differentExamples: string[];
  /** Already backed up, but the backed-up copy has another path than the file has now: it was renamed or moved. */
  moves: Move[];
}

interface ClassifyInput {
  entries: readonly SourceEntry[];
  index: DestIndex;
  flat: boolean;
  rule: 'size_and_date' | 'size_or_date';
  rules: ReturnType<RulesStore['compiled']>;
  /** A live copy in the backup with this content and size (any name), or null. */
  byContent: ((sha256: string, size: number) => { id: number; origin: number | null } | null) | null;
}

/** The copy lies where the file does not (any more): the file was renamed or moved since. A name Windows cannot store is compared in the form the copy got. */
function pathChanged(rel: string, rest: string): boolean {
  if (nameKey(rel) === nameKey(rest)) return false;
  const safe = placeInFolder({ root: '', session: '', rel });
  return safe === null || nameKey(safe.rel) !== nameKey(rest);
}

/** What the person's choices and the drive say about every file of the folder (a generator: 100,000 files must not block the window). */
export function* classifySteps(o: ClassifyInput): Steps<Classified> {
  const out: Classified = { items: [], relinks: [], buckets: new Map(), alreadyBackedUp: 0, sameElsewhere: 0, differentOnDrive: 0, differentExamples: [], moves: [] };
  let n = 0;
  for (const e of o.entries) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const path = rulePathOf(e.rel);
    const choice = o.rules.match(path);
    if (choice !== null && choice.choice === 'leave_out') {
      const key = `rule:${choice.id}`;
      let b = out.buckets.get(key);
      if (!b) out.buckets.set(key, (b = { key, filter: 'your_rule', folder: choice.pattern, rule: { id: choice.id, scope: choice.scope, pattern: choice.pattern, choice: choice.choice }, files: [], bytes: 0 }));
      b.files.push({ path, size: e.size, mtimeSec: Math.floor(e.mtimeMs / 1000), rowId: e.rowId });
      b.bytes += e.size;
      continue;
    }
    const mtimeSec = Math.floor(e.mtimeMs / 1000);
    if (o.flat) {
      const there = o.index.flat.get(nameKey(e.rel));
      if (!there) out.items.push({ path, size: e.size, mtimeSec, kind: 'new', rowId: e.rowId, destRel: '', candidates: [] });
      else if (there.size === e.size) out.alreadyBackedUp += 1;
      else {
        out.differentOnDrive += 1;
        if (out.differentExamples.length < EXAMPLES) out.differentExamples.push(e.rel);
      }
      continue;
    }
    const copies = copiesOf(o.index, e.rowId, e.rel);
    const match = findCopy(o.rule, { size: e.size, mtimeMs: e.mtimeMs, sha256: e.sha256 }, copies);
    if (match !== null && match.kind === 'same') {
      out.alreadyBackedUp += 1;
      // The file's own row is what the copy points at: a file renamed or moved keeps its row (R1.6), so its copy is found under the OLD path.
      if (e.rowId !== null && match.copy.origin === e.rowId && match.copy.rest !== null && pathChanged(e.rel, match.copy.rest)) out.moves.push({ from: match.copy.rest, to: e.rel });
      continue;
    }
    // The same content under another name or in another dated folder: already in the backup. It is linked when that copy points at no file yet.
    if (e.sha256 !== null && e.size > 0 && o.byContent !== null) {
      const found = o.byContent(e.sha256, e.size);
      if (found !== null) {
        out.alreadyBackedUp += 1;
        out.sameElsewhere += 1;
        if (found.origin === null && e.rowId !== null) out.relinks.push({ path, phoneRowId: e.rowId, copyRowId: found.id, sha256: e.sha256 });
        continue;
      }
    }
    out.items.push({
      path,
      size: e.size,
      mtimeSec,
      kind: copies.length > 0 ? 'changed' : 'new',
      rowId: e.rowId,
      destRel: '',
      // Same size and a date off by whole hours: only a checksum can say, so the run reads it and decides.
      candidates: match !== null ? [{ id: match.copy.id, relPath: match.copy.relPath, size: e.size, sha256: match.copy.sha256 }] : [],
    });
  }
  return out;
}

/** Where each file goes on the drive, in slices (100,000 names took over a second in one go). A name with no usable form is left out and returned apart. */
function* placeSteps(items: readonly PlanItem[], root: string, session: string): Steps<{ placed: PlanItem[]; unplaceable: string[] }> {
  const placed: PlanItem[] = [];
  const unplaceable: string[] = [];
  let n = 0;
  for (const i of items) {
    if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
    const where = placeInFolder({ root, session, rel: relOfRulePath(i.path)! });
    if (where === null) unplaceable.push(i.path);
    else {
      i.destRel = where.rel;
      placed.push(i);
    }
  }
  return { placed, unplaceable };
}

function* nameAllSteps(items: PlanItem[], used: Map<string, number | null> | null, now: Date): Steps<void> {
  if (used !== null) yield* assignNamesSteps(items, used, now);
  else yield* sortSteps(items, (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function planFolderBackup(deps: FolderBackupDeps, params: { backupId: number }, ctx: RunCtx): Promise<FolderPlanOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const fail = (message: string): FolderPlanOutcome => ({ result: { ok: false, message }, stored: null });
  const profile = db.prepare('SELECT id, name, source_kind, source_root, folder_prefix, change_rule, import_key, enabled FROM backup_profiles WHERE id = ?').get(params.backupId) as ProfileRow | undefined;
  if (!profile || profile.source_kind !== 'folder') return fail('That is not a folder backup.');
  if (profile.enabled !== 1) return fail('This backup is switched off.');
  const dest = loadDestinations(db, profile.id)[0];
  if (!dest) return fail('This backup has no drive to go to yet.');
  const target = await deps.driveFor(dest.placeId);
  if (!target) return fail('The drive for this backup is not plugged in. Plug it in and try again. Nothing was changed.');
  const protectedLine = deps.writeProtected?.(dest.placeId) ?? null;
  if (protectedLine) return fail(protectedLine);
  const flat = profile.import_key === KEEP_SYNC_KEY;
  const layout: FolderBackupKind = flat ? 'flat' : 'dated';
  const found = await deps.sourceFor({ id: profile.id, name: profile.name, sourceRoot: profile.source_root, importKey: profile.import_key, folderPrefix: profile.folder_prefix });
  if (!found.ok) return fail(found.message);
  const source = found.source;
  const pause = (): Promise<void> => ctx.yield();
  const say = (message: string): void => ctx.progress(0, 1, { message });

  // Look first, every time: the folder, then the backup folder on the drive. A look that did not finish plans nothing.
  say(`Looking at ${source.words}. Nothing is copied.`);
  const look = await source.look({ signal: ctx.signal, progress: say });
  if (look.rootMissing) return fail(`The folder ${source.words} could not be found. If it is in OneDrive, check that OneDrive is running and signed in. Nothing was planned.`);
  if (!look.complete) return fail(`${look.message ?? 'The folder could not be read completely.'} Nothing was planned.`);
  say(`Looking at ${target.label}. Nothing is copied.`);
  const driveLook = await target.drive.look(dest.root, { signal: ctx.signal, progress: say });
  if (!driveLook.complete && !driveLook.rootMissing) return fail(`${target.label}: ${driveLook.message ?? 'the list of files could not be read completely.'} Nothing was planned.`);

  const entries = look.entries ?? (await finishSliced(loadSourceRowsSteps(db, source), pause));
  // A folder that looks empty where files were backed up before (OneDrive signed out, a wrong path) is never planned: "nothing new" would be a lie.
  if (entries.length === 0 && !flat && source.placeId !== null) {
    const prefix = source.relBase === '' ? '' : source.relBase + '/';
    const before = db.prepare('SELECT 1 FROM files WHERE place_id = ? AND gone_at IS NOT NULL AND rel_path > ? AND rel_path < ? LIMIT 1').get(source.placeId, prefix, prefix === '' ? AFTER_ALL : prefixUpperBound(prefix));
    if (before !== undefined) return fail(`${source.words} looks empty, but files were there before. Check that it is the right folder and that OneDrive is signed in. Nothing was planned.`);
  }

  say('Comparing with the backup. Nothing is copied.');
  const empty: DestIndex = { byKey: new Map(), byOrigin: new Map(), flat: new Map(), rows: 0 };
  const index = driveLook.rootMissing ? empty : await finishSliced(loadDestSteps(db, { placeId: dest.placeId, root: dest.root, prefix: profile.folder_prefix, flat }), pause);
  const base = dest.root.replace(/\/+$/, '') + '/';
  const lo = base;
  const hi = prefixUpperBound(base);
  const shaStmt = db.prepare('SELECT id, origin_file_id FROM files WHERE sha256 = ? AND place_id = ? AND gone_at IS NULL AND size = ? AND rel_path > ? AND rel_path < ? LIMIT 1');
  const byContent = flat || driveLook.rootMissing ? null : (sha: string, size: number): { id: number; origin: number | null } | null => {
    const r = shaStmt.get(sha, dest.placeId, size, lo, hi) as { id: number; origin_file_id: number | null } | undefined;
    return r ? { id: r.id, origin: r.origin_file_id } : null;
  };
  const date = new Date(now());
  const sessionFolder = flat ? '' : sessionFolderName(profile.folder_prefix, date);
  const classified = await finishSliced(classifySteps({ entries, index, flat, rule: profile.change_rule, rules: new RulesStore(db, now).compiled(profile.id), byContent }), pause);

  // OneDrive: a file whose content is online only is never read. The index flag is a hint; Windows is asked about every file that would be copied.
  const onlineOnly: OnlineOnlyInfo = { files: 0, bytes: 0, examples: [] };
  let items = classified.items;
  if (source.cloudAware && items.length > 0) {
    const flagged = new Set(entries.filter((e) => e.cloudOnly).map((e) => rulePathOf(e.rel)));
    const online = (i: PlanItem): void => {
      onlineOnly.files += 1;
      onlineOnly.bytes += i.size;
      if (onlineOnly.examples.length < EXAMPLES) onlineOnly.examples.push(relOfRulePath(i.path) ?? i.path);
    };
    const keep: PlanItem[] = [];
    const check: PlanItem[] = [];
    for (const i of items) {
      if (flagged.has(i.path)) online(i);
      else check.push(i);
    }
    for (let at = 0; at < check.length; at += CLOUD_BATCH) {
      await pause();
      ctx.progress(at, Math.max(1, check.length), { message: `Checking which OneDrive files are online only: ${at.toLocaleString('en-GB')} of ${check.length.toLocaleString('en-GB')}. Nothing is opened.` });
      const group = check.slice(at, at + CLOUD_BATCH);
      const states = await source.cloudStates(group.map((i) => relOfRulePath(i.path)!), ctx.signal);
      for (const i of group) {
        const state = states.get(relOfRulePath(i.path)!) ?? 'unknown';
        // A file Windows could not be asked about counts as online only: it is never opened to find out.
        if (state === 'cloud' || state === 'unknown') online(i);
        else if (state === 'local') keep.push(i);
      }
    }
    items = keep;
  }

  const { placed, unplaceable } = await finishSliced(placeSteps(items, dest.root, sessionFolder), pause);
  await finishSliced(nameAllSteps(placed, flat ? null : takenUnder(db, dest.placeId, `${dest.root}/${sessionFolder}`), date), pause);

  const total = { files: placed.length, bytes: placed.reduce((s, i) => s + i.size, 0) };
  const free = await target.drive.freeBytes();
  const blocked = free !== null && total.bytes + LOCAL_MIN_FREE_BYTES > free ? `${target.label} does not have room for this (it has ${Math.max(0, Math.floor(free / 1e9))} GB free, the copy needs ${(total.bytes / 1e9).toFixed(1)} GB). Free up some space on it first.` : null;
  const grouped = await finishSliced(groupMovesSteps(classified.moves), pause);
  const buckets = [...classified.buckets.values()].toSorted((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : 1));
  const notes: string[] = [];
  if (unplaceable.length > 0) notes.push(`${unplaceable.length} files have names that cannot be stored on Windows at all and will not be copied.`);
  if (classified.sameElsewhere > 0) notes.push(`${classified.sameElsewhere.toLocaleString('en-GB')} files are already in the backup under another name or date (same content), so they are linked and not copied again.`);
  if (classified.differentOnDrive > 0) notes.push(`${classified.differentOnDrive.toLocaleString('en-GB')} files have the same name as a file already on ${target.label} but another size. Nothing on the drive is ever replaced, so they were left alone.`);
  if (onlineOnly.files > 0) notes.push(`${onlineOnly.files.toLocaleString('en-GB')} OneDrive files (${(onlineOnly.bytes / 1e9).toFixed(1)} GB) are online only. They are not copied this time and nothing was downloaded.`);

  const base2: StoredFolderPlan['base'] = {
    planId: randomUUID(),
    backupId: profile.id,
    backupName: profile.name,
    phoneName: source.words,
    serial: '',
    phonePlaceId: source.placeId ?? '',
    destPlaceId: dest.placeId,
    destRoot: dest.root,
    sessionFolder,
    notCovered: [],
    folders: [],
    accept: [],
    flat,
    onlineOnly,
  };
  const hash = await finishSliced(hashPlanSteps({ items: placed, relinks: classified.relinks, leftOut: buckets.map((b) => ({ key: b.key, files: b.files.length })), folder: sessionFolder === '' ? dest.root : sessionFolder }), pause);
  const stored: StoredFolderPlan = { planId: base2.planId, hash, createdAt: now(), base: base2, items: placed, relinks: classified.relinks, buckets, total, onlineOnly };
  const view: FolderPlanView = {
    planId: base2.planId,
    hash,
    backupId: profile.id,
    backupName: profile.name,
    sourceWords: source.words,
    driveLabel: target.label,
    folderWords: `${dest.root.split('/').join('\\')}${sessionFolder === '' ? '' : '\\' + sessionFolder}`,
    layout,
    rows: placed.map((i) => ({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, kind: i.kind })),
    totals: total,
    alreadyBackedUp: classified.alreadyBackedUp,
    sameContentElsewhere: classified.sameElsewhere,
    differentOnDrive: classified.differentOnDrive,
    moved: grouped.groups,
    movedFiles: grouped.files,
    leftOut: buckets.map((b): LeftOutGroup => {
      const group: LeftOutGroup = { key: b.key, filter: b.filter, folder: b.folder, files: b.files.length, bytes: b.bytes, canInclude: false };
      if (b.rule) group.rule = { id: b.rule.id, words: ruleWords(b.rule) };
      return group;
    }),
    onlineOnly,
    notes,
    freeBytes: free,
    blocked,
  };
  deps.log.info(`folderBackup: plan ${base2.planId} for backup ${profile.id}: ${total.files} to copy (${total.bytes} bytes), ${classified.alreadyBackedUp} already backed up (${grouped.files} of them renamed or moved), ${onlineOnly.files} online only, ${buckets.reduce((s, b) => s + b.files.length, 0)} left out`);
  return { result: { ok: true, plan: view }, stored };
}
