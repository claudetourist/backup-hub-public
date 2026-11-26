/**
 * Free up phone space: the plain words and the small rules the window needs (no React), so they can be tested.
 * Words are for someone who is not technical: "checked now" means read again just now, not taken from a list.
 */
import { formatGb } from '../../shared/cloudCopy';
import { freeLine, placesText, type FreeUpRemoved, type FreeUpGroupId, type FreeUpGroupView, type FreeUpKeepRule, type FreeUpMode, type FreeUpPrepareView, type FreeUpResultView } from '../../shared/freeUp';
import { formatCount } from '../lib/format';

export const FREE_TITLE = 'Free up phone space';
export const FREE_INTRO = 'Take pictures and videos off the phone to make room. A file goes only when the phone, the first drive, the second drive and Google all hold exactly the same file, checked again just now. You see the list first, and nothing goes until you say so.';
export const FREE_NOT_COVERED_TITLE = 'First: things no backup can copy';
export const FREE_NOT_COVERED_HELP = 'Taking files off the phone does not touch these, but check them before you free up space. Tick each one when it is done.';
export const FREE_START = 'Check what can go';
export const FREE_CHECKING = 'Reading the phone, both drives and Google again, so nothing is taken from an old list. This can take a while: you can pause or stop it.';
export const FREE_ONLY_KINDS = 'Only photos and videos are ever offered. Documents, downloads, music and app folders never are.';
export const FREE_BLOCKED_TITLE = 'Nothing can be removed yet';
export const FREE_NOT_READY_HELP = 'These files stay on the phone because one of the copies is missing or not checked. Back them up first, then check again.';
export const FREE_AGAIN = 'Check again';

/** The two ways to check, each with one line of what it does and how long it takes. */
export const CHECK_MODES: readonly { mode: FreeUpMode; label: string; line: string }[] = [
  { mode: 'quick', label: 'Quick', line: 'Looks at the phone\'s file list, that each copy is on the drives at its size, and asks Google. Takes seconds.' },
  { mode: 'full', label: 'Full', line: 'Reads every file on the phone and on both drives again. Takes about 1 hour for 46 GB.' },
];
/** The two ways to remove, chosen on the confirm step. Full is the default and the advice. */
export const REMOVE_MODES: readonly { mode: FreeUpMode; label: string; line: string }[] = [
  { mode: 'full', label: 'Full (recommended)', line: 'Reads each file again on the phone and on both drives just before it goes, and asks Google. Slower, safest.' },
  { mode: 'quick', label: 'Quick', line: 'Does not read the files again: checks each copy is still there at its size, asks Google, checks the phone\'s file size.' },
];
export const modeWord = (m: FreeUpMode): string => (m === 'quick' ? 'Quick' : 'Full');

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
/** "Quick check, 12:05". */
export const stepsHeader = (v: Pick<FreeUpResultView, 'mode' | 'at'>): string => `${modeWord(v.mode)} check, ${CLOCK.format(new Date(v.at))}`;
/** "Phone: file still there ...: 120 passed, 3 did not". */
export const stepLine = (s: { what: string; passed: number; failed: number }): string => `${s.what}: ${formatCount(s.passed)} passed, ${formatCount(s.failed)} did not`;
/** The steps the check really ran (a check that was stopped at the start has none). */
export const ranSteps = (v: Pick<FreeUpResultView, 'steps'>): FreeUpResultView['steps'] => (v.steps.some((s) => s.passed + s.failed > 0) ? v.steps : []);

const files = (n: number): string => `${formatCount(n)} ${n === 1 ? 'file' : 'files'}`;

/** "Camera photos: 90 files, 1.2 GB (10 left out)": the files in this removal; the ones the person unticked are said last. */
export const groupWords = (g: Pick<FreeUpGroupView, 'label' | 'files' | 'bytes'> & { leftOutFiles?: number }): string => `${g.label}: ${files(g.files)}, ${formatGb(g.bytes)}${g.leftOutFiles !== undefined && g.leftOutFiles > 0 ? ` (${formatCount(g.leftOutFiles)} left out)` : ''}`;

