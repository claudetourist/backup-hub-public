/** "Get files back" on a backup's page and on the Files screen: the plain parts (no window, no calls). */
import type { RestoreEntry, RestorePick, RestorePlanView } from '../../shared/restore';
import { formatBytes, formatCount, plural } from '../lib/format';

export const RESTORE_TAB_TITLE = 'Get files back';
export const RESTORE_SHOW_BUTTON = 'Show what will come back';
export const RESTORE_GO_BUTTON = 'Get files back';
export const RESTORE_DAY_WORDS = 'Pick a day, then tick the folders and files you want.';

export type RestoreMode = 'day' | 'newest';

/** The key of a ticked entry: its path below the day, a folder ends with "/". */
export const tickKey = (path: string, entry: Pick<RestoreEntry, 'name' | 'folder'>): string => (path === '' ? '' : path + '/') + entry.name + (entry.folder ? '/' : '');

export function toggleTick(ticks: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(ticks);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const childPath = (path: string, name: string): string => (path === '' ? name : path + '/' + name);

/** "DCIM/Camera" -> the way back up: [{label: 'Top', path: ''}, {label: 'DCIM', path: 'DCIM'}, {label: 'Camera', path: 'DCIM/Camera'}] */
export function crumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: 'Top', path: '' }];
  let at = '';
  for (const part of path === '' ? [] : path.split('/')) {
    at = childPath(at, part);
    out.push({ label: part, path: at });
  }
  return out;
}

/** "1,204 files · 3.2 GB" for a folder, "3.2 MB" for a file. */
export function entrySize(entry: Pick<RestoreEntry, 'folder' | 'files' | 'bytes'>): string {
  return entry.folder ? formatCount(entry.files) + ' ' + plural(entry.files, 'file', 'files') + ' · ' + formatBytes(entry.bytes) : formatBytes(entry.bytes);
}

/** What the person picked, as the request main understands; null while nothing is picked yet. */
export function pickOf(o: { mode: RestoreMode; backupId: number; flat: boolean; day: string | null; everything: boolean; ticks: ReadonlySet<string> }): RestorePick | null {
  if (o.mode === 'newest') return { kind: 'newest', backupId: o.backupId };
  if (!o.flat && o.day === null) return null;
  if (!o.everything && o.ticks.size === 0) return null;
  return { kind: 'date', backupId: o.backupId, folder: o.flat ? null : o.day, items: o.everything ? [] : [...o.ticks] };
}

/** The line under the list: how many things are ticked. */
export function tickedText(count: number, everything: boolean): string {
  if (everything) return 'Everything on this day';
  if (count === 0) return 'Nothing ticked yet';
  return formatCount(count) + ' ' + plural(count, 'thing', 'things') + ' ticked';
}

export function planHeadline(plan: Pick<RestorePlanView, 'files' | 'bytes' | 'fromWords'>): string {
  return formatCount(plan.files) + ' ' + plural(plan.files, 'file', 'files') + ' (' + formatBytes(plan.bytes) + ') will come back from ' + plan.fromWords + '.';
}

/** "12 files will be downloaded from Google." (nothing when none) */
export function googleLine(plan: Pick<RestorePlanView, 'fromGoogle'>): string | null {
  return plan.fromGoogle > 0 ? formatCount(plan.fromGoogle) + ' ' + plural(plan.fromGoogle, 'file', 'files') + ' will be downloaded from Google (no plugged-in drive has ' + (plan.fromGoogle === 1 ? 'it' : 'them') + ').' : null;
}

export function heldHeadline(count: number): string {
  return formatCount(count) + ' ' + plural(count, 'file', 'files') + ' will not come back:';
}

/** The warning when the place they go to has less room than they need; null when there is room or it is not known. */
export function roomWarning(plan: Pick<RestorePlanView, 'bytes' | 'freeBytes'>): string | null {
  if (plan.freeBytes === null || plan.freeBytes >= plan.bytes + 200_000_000) return null;
  return 'There is not enough room there: ' + formatBytes(Math.max(0, plan.freeBytes)) + ' free, ' + formatBytes(plan.bytes) + ' needed. Choose another folder.';
}
