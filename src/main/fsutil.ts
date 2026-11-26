import fs from 'node:fs';
import path from 'node:path';
import { ownRemove, ownRemoveAsync, ownReplace, ownReplaceAsync } from './danger/ownFiles';
import { LEGACY_CARD_FOLDER } from '../shared/appFolders';
import { cardFile, legacyCardFile } from './places/appFolders';

/**
 * Write a file so a crash never leaves a half-written one under the final name: write
 * `<file>.tmp`, then rename it into place. Only ever touches `file` and `file.tmp`.
 * (Callers that can target a drive call `assertWritable` first; this helper does not.)
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    ownReplace(tmp, file);
  } catch (err) {
    ownRemove(tmp);
    throw err;
  }
}

/** The same as `writeFileAtomic` without waiting for the drive on the window's thread (a drive's manifest, list or card file). */
export async function writeFileAtomicAsync(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await ownReplaceAsync(tmp, file);
  } catch (err) {
    await ownRemoveAsync(tmp);
    throw err;
  }
}

/** Parse JSON text that may start with a byte-order mark (PowerShell and Notepad write one). */
export function parseJsonLoose(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// ---- Write protection for drives -------------------------------------------------------------
//
// DRIVE WRITE PROTECTION (T7 ban 3 Nov 2026, lifted by the user 5 Nov 2026): a drive listed in the setting `writeProtectedDrives`
// (names or ids, default []) must never be written to by this app. EVERY code path that creates, changes,
// renames or deletes something that can be on a drive calls `assertWritable(absPath)` first.
// Reading, listing and hashing are not affected. The guard only READS the drive's ID card.

/** Shown wherever a write to a protected drive was refused or a button is disabled. */
export function protectedDriveMessage(name: string): string {
  return `${name} is read-only (protected), so nothing is written to it.`;
}

export class DriveWriteProtectedError extends Error {
  readonly driveName: string;
  constructor(driveName: string, detail?: string) {
    super(detail ?? protectedDriveMessage(driveName));
    this.name = 'DriveWriteProtectedError';
    this.driveName = driveName;
  }
}

export const DEFAULT_WRITE_PROTECTED_DRIVES: readonly string[] = [];

export interface VolumeFact {
  /** The Windows volume label, when known. */
  label: string | null;
  /** True for a drive that can be unplugged (USB, SD). */
  removable: boolean;
}

export interface WriteGuardConfig {
  /** The protected drive names or ids (the setting). May throw: then the default is used. */
  protectedDrives: () => readonly string[];
  /** What the volume list last said about a drive root such as "F:\\" (optional extra evidence). */
  volumeOf?: (root: string) => VolumeFact | null;
  /** Which drive root a path belongs to (default: the "X:\" of the path; null = not a lettered drive). Tests map temp folders to fake cards. */
  rootOf?: (absPath: string) => string | null;
  /** A card id that must not be written to (a drive-identity decision is open), with the plain sentence; null = fine. */
  identityBlock?: (cardId: string) => string | null;
  /** Drive root of the system disk (default %SystemDrive%\). */
  systemRoot?: string;
  now?: () => number;
}

let config: WriteGuardConfig = { protectedDrives: () => DEFAULT_WRITE_PROTECTED_DRIVES };
const CARD_CACHE_MS = 1500;
const LIST_CACHE_MS = 1000;
type CardFact = { kind: 'none' } | { kind: 'card'; id: string; name: string } | { kind: 'unreadable' };
const cardCache = new Map<string, { at: number; fact: CardFact }>();
/** Roots that were seen protected in this run, with the name that protected them (a flaky card read must not lift it). */
const sticky = new Map<string, string>();
let listCache: { at: number; list: string[] } | null = null;

export function configureWriteGuard(next: WriteGuardConfig): void {
  config = next;
  cardCache.clear();
  listCache = null;
}

/** Tests only: back to the defaults, empty caches. */
export function resetWriteGuardForTests(): void {
  config = { protectedDrives: () => DEFAULT_WRITE_PROTECTED_DRIVES };
  cardCache.clear();
  sticky.clear();
  listCache = null;
}

function nowMs(): number {
  return (config.now ?? Date.now)();
}

function protectedList(): string[] {
  const t = nowMs();
  if (listCache && t - listCache.at < LIST_CACHE_MS) return listCache.list;
  let list: string[];
  try {
    list = config.protectedDrives().map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  } catch {
    list = listCache?.list ?? DEFAULT_WRITE_PROTECTED_DRIVES.map((s) => s.toLowerCase()); // settings unreadable: keep the last list read
  }
  listCache = { at: t, list };
  return list;
}

function defaultRootOf(resolved: string): string | null {
  const root = path.parse(resolved).root;
  return /^[A-Za-z]:[\\/]$/.test(root) ? root : null;
}

/** Reads one card file: its fact, or 'missing' when it is not there. */
function readCardFile(file: string): CardFact | 'missing' {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = text.length > 16 * 1024 ? null : (parseJsonLoose(text) as Record<string, unknown> | null);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed['name'] === 'string') {
      return { kind: 'card', id: typeof parsed['id'] === 'string' ? parsed['id'].toLowerCase() : '', name: parsed['name'].trim() };
    }
    return { kind: 'unreadable' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : { kind: 'unreadable' };
  }
}