export const TICK_HELP = 'A ticked file is in this removal. Untick a file and it stays on the phone this time (it is offered again at the next check). "Keep on the phone" means never offered.';
export const tickAllGroupLink = (total: number): string => `Tick all ${formatCount(total)}`;
export const untickAllLink = 'Untick all';
/** The header tick of a page of the group's files: all ticked, none, or some. */
export function pageFilesTick(rows: readonly { ticked?: boolean }[]): 'all' | 'some' | 'none' {
  const n = rows.filter((r) => r.ticked === true).length;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}

export function tickedTotals(groups: readonly FreeUpGroupView[], ticked: ReadonlySet<FreeUpGroupId>): { files: number; bytes: number } {
  let f = 0;
  let b = 0;
  for (const g of groups) if (ticked.has(g.id)) {
    f += g.files;
    b += g.bytes;
  }
  return { files: f, bytes: b };
}

/** The one main button of the list: what the ticks would free, or a hint when nothing is ticked. */
export const reviewButton = (t: { files: number; bytes: number }): string => (t.files === 0 ? 'Tick a group to go on' : `Review ${files(t.files)}: free ${formatGb(t.bytes)}`);

/** The space this screen will never touch, in plain lines (nothing is said about a part that is empty). */
export function lockedLines(locked: FreeUpResultView['locked']): string[] {
  const out: string[] = [];
  if (locked.keepFiles > 0) out.push(`Kept on the phone because you said so: ${files(locked.keepFiles)}, ${formatGb(locked.keepBytes)}.`);
  for (const k of locked.googleKinds) out.push(`Not sent to Google, so never removed: ${k.label.toLowerCase()}, ${files(k.files)}, ${formatGb(k.bytes)}.`);
  if (locked.otherFiles > 0) out.push(`Never offered (documents, downloads, music, app folders): ${files(locked.otherFiles)}, ${formatGb(locked.otherBytes)}.`);
  return out;
}

export const notReadyHeader = (v: FreeUpResultView): string => `Not ready: ${files(v.notReady.files)}, ${formatGb(v.notReady.bytes)}`;

/** The confirm screen: what goes, and where the three copies are. */
export function confirmLines(p: FreeUpPrepareView): { headline: string; lines: string[] } {
  return {
    headline: freeLine(p.files, p.bytes),
    lines: [
      `The copies are on ${placesText(p.places)}. They are not touched.`,
      'Each file is read again just before it is removed. If it changed, or any copy does not match, it stays on the phone.',
      'You can put removed files back from the first drive.',
    ],
  };
}

/** What the chosen removal will do, for the confirm step. */
export const removeModeSummary = (m: FreeUpMode): string => (REMOVE_MODES.find((x) => x.mode === m) ?? REMOVE_MODES[0]!).line;

