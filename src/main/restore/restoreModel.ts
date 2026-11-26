/**
 * Get files back: the plain rules, with no disk and no database. Where a restore may write, what the new folder is called, which copies may come back.
 */
import path from 'node:path';
import { isInsideAppOwnFiles } from '../../shared/appFolders';
import { HELD_WORDS, REASON_WORDS } from '../../shared/restore';

/** A drive's MyData folder (F:, G:, D:, any letter): the backups and the protected source live there. Nothing is ever restored into it. */
const MY_DATA_AT_ROOT = /^[A-Za-z]:[\\/]+MyData(?:[\\/]|$)/i;

/** Why a restore must not write at `target`, or null when it may. Pure: the path is only looked at as text. */
export function protectedReason(target: string): string | null {
  if (typeof target !== 'string' || target.trim() === '' || target.includes('\0')) return 'That folder is not valid.';
  if (!path.isAbsolute(target)) return 'Choose a folder on this computer.';
  const abs = path.resolve(target);
  if (!/^[A-Za-z]:/.test(abs)) return 'Choose a folder on this computer.';
  if (MY_DATA_AT_ROOT.test(abs)) return `${abs.slice(0, 2)}\\MyData is protected: Backup Hub never writes there. Choose another folder.`;
  if (isInsideAppOwnFiles(abs)) return 'That folder belongs to Backup Hub itself. Choose another folder.';
  return null;
}

const NOT_IN_A_NAME = new Set('<>:"/\\|?*');
const isControl = (c: string): boolean => c.charCodeAt(0) < 32;

/** A name as a folder name: characters Windows cannot keep become "-", no dots or spaces at the end. */
export const cleanName = (name: string): string =>
  Array.from(name, (c) => (NOT_IN_A_NAME.has(c) || isControl(c) ? '-' : c))
    .join('')
    .replace(/[. ]+$/, '')
    .trim();

/** "Poco-F4" and a day: the folder a restore goes into. */
export function restoreFolderName(backupName: string, now: number): string {
  const clean = cleanName(backupName);
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${clean === '' ? 'Backup' : clean}-${day}`;
}

/** The name with " (2)", " (3)" ...: "Poco-2026-11-25" -> "Poco-2026-11-25 (2)". */
export function numberedName(name: string, n: number): string {
  return n <= 1 ? name : `${name} (${n})`;
}

/** A file name with " (2)" before its extension: "a.jpg" -> "a (2).jpg". */
export function numberedFile(fileName: string, n: number): string {
  if (n <= 1) return fileName;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`;
}

/** The parts of a path below a folder, or null when any part could leave it (".." and friends) or is not a usable name. */
export function safeParts(rel: string): string[] | null {
  if (rel === '' || rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes(':') || Array.from(p).some((c) => '<>"|?*'.includes(c) || isControl(c))) return null;
  }
  return parts;
}

export interface CopyFacts {
  size: number | null;
  sha256: string | null;
  expected: string | null;
  verifiedHow: string | null;
}

/** The checksum a copy must have when it is read: the one Backup Hub read from it, else the one it must have. */
export const knownSha = (f: Pick<CopyFacts, 'sha256' | 'expected'>): string | null => f.sha256 ?? f.expected;

/** Only a copy with a known checksum that was not found different may come back; otherwise the reason it is held back. */
export function heldReason(f: CopyFacts): 'no_checksum' | 'differs' | null {
  if (f.verifiedHow === 'differs') return 'differs';
  if (knownSha(f) === null) return 'no_checksum';
  return null;
}

export const heldText = (why: keyof typeof HELD_WORDS): string => HELD_WORDS[why];

/** "1,204 files" / "1 file" */
export const filesText = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`;

/** "3.2 GB" / "850 MB" / "12 KB" */
export function bytesText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6).toLocaleString('en-US')} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString('en-US')} KB`;
  return `${n} bytes`;
}

/** The plugged-in drives, the T7 first, then the others in the backup's own order. */
export function preferredSources<T extends { label: string; position: number }>(sources: readonly T[]): T[] {
  const t7 = (s: T): number => (/^t7\b/i.test(s.label.trim()) ? 0 : 1);
  return sources.toSorted((a, b) => t7(a) - t7(b) || a.position - b.position);
}

/** What no copy can be reached for: the one sentence. */
export const NO_COPY_WORDS = 'No copy can be reached now: the drive is not plugged in and Google does not have it.';

/** "2 never checked, 1 no copy to reach now" for the report; empty when nothing was held back. */
export function reasonsText(counts: Readonly<Record<keyof typeof REASON_WORDS, number>>): string {
  return (Object.keys(REASON_WORDS) as (keyof typeof REASON_WORDS)[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k].toLocaleString('en-US')} ${REASON_WORDS[k]}`)
    .join(', ');
}
