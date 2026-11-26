import type { PlaceView } from '../../shared/places';
import type { Tone } from '../components/status';
import { formatBytes, formatCount, plural } from '../lib/format';
import type { TinyStorage } from '../lib/sectionState';
import { quotaFraction } from './placesModel';

/** Pure helpers behind the Devices page: drive stripes, account search and sort, the accounts summary line. */

/** A drive this full or more is amber, and this full or more is red. */
export const DRIVE_AMBER_AT = 0.85;
export const DRIVE_RED_AT = 0.95;

/** An account at this share used (or more) is amber, and at this share used (or more) red. */
export const ACCOUNT_AMBER_PERCENT = 70;
export const ACCOUNT_RED_PERCENT = 90;

/** Every Google account keeps at least this share of its space free (PLAN section 2). */
export const GOOGLE_MARGIN = 0.25;

export type StripeTone = Extract<Tone, 'ok' | 'amber' | 'crit' | 'neutral'>;

export interface DriveStripe {
  tone: StripeTone;
  /** Said in words next to the icon, so the colour is never the only sign. */
  word: string;
}

/**
 * The colour stripe of a drive card: green when connected and fine, amber from 85% full, red from 95% full, grey when it is not
 * connected. (USB trouble would also be red; the window is not told about it, so it is left out here.)
 */
export function driveStripe(place: Pick<PlaceView, 'status' | 'capacityBytes' | 'freeBytes'> & { safeToUnplug?: boolean }): DriveStripe {
  if (place.safeToUnplug === true) return { tone: 'ok', word: 'Safe to unplug' };
  if (place.status === 'problem') return { tone: 'amber', word: "Plugged in, can't be read" };
  if (place.status !== 'connected') return { tone: 'neutral', word: 'Not connected' };
  const used = usedShare(place.freeBytes, place.capacityBytes);
  if (used !== null && used >= DRIVE_RED_AT) return { tone: 'crit', word: 'Almost full' };
  if (used !== null && used >= DRIVE_AMBER_AT) return { tone: 'amber', word: 'Filling up' };
  return { tone: 'ok', word: 'Connected' };
}

/** Share of a drive in use (0..1), or null when the size is not known. */
export function usedShare(freeBytes: number | null, capacityBytes: number | null): number | null {
  if (freeBytes === null || capacityBytes === null || capacityBytes <= 0) return null;
  return Math.min(1, Math.max(0, 1 - freeBytes / capacityBytes));
}

/** Connected drives first, then the others; each group in natural order of name. */
export function driveOrder<T extends Pick<PlaceView, 'status' | 'label'>>(drives: readonly T[]): T[] {
  return drives.toSorted((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || naturalCompare(a.label, b.label));
}

/** "322 GB free of 1 TB", split for the card: "678 GB used", "322 GB free", "1 TB". Empty strings when unknown. */
export function driveSpace(place: Pick<PlaceView, 'capacityBytes' | 'freeBytes'>): { used: string; free: string; total: string } {
  const { capacityBytes: total, freeBytes: free } = place;
  if (total === null) return { used: '', free: free === null ? '' : `${formatBytes(free)} free`, total: '' };
  if (free === null) return { used: '', free: '', total: formatBytes(total) };
  return { used: `${formatBytes(Math.max(0, total - free))} used`, free: `${formatBytes(free)} free`, total: formatBytes(total) };
}

/** Text order that reads numbers as numbers: "acc2" comes before "acc10", and case does not matter. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/** Green under 70%, amber from 70% to under 90%, red from 90%. */
export function percentTone(percent: number): StripeTone {
  if (percent >= ACCOUNT_RED_PERCENT) return 'crit';
  if (percent >= ACCOUNT_AMBER_PERCENT) return 'amber';
  return 'ok';
}

export interface AccountFacts {
  usedBytes: number | null;
  limitBytes: number | null;
  freeBytes: number | null;
  /** Whole percent used, or null when the space is not known. */
  percent: number | null;
}

export function accountFacts(place: Pick<PlaceView, 'gdrive'>): AccountFacts {
  const usedBytes = place.gdrive?.quotaUsageBytes ?? null;
  const limitBytes = place.gdrive?.quotaLimitBytes ?? null;
  const fraction = quotaFraction(usedBytes, limitBytes);
  return {
    usedBytes,
    limitBytes,
    freeBytes: usedBytes !== null && limitBytes !== null ? Math.max(0, limitBytes - usedBytes) : null,
    percent: fraction === null ? null : Math.round(fraction * 100),
  };
}

/** "4.2 of 15 GB": the used amount without its unit when both are in the same unit. */
export function usedOfText(usedBytes: number, limitBytes: number): string {
  const used = formatBytes(usedBytes);
  const limit = formatBytes(limitBytes);
  const [usedNumber, usedUnit] = used.split(' ');
  const [, limitUnit] = limit.split(' ');
  return `${usedUnit === limitUnit ? usedNumber : used} of ${limit}`;
}

/** An account matches when the typed text is part of its address or nickname (the label), in any case. Empty text matches all. */
export function accountMatches(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || label.toLowerCase().includes(q);
}

export function filterAccounts<T extends Pick<PlaceView, 'label'>>(accounts: readonly T[], query: string): T[] {
  return accounts.filter((a) => accountMatches(a.label, query));
}

export type AccountSort = 'name' | 'free' | 'used' | 'recent';

export const ACCOUNT_SORTS: readonly { id: AccountSort; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'free', label: 'Most free space' },
  { id: 'used', label: 'Most full' },
  { id: 'recent', label: 'Recently added' },
];