/** "Kept on the phone: IMG_1.jpg" with the id of the rule to undo (null when the rule cannot be found in the list). */
export function keptNote(scope: 'file' | 'folder', path: string, rules: readonly FreeUpKeepRule[]): { text: string; ruleId: number | null } {
  const plain = (p: string): string => p.replace(/\/+$/, '');
  const rule = rules.filter((r) => r.scope === scope && plain(r.path) === plain(path)).toSorted((a, b) => b.id - a.id)[0];
  const name = plain(path).slice(plain(path).lastIndexOf('/') + 1) || path;
  return { text: scope === 'folder' ? `Kept on the phone: everything in ${name}` : `Kept on the phone: ${name}`, ruleId: rule?.id ?? null };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "12 Jun 2026" from seconds since 1970 (a dash when unknown). */
export function shortDate(mtimeSec: number): string {
  if (!Number.isFinite(mtimeSec) || mtimeSec <= 0) return '-';
  const d = new Date(mtimeSec * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]!} ${d.getFullYear()}`;
}

/** "/sdcard/DCIM/Camera" -> "DCIM/Camera"; long ones keep the last three folders ("…/a/b/c"). */
export function shortFolder(folder: string): string {
  const parts = folder.replace(/^\/(?:sdcard|storage\/emulated\/0)(?=\/|$)/, '').split('/').filter((p) => p !== '');
  if (parts.length === 0) return 'Phone storage';
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/');
}

export const removeButton = (p: Pick<FreeUpPrepareView, 'files'>): string => `Remove ${files(p.files)} from the phone`;

export function ageText(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  return min < 1 ? 'just now' : min === 1 ? '1 minute ago' : `${min} minutes ago`;
}

/** A check older than this is not removed from (main refuses); the window says so before the person finds out. */
export const isOldCheck = (at: number, now: number): boolean => now - at > 30 * 60 * 1000;

export const keepFileTitle = 'Never offer this file again';
export const keepFolderTitle = 'Never offer anything in this folder again';

export const removedLine = (total: { files: number; bytes: number }): string => `Removed and not put back: ${files(total.files)}, ${formatGb(total.bytes)}.`;

// ---- the put-back list: a paged table with ticks (selection kept across pages, by removal id) ----------------------------------------------

export const PUT_BACK_HELP = 'Put back copies a file from the first drive to where it was on the phone and checks it there. The phone and the first drive must be plugged in, and the phone unlocked.';
export const PUT_BACK_NOTHING = 'Nothing is removed and not put back.';

/** "1-100 of 422" (0 of 0 when the list is empty). */
export const rangeText = (offset: number, shown: number, total: number): string => (shown === 0 ? `0 of ${formatCount(total)}` : `${formatCount(offset + 1)}-${formatCount(offset + shown)} of ${formatCount(total)}`);

/** The date column: when it was taken, else (marked as such in the tooltip) the day it was removed. */
export const putBackDate = (r: Pick<FreeUpRemoved, 'takenSec' | 'removedAt'>): { text: string; title: string } =>
  r.takenSec > 0 ? { text: shortDate(r.takenSec), title: 'Date taken' } : { text: shortDate(Math.floor(r.removedAt / 1000)), title: 'Date taken is not known: this is the day it was removed' };

/** "26 Nov 2026, 10:03". */
export function shortDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  return `${shortDate(Math.floor(ms / 1000))}, ${CLOCK.format(new Date(ms))}`;
}

/** The state of the header tick for the rows of one page: all ticked, none, or some. */
export function pageTick(rows: readonly Pick<FreeUpRemoved, 'id'>[], ticked: ReadonlySet<number>): 'all' | 'some' | 'none' {
  const n = rows.filter((r) => ticked.has(r.id)).length;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}

/** Ticks or unticks every row of the page (the ticks on other pages stay). */
export function tickPage(ticked: ReadonlySet<number>, rows: readonly Pick<FreeUpRemoved, 'id'>[], on: boolean): Set<number> {
  const next = new Set(ticked);
  for (const r of rows) {
    if (on) next.add(r.id);
    else next.delete(r.id);
  }
  return next;
}

export function tickOne(ticked: ReadonlySet<number>, id: number, on: boolean): Set<number> {
  const next = new Set(ticked);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Bytes of the ticked files (sizes are known for every file that was ticked: from a page or from "Tick all"). */
export function tickedBytes(ticked: ReadonlySet<number>, sizes: ReadonlyMap<number, number>): number {
  let n = 0;
  for (const id of ticked) n += sizes.get(id) ?? 0;
  return n;
}

export const putBackButton = (count: number, bytes: number): string => (count === 0 ? 'Put back 0 ticked' : `Put back ${formatCount(count)} ticked (${formatGb(bytes)})`);
export const tickAllLink = (total: number): string => `Tick all ${formatCount(total)}`;
/** The confirm step: what comes back, from where. */
export const putBackConfirmLine = (count: number, bytes: number): string => `Put ${files(count)} (${formatGb(bytes)}) back on the phone? They are copied from the first drive and checked on the phone.`;
