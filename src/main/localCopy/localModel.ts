/**
 * Pure rules for "Back up now" to a drive: where a file lands on the drive, the hash that ties a confirmed plan to the
 * plan main computed, and the wording of the report. No database, no files.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BACKUPS_PARTS } from '../../shared/appFolders';
import type { LocalCopyPlan, LocalReport } from '../../shared/localCopy';

const BACKSLASH = String.fromCharCode(92);
const INVALID = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/** One folder or file name that Windows accepts: no control characters or `<>:"/\|?*`, no trailing dot or space, no reserved name. */
export function cleanSegment(s: string): string {
  const kept = s
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || INVALID.has(ch) ? '_' : ch))
    .join('')
    .replace(/[. ]+$/, '')
    .trim();
  if (kept === '' || kept === '.' || kept === '..') return '_';
  return RESERVED.has(kept.split('.')[0]!.toUpperCase()) ? `_${kept}` : kept;
}

export interface LocalDestination {
  /** Folder names from the drive root: the app's backups folder, the collection, then the folders below the collection root. */
  folders: string[];
  name: string;
}

/** `<the app's backups folder>/<collection name>/<path below the collection root>`. */
export function localDestinationFor(collectionName: string, below: string): LocalDestination {
  const parts = below.split('/').filter((p) => p !== '' && p !== '.' && p !== '..');
  const name = cleanSegment(parts.pop() ?? 'file');
  return { folders: [...BACKUPS_PARTS, cleanSegment(collectionName), ...parts.map(cleanSegment)], name };
}

/** Two different files must not land on one path: a later one gets the start of its MD5 in the name. */
export function taggedName(name: string, md5: string): string {
  const dot = name.lastIndexOf('.');
  const tag = md5.slice(0, 8);
  return dot > 0 ? `${name.slice(0, dot)} (${tag})${name.slice(dot)}` : `${name} (${tag})`;
}

/** SHA-256 over everything the job will do. Time and id are left out. */
export function hashLocalPlan(plan: Pick<LocalCopyPlan, 'collectionId' | 'targetPlaceId' | 'files'> & { targetFolder?: string }): string {
  const body = JSON.stringify({
    c: plan.collectionId,
    t: plan.targetPlaceId,
    ...(plan.targetFolder ? { d: plan.targetFolder } : {}),
    f: plan.files.map((f) => [f.index, f.name, f.folder, f.sourcePlaceId, f.sourceRel, f.size, f.mtime, f.md5]),
  });
  return createHash('sha256').update(body).digest('hex');
}

export const newLocalPlanId = (): string => randomUUID();

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The one-line report stored on the job. */
export function reportLine(r: LocalReport, targetLabel: string, formatBytes: (n: number) => string): string {
  const parts = [`Copied and checked ${plural(r.copied, 'file')} (${formatBytes(r.copiedBytes)}) to ${targetLabel}`];
  if (r.already > 0) parts.push(`${plural(r.already, 'file')} already there`);
  if (r.skipped > 0) parts.push(`${plural(r.skipped, 'file')} skipped`);
  if (r.failed > 0) parts.push(`${plural(r.failed, 'file')} failed`);
  return parts.join('; ');
}

/**
 * The folder and file on a drive for a plan entry, or null when the path would leave the drive root or is not a plain
 * folder-and-name (".." and empty parts are refused).
 */
export function safeDestination(base: string, folder: string, name: string): { dir: string; final: string } | null {
  const parts = folder.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '') || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes(BACKSLASH)) return null;
  const root = path.resolve(base);
  const dir = path.resolve(base, ...parts);
  const final = path.join(dir, name);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!(dir + path.sep).startsWith(rootWithSep) || path.dirname(final) !== dir) return null;
  return { dir, final };
}
