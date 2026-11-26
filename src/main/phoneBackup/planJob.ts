/**
 * Look and plan (job `phone.look`): the phone is listed completely (R1.0a), compared with the index, the filters and the person's own
 * exclusions are applied, name-and-size matches with copies already on the drive are CONFIRMED by the phone's checksum, and the result is a
 * plan for the preview. Nothing is copied. An incomplete or doubtful look plans nothing and says why. The only writes are the look's own
 * (the phone's rows in the index).
 */
import { randomUUID } from 'node:crypto';
import { type LeftOutGroup, type PhoneLookResult, type PhonePlanView } from '../../shared/phoneBackup';
import { LOCAL_MIN_FREE_BYTES } from '../../shared/localCopy';
import { parseFilters } from '../backupProfiles/filters';
import { loadDestinations } from '../look/lookStore';
import { runLook } from '../look/lookRun';
import type { DecisionKind } from '../look/lookGuard';
import { JobFailure } from '../jobs/jobService';
import { finishSliced } from '../sliceWork';
import { buildPlanSteps, hashPlanSteps } from './planModel';
import { dayStamp, sessionFolderName } from './pathMap';
import { looseLookup, phoneRowIdsSteps, takenUnder } from './runStore';
import { ruleWords } from '../../shared/rules';
import { RulesStore } from '../rules/rulesStore';
import type { PhoneBackupDeps, RunCtx, StoredPlan } from './phoneBackupTypes';

export const PHONE_ROOT = '/sdcard';

export interface PlanParams {
  backupId: number;
  accept?: DecisionKind[];
}

export interface PlanOutcome {
  result: PhoneLookResult;
  stored: StoredPlan | null;
}

interface ProfileRow {
  id: number;
  name: string;
  source_kind: string;
  source_place_id: string | null;
  phone_serial: string | null;
  folder_prefix: string;
  filters_json: string;
  change_rule: 'size_and_date' | 'size_or_date';
  enabled: number;
}

/** Why a phone cannot be used right now, in plain words (null when it is plugged in and allowed), and the model name adb reports. */
export async function checkPhone(deps: PhoneBackupDeps, serial: string): Promise<{ problem: string | null; model: string | null }> {
  let devices;
  try {
    devices = await deps.adb.devices();
  } catch {
    return { problem: 'Backup Hub could not talk to the phone. Plug it in with the cable, unlock it, and try again.', model: null };
  }
  const mine = devices.find((d) => d.serial === serial);
  if (!mine) return { problem: "This backup's phone is not plugged in. Plug it in with the cable and unlock it.", model: null };
  if (mine.state === 'unauthorized') return { problem: 'The phone has not allowed this computer. Unlock the phone and tap Allow on its screen, then try again.', model: mine.model };
  if (mine.state !== 'device') return { problem: `The phone is not ready (${mine.state}). Unlock it, set the cable to file transfer, and try again.`, model: mine.model };
  return { problem: null, model: mine.model };
}

export const phoneProblem = async (deps: PhoneBackupDeps, serial: string): Promise<string | null> => (await checkPhone(deps, serial)).problem;

