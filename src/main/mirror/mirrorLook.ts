/**
 * The look of the mirror (job `mirror.look`, light): both drives' folders are looked at again (the listing's quick look brings the file list up to
 * date; it opens no file), then the list of what the second drive is missing is made from the file list alone. Nothing is copied, nothing is written
 * to either drive. A first drive that is not plugged in is said plainly; an incomplete look of the first drive plans nothing.
 */
import { randomUUID } from 'node:crypto';
import { type MirrorLookResult, type MirrorPlanView, type MirrorRow } from '../../shared/mirror';
import { finishSliced, STEP_ITEMS } from '../sliceWork';
import { rowId, planSteps } from './mirrorScan';
import { pairOf } from './mirrorPairs';
import type { MirrorCtx, MirrorDeps, MirrorDrive, MirrorPair, StoredMirrorPlan } from './mirrorTypes';

export interface MirrorPlanOutcome {
  result: MirrorLookResult;
  stored: StoredMirrorPlan | null;
}

/** Room that must stay free on a drive after the copy (the same margin the phone backup keeps). */
export const KEEP_FREE_BYTES = 200_000_000;

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

const no = (reason: Extract<MirrorLookResult, { ok: false }>['reason'], message: string): MirrorPlanOutcome => ({ result: { ok: false, message, reason }, stored: null });

export const plugInSourceLine = (pair: Pick<MirrorPair, 'srcLabel' | 'dstLabel'>): string => `Plug in the ${pair.srcLabel} to bring the ${pair.dstLabel} up to date.`;
export const plugInTargetLine = (pair: Pick<MirrorPair, 'dstLabel'>): string => `Plug in ${pair.dstLabel} to bring it up to date.`;

export async function planMirror(deps: MirrorDeps, request: { backupIds: number[] }, ctx: MirrorCtx): Promise<MirrorPlanOutcome> {
  const { db } = deps;
  const wanted = request.backupIds.map((id) => pairOf(db, id)).filter((p): p is MirrorPair => p !== null);
  if (wanted.length === 0) return no('nothing', 'No backup has a second drive yet. Add "Also keep a copy" to a backup first.');
  const notes: string[] = [];
  const usable: { pair: MirrorPair; src: MirrorDrive; dst: MirrorDrive }[] = [];
  let firstRefusal: MirrorPlanOutcome | null = null;
  for (const pair of wanted) {
    const found = await deps.drivesFor(pair.srcPlaceId, pair.dstPlaceId);
    const refuse = (outcome: MirrorPlanOutcome): void => {
      firstRefusal ??= outcome;
      if (!outcome.result.ok) notes.push(`${pair.backupName}: ${outcome.result.message}`);
    };
    if (!found.src) refuse(no('source_missing', plugInSourceLine(pair)));
    else if (!found.dst) refuse(no('target_missing', plugInTargetLine(pair)));
    else {
      const guarded = deps.writeProtected?.(pair.dstPlaceId) ?? null;
      if (guarded) refuse(no('other', guarded));
      else usable.push({ pair, src: found.src, dst: found.dst });
    }
  }
  if (usable.length === 0) return firstRefusal ?? no('other', 'Nothing can be checked right now.');
  const pairs = usable.map((u) => u.pair);

  for (const { pair, src, dst } of usable) {
    ctx.progress(0, 0, { message: `Looking at the ${src.label}: ${pair.backupName}` });
    const seen = await src.look(pair.srcRoot, { signal: ctx.signal, progress: (message) => ctx.progress(0, 0, { message }) });
    if (seen.rootMissing) return no('incomplete', `The folder ${pair.srcRoot} was not found on the ${src.label}, so nothing is planned.`);
    if (!seen.complete) return no('incomplete', `The list of files on the ${src.label} is not complete (${seen.message ?? 'a folder could not be read'}), so nothing is planned. Nothing was changed. Try again.`);
    ctx.progress(0, 0, { message: `Looking at ${dst.label}: ${pair.backupName}` });
    const there = await dst.look(pair.dstRoot, { signal: ctx.signal, progress: (message) => ctx.progress(0, 0, { message }) });
    // A second drive whose list is not complete only makes the list longer: each file is looked at again before it is copied.
    if (!there.complete && !there.rootMissing) notes.push(`The list of files on ${dst.label} was not complete. Every file is checked again on the drive before it is copied.`);
  }

  ctx.progress(0, 0, { message: 'Working out what is missing' });
  const data = await finishSliced(planSteps(db, pairs), () => ctx.yield());
  const rows: MirrorRow[] = [];
  let ownChecksums = 0;
  for (const i of data.copy) {
    rows.push({ id: rowId(i.b, i.rel), backupIndex: i.b, path: i.rel, size: i.size, mtimeMs: i.mtimeMs, ownChecksum: !i.expected });
    if (!i.expected) ownChecksums += 1;
    if (rows.length % STEP_ITEMS === 0) await ctx.yield();
  }
  const bytes = data.copy.reduce((s, i) => s + i.size, 0);
  const freeByDrive = new Map<string, { label: string; free: number | null; needed: number }>();
  for (const { pair, dst } of usable) {
    const entry = freeByDrive.get(pair.dstPlaceId) ?? { label: dst.label, free: await dst.freeBytes(), needed: 0 };
    entry.needed += data.perPair[pairs.indexOf(pair)]!.bytes;
    freeByDrive.set(pair.dstPlaceId, entry);
  }
  let blocked: string | null = null;
  let freeBytes: number | null = null;
  for (const e of freeByDrive.values()) {
    if (e.free !== null) freeBytes = freeBytes === null ? e.free : Math.min(freeBytes, e.free);
    if (blocked === null && e.free !== null && e.needed + KEEP_FREE_BYTES > e.free) blocked = `There is not enough room on ${e.label}: the list needs ${gb(e.needed)} and ${gb(e.free)} is free. Untick files, or free up space first.`;
  }
  if (data.knownProblems > 0) notes.push(`${data.knownProblems.toLocaleString('en-US')} files were already asked about (a damaged copy or a different file). They are not offered again and are still not on the second drive.`);
  if (ownChecksums > 0) notes.push(`${ownChecksums.toLocaleString('en-US')} of these files have no checksum from the phone. Their own checksum is used, and the report says so.`);
  const view: MirrorPlanView = {
    planId: randomUUID(),
    hash: data.hash,
    backups: pairs.map((p, b) => ({ backupId: p.backupId, backupName: p.backupName, sourceLabel: p.srcLabel, targetLabel: p.dstLabel, folderWords: p.dstRoot.split('/').join('\\'), files: data.perPair[b]!.files, bytes: data.perPair[b]!.bytes })),
    rows,
    totals: { files: data.copy.length, bytes },
    toCheck: data.same,
    different: { files: data.different.length, examples: data.different.slice(0, 5).map((i) => i.rel) },
    knownProblems: data.knownProblems,
    ownChecksums,
    notes,
    freeBytes,
    blocked,
  };
  const stored: StoredMirrorPlan = { planId: view.planId, hash: data.hash, createdAt: (deps.now ?? Date.now)(), pairs, copy: data.copy, different: data.different, view };
  return { result: { ok: true, plan: view }, stored };
}
