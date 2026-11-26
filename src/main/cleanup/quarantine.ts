/**
 * The quarantine of laptop duplicates: moving a file in (see laptopCleanJob), putting it back (Undo) and, only after 30 days and
 * only when the person confirms the exact count and size, emptying a day's batch. Nothing here ever runs by itself.
 * Every path used here is checked to be inside the quarantine folder of the drive (see `shared/appFolders.ts`; files that an earlier
 * version moved to the old quarantine folder can still be put back or emptied) or the root the tests pass in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { plural, type EmptyQuarantineResult, type UndoResult } from '../../shared/cleanup';
import { hashConfirmed, runDanger, type ConfirmedEntry, type DangerItem, type Survivor } from '../danger';
import { absolutePathFor } from '../hashing/paths';
import { sha256OfFile } from './hashLocal';
import type { CleanStore } from './cleanStore';
import { canEmptyEntry, canUndoEntry, quarantineDate, quarantineRootFor } from './safety';

export interface QuarantineDeps {
  /** The quarantine folder for a laptop path (see `quarantineRootFor`). Tests pass a temporary folder. */
  rootFor?: (abs: string) => string | null;
  now?: () => number;
}

const NOT_DONE_UNDO = 'Nothing was moved.';

/** "D:/Photos/a.jpg" as Windows writes it. */
export const toWindowsPath = (abs: string): string => path.win32.normalize(abs.replaceAll('/', '\\'));

/** Moves a quarantined file back to where it came from. Never overwrites: a file already at the old place stops it. */
export async function undoLaptopRemoval(deps: QuarantineDeps, store: CleanStore, removalId: number): Promise<UndoResult> {
  const entry = store.removal(removalId);
  if (!entry || entry.kind !== 'laptop') return { ok: false, message: `That is not a file moved to the quarantine. ${NOT_DONE_UNDO}` };
  const original = toWindowsPath(entry.path);
  const root = (deps.rootFor ?? quarantineRootFor)(entry.path);
  if (!canUndoEntry(entry, root)) return { ok: false, message: `It is not waiting in the quarantine any more. ${NOT_DONE_UNDO}` };
  const quarantined = toWindowsPath(entry.quarantinePath!);
  let st: fs.Stats;
  try {
    st = fs.statSync(quarantined);
  } catch {
    return { ok: false, message: `The file is not in the quarantine folder any more. ${NOT_DONE_UNDO}` };
  }
  if (!st.isFile() || st.size !== entry.size) return { ok: false, message: `The file in the quarantine has another size than when it was moved, so it was left alone. ${NOT_DONE_UNDO}` };
  if (fs.existsSync(original)) return { ok: false, message: `Another file is already at ${entry.path}. Nothing was overwritten. ${NOT_DONE_UNDO}` };
  // Putting a file back takes nothing away, so it needs no proof; it still goes through the guarded path (never replaces, logged).
  const entryRow: ConfirmedEntry = { id: String(removalId), action: 'put-back', target: quarantined };
  const moved = (await runDanger({ db: store.db, ...(deps.now ? { now: deps.now } : {}) }, { listId: `undo-${removalId}`, confirmedHash: hashConfirmed([entryRow]), confirmed: [entryRow], items: [{ ...entryRow, to: original, toRoot: path.parse(original).root }] }))[0];
  if (moved?.outcome !== 'done') return { ok: false, message: `It could not be put back (${moved?.reason?.slice(0, 100) ?? 'unknown error'}). ${NOT_DONE_UNDO}` };
  store.markUndone(removalId);
  if (entry.placeId !== null) store.setGone(entry.placeId, entry.path, false);
  return { ok: true, message: `Put back at ${entry.path}.` };
}

