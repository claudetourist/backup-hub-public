/**
 * The list of "Check old copies" (R1.3b), made from the file list alone: no drive is read. The files of a backup that are on the second drive with the same
 * size and not proven yet, photos and videos first, then documents, then the rest (each in path order, which is also the order on the disk), with how many
 * need one read (the first drive's checksum is known) and how many two, and a rough time. Written as steps (sliceWork.ts): sliced on the main thread.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { STEP_ITEMS, sortSteps, type Steps } from '../sliceWork';
import { MIRROR_CHECK_GROUPS, checkGroupOf, estimateCheckSeconds, type MirrorCheckPlanView } from '../../shared/mirrorCheck';
import { checkScanSteps } from './mirrorScan';
import type { MirrorItem, MirrorPair, StoredCheckPlan } from './mirrorTypes';

const RANK: Record<string, number> = { photos: 0, documents: 1, other: 2 };
const gi = (i: MirrorItem): number => RANK[i.group!]!;
const order = (a: MirrorItem, b: MirrorItem): number => gi(a) - gi(b) || a.b - b.b || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

export function* checkPlanSteps(db: Db, pairs: readonly MirrorPair[], now: number): Steps<StoredCheckPlan> {
  const items: MirrorItem[] = [];
  let proven = 0;
  let knownProblems = 0;
  for (const [b, pair] of pairs.entries()) {
    const scan = yield* checkScanSteps(db, pair, b);
    for (const i of scan.items) {
      i.group = checkGroupOf(i.rel);
      items.push(i);
    }
    proven += scan.proven;
    knownProblems += scan.knownProblems;
    yield;
  }
  yield* sortSteps(items, order);
  const sha = createHash('sha256');
  const groups = MIRROR_CHECK_GROUPS.map((group) => ({ group, files: 0, bytes: 0 }));
  const one = { files: 0, bytes: 0 };
  const two = { files: 0, bytes: 0 };
  const per = pairs.map(() => ({ files: 0, bytes: 0 }));
  let n = 0;
  for (const i of items) {
    sha.update(`${i.b}|${i.rel}|${i.size}\n`);
    const g = groups[gi(i)]!;
    g.files += 1;
    g.bytes += i.size;
    const k = i.sha256 !== null ? one : two;
    k.files += 1;
    k.bytes += i.size;
    per[i.b]!.files += 1;
    per[i.b]!.bytes += i.size;
    if (++n % STEP_ITEMS === 0) yield;
  }
  const totals = { files: items.length, bytes: one.bytes + two.bytes };
  const notes: string[] = [];
  if (proven > 0) notes.push(`${proven.toLocaleString('en-US')} files on the second drive were proven earlier. They are not read again.`);
  if (knownProblems > 0) notes.push(`${knownProblems.toLocaleString('en-US')} files were already asked about (a damaged copy or a different file). They are not checked again.`);
  const view: MirrorCheckPlanView = {
    planId: randomUUID(),
    hash: sha.digest('hex'),
    backups: pairs.map((p, b) => ({ backupId: p.backupId, backupName: p.backupName, sourceLabel: p.srcLabel, targetLabel: p.dstLabel, files: per[b]!.files, bytes: per[b]!.bytes })),
    totals,
    groups: groups.filter((g) => g.files > 0),
    oneRead: one,
    twoReads: two,
    alreadyChecked: proven,
    estimateSeconds: estimateCheckSeconds(totals, two),
    notes,
  };
  return { planId: view.planId, hash: view.hash, createdAt: now, pairs: [...pairs], items, view };
}
