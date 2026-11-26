/**
 * Pure rules of Free up phone space: which kinds and paths may ever be offered, which group a file sits in, the order of the list, and
 * whether a copy sits where a copy of this backup must be. No database, no phone, no disk.
 */
import { BIG_VIDEO_BYTES, OFFERED_KINDS, type FreeUpGroupId, FREEUP_GROUPS } from '../../shared/freeUp';
import { isFileKind, kindOf, type FileKind } from '../../shared/fileKinds';

const OFFERED = new Set<string>(OFFERED_KINDS);

/** The kind of a phone file: the stored kind when the classify job has set one, else worked out from the path and size. */
export function phoneKindOf(path: string, size: number, stored: string | null): FileKind {
  if (stored !== null && isFileKind(stored)) return stored;
  return kindOf(path, path.slice(path.lastIndexOf('/') + 1), null, size);
}

export const isOfferedKind = (kind: string): boolean => OFFERED.has(kind);

const segmentsOf = (path: string): string[] => {
  const parts = path.split('/').filter((s) => s !== '');
  // Drop the storage root: /sdcard/..., /storage/emulated/0/..., /storage/self/primary/...
  if (parts[0]?.toLowerCase() === 'sdcard') return parts.slice(1);
  if (parts[0]?.toLowerCase() === 'storage' && (parts[1]?.toLowerCase() === 'emulated' || parts[1]?.toLowerCase() === 'self')) return parts.slice(3);
  return parts;
};

/** Plain words when a path may never be offered whatever its kind (app data, WhatsApp's own databases and backups), else null. */
export function neverOfferedPath(path: string): string | null {
  const segs = segmentsOf(path).map((s) => s.toLowerCase());
  if (segs.length === 0) return 'It is not a file in a phone folder.';
  if (segs[0] === 'android') return 'It is in the Android folder (apps keep their own data there).';
  // WhatsApp's chat databases and backups, wherever the folder sits (old and new places).
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (segs[i]!.includes('whatsapp') && (segs[i + 1] === 'databases' || segs[i + 1] === 'backups')) return "It is part of WhatsApp's own database or backup.";
  }
  return null;
}

/** The group a file is listed in, or null for a kind that is never offered. A video over 100 MB is always in the first group. */
export function groupOf(kind: string, size: number): FreeUpGroupId | null {
  switch (kind) {
    case 'video-camera':
    case 'video-whatsapp':
    case 'video-other':
      if (size >= BIG_VIDEO_BYTES) return 'big-videos';
      return kind === 'video-camera' ? 'camera-videos' : kind === 'video-whatsapp' ? 'whatsapp-videos' : 'other-videos';
    case 'photo-screenshot':
      return 'screenshots';
    case 'photo-camera':
      return 'camera-photos';
    case 'photo-whatsapp':
      return 'whatsapp-photos';
    case 'photo-other':
      return 'other-photos';
    default:
      return null;
  }
}

const GROUP_RANK = new Map<string, number>(FREEUP_GROUPS.map((g, i) => [g, i]));

/** Big videos first, then camera videos, WhatsApp videos, other videos, screenshots, camera photos, WhatsApp photos, other photos; biggest first inside each group. */
export function compareForList(a: { group: FreeUpGroupId; size: number; path: string }, b: { group: FreeUpGroupId; size: number; path: string }): number {
  return GROUP_RANK.get(a.group)! - GROUP_RANK.get(b.group)! || b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const norm = (p: string): string => p.split('\\').join('/').replace(/^\/+|\/+$/g, '');

/** True when a drive file sits inside this backup's folder on the drive and is a finished copy (not in old versions, damaged or half copied). */
export function copyIsInPlace(relPath: string, root: string): boolean {
  const rel = norm(relPath).toLowerCase();
  const base = norm(root).toLowerCase();
  if (base !== '' && !rel.startsWith(`${base}/`)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '_old-versions' || s === '_damaged')) return false;
  return !rel.endsWith('.bhpart') && !rel.endsWith('.bhpart.tmp');
}

/** The folders above a phone path, nearest first ("/sdcard/DCIM/Camera/a.jpg" -> "/sdcard/DCIM/Camera", "/sdcard/DCIM", "/sdcard"). */
export function parentFolders(path: string): string[] {
  const out: string[] = [];
  let i = path.lastIndexOf('/');
  while (i > 0) {
    out.push(path.slice(0, i));
    i = path.lastIndexOf('/', i - 1);
  }
  return out;
}
