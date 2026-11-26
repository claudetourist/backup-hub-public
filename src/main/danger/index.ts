/**
 * THE one guarded path for removing, moving away or overwriting a user's data (PLAN.md section 4 rule 3): delete, quarantine, set
 * aside, overwrite, `adb shell rm`, Drive trash and Drive delete. Nothing else in Backup Hub may do any of these (a static test
 * checks). Google's blanket "empty trash" call is not offered at all: only a confirmed list, file by file.
 *
 * What it demands, for every action that takes content away from where it was:
 *   1. the exact list the person confirmed: the list id and the hash of the list (`hashConfirmed`). The caller gives the whole
 *      confirmed list plus the items to act on now; every item must be on that list, unchanged, and the list must still hash to
 *      what was confirmed. A list that changed since the click refuses everything.
 *   2. proof: checksums of surviving copies, read FRESH by the proof functions (from the disk, the phone or Google at this moment,
 *      never from the index), at least `minSurvivors` different places, every one equal to the content hash of the item.
 *   3. a permanent row in `danger_log`, written before the action and updated after it. A refusal is logged too.
 * A damaged or replaced file in a backup root is never overwritten or deleted: it is moved aside to
 * the set-aside folder in the app's own files on the drive (`<date>\` below it). A move never replaces: it is a hard link that fails with EEXIST, then the old name goes.
 * Actions that take nothing away (put a quarantined file back, remove an empty folder) need the confirmed list but no proof.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection';
import { assertWritable } from '../fsutil';
import { removeCommand, type RemoveManyItem, type RemoveManyStatus } from './adbRm';
import { setAsideFolder } from '../places/appFolders';
import { ownPathProblem, ownRemoveAsync } from './ownFiles';

export { removeCommand };

export type DangerAction = 'delete-file' | 'quarantine' | 'put-back' | 'set-aside' | 'replace-damaged' | 'remove-empty-folder' | 'adb-rm' | 'drive-trash' | 'drive-delete';

/** Actions that take content away from where it was: they need proof. */
const NEEDS_PROOF: ReadonlySet<DangerAction> = new Set(['delete-file', 'quarantine', 'set-aside', 'replace-damaged', 'adb-rm', 'drive-trash', 'drive-delete']);

/** One surviving copy, read fresh when asked. Returns the checksum now, or null when the copy cannot be read. */
export interface Survivor {
  /** Where it is, for the log and the person ("T7:Phone/DCIM/a.jpg"). */
  where: string;
  /** The path or id, to make sure the survivor is not the very file being removed. */
  ref: string;
  readFresh(): Promise<string | null>;
}

/** What the person confirmed for one item (this is what the list hash covers). */
export interface ConfirmedEntry {
  id: string;
  action: DangerAction;
  /** A path, a phone path or a Drive file id. */
  target: string;
  /** The content checksum the survivors must show (lower-case hex). */
  contentHash?: string | null;
  /** The phone's serial (adb) or the Google account (Drive). */
  serial?: string | null;
}

export interface DangerItem extends ConfirmedEntry {
  /** Where the file goes: quarantine, the place it is put back to, or the replacement file for 'replace-damaged'. */
  to?: string;
  /** Required with 'quarantine' and 'put-back': the folder `to` must be inside. */
  toRoot?: string;
  /** Required with 'set-aside' and 'replace-damaged': the root of the drive the backup lives on. */
  driveRoot?: string;
  size?: number | null;
  survivors?: readonly Survivor[];
}

export interface DangerRequest {
  listId: string;
  /** The hash the person confirmed (`hashConfirmed` of the list as it was shown). */
  confirmedHash: string;
  confirmed: readonly ConfirmedEntry[];
  items: readonly DangerItem[];
  /** How many different surviving copies must show the content hash (default 1). */
  minSurvivors?: number;
}