/** Removes empty folders from `dir` up to (not including) `root`. Never touches a folder that still holds anything (the removal of a non-empty folder fails). */
async function pruneEmpty(env: { db: CleanStore['db']; now?: () => number }, dir: string, root: string): Promise<void> {
  let current = dir;
  const stop = path.win32.normalize(root).toLowerCase();
  while (path.win32.normalize(current).toLowerCase() !== stop && path.win32.normalize(current).toLowerCase().startsWith(`${stop}\\`)) {
    const entry: ConfirmedEntry = { id: current, action: 'remove-empty-folder', target: current };
    const r = (await runDanger(env, { listId: `empty-folders-${stop}`, confirmedHash: hashConfirmed([entry]), confirmed: [entry], items: [entry] }))[0];
    if (r?.outcome !== 'done') return;
    current = path.dirname(current);
  }
}

/**
 * Deletes for good the files of one day's quarantine batch. Only after 30 days, only files that still sit inside the quarantine
 * with the size they had when they were moved, and only when `expectCount` and `expectBytes` equal what is about to go.
 */
export async function emptyQuarantine(deps: QuarantineDeps, store: CleanStore, date: string, expectCount: number, expectBytes: number): Promise<EmptyQuarantineResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'That is not a quarantine day. Nothing was emptied.' };
  const now = (deps.now ?? Date.now)();
  const entries = store.waitingOnDate(date).filter((e) => quarantineDate(e.removedAt) === date);
  if (entries.length === 0) return { ok: false, message: 'There is nothing waiting for that day. Nothing was emptied.' };
  const eligible = entries.filter((e) => canEmptyEntry(e, (deps.rootFor ?? quarantineRootFor)(e.path), now).ok);
  if (eligible.length !== entries.length) return { ok: false, message: 'Some of these files have not waited 30 days yet, so Backup Hub does not ask. Nothing was emptied.' };
  const bytes = eligible.reduce((s, e) => s + e.size, 0);
  if (expectCount !== eligible.length || expectBytes !== bytes) return { ok: false, message: 'What is waiting is not what was confirmed. Look at the list again. Nothing was emptied.' };
  // The list the person confirmed (count and size), as the guarded path wants it: one entry per file, hashed.
  const confirmed: ConfirmedEntry[] = eligible.map((e) => ({ id: String(e.id), action: 'delete-file', target: toWindowsPath(e.quarantinePath!), contentHash: e.sha256 }));
  const confirmedHash = hashConfirmed(confirmed);
  const env = { db: store.db, ...(deps.now ? { now: deps.now } : {}) };
  let gone = 0;
  let goneBytes = 0;
  let kept = 0;
  for (const e of eligible) {
    const q = toWindowsPath(e.quarantinePath!);
    try {
      const st = fs.statSync(q);
      if (!st.isFile() || st.size !== e.size) {
        kept += 1;
        continue;
      }
      // Proof, read now: a kept copy on this laptop (the voucher of the move) still has the checksum of the file.
      const survivors: Survivor[] = e.vouchers
        .filter((v) => v.placeKind === 'laptop')
        .flatMap((v) => {
          const abs = absolutePathFor('laptop', '', v.relPath);
          return abs === null ? [] : [{ where: v.relPath, ref: abs, readFresh: () => sha256OfFile(abs).catch(() => null) }];
        });
      const item: DangerItem = { ...confirmed.find((c) => c.id === String(e.id))!, size: e.size, survivors };
      const result = (await runDanger(env, { listId: `empty-quarantine-${date}`, confirmedHash, confirmed, items: [item] }))[0];
      if (result?.outcome !== 'done') {
        kept += 1;
        continue;
      }
      store.markEmptied(e.id);
      gone += 1;
      goneBytes += e.size;
      const root = (deps.rootFor ?? quarantineRootFor)(e.path);
      if (root !== null) await pruneEmpty(env, path.dirname(q), root);
    } catch {
      kept += 1;
    }
  }
  const text = `Emptied ${plural(gone, 'file')} (${goneBytes >= 1e9 ? `${(goneBytes / 1e9).toFixed(1)} GB` : `${Math.round(goneBytes / 1e6)} MB`}) from the quarantine.`;
  return gone === 0 ? { ok: false, message: `Nothing could be emptied: ${plural(kept, 'file')} changed or are missing, so they were left alone.` } : { ok: true, message: kept > 0 ? `${text} ${plural(kept, 'file')} changed or were missing and were left alone.` : text };
}