/**
 * The drive's card: the new place first, then the old place of a drive that has not been moved yet (read only). Cards at both places
 * that name different drives, or an unreadable card at the old place when the new place has none, count as unreadable (fail closed).
 */
function readCardFact(root: string): CardFact {
  const t = nowMs();
  const hit = cardCache.get(root);
  if (hit && t - hit.at < CARD_CACHE_MS) return hit.fact;
  const fresh = readCardFile(cardFile(root));
  const old = fresh === 'missing' || fresh.kind === 'card' ? readCardFile(legacyCardFile(root)) : 'missing';
  let fact: CardFact | 'missing';
  if (fresh === 'missing') fact = old;
  else if (fresh.kind === 'card' && old !== 'missing' && old.kind === 'card' && old.id !== fresh.id) fact = { kind: 'unreadable' };
  else fact = fresh;
  const result: CardFact = fact === 'missing' ? { kind: 'none' } : fact;
  cardCache.set(root, { at: t, fact: result });
  return result;
}

/**
 * Throws DriveWriteProtectedError when `absPath` is on a protected drive. The drive is found by
 * reading its card (read only), not by its letter. A drive letter with no card is allowed, unless
 * it was seen protected before or its volume label is a protected name. A card that cannot be
 * read fails closed for every drive except the system disk.
 */
export function assertWritable(absPath: string): void {
  const resolved = path.resolve(absPath);
  const root = config.rootOf ? config.rootOf(resolved) : defaultRootOf(resolved);
  if (root === null) return; // not a lettered drive (network share, ...): not one of ours
  // The old place of the ID card (the drive root) is read, never written: nothing is created, changed or removed there.
  if (path.relative(root, resolved).split(path.sep)[0]?.toLowerCase() === LEGACY_CARD_FOLDER.toLowerCase()) {
    throw new DriveWriteProtectedError(root.slice(0, 2), `Backup Hub only reads the old ID card place on ${root.slice(0, 2)} and never writes there.`);
  }
  const key = root.toUpperCase();
  const names = protectedList();
  const systemRoot = (config.systemRoot ?? `${process.env['SystemDrive'] ?? 'C:'}\\`).toUpperCase();
  const isSystem = key === systemRoot;
  const fact = readCardFact(root);
  if (fact.kind === 'card') {
    if (names.includes(fact.name.toLowerCase()) || (fact.id !== '' && names.includes(fact.id))) {
      sticky.set(key, fact.name);
      throw new DriveWriteProtectedError(fact.name);
    }
  }
  if (fact.kind === 'card' && fact.id !== '') {
    let why: string | null = null;
    try {
      why = config.identityBlock?.(fact.id) ?? null;
    } catch {
      why = null;
    }
    if (why !== null) throw new DriveWriteProtectedError(fact.name, why);
  }
  const stuck = sticky.get(key);
  if (stuck !== undefined && fact.kind !== 'card' && names.includes(stuck.toLowerCase())) throw new DriveWriteProtectedError(stuck);
  const volume = config.volumeOf?.(key) ?? null;
  if (volume?.label && names.includes(volume.label.trim().toLowerCase())) {
    sticky.set(key, volume.label.trim());
    throw new DriveWriteProtectedError(volume.label.trim());
  }
  if (fact.kind === 'unreadable' && !isSystem) {
    // Cannot tell which drive this is: fail closed (unless it is known to be a fixed disk).
    if (!(volume && !volume.removable)) {
      throw new DriveWriteProtectedError(
        key.slice(0, 2),
        `The drive ${key.slice(0, 2)} could not be identified (its ID card cannot be read), so nothing is written to it.`,
      );
    }
  }
}

/** Assert for several paths (a copy has a source-side read and a destination-side write; pass only the written ones). */
export function assertAllWritable(paths: readonly string[]): void {
  for (const p of paths) assertWritable(p);
}

/** Non-throwing form for planning and button state: the protected drive name, or null. */
export function protectedDriveFor(absPath: string): string | null {
  try {
    assertWritable(absPath);
    return null;
  } catch (err) {
    if (err instanceof DriveWriteProtectedError) return err.driveName;
    throw err;
  }
}