export interface DangerEnv {
  db: Db;
  now?: () => number;
  signal?: AbortSignal;
  /** The phone transport; only this module calls it. */
  adbRemove?: (serial: string, remotePath: string, signal?: AbortSignal) => Promise<void>;
  /**
   * A batch version of `adbRemove`: when it is given, every 'adb-rm' item of a request is proved and logged as before, but the phone is told once for the
   * whole request (the items must carry their planned `size`). One answer per item, in order; a thrown error fails every item of the request.
   */
  adbRemoveMany?: (serial: string, items: readonly RemoveManyItem[], signal?: AbortSignal) => Promise<AdbRemoveManyAnswer[]>;
  /** The Google transport (trash puts a file in the bin; delete removes it for good); only this module calls them. */
  driveTrash?: (account: string, fileId: string) => Promise<void>;
  driveDelete?: (account: string, fileId: string) => Promise<void>;
}

export type AdbRemoveManyAnswer = { ok: true } | { ok: false; reason: string };
export type { RemoveManyItem, RemoveManyStatus };

export type DangerOutcome = 'done' | 'refused' | 'failed';
export interface DangerResult {
  id: string;
  outcome: DangerOutcome;
  /** Plain words. */
  reason?: string;
  /** For set-aside and replace-damaged: where the old file went. */
  movedTo?: string;
}

export class DangerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DangerRefused';
  }
}

