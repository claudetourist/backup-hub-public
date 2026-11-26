import { CARD_FOLDER } from '../../../shared/appFolders';
import { FOLDERS, type World } from './world.testutil';

/**
 * The invariants of PLAN.md section 3c, as reusable checks over a World. Each returns a list of violations (empty = holds). Invariant 6
 * (a rename or move causes no recopy) is R1.6's: it is checked for folder backups (folderMoves.test.ts); the phone's inodes are not trusted yet.
 */
export type Violations = string[];

/**
 * 1. Every piece of content that was ever backed up still exists on every destination it was copied to (nothing here is ever removed
 *    through danger/, so nothing may disappear).
 */
export function invariant1(w: World): Violations {
  const out: Violations = [];
  for (const c of w.copyLog) {
    const now = w.drives[c.drive]!.durableSha(c.path);
    if (now === null) out.push(`1: ${c.path} (drive ${c.drive + 1}) is no longer on the drive`);
    else if (now !== c.sha256) out.push(`1: ${c.path} (drive ${c.drive + 1}) holds other content than was verified`);
  }
  return out;
}

/**
 * 2. No file at a final name was ever overwritten or left half-written: no write ever replaced a final name; every file at a final name
 *    (on the drive, and in the system's memory) holds a complete content the phone really had.
 */
export function invariant2(w: World): Violations {
  const out: Violations = [];
  for (const d of w.drives) {
    for (const p of d.overwrites) out.push(`2: a write replaced the file at the final name ${p} on ${d.name}`);
    for (const f of d.onDrive()) {
      if (f.path.startsWith(`${CARD_FOLDER}/`)) continue; // the app's own files: temp names and the lists of runs
      if (!w.everContent.has(f.sha256)) out.push(`2: ${f.path} on ${d.name} holds content the phone never had (torn or invented)`);
    }
  }
  const seen = new Map<string, number>();
  for (const c of w.copyLog) seen.set(`${c.drive}|${c.path.toLowerCase()}`, (seen.get(`${c.drive}|${c.path.toLowerCase()}`) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) out.push(`2: ${k} was written ${n} times`);
  return out;
}

export interface IndexSnapshot {
  rows: string;
}

/** The phone's rows, as one comparable text (for "an incomplete look changes nothing"). */
export function snapshotIndex(w: World): IndexSnapshot {
  return { rows: JSON.stringify(w.phoneRows()) };
}

/**
 * 3. After "look", the index says exactly what is on the devices. After a look that did not finish or was doubtful, it says exactly what
 *    it said before. `unreadable` are the folders the phone refused (and the filters drop): not part of the claim.
 */
export function invariant3(w: World, before: IndexSnapshot, report: { outcome: { ok: boolean }; look: { unreadable: string[] } }): Violations {
  if (!report.outcome.ok) {
    return snapshotIndex(w).rows === before.rows ? [] : ['3: a look that was not accepted changed the index'];
  }
  const out: Violations = [];
  const blind = report.look.unreadable.map((p) => `${p.replace(/^\//, '')}/`);
  const hidden = (rel: string): boolean => blind.some((p) => rel.startsWith(p));
  const inScope = (rel: string): boolean => FOLDERS.some((f) => rel.startsWith(`${f.replace(/^\//, '')}/`));
  const phone = new Map(w.phoneNow().filter((f) => inScope(f.rel) && !hidden(f.rel)).map((f) => [f.rel, f]));
  const live = w.phoneRows().filter((r) => r.gone_at === null && inScope(r.rel_path) && !hidden(r.rel_path));
  const liveKeys = new Set(live.map((r) => r.rel_path));
  for (const r of live) {
    const f = phone.get(r.rel_path);
    if (!f) out.push(`3: the index has ${r.rel_path} but the phone does not`);
    else if (!w.judgeSame(r, f)) out.push(`3: the index row of ${r.rel_path} differs from the phone (size ${r.size} vs ${f.size})`);
  }
  for (const rel of phone.keys()) if (!liveKeys.has(rel)) out.push(`3: the phone has ${rel} but the index has no live row for it`);
  for (const r of w.phoneRows()) if (r.gone_at !== null && r.gone_reason === null) out.push(`3: ${r.rel_path} is marked gone without a reason`);
  return out;
}

/** 4. A second run right after a finished run copies nothing (and changes nothing in the index). */
export function invariant4(first: { copied: number }, second: { copied: number; report: { recorded: { added: number; changed: number; cameBack: number; markedGone: number } | null } }): Violations {
  const out: Violations = [];
  if (second.copied !== 0) out.push(`4: the second run copied ${second.copied} file(s) (the first copied ${first.copied})`);
  const r = second.report.recorded;
  if (r && r.added + r.changed + r.cameBack + r.markedGone > 0) out.push(`4: the second look still found changes: ${JSON.stringify(r)}`);
  return out;
}

/**
 * 5. Nothing left the phone without the required verified copies existing at that moment: every removal carries one proof per
 *    destination and each proof is the same content as the removed file (read from the drive at that moment).
 */
export function invariant5(w: World): Violations {
  const out: Violations = [];
  for (const r of w.removals) {
    if (r.proofs.length !== w.destinations.length) out.push(`5: ${r.path} left the phone with ${r.proofs.length} of ${w.destinations.length} copies proven`);
    for (const p of r.proofs) {
      if (p.sha256 !== r.sha256) out.push(`5: ${r.path}: the copy on drive ${p.drive + 1} is not the same content`);
      if (w.drives[p.drive]!.durableSha(p.path) !== r.sha256) out.push(`5: ${r.path}: the copy on drive ${p.drive + 1} is not on the drive`);
    }
  }
  return out;
}

/**
 * 6. A rename or move at the source caused no recopy of unchanged content, and lost no path history. `read` is every file the backup read from the folder,
 *    `mustRead` the files whose content is new or edited since they were last backed up (the only ones that may be read), `lostPaths` the paths a renamed
 *    file had at the last look that its history no longer holds.
 */
export function invariant6(o: { read: readonly string[]; mustRead: readonly string[]; lostPaths: readonly string[] }): Violations {
  const out: Violations = [];
  const must = new Set(o.mustRead);
  const read = new Set(o.read);
  for (const p of o.read) if (!must.has(p)) out.push(`6: ${p} was read (copied again) although its content was already backed up and only its name or place changed`);
  for (const p of o.mustRead) if (!read.has(p)) out.push(`6: ${p} is new or edited but was not copied`);
  for (const p of o.lostPaths) out.push(`6: the old path ${p} is missing from the path history of a renamed file`);
  return out;
}

export function checkAll(w: World): Violations {
  return [...invariant1(w), ...invariant2(w), ...invariant5(w)];
}

