import type { BackupRow } from '../../shared/backups';
import type { MirrorBackupStatus, MirrorPlanView, MirrorReport, MirrorRow } from '../../shared/mirror';
import { MIRROR_CHECK_GROUP_WORDS, type MirrorCheckPlanView, type MirrorCheckReport } from '../../shared/mirrorCheck';
import type { BackupStatus } from '../components/backupStatus';
import type { ReportData } from '../components/reportModel';
import { formatBytes, formatCount, plural } from '../lib/format';
import { dateText, fileNameOf } from './phoneBackupModel';

/** Pure words and lists for the second drive (R1.3): no React, so they can be tested. */

export const alsoKeepButton = (label: string): string => `Also keep a copy on ${label}`;
export const bringUpButton = (label: string): string => `Bring ${label} up to date`;
export const bringAllButton = (label: string): string => `Bring ${label} up to date (all backups)`;
export const MIRROR_PANEL_TITLE = 'Second copy';
export const MIRROR_LOOKING = 'Looking at both drives. This can take a few minutes. Nothing is copied.';

/** "T7 + Seagate2TB, folder MyData/POCO" (a backup with one drive keeps its old words). */
export function savedToText(row: Pick<BackupRow, 'driveLabel' | 'folder' | 'driveConnected' | 'destinations'>): string {
  if (row.driveLabel === null || row.folder === null) return 'No backup folder yet';
  const drives = row.destinations && row.destinations.length > 1 ? row.destinations : null;
  if (drives === null) return row.driveLabel + ', folder ' + row.folder + (row.driveConnected ? '' : ' (not plugged in)');
  const missing = drives.filter((d) => !d.connected).map((d) => d.label);
  return drives.map((d) => d.label).join(' + ') + ', folder ' + row.folder + (missing.length > 0 ? ' (' + missing.join(' and ') + ' not plugged in)' : '');
}

const WORDS: Record<BackupStatus, string> = { 'up-to-date': 'up to date', behind: 'behind', never: 'never backed up', 'not-connected': 'not plugged in', problem: 'a problem' };

/** "behind by 1,234 files (12 GB)", "up to date", "counting..." */
export function behindText(files: number | null, bytes: number): string {
  if (files === null) return 'counting...';
  if (files === 0) return 'up to date';
  return 'behind by ' + formatCount(files) + ' ' + plural(files, 'file', 'files') + ' (' + formatBytes(bytes) + ')';
}

/** "T7: up to date · Seagate2TB: behind by 1,234 files (12 GB)". Null when the backup has no second drive. */
export function statusLine(first: string, base: BackupStatus, mirror: MirrorBackupStatus | undefined): string | null {
  if (!mirror || mirror.mirrors.length === 0) return null;
  const parts = [first + ': ' + WORDS[base]];
  for (const m of mirror.mirrors) {
    const need = m.needYou > 0 ? ', ' + formatCount(m.needYou) + ' ' + plural(m.needYou, 'file needs', 'files need') + ' you' : '';
    parts.push(m.label + ': ' + behindText(m.behindFiles, m.behindBytes) + need + (m.connected ? '' : ' (not plugged in)'));
  }
  return parts.join(' · ');
}

/** A backup is Up to date only if each of its drives is: a second drive that is behind makes the whole backup Behind. */
export function combinedStatus(base: BackupStatus, mirror: MirrorBackupStatus | undefined): BackupStatus {
  if (base !== 'up-to-date' || !mirror) return base;
  return mirror.mirrors.some((m) => (m.behindFiles ?? 0) > 0) ? 'behind' : base;
}

/** "Plug in the T7 to bring the Seagate2TB up to date": the second drive is here and the first is not. Null otherwise. */
export function plugInNote(mirror: MirrorBackupStatus | undefined): string | null {
  if (!mirror || mirror.sourceConnected) return null;
  const second = mirror.mirrors.find((m) => m.connected);
  return second ? 'Plug in the ' + mirror.sourceLabel + ' to bring the ' + second.label + ' up to date' : null;
}

/** The button of a backup's row: off (with the reason) when a drive is missing or the second drive is level. */
export function bringUpState(mirror: MirrorBackupStatus): { enabled: boolean; why: string | null } {
  const m = mirror.mirrors[0];
  if (!m) return { enabled: false, why: null };
  const missing = [mirror.sourceConnected ? null : mirror.sourceLabel, m.connected ? null : m.label].filter((x): x is string => x !== null);
  if (missing.length > 0) return { enabled: false, why: copyRouteText(mirror.sourceLabel, m.label) + ' Plug in ' + missing.join(' and ') + '.' };
  return { enabled: true, why: null };
}