/** The hash of a confirmed list: independent of the order of the entries. */
export function hashConfirmed(entries: readonly ConfirmedEntry[]): string {
  const rows = entries.map((e) => [e.id, e.action, e.target, e.contentHash ?? null, e.serial ?? null]).toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Moves a file to a new name, never replacing and never copying: a hard link (fails with EEXIST), then the old name goes. */
export async function moveNoReplace(from: string, to: string): Promise<void> {
  try {
    await fs.promises.link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    throw Object.assign(new Error('This drive cannot move a file safely (no hard links), so nothing was moved.'), { code: 'ENOTSUP' });
  }
  try {
    await fs.promises.unlink(from);
  } catch (err) {
    // The name could not be removed: undo the new name so the file is where it was, once.
    await fs.promises.rm(to, { force: true });
    throw err;
  }
}

const existsAsync = async (p: string): Promise<boolean> => {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
};

const pad = (n: number): string => String(n).padStart(2, '0');
const dateFolder = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** `<set-aside folder>\<date>\<path below the drive root>`, with a number added when the name is taken. */
export async function setAsidePathFor(driveRoot: string, file: string, nowMs: number, exists: (p: string) => boolean | Promise<boolean> = existsAsync): Promise<string> {
  const root = path.resolve(driveRoot);
  const rel = path.relative(root, path.resolve(file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new DangerRefused('That file is not inside the drive.');
  const base = path.join(setAsideFolder(root), dateFolder(nowMs), rel);
  if (!(await exists(base))) return base;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base}.${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new DangerRefused('No free name was found in the set-aside folder.');
}

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

interface ProofRow {
  where: string;
  hash: string | null;
}

async function proofFor(item: DangerItem, min: number): Promise<{ ok: true; rows: ProofRow[] } | { ok: false; reason: string; rows: ProofRow[] }> {
  const hash = typeof item.contentHash === 'string' ? item.contentHash.toLowerCase() : '';
  if (!/^[0-9a-f]{32}$|^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'There is no checksum to prove against.', rows: [] };
  const rows: ProofRow[] = [];
  const seen = new Set<string>();
  let matching = 0;
  for (const s of item.survivors ?? []) {
    if (s.ref === item.target || seen.has(s.ref)) continue; // the file itself is no proof of itself; one place counts once
    seen.add(s.ref);
    let fresh: string | null;
    try {
      fresh = await s.readFresh();
    } catch {
      fresh = null;
    }
    rows.push({ where: s.where, hash: fresh });
    if (fresh !== null && fresh.toLowerCase() === hash) matching += 1;
  }
  if (matching < min) return { ok: false, reason: `Only ${matching} of the ${min} required surviving copies could be read now and matched the checksum.`, rows };
  return { ok: true, rows };
}

function logRow(env: DangerEnv, req: DangerRequest, item: DangerItem, rows: ProofRow[], outcome: string, detail: string | null): number {
  const r = env.db
    .prepare('INSERT INTO danger_log (at, list_id, list_hash, item_id, action, target, to_path, size, content_hash, proof_json, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run((env.now ?? Date.now)(), req.listId, req.confirmedHash, item.id, item.action, item.target, item.to ?? null, item.size ?? null, item.contentHash ?? null, JSON.stringify(rows), outcome, detail);
  return Number(r.lastInsertRowid);
}

function setOutcome(env: DangerEnv, id: number, outcome: string, detail: string | null): void {
  env.db.prepare('UPDATE danger_log SET outcome = ?, detail = ? WHERE id = ?').run(outcome, detail, id);
}

const message = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'unknown error');

/**
 * Acts on `req.items`, one after another. Throws DangerRefused when the confirmed list is not the one that was confirmed (nothing is
 * logged per item then); otherwise returns one result per item. An item with missing or failed proof is refused and left alone.
 */
export async function runDanger(env: DangerEnv, req: DangerRequest): Promise<DangerResult[]> {
  if (typeof req.listId !== 'string' || req.listId === '' || typeof req.confirmedHash !== 'string' || req.confirmedHash === '') throw new DangerRefused('There is no confirmed list, so nothing was changed.');
  if (!Array.isArray(req.confirmed) || hashConfirmed(req.confirmed) !== req.confirmedHash) throw new DangerRefused('The list is not the one that was confirmed, so nothing was changed.');
  if (new Set(req.confirmed.map((e) => e.id)).size !== req.confirmed.length) throw new DangerRefused('The confirmed list has the same item twice, so nothing was changed.');
  const min = Math.max(1, req.minSurvivors ?? 1);
  const results: DangerResult[] = [];
  /** The phone removals that passed their proof and wait for the one batch call: [result index, danger_log id, item]. */
  const deferred: { at: number; logId: number; item: DangerItem }[] = [];
  for (const item of req.items) {
    const refuse = (reason: string, rows: ProofRow[] = []): void => {
      logRow(env, req, item, rows, 'refused', reason);
      results.push({ id: item.id, outcome: 'refused', reason });
    };
    const entry = req.confirmed.find((e) => e.id === item.id);
    if (!entry || entry.action !== item.action || entry.target !== item.target || (entry.contentHash ?? null) !== (item.contentHash ?? null) || (entry.serial ?? null) !== (item.serial ?? null)) {
      refuse('It is not on the confirmed list as it is now.');
      continue;
    }
    let rows: ProofRow[] = [];
    if (NEEDS_PROOF.has(item.action)) {
      const proof = await proofFor(item, min);
      rows = proof.rows;
      if (!proof.ok) {
        refuse(proof.reason, rows);
        continue;
      }
    }
    const id = logRow(env, req, item, rows, 'started', null);
    if (item.action === 'adb-rm' && env.adbRemoveMany) {
      try {
        if (typeof item.serial !== 'string') throw new DangerRefused('The phone is not known.');
        removeCommand(item.target); // refuses an unsafe path before anything is sent
        if (!Number.isSafeInteger(item.size) || (item.size ?? 0) <= 0) throw new DangerRefused('The planned size is not known.');
        deferred.push({ at: results.length, logId: id, item });
        results.push({ id: item.id, outcome: 'failed', reason: 'not run' });
      } catch (err) {
        setOutcome(env, id, 'failed', message(err));
        results.push({ id: item.id, outcome: 'failed', reason: message(err) });
      }
      continue;
    }
    try {
      const movedTo = await perform(env, item);
      setOutcome(env, id, 'done', movedTo ?? null);
      results.push({ id: item.id, outcome: 'done', ...(movedTo === undefined ? {} : { movedTo }) });
    } catch (err) {
      setOutcome(env, id, 'failed', message(err));
      results.push({ id: item.id, outcome: 'failed', reason: message(err) });
    }
  }
  await removeDeferred(env, deferred, results);
  return results;
}

/** The phone removals of one request, one call per phone. A stop (the signal) before the call removes nothing; every item gets its own answer. */
async function removeDeferred(env: DangerEnv, deferred: readonly { at: number; logId: number; item: DangerItem }[], results: DangerResult[]): Promise<void> {
  const serials = [...new Set(deferred.map((d) => d.item.serial as string))];
  for (const serial of serials) {
    const group = deferred.filter((d) => d.item.serial === serial);
    let answers: AdbRemoveManyAnswer[];
    try {
      if (env.signal?.aborted) throw new Error('The clean-up was stopped before the phone was asked, so nothing was removed.');
      answers = await env.adbRemoveMany!(serial, group.map((d) => ({ path: d.item.target, size: d.item.size as number })), env.signal);
      if (answers.length !== group.length) throw new Error('The phone did not answer for every file.');
    } catch (err) {
      answers = group.map(() => ({ ok: false as const, reason: message(err) }));
    }
    group.forEach((d, i) => {
      const a = answers[i]!;
      if (a.ok) {
        setOutcome(env, d.logId, 'done', null);
        results[d.at] = { id: d.item.id, outcome: 'done' };
      } else {
        setOutcome(env, d.logId, 'failed', a.reason);
        results[d.at] = { id: d.item.id, outcome: 'failed', reason: a.reason };
      }
    });
  }
}

async function perform(env: DangerEnv, item: DangerItem): Promise<string | undefined> {
  const nowMs = (env.now ?? Date.now)();
  switch (item.action) {
    case 'delete-file': {
      assertWritable(item.target);
      const st = await fs.promises.lstat(item.target);
      if (!st.isFile()) throw new DangerRefused('It is not a plain file.');
      await fs.promises.unlink(item.target);
      return undefined;
    }
    case 'remove-empty-folder': {
      assertWritable(item.target);
      await fs.promises.rmdir(item.target);
      return undefined;
    }
    case 'quarantine':
    case 'put-back': {
      if (item.to === undefined || item.toRoot === undefined || !inside(item.toRoot, item.to)) throw new DangerRefused('The place to move it to is not valid.');
      assertWritable(item.target);
      assertWritable(item.to);
      if (!(await fs.promises.lstat(item.target)).isFile()) throw new DangerRefused('It is not a plain file.');
      await fs.promises.mkdir(path.dirname(item.to), { recursive: true });
      await moveNoReplace(item.target, item.to);
      return item.to;
    }
    case 'set-aside': {
      if (item.driveRoot === undefined) throw new DangerRefused('The drive is not known.');
      const aside = await setAsidePathFor(item.driveRoot, item.target, nowMs);
      assertWritable(item.target);
      assertWritable(aside);
      await fs.promises.mkdir(path.dirname(aside), { recursive: true });
      await moveNoReplace(item.target, aside);
      return aside;
    }
    case 'replace-damaged': {
      if (item.driveRoot === undefined || item.to === undefined) throw new DangerRefused('The drive or the replacement is not known.');
      if (ownPathProblem(item.to) !== null) throw new DangerRefused('The replacement must be a temp file of Backup Hub (in its own temp folder).');
      const aside = await setAsidePathFor(item.driveRoot, item.target, nowMs);
      assertWritable(item.target);
      assertWritable(aside);
      await fs.promises.mkdir(path.dirname(aside), { recursive: true });
      await moveNoReplace(item.target, aside);
      try {
        await fs.promises.link(item.to, item.target); // never replaces: the damaged file was moved aside first
      } catch (err) {
        await moveNoReplace(aside, item.target); // put the old one back where it was
        throw err;
      }
      await ownRemoveAsync(item.to, { quiet: true });
      return aside;
    }
    case 'adb-rm': {
      if (!env.adbRemove) throw new DangerRefused('No phone connection was given.');
      if (typeof item.serial !== 'string') throw new DangerRefused('The phone is not known.');
      removeCommand(item.target); // refuses an unsafe path before anything is sent
      await env.adbRemove(item.serial, item.target, env.signal);
      return undefined;
    }
    case 'drive-trash': {
      if (!env.driveTrash || typeof item.serial !== 'string') throw new DangerRefused('No Google connection was given.');
      await env.driveTrash(item.serial, item.target);
      return undefined;
    }
    case 'drive-delete': {
      if (!env.driveDelete || typeof item.serial !== 'string') throw new DangerRefused('No Google connection was given.');
      await env.driveDelete(item.serial, item.target);
      return undefined;
    }
  }
}