/** Name in natural order; free space, biggest first; share used, biggest first. Accounts with no known space go last. */
export function sortAccounts<T extends Pick<PlaceView, 'label' | 'gdrive'>>(accounts: readonly T[], sort: AccountSort): T[] {
  const byName = (a: T, b: T): number => naturalCompare(a.label, b.label);
  if (sort === 'name') return accounts.toSorted(byName);
  // The list arrives oldest first (places are read in the order they were added), so newest first is that order turned round.
  if (sort === 'recent') return accounts.toReversed();
  const key = (a: T): number | null => {
    const facts = accountFacts(a);
    return sort === 'free' ? facts.freeBytes : facts.percent;
  };
  return accounts.toSorted((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null || kb === null) return Number(ka === null) - Number(kb === null) || byName(a, b);
    return kb - ka || byName(a, b);
  });
}

/** The Google accounts list shows this many (the fullest) before "Show all". */
export const ACCOUNTS_SHOWN = 8;

/** Which accounts the list shows: all of them while the person searches or has opened the fold, else the first ACCOUNTS_SHOWN. */
export function accountsFold<T>(sorted: readonly T[], opened: boolean, searching: boolean): { rows: T[]; foldText: string | null } {
  if (sorted.length <= ACCOUNTS_SHOWN || searching) return { rows: [...sorted], foldText: null };
  return opened ? { rows: [...sorted], foldText: 'Show fewer' } : { rows: sorted.slice(0, ACCOUNTS_SHOWN), foldText: `Show all ${sorted.length}` };
}

/** The "Check now" button of a plugged-in drive or the laptop: shown only for those, off while a check is already under way. */
export function checkNowState(place: Pick<PlaceView, 'kind' | 'status' | 'listing'>): { show: boolean; busy: boolean; text: string } {
  const show = (place.kind === 'drive' || place.kind === 'laptop') && place.status === 'connected';
  const busy = place.listing !== 'idle';
  return { show, busy, text: busy ? 'Checking…' : 'Check now' };
}

/** What can still be put on an account after its 25% margin is kept free. */
export function usableBytes(facts: Pick<AccountFacts, 'limitBytes' | 'usedBytes'>): number {
  if (facts.limitBytes === null || facts.usedBytes === null) return 0;
  return Math.max(0, facts.limitBytes * (1 - GOOGLE_MARGIN) - facts.usedBytes);
}

/** "27 accounts · 120 GB used · 245 GB free · 135 GB usable after the 25% margin". */
export function accountsSummary(accounts: readonly Pick<PlaceView, 'gdrive'>[]): string {
  if (accounts.length === 0) return 'No Google account yet';
  let used = 0;
  let free = 0;
  let usable = 0;
  for (const account of accounts) {
    const facts = accountFacts(account);
    if (facts.usedBytes === null || facts.freeBytes === null) continue;
    used += facts.usedBytes;
    free += facts.freeBytes;
    usable += usableBytes(facts);
  }
  const count = `${formatCount(accounts.length)} ${plural(accounts.length, 'account', 'accounts')}`;
  return `${count} · ${formatBytes(used)} used · ${formatBytes(free)} free · ${formatBytes(usable)} usable after the ${Math.round(GOOGLE_MARGIN * 100)}% margin`;
}

/** The line under an empty search. */
export function noAccountMatchText(query: string): string {
  return `No account matches ${query.trim()}`;
}

/** How the Google accounts are shown: the compact list (the default) or cards. A view choice, remembered in the window's own storage. */
export type AccountsView = 'list' | 'grid';
export const ACCOUNTS_VIEWS: readonly { id: AccountsView; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'grid', label: 'Grid' },
];
export const ACCOUNTS_VIEW_KEY = 'backuphub.devices.googleAccountsView';

/** The remembered view; anything else (nothing saved, an unreadable store) is the list. */
export function readAccountsView(storage: TinyStorage | null): AccountsView {
  try {
    const value = storage?.getItem(ACCOUNTS_VIEW_KEY);
    if (value === 'grid' || value === 'list') return value;
  } catch {
    // Storage blocked: use the list.
  }
  return 'list';
}

export function writeAccountsView(storage: TinyStorage | null, view: AccountsView): void {
  try {
    storage?.setItem(ACCOUNTS_VIEW_KEY, view);
  } catch {
    // Not remembered; the switch still works.
  }
}