/** "The second copy is made from T7 to Seagate2TB, so both must be plugged in." */
export const copyRouteText = (source: string, target: string): string => 'The second copy is made from ' + source + ' to ' + target + ', so both must be plugged in.';

/** The header hint of a backup whose second drive is behind: what to plug in and where to go. Null when it is not behind. */
export function secondHint(mirror: MirrorBackupStatus | undefined): { text: string; ready: boolean } | null {
  const m = mirror?.mirrors.find((x) => (x.behindFiles ?? 0) > 0);
  if (!mirror || !m) return null;
  const state = bringUpState(mirror);
  return { text: m.label + ' is behind. ' + (state.enabled ? 'Both drives are plugged in: open Second copy to bring it up to date.' : state.why!), ready: state.enabled };
}

/** "Also keep" confirmation words. */
export const alsoKeepQuestion = (backupName: string, label: string, folder: string): string =>
  'Backup Hub will also keep ' + backupName + ' on ' + label + ', in the same folder (' + folder.split('/').join('\\') + '). Nothing is copied until you bring ' + label + ' up to date. This only changes the list of backups.';

// ---- the list before the copy ---------------------------------------------------------------------------------------------------------

export const MIRROR_HEADLINE = 'Files to copy, largest first.';
export const MIRROR_UNTICK = 'Untick = skip this time.';

export interface MirrorListRow {
  id: string;
  name: string;
  folder: string;
  size: number;
  date: string;
  /** "Phone checksum" or "Own checksum" (the first drive's copy has none from the phone). */
  checked: string;
  backupName: string;
  haystack: string;
}

export const checkedWord = (ownChecksum: boolean): string => (ownChecksum ? 'Own checksum' : 'Phone checksum');

