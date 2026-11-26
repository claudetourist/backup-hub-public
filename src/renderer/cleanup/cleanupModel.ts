/** Pure helpers behind the Clean up screen (no React, no window.backupHub). */
import { DAY_MS, type DuplicateGroup, type PhoneCleanFile, type PhoneVerdict } from '../../shared/cleanup';
import type { PlaceView } from '../../shared/places';
import { SEAGATE_NAME } from '../../shared/start';
import type { Tone } from '../components/status';

export interface MonthGroup {
  month: string;
  files: PhoneCleanFile[];
  bytes: number;
}

export interface FolderGroup {
  folder: string;
  months: MonthGroup[];
  files: number;
  bytes: number;
  /** Files of this folder that can be ticked. */
  safe: number;
}

/** Phone files grouped by folder, then by month (newest month first). */
export function groupPhoneFiles(files: readonly PhoneCleanFile[]): FolderGroup[] {
  const folders = new Map<string, Map<string, PhoneCleanFile[]>>();
  for (const f of files) {
    const months = folders.get(f.folder) ?? new Map<string, PhoneCleanFile[]>();
    const list = months.get(f.month) ?? [];
    list.push(f);
    months.set(f.month, list);
    folders.set(f.folder, months);
  }
  return [...folders.entries()]
    .map(([folder, months]) => {
      const groups = [...months.entries()]
        .map(([month, list]) => ({ month, files: list, bytes: list.reduce((s, f) => s + f.size, 0) }))
        .toSorted((a, b) => b.month.localeCompare(a.month));
      const all = groups.flatMap((g) => g.files);
      return { folder, months: groups, files: all.length, bytes: all.reduce((s, f) => s + f.size, 0), safe: all.filter((f) => f.verdict === 'safe').length };
    })
    .toSorted((a, b) => a.folder.localeCompare(b.folder));
}

export function tickedTotals(files: readonly PhoneCleanFile[], ticked: ReadonlySet<number>): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const f of files) {
    if (f.verdict === 'safe' && ticked.has(f.index)) {
      count += 1;
      bytes += f.size;
    }
  }
  return { count, bytes };
}

export const safeIndexes = (files: readonly PhoneCleanFile[]): number[] => files.filter((f) => f.verdict === 'safe').map((f) => f.index);

export function verdictLabel(v: PhoneVerdict): { text: string; tone: Tone } {
  switch (v) {
    case 'safe':
      return { text: 'Safe to remove', tone: 'ok' };
    case 'waiting':
      return { text: 'Not on all three backups yet', tone: 'amber' };
    case 'stale':
      return { text: 'Check now first', tone: 'amber' };
    default:
      return { text: 'Could not be read', tone: 'crit' };
  }
}

/** "12 days left", "Ends today". */
export function lockLeft(expiresAt: number, now: number): string {
  const days = Math.ceil((expiresAt - now) / DAY_MS);
  return days <= 0 ? 'Ends today' : `${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** The folder name for the screen: "/sdcard/DCIM/Camera" becomes "DCIM / Camera". */
export const folderShown = (folder: string): string => folder.replace(/^\/sdcard\/?/, '').split('/').filter(Boolean).join(' / ') || 'Phone storage';

/** The groups that can be ticked: the ones with at least one copy that would move (the others stay disabled). */
export function removableGroupIds(groups: readonly DuplicateGroup[], keepOf: (g: DuplicateGroup) => string): string[] {
  return groups.filter((g) => g.members.some((m) => m.removable && m.relPath !== keepOf(g))).map((g) => g.id);
}

/** What a ticked duplicate group moves: every removable copy except the one kept (the same rule main applies). */
export function duplicateTotals(groups: readonly DuplicateGroup[], ticked: ReadonlySet<string>, keepOf: (g: DuplicateGroup) => string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const g of groups) {
    if (!ticked.has(g.id)) continue;
    const keep = keepOf(g);
    const n = g.members.filter((m) => m.removable && m.relPath !== keep).length;
    count += n;
    bytes += n * g.size;
  }
  return { count, bytes };
}

/** A catalog path split for the screen: "C:/Users/me/Pics/a.jpg" gives the folder and the name. */
export function shownPath(relPath: string): { folder: string; name: string } {
  const slash = relPath.lastIndexOf('/');
  return { folder: slash < 0 ? '' : relPath.slice(0, slash), name: relPath.slice(slash + 1) };
}

export const NOT_READY_TITLE = 'Not ready yet';
export const NOT_READY_TEXT = `Removing files from a phone needs three checked copies: on the T7, on a second drive and in Google. The second drive (${SEAGATE_NAME}) is not available, so nothing can be removed yet. Nothing is changed on your phone.`;

/**
 * True when the second drive (Seagate2TB) cannot be used now: it is not plugged in, it shows a problem, or no drive of that name is
 * known. Then nothing can have three checked copies. False while the places are not read yet (null), so the panel does not flash.
 */
export function secondDriveNotReady(places: readonly Pick<PlaceView, 'kind' | 'label' | 'status' | 'problem'>[] | null): boolean {
  if (places === null) return false;
  const drive = places.find((p) => p.kind === 'drive' && p.label === SEAGATE_NAME);
  return drive === undefined || drive.status !== 'connected' || drive.problem !== null;
}