export async function planPhoneBackup(deps: PhoneBackupDeps, params: PlanParams, ctx: RunCtx): Promise<PlanOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const fail = (message: string, decision: { kind: string; canAccept: boolean } | null = null): PlanOutcome => ({ result: { ok: false, message, decision }, stored: null });

  const profile = db.prepare('SELECT id, name, source_kind, source_place_id, phone_serial, folder_prefix, filters_json, change_rule, enabled FROM backup_profiles WHERE id = ?').get(params.backupId) as ProfileRow | undefined;
  if (!profile || profile.source_kind !== 'phone' || profile.phone_serial === null || profile.source_place_id === null) return fail('That is not a phone backup.');
  if (profile.enabled !== 1) return fail('This backup is switched off.');
  const dest = loadDestinations(db, profile.id)[0];
  if (!dest) return fail('This backup has no drive to go to yet.');
  const target = await deps.driveFor(dest.placeId);
  if (!target) return fail('The drive for this backup is not plugged in. Plug it in and try again. Nothing was changed.');
  const protectedLine = deps.writeProtected?.(dest.placeId) ?? null;
  if (protectedLine) return fail(protectedLine);
  const checked = await checkPhone(deps, profile.phone_serial);
  if (checked.problem) return fail(checked.problem);

  // About how many files the phone had last time, so the live count reads "12,000 of about 33,700". For the person only.
  const expected = db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NULL').pluck().get(profile.source_place_id) as number;
  const readingWords = (n: number): string =>
    expected > 0 ? `Reading the list of files on the phone: ${n.toLocaleString('en-GB')} of about ${expected.toLocaleString('en-GB')}. Nothing is copied.` : `Reading the list of files on the phone: ${n.toLocaleString('en-GB')} so far. Nothing is copied.`;
  ctx.progress(0, Math.max(1, expected), { message: readingWords(0) });
  const report = await runLook({
    onCount: (n) => ctx.progress(Math.min(n, Math.max(1, expected)), Math.max(1, expected), { message: readingWords(n) }),
    db,
    placeId: profile.source_place_id,
    serial: profile.phone_serial,
    folders: [PHONE_ROOT],
    run: deps.adb.listRunner(),
    changeRule: profile.change_rule,
    backupProfileId: profile.id,
    accept: params.accept ?? [],
    allowRoot: true,
    now,
    signal: ctx.signal,
    pause: () => ctx.yield(),
  });
  if (!report.outcome.ok) {
    const d = report.outcome.decision;
    return fail(d.plain, { kind: d.kind, canAccept: d.options.includes('accept') });
  }
  const compare = report.outcome.compare;
  const filters = parseFilters(profile.filters_json);
  const date = new Date(now());
  const sessionFolder = sessionFolderName(profile.folder_prefix, date);
  const pause = (): Promise<void> => ctx.yield();
  const ids = await finishSliced(phoneRowIdsSteps(db, profile.source_place_id, compare.entries.filter((e) => e.destinations[0]?.backedUp !== true).map((e) => e.relPath)), pause);

  const planned = await finishSliced(buildPlanSteps({
    entries: compare.entries,
    filters,
    rules: new RulesStore(db, now).compiled(profile.id),
    root: dest.root,
    sessionFolder,
    now: date,
    rowIdOf: (rel) => ids.get(rel) ?? null,
    taken: takenUnder(db, dest.placeId, `${dest.root}/${sessionFolder}`),
    looseFor: looseLookup(db, dest.placeId, dest.root),
    listedPaths: report.look.files.map((f) => f.path),
  }), pause);

  // A name-and-size match is a candidate only: the phone's checksum and a read of the drive's file must agree before it counts.
  const withCandidates = planned.items.filter((i) => i.candidates.length > 0);
  const relinks: StoredPlan['relinks'] = [];
  const confirmed = new Set<string>();
  const usedCopies = new Set<number>();
  let done = 0;
  for (const item of withCandidates) {
    await ctx.yield();
    ctx.progress(done, withCandidates.length, { message: `Checking ${withCandidates.length - done} files that may already be on the drive` });
    done += 1;
    if (item.rowId === null) continue;
    const phoneSha = await deps.adb.sha256(profile.phone_serial, item.path, ctx.signal);
    if (phoneSha === null) continue;
    for (const c of item.candidates) {
      if (usedCopies.has(c.id)) continue;
      const file = target.drive.finalPath(c.relPath);
      if (!(await target.drive.ops.exists(file))) continue;
      let there: string;
      try {
        there = await target.drive.ops.hash(file, () => ctx.yield());
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        continue;
      }
      if (there === phoneSha) {
        usedCopies.add(c.id);
        confirmed.add(item.path);
        relinks.push({ path: item.path, phoneRowId: item.rowId, copyRowId: c.id, sha256: phoneSha });
        break;
      }
    }
  }
  const notConfirmed = withCandidates.length - confirmed.size;
  const items = planned.items.filter((i) => !confirmed.has(i.path));

  const notes: string[] = [];
  const notCovered: string[] = [];
  if (report.look.unreadable.length > 0) notes.push(`${report.look.unreadable.length} folders on the phone refused to be read (private app folders the filters leave out anyway), so their files were not seen.`);
  if (planned.unplaceable.length > 0) notes.push(`${planned.unplaceable.length} files have names that cannot be stored on Windows at all and will not be copied.`);
  try {
    for (const space of await deps.adb.otherSpaces(profile.phone_serial, ctx.signal)) {
      const line = `A second space on the phone (number ${space.id}) is ${space.readable ? 'readable but is not backed up yet' : 'not readable from the computer'}.`;
      notCovered.push(line);
      notes.push(line + ' It is named as not covered in the report.');
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    notes.push('Backup Hub could not check whether the phone has a second space.');
  }

  const total = { files: items.length, bytes: items.reduce((s, i) => s + i.size, 0) };
  const free = await target.drive.freeBytes();
  const blocked = free !== null && total.bytes + LOCAL_MIN_FREE_BYTES > free ? `${target.label} does not have room for this (it has ${Math.max(0, Math.floor(free / 1e9))} GB free, the copy needs ${(total.bytes / 1e9).toFixed(1)} GB). Free up some space on it first.` : null;
  const phoneName = checked.model ?? profile.name;
  const leftOutTotals = planned.leftOut.reduce((a, b) => ({ files: a.files + b.files.length, bytes: a.bytes + b.bytes }), { files: 0, bytes: 0 });

  const base: StoredPlan['base'] = {
    planId: randomUUID(),
    backupId: profile.id,
    backupName: profile.name,
    phoneName,
    serial: profile.phone_serial,
    phonePlaceId: profile.source_place_id,
    destPlaceId: dest.placeId,
    destRoot: dest.root,
    sessionFolder,
    notCovered,
    folders: [PHONE_ROOT],
    accept: params.accept ?? [],
  };
  const hash = await finishSliced(hashPlanSteps({ items, relinks, leftOut: planned.leftOut.map((b) => ({ key: b.key, files: b.files.length })), folder: sessionFolder }), pause);
  const stored: StoredPlan = {
    planId: base.planId,
    hash,
    createdAt: now(),
    base,
    items,
    relinks,
    buckets: planned.leftOut,
    canInclude: new Set(['android_data', 'nomedia', 'cache_folder', 'temporary_file', 'whatsapp_hidden']),
    ruledBuiltin: planned.ruledBuiltin,
    total,
  };
  const view: PhonePlanView = {
    planId: base.planId,
    hash,
    backupId: profile.id,
    backupName: profile.name,
    phoneName,
    driveLabel: target.label,
    folderWords: `${dest.root.split('/').join('\\')}\\${sessionFolder}`,
    rows: items.map((i) => ({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, kind: i.kind })),
    totals: total,
    confirmedOnDrive: confirmed.size,
    notConfirmed,
    alreadyBackedUp: planned.alreadyBackedUp,
    leftOut: planned.leftOut.map((b): LeftOutGroup => {
      const group: LeftOutGroup = { key: b.key, filter: b.filter, folder: b.folder, files: b.files.length, bytes: b.bytes, canInclude: b.filter !== 'your_rule' };
      if (b.rule) group.rule = { id: b.rule.id, words: ruleWords(b.rule) };
      return group;
    }),
    notes,
    freeBytes: free,
    blocked,
  };
  deps.log.info(`phoneBackup: plan ${base.planId} for ${profile.name} (${dayStamp(date)}): ${total.files} to copy (${total.bytes} bytes), ${confirmed.size} confirmed on the drive, ${leftOutTotals.files} left out`);
  return { result: { ok: true, plan: view }, stored };
}

/** The plain sentence for a plan that cannot be made (shown by the job when the look says no). */
export function refusal(outcome: PlanOutcome): JobFailure {
  const r = outcome.result;
  return new JobFailure(r.ok ? 'The plan was made.' : r.message, undefined, 'refused');
}