/** The rows of the list, largest first (same size: by name, then id, so the order never jumps). */
export function listRows(plan: Pick<MirrorPlanView, 'rows' | 'backups'>): MirrorListRow[] {
  return plan.rows
    .map((r: MirrorRow): MirrorListRow => {
      const slash = r.path.lastIndexOf('/');
      const folder = slash < 0 ? 'Top folder' : r.path.slice(0, slash);
      const backupName = plan.backups[r.backupIndex]?.backupName ?? '';
      return { id: r.id, name: fileNameOf(r.path), folder, size: r.size, date: dateText(r.mtimeMs / 1000), checked: checkedWord(r.ownChecksum), backupName, haystack: (fileNameOf(r.path) + ' ' + folder + ' ' + backupName).toLowerCase() };
    })
    .toSorted((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function filterRows(rows: readonly MirrorListRow[], query: string): MirrorListRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  return words.length === 0 ? [...rows] : rows.filter((r) => words.every((w) => r.haystack.includes(w)));
}

/** Ticks or unticks exactly the rows given; every other row keeps its tick. A new set. */
export function setTicks(unticked: ReadonlySet<string>, rows: readonly MirrorListRow[], ticked: boolean): Set<string> {
  const next = new Set(unticked);
  for (const r of rows) {
    if (ticked) next.delete(r.id);
    else next.add(r.id);
  }
  return next;
}

export interface MirrorCount {
  shown: number;
  shownTicked: number;
  all: number;
  allTicked: number;
}

export function countOf(all: readonly MirrorListRow[], shown: readonly MirrorListRow[], unticked: ReadonlySet<string>): MirrorCount {
  return { shown: shown.length, shownTicked: shown.filter((r) => !unticked.has(r.id)).length, all: all.length, allTicked: all.filter((r) => !unticked.has(r.id)).length };
}

/** "47 of 47 files ticked", and with a search: "Showing 12 of 230 files (12 ticked). 180 of 230 files ticked." */
export function countText(c: MirrorCount): string {
  const base = formatCount(c.allTicked) + ' of ' + formatCount(c.all) + ' ' + plural(c.all, 'file', 'files') + ' ticked';
  return c.shown === c.all ? base : 'Showing ' + formatCount(c.shown) + ' of ' + formatCount(c.all) + ' ' + plural(c.all, 'file', 'files') + ' (' + formatCount(c.shownTicked) + ' ticked). ' + base + '.';
}

export interface MirrorSelectionTotals {
  files: number;
  bytes: number;
}

export function selectionTotals(rows: readonly MirrorListRow[], unticked: ReadonlySet<string>): MirrorSelectionTotals {
  let files = 0;
  let bytes = 0;
  for (const r of rows) {
    if (unticked.has(r.id)) continue;
    files += 1;
    bytes += r.size;
  }
  return { files, bytes };
}

/** "Copy 180 files (1.1 GB) to Seagate2TB". */
export const confirmText = (sel: MirrorSelectionTotals, label: string): string => 'Copy ' + formatCount(sel.files) + ' ' + plural(sel.files, 'file', 'files') + ' (' + formatBytes(sel.bytes) + ') to ' + label;

/** "Already on Seagate2TB (same size, not checked yet): 40,940 files, 173 GB." The copy never reads them. */
export const alreadyThereLine = (c: { files: number; bytes: number }, label: string): string =>
  'Already on ' + label + ' (same size, not checked yet): ' + formatCount(c.files) + ' ' + plural(c.files, 'file', 'files') + ', ' + formatBytes(c.bytes) + '. This copy does not read them.';

/** What the list says about the files that are not in it. */
export function planLines(plan: Pick<MirrorPlanView, 'toCheck' | 'different'>, label: string): string[] {
  const lines: string[] = [];
  if (plan.toCheck.files > 0) lines.push(alreadyThereLine(plan.toCheck, label));
  if (plan.different.files > 0) lines.push(formatCount(plan.different.files) + ' ' + plural(plan.different.files, 'file is', 'files are') + ' on ' + label + ' with another size. They are never replaced: each goes to Needs your decision.' + (plan.different.examples.length > 0 ? ' For example: ' + plan.different.examples.map(fileNameOf).join(', ') : ''));
  return lines;
}

/** The generic Report of the kit, from the report main kept. */
export function reportData(r: MirrorReport, formatWhen: (ms: number) => string): ReportData {
  const skipped = [...r.skipped];
  if (r.linked > 0) skipped.push({ reason: 'already there and the same (checked, not copied again)', count: r.linked, examples: [] });
  if (r.damaged > 0) skipped.push({ reason: 'not copied: the copy on the first drive looks damaged (see Needs your decision)', count: r.damaged, examples: [] });
  if (r.different > 0) skipped.push({ reason: 'not copied: a different file is already there (see Needs your decision)', count: r.different, examples: [] });
  return { copied: r.copied, skipped, failed: r.failed, where: r.where, finished: formatWhen(r.finishedAt) };
}

export const ownChecksumLine = (n: number): string => formatCount(n) + ' ' + plural(n, 'file was', 'files were') + ' copied with the first drive\'s own checksum: the phone had never given one, so these are checked drive to drive only.';

// ---- "Check old copies" ---------------------------------------------------------------------------------------------------------------

export const MIRROR_CHECK_TITLE = 'Check old copies';
export const MIRROR_CHECK_COUNTING = 'Counting the old copies from the file list. Nothing is read from the drives.';
export const checkButton = (label: string): string => 'Check old copies on ' + label;
export const checkAllButton = (label: string): string => 'Check old copies on ' + label + ' (all backups)';
export const CHECK_LINK_TEXT = 'Check these old copies';

/** 45 -> "less than a minute"; 600 -> "about 10 min"; 10800 -> "about 3 h". */
export function durationText(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  if (seconds < 5400) return 'about ' + Math.max(1, Math.round(seconds / 60)) + ' min';
  return 'about ' + Math.round(seconds / 3600) + ' h';
}

/** "Rough time: about 3 h; fine to leave overnight. The real time shows after a few minutes." */
export const estimateLine = (seconds: number, now: number = Date.now()): string => 'Rough time: ' + durationText(seconds) + (seconds >= 7200 ? '; you can keep using the laptop' : '') + (seconds >= 60 ? '. ' + finishText(seconds, now) : '') + '. This is a guess from the file list; the real time shows after a few minutes.';

/** "Should finish around 3:30 pm" (the laptop's local time), with "tomorrow" or the date when that is not today. */
export function finishText(seconds: number, now: number): string {
  const end = new Date(now + seconds * 1000);
  const clock = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ').toLowerCase();
  const today = new Date(now);
  const sameDay = end.getFullYear() === today.getFullYear() && end.getMonth() === today.getMonth() && end.getDate() === today.getDate();
  const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const tomorrow = end.getFullYear() === next.getFullYear() && end.getMonth() === next.getMonth() && end.getDate() === next.getDate();
  return 'Should finish around ' + clock + (sameDay ? '' : tomorrow ? ' tomorrow' : ' on ' + end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
}

export function checkHeadline(plan: Pick<MirrorCheckPlanView, 'totals' | 'backups'>, label: string): string {
  if (plan.totals.files === 0) return 'Nothing to check: every file on ' + label + ' that has the same size as on ' + plan.backups.map((b) => b.sourceLabel).filter((v, i, all) => all.indexOf(v) === i).join(', ') + ' is proven already.';
  const names = [...new Set(plan.backups.map((b) => b.backupName))];
  const which = names.length <= 3 ? names.join(', ') : `${names.length} backups`;
  return which + ': ' + formatCount(plan.totals.files) + ' ' + plural(plan.totals.files, 'file', 'files') + ' (' + formatBytes(plan.totals.bytes) + ') on ' + label + ' have the same size as on ' + plan.backups[0]!.sourceLabel + ' but were never proven to be the same.';
}

/** The plain lines of the preview: order, one read or two, what happens to each. */
export function checkPlanLines(plan: MirrorCheckPlanView, label: string): string[] {
  const lines: string[] = [];
  if (plan.totals.files === 0) {
    if (plan.alreadyChecked > 0) lines.push(formatCount(plan.alreadyChecked) + ' ' + plural(plan.alreadyChecked, 'file was', 'files were') + ' proven earlier.');
    return lines;
  }
  const order = plan.groups.map((g) => MIRROR_CHECK_GROUP_WORDS[g.group] + ': ' + formatCount(g.files) + ' ' + plural(g.files, 'file', 'files') + ' (' + formatBytes(g.bytes) + ')');
  lines.push('Order: ' + order.join(', then ') + '. A stop part-way keeps the valuable ones proven.');
  lines.push(
    formatCount(plan.oneRead.files) + ' ' + plural(plan.oneRead.files, 'file needs', 'files need') + ' one read (their checksum is known, so only ' + label + ' is read)' +
      (plan.twoReads.files > 0 ? '; ' + formatCount(plan.twoReads.files) + ' ' + plural(plan.twoReads.files, 'needs', 'need') + ' two (the ' + plan.backups[0]!.sourceLabel + ' file is read too).' : '.'),
  );
  lines.push('The same checksum: the file on ' + label + ' becomes a verified copy. A different one is never replaced: it goes to Needs your decision. Nothing on ' + plan.backups[0]!.sourceLabel + ' is changed.');
  return lines;
}

export const checkConfirmText = (plan: Pick<MirrorCheckPlanView, 'totals'>, label: string): string => 'Check ' + formatCount(plan.totals.files) + ' ' + plural(plan.totals.files, 'file', 'files') + ' on ' + label;

/** The lines of a finished (or stopped) check, for the screen and for Activity. */
export function checkReportLines(r: MirrorCheckReport, label: string): string[] {
  const checked = r.verified + r.differs;
  const lines: string[] = [];
  lines.push(
    (r.complete ? 'Checked ' : 'Stopped after checking ') + formatCount(checked) + ' ' + plural(checked, 'file', 'files') + ': ' + formatCount(r.verified) + ' ' + plural(r.verified, 'is', 'are') + ' the same and now verified copies on ' + label +
      (r.differs > 0 ? '; ' + formatCount(r.differs) + ' ' + plural(r.differs, 'is', 'are') + ' different (not replaced, see Needs your decision)' : '') + '.',
  );
  lines.push(formatCount(r.oneRead) + ' ' + plural(r.oneRead, 'file needed', 'files needed') + ' one read, ' + formatCount(r.twoReads) + ' needed two.');
  if (r.groups.length > 0) lines.push('Checked: ' + r.groups.map((g) => MIRROR_CHECK_GROUP_WORDS[g.group] + ' ' + formatCount(g.done) + ' of ' + formatCount(g.total)).join(' · ') + '.');
  if (!r.complete) lines.push('What was proven stays proven. Make a new list to check the rest.');
  return lines;
}
