/** Pure parts of the Google section of a backup's page (no React), so they can be tested. */
import { GOOGLE_KEEP_FREE_PERCENT, shortLine, suggestAccounts, ticked, toPlaceBytes, toPlaceFiles, googleBytes, type GoogleAccountPick, type GoogleCopyPlan, type GoogleCopyPreview, type GoogleCopyReport, type GoogleKindRow, type GooglePlanLine, type GoogleSentLine } from '../../shared/googleCopy';
import type { ReportData } from '../components/reportModel';
import { formatCount, plural } from '../lib/format';

export const GOOGLE_TITLE = 'Copy to Google';
export const GOOGLE_COUNTING = 'Counting what is on Google...';
export const GOOGLE_LOADING = 'Reading what is on the drive...';
export const GOOGLE_LEAVE_OUT_NOTE = 'A kind you leave unticked is not sent, and Free up phone space will never offer those files.';

/** The ticked kinds as the screen keeps them: the kind names. */
export const tickedKinds = (rows: readonly GoogleKindRow[], ticks: ReadonlySet<string>): string[] => rows.filter((r) => ticks.has(r.kind)).map((r) => r.kind);

export const rowsWithTicks = (rows: readonly GoogleKindRow[], ticks: ReadonlySet<string>): GoogleKindRow[] => rows.map((r) => ({ ...r, ticked: ticks.has(r.kind) }));

/** "12,000 files, 45.0 GB". */
export const kindSize = (r: Pick<GoogleKindRow, 'files' | 'bytes'>): string => `${formatCount(r.files)} ${plural(r.files, 'file', 'files')}, ${googleBytes(r.bytes)}`;

/** "3,000 already on Google, 9,000 to go". */
export function kindProgress(r: GoogleKindRow): string {
  if (r.onGoogleFiles === 0) return `${formatCount(r.toGoFiles)} to go`;
  return `${formatCount(r.onGoogleFiles)} already on Google, ${formatCount(r.toGoFiles)} to go`;
}

/** The plan of the ticked kinds in the ticked accounts: 'loading' while main works it out, null when there is nothing to plan (no kind or no account ticked). */
export type PlanState = GoogleCopyPlan | 'loading' | null;

/**
 * "608 files, but 381 different ones (227 are repeats from older phone backups): 381 files, 184 MB will be sent". Null when nothing ticked repeats. A phone
 * backup holds older backups of the phone, so the same picture can sit in it two or three times; each content is sent once.
 */
export function repeatLine(rows: readonly GoogleKindRow[]): string | null {
  const repeats = ticked(rows).reduce((s, r) => s + r.repeatFiles, 0);
  if (repeats === 0) return null;
  const files = toPlaceFiles(rows);
  const word = (n: number): string => `${formatCount(n)} ${plural(n, 'file', 'files')}`;
  return `${word(files + repeats)}, but ${formatCount(files)} different ${plural(files, 'one', 'ones')} (${formatCount(repeats)} ${plural(repeats, 'is a repeat', 'are repeats')} from older phone backups): ${word(files)}, ${googleBytes(toPlaceBytes(rows))} will be sent`;
}

export const ACCOUNTS_SUGGESTED_NOTE = 'Suggested by Backup Hub: check and change the ticks if needed';
export const ACCOUNTS_LAST_TIME_NOTE = 'Suggested by Backup Hub (your choice last time): check and change the ticks if needed';
export const ACCOUNTS_PLAN_LOADING = 'Working out where each file goes...';
/** A "Find an account" box shows when there are more accounts than this. */
export const FIND_ACCOUNT_FROM = 9;

const accountWord = (n: number): string => plural(n, 'account', 'accounts');

/** The email (or the name when there is no email). */
export const accountName = (a: Pick<GoogleAccountPick, 'email' | 'label'>): string => a.email ?? a.label;

/** Most "can still take" first; accounts that cannot take anything last (by name). */
export function sortAccountRows(rows: readonly GoogleAccountPick[]): GoogleAccountPick[] {
  return rows.toSorted((a, b) => Number(b.canTake) - Number(a.canTake) || b.room - a.room || (accountName(a).toLowerCase() < accountName(b).toLowerCase() ? -1 : 1));
}

export const showFindBox = (rows: readonly GoogleAccountPick[]): boolean => rows.length >= FIND_ACCOUNT_FROM;

/** A row matches when the typed text is part of its email or name, in any case. Empty text matches all. */
export function filterAccountRows(rows: readonly GoogleAccountPick[], query: string): GoogleAccountPick[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...rows] : rows.filter((a) => accountName(a).toLowerCase().includes(q) || a.label.toLowerCase().includes(q));
}

/** "2.9 GB free of 15.0 GB" or the reason it is greyed. */
export function accountSpace(a: GoogleAccountPick): string {
  if (a.limit === null || a.usage === null || a.free === null) return a.reason ?? 'space not known yet';
  return `${googleBytes(a.free)} free of ${googleBytes(a.limit)}`;
}

/** "can take 0.8 GB (keeping 25% free)"; the reason for a greyed row. */
export const accountTake = (a: GoogleAccountPick): string => (a.canTake ? `can take ${googleBytes(a.room)} (keeping ${GOOGLE_KEEP_FREE_PERCENT}% free)` : (a.reason ?? ''));

export const accountChecked = (a: GoogleAccountPick): string => (a.checkedNow ? 'checked just now' : '');

/** The accounts of the preview that are ticked and can take files (a greyed account is never counted, whatever was ticked). */
export const pickedAccounts = (preview: Pick<GoogleCopyPreview, 'accounts'>, ticks: ReadonlySet<string>): GoogleAccountPick[] => preview.accounts.filter((a) => a.canTake && ticks.has(a.placeId));

export const tickedAccountIds = (preview: Pick<GoogleCopyPreview, 'accounts'>, ticks: ReadonlySet<string>): string[] => pickedAccounts(preview, ticks).map((a) => a.placeId);

/** The room each ticked account showed on the screen: the start compares it with a fresh question. */
export function seenRoom(preview: Pick<GoogleCopyPreview, 'accounts'>, ticks: ReadonlySet<string>): Record<string, number> {
  return Object.fromEntries(pickedAccounts(preview, ticks).map((a) => [a.placeId, a.room]));
}

/** True when the first ticks are the person's own choice from last time (else Backup Hub suggested them). */
export const ticksFromLastTime = (preview: Pick<GoogleCopyPreview, 'accounts'>): boolean => preview.accounts.some((a) => a.ticked);

/** The ticks the screen opens with: the person's own last choice for this backup, else the fewest accounts that fit the ticked kinds, most room first. */
export function initialAccountTicks(preview: GoogleCopyPreview, kindTicks: ReadonlySet<string>): Set<string> {
  const last = preview.accounts.filter((a) => a.ticked).map((a) => a.placeId);
  if (last.length > 0) return new Set(last);
  return new Set(suggestAccounts(preview.accounts, toPlaceBytes(rowsWithTicks(preview.kinds, kindTicks))));
}

/** Backup Hub's suggestion for these kinds (live room, fewest accounts that fit, most room first), ignoring last time's ticks: used when the kinds change. */
export const suggestedAccountTicks = (preview: GoogleCopyPreview, kindTicks: ReadonlySet<string>): Set<string> => new Set(suggestAccounts(preview.accounts, toPlaceBytes(rowsWithTicks(preview.kinds, kindTicks))));

export const suggestionNote = (preview: Pick<GoogleCopyPreview, 'accounts'>): string | null => (preview.accounts.some((a) => a.canTake) ? (ticksFromLastTime(preview) ? ACCOUNTS_LAST_TIME_NOTE : ACCOUNTS_SUGGESTED_NOTE) : null);

// ---- phone backups: "Only what is still on the phone" and "Fit what I have room for, biggest first" ------------------------------------------------------

export const ONLY_ON_PHONE_LABEL = 'Only what is still on the phone';
export const ONLY_ON_PHONE_NOTE = 'Files you already took off the phone are left out, so the list shows what can free space now.';
export const FIT_LABEL = 'Fit what I have room for, biggest first';
export const FIT_NOTE = 'Sends the biggest files first and stops when the ticked accounts are full. The rest can go later, into another account.';
export const FIT_NOTHING = 'Not even the smallest file fits in the ticked accounts: tick another account.';
export const RECOUNTING = 'Counting again...';

/** What the ticked accounts can take in all (each account's room, keeping 25% free). */
export const roomOf = (picked: readonly GoogleAccountPick[]): number => picked.reduce((s, a) => s + a.room, 0);

/**
 * Is "Fit what I have room for" on? Phone backups only. Until the person touches the tick (`choice` null) it is on exactly when what is ticked is bigger
 * than the room in the ticked accounts; the person's own choice always wins.
 */
export function fitIsOn(preview: Pick<GoogleCopyPreview, 'isPhone' | 'kinds' | 'accounts'>, ticks: ReadonlySet<string>, accountTicks: ReadonlySet<string>, choice: boolean | null): boolean {
  if (!preview.isPhone) return false;
  return choice ?? toPlaceBytes(rowsWithTicks(preview.kinds, ticks)) > roomOf(pickedAccounts(preview, accountTicks));
}

/**
 * The plain line for "fit" mode: "Will send 31.8 GB of 46.0 GB: the 212 biggest files. 14.2 GB waits for another account." Null when the plan is not a
 * fit plan (or not there yet).
 */
export function fitLine(plan: PlanState): string | null {
  if (plan === null || plan === 'loading' || plan.fit !== true) return null;
  const wait = plan.waitingFiles ?? 0;
  if (plan.toPlaceFiles === 0) return null;
  if (wait === 0) return `Everything fits: all ${bytesAndFiles(plan.toPlaceBytes, plan.toPlaceFiles)} will be sent.`;
  const n = plan.toPlaceFiles;
  return `Will send ${googleBytes(plan.toPlaceBytes)} of ${googleBytes(plan.toPlaceBytes + (plan.waitingBytes ?? 0))}: the ${n === 1 ? 'biggest file' : `${formatCount(n)} biggest files`}. ${googleBytes(plan.waitingBytes ?? 0)} waits for another account.`;
}

/** How many bytes the ticked accounts are short by: the real per-file plan when it is there, else the totals. 0 = everything fits. In fit mode nothing is ever short (what does not fit waits). */
export function shortBytes(toPlace: number, picked: readonly GoogleAccountPick[], plan: PlanState, fit = false): number {
  if (fit) return 0;
  const total = toPlace - picked.reduce((s, a) => s + a.room, 0);
  const real = plan !== null && plan !== 'loading' ? plan.unplacedBytes : 0;
  return Math.max(total, real, 0);
}

/** "3.1 GB (120 files)". */
export const bytesAndFiles = (bytes: number, files: number): string => `${googleBytes(bytes)} (${formatCount(files)} ${plural(files, 'file', 'files')})`;

/** "name@example.com: will get 3.1 GB (120 files), ends 62% full". */
export const planLineText = (l: GooglePlanLine): string => `${l.email ?? l.label}: will get ${bytesAndFiles(l.bytes, l.files)}${l.endsPercent === null ? '' : `, ends ${l.endsPercent}% full`}`;

/** The ticked accounts by email for the confirm step, each with what it gets (an account that gets nothing says so). */
export function confirmLines(preview: GoogleCopyPreview, accountTicks: ReadonlySet<string>, plan: PlanState): string[] {
  const lines = plan !== null && plan !== 'loading' ? plan.lines : [];
  return pickedAccounts(preview, accountTicks).map((a) => {
    const l = lines.find((x) => x.placeId === a.placeId);
    return l ? planLineText(l) : `${accountName(a)}: will get nothing`;
  });
}

/** Why the main button cannot be pressed now, in plain words, or null. Every file must fit in the ticked accounts. */
export function cannotStart(preview: GoogleCopyPreview, ticks: ReadonlySet<string>, accountTicks: ReadonlySet<string>, plan: PlanState, fit = false): string | null {
  if (preview.blocker) return preview.blocker;
  if (!preview.driveConnected) return `Plug in ${preview.driveLabel} first: the files are read from it.`;
  const rows = rowsWithTicks(preview.kinds, ticks);
  if (toPlaceFiles(rows) === 0) return ticks.size === 0 ? 'Tick at least one kind of file.' : 'Everything that is ticked is already on Google.';
  const picked = pickedAccounts(preview, accountTicks);
  if (picked.length === 0) return 'Tick at least one Google account.';
  const short = shortBytes(toPlaceBytes(rows), picked, plan, fit);
  if (short > 0) return shortLine(short);
  if (plan === 'loading' || plan === null) return ACCOUNTS_PLAN_LOADING;
  if (fit && plan.toPlaceFiles === 0) return FIT_NOTHING;
  return null;
}

/** The main button of step 2: it only opens step 3. */
export const CHECK_BUTTON = 'Next: check and copy';

/** The main button of step 3 (and of the picker that comes back when the accounts are full): the one that starts the copy. */
export const startButton = (accountTicks: number): string => `Use these ${accountTicks} ${accountWord(accountTicks)} and copy`;

/** The accounts a waiting copy asks about: what is in use stays ticked; the suggestion adds the fewest accounts that cover what is still to go. */
export function moreAccountTicks(preview: Pick<GoogleCopyPreview, 'accounts'>, inUse: readonly string[], needBytes: number): Set<string> {
  const used = new Set(inUse);
  const usedRoom = preview.accounts.filter((a) => used.has(a.placeId) && a.canTake).reduce((s, a) => s + a.room, 0);
  return new Set([...used, ...suggestAccounts(preview.accounts, Math.max(0, needBytes - usedRoom), used)]);
}

// ---- the summary bar, the step headings, the live lines (same three words everywhere: "to send", "placed", "still to place") ----------------------------------

export const GOOGLE_STEP_1 = 'Step 1 of 3 · What to send';
export const GOOGLE_STEP_2 = 'Step 2 of 3 · Where to put it';
export const GOOGLE_STEP_3 = 'Step 3 of 3 · Check and copy';
export const SUMMARY_FITS = '✓ Everything fits';
export const SUMMARY_SHORT = '✗ Tick more accounts or fewer kinds';
export const SUMMARY_NO_ACCOUNT = '✗ Tick an account';
export const SUMMARY_NOTHING = 'Nothing is ticked to send.';

/** 'loading' = the real per-file plan is being worked out; 'none' = no account ticked; 'empty' = nothing to send. */
export type SummaryState = 'loading' | 'fits' | 'short' | 'none' | 'empty';

export interface GoogleSummary {
  state: SummaryState;
  /** The summary as one plain line (the bar shows the same parts). */
  text: string;
  /** The parts of the line, so the bar can lay them out. */
  send: string;
  placed: string;
  still: string;
  verdict: string;
  stillBytes: number;
}

/** What the person ticked, what the ticked accounts take, and what is still left, for the always-visible bar. The real per-file plan wins over the totals. */
export function googleSummary(toSendBytes: number, toSendFiles: number | null, picked: readonly GoogleAccountPick[], plan: PlanState, fit = false): GoogleSummary {
  const fitted = fit && plan !== null && plan !== 'loading' && plan.fit === true && picked.length > 0 && plan.toPlaceFiles > 0;
  // "Fit" mode with its plan: what is sent is the chosen subset, and what does not fit waits (it is not "short").
  if (fitted) {
    const waits = plan.waitingBytes ?? 0;
    const sendNow = `To send: ${bytesAndFiles(plan.toPlaceBytes, plan.toPlaceFiles)}`;
    const waitText = `Waits for another account: ${googleBytes(waits)}`;
    return { state: 'fits', send: sendNow, placed: `Placed: ${googleBytes(plan.toPlaceBytes)} in ${plan.lines.length} ${accountWord(plan.lines.length)}`, still: waitText, verdict: SUMMARY_FITS, stillBytes: 0, text: [sendNow, `Placed: ${googleBytes(plan.toPlaceBytes)} in ${plan.lines.length} ${accountWord(plan.lines.length)}`, waitText].join(' · ') + ` ${SUMMARY_FITS}` };
  }
  const send = `To send: ${toSendFiles === null ? googleBytes(toSendBytes) : bytesAndFiles(toSendBytes, toSendFiles)}`;
  const make = (state: SummaryState, placedBytes: number, accounts: number | null, stillBytes: number, verdict: string, stillPrefix = ''): GoogleSummary => {
    const placed = `Placed: ${googleBytes(placedBytes)}${accounts === null ? '' : ` in ${accounts} ${accountWord(accounts)}`}`;
    const still = `Still to place: ${stillPrefix}${googleBytes(stillBytes)}`;
    return { state, send, placed, still, verdict, stillBytes, text: [send, placed, still].join(' · ') + (verdict === '' ? '' : ` ${verdict}`) };
  };
  if (toSendBytes <= 0 && (toSendFiles ?? 0) <= 0) return { state: 'empty', send, placed: '', still: '', verdict: SUMMARY_NOTHING, stillBytes: 0, text: `${send} · ${SUMMARY_NOTHING}` };
  if (picked.length === 0) return make('none', 0, 0, toSendBytes, SUMMARY_NO_ACCOUNT);
  if (plan === 'loading' || plan === null) {
    // At once, from the totals: what is left already moves with every tick; the exact answer follows.
    const estimate = Math.max(0, toSendBytes - picked.reduce((s, a) => s + a.room, 0));
    return make('loading', toSendBytes - estimate, picked.length, estimate, ACCOUNTS_PLAN_LOADING, estimate > 0 ? 'at least ' : '');
  }
  const still = shortBytes(toSendBytes, picked, plan, fit);
  const accounts = plan.lines.length;
  return still > 0 ? make('short', toSendBytes - still, accounts, still, SUMMARY_SHORT) : make('fits', toSendBytes, accounts, 0, SUMMARY_FITS);
}

/** The summary of the capacity and confirm steps: the ticked kinds against the ticked accounts. */
export function capacitySummary(preview: GoogleCopyPreview, ticks: ReadonlySet<string>, accountTicks: ReadonlySet<string>, plan: PlanState, fit = false): GoogleSummary {
  const rows = rowsWithTicks(preview.kinds, ticks);
  return googleSummary(toPlaceBytes(rows), toPlaceFiles(rows), pickedAccounts(preview, accountTicks), plan, fit);
}

/** The summary of the picker that comes back when the accounts are full: what is still to go (the files only once the plan is known). */
export const moreSummary = (needBytes: number, picked: readonly GoogleAccountPick[], plan: PlanState, fit = false): GoogleSummary => googleSummary(needBytes, plan !== null && plan !== 'loading' ? plan.toPlaceFiles : null, picked, plan, fit);

/** True once, at the moment everything starts to fit: the last settled state was not "fits" and the new one is. A first look (nothing before) and "loading" never count. */
export const becameFits = (before: SummaryState | null, now: SummaryState): boolean => now === 'fits' && before !== null && before !== 'fits' && before !== 'loading';

/** "288 MB ticked" (right of the Step 1 heading). */
export const stepOneNote = (preview: Pick<GoogleCopyPreview, 'kinds'>, ticks: ReadonlySet<string>): string => `${googleBytes(toPlaceBytes(rowsWithTicks(preview.kinds, ticks)))} ticked`;

/** "288 MB to fit · 31.2 GB room in 2 ticked accounts" (right of the Step 2 heading). */
export function stepTwoNote(toSendBytes: number, picked: readonly GoogleAccountPick[]): string {
  if (picked.length === 0) return `${googleBytes(toSendBytes)} to fit · no account ticked`;
  return `${googleBytes(toSendBytes)} to fit · ${googleBytes(picked.reduce((s, a) => s + a.room, 0))} room in ${picked.length} ticked ${accountWord(picked.length)}`;
}

/**
 * One line per ticked account for the account list: what it gets from the real plan ("will get 288 MB (608 files)"), or, while the plan is worked
 * out, a quick guess of what it takes of what is left ("takes about 8.4 GB of what is left"). Accounts that are not ticked get no line.
 */
export function accountGetLines(accounts: readonly GoogleAccountPick[], ticks: ReadonlySet<string>, toSendBytes: number, plan: PlanState): Record<string, string> {
  const picked = sortAccountRows(accounts.filter((a) => a.canTake && ticks.has(a.placeId)));
  const out: Record<string, string> = {};
  if (plan !== null && plan !== 'loading') {
    for (const a of picked) {
      const l = plan.lines.find((x) => x.placeId === a.placeId);
      out[a.placeId] = l ? `will get ${bytesAndFiles(l.bytes, l.files)}` : 'will get nothing';
    }
    return out;
  }
  let left = toSendBytes;
  for (const a of picked) {
    const take = Math.min(a.room, Math.max(left, 0));
    left -= take;
    out[a.placeId] = `takes about ${googleBytes(take)} of what is left`;
  }
  return out;
}

/** "Worked through 120 MB of 288 MB · 168 MB to go" while the copy runs (includes files that failed; what Google really holds is on the account lines). */
export const progressLine = (doneBytes: number, totalBytes: number): string => `Worked through ${googleBytes(doneBytes)} of ${googleBytes(totalBytes)} · ${googleBytes(Math.max(0, totalBytes - doneBytes))} to go`;

/**
 * One line per account while the copy runs. Live (the main side says what each account was sent so far): "name@example.com: 60 MB of 144 MB". Until the
 * first live numbers arrive: "name@example.com: 144 MB to send", from the plan the person confirmed. An account that gets nothing has no line. The name
 * is the account's email when the confirmed plan is known (it is not after a restart), else its label.
 */
export function runningAccountLines(plan: readonly GooglePlanLine[] | null, sent: readonly GoogleSentLine[] = []): string[] {
  const nameOf = (placeId: string, label: string): string => plan?.find((p) => p.placeId === placeId)?.email ?? label;
  const live = sent.filter((l) => l.toSend > 0 || l.bytes > 0).toSorted((a, b) => (a.placeId < b.placeId ? -1 : 1));
  if (live.length > 0) return live.map((l) => `${nameOf(l.placeId, l.label)}: ${googleBytes(l.bytes)} of ${googleBytes(Math.max(l.toSend, l.bytes))}`);
  return (plan ?? []).map((l) => `${l.email ?? l.label}: ${googleBytes(l.bytes)} to send`);
}

export const REPEATS_REASON = 'repeats (same picture in another phone backup): sent once';
export const ALREADY_REASON = 'already in Google from an earlier copy (checked, not sent again)';

/** After the copy, the same three numbers: sent, not sent (and why, in the report below), repeats (sent once), already in Google from an earlier copy. */
export function reportSummaryLine(r: GoogleCopyReport): string {
  const notSent = r.heldBack.reduce((s, h) => s + h.count, 0) + r.failed.reduce((s, f) => s + f.count, 0) + r.noRoom.files;
  const sent = `Sent ${bytesAndFiles(r.copied.bytes, r.copied.files)}`;
  const not = notSent === 0 ? 'Not sent: nothing' : `Not sent: ${formatCount(notSent)} ${plural(notSent, 'file', 'files')} (why is listed below)`;
  const repeats = r.repeats ?? 0;
  return `${sent} · ${not}${repeats > 0 ? ` · Repeats (same picture in another phone backup): ${formatCount(repeats)}, sent once` : ''}${r.alreadyThere > 0 ? ` · Already in Google from an earlier copy: ${formatCount(r.alreadyThere)}, checked, not sent again` : ''}`;
}

export function googleReportData(r: GoogleCopyReport, finishedAt: string): ReportData {
  const skipped = [
    ...r.heldBack.map((h) => ({ reason: `not sent: ${h.reason}`, count: h.count, examples: h.examples })),
    ...((r.repeats ?? 0) > 0 ? [{ reason: REPEATS_REASON, count: r.repeats, examples: [] as string[] }] : []),
    ...(r.alreadyThere > 0 ? [{ reason: ALREADY_REASON, count: r.alreadyThere, examples: [] as string[] }] : []),
    ...(r.noRoom.files > 0 ? [{ reason: `no account had room (${googleBytes(r.noRoom.bytes)}; every account keeps 25% free)`, count: r.noRoom.files, examples: [] as string[] }] : []),
  ];
  return {
    copied: r.copied,
    skipped,
    failed: r.failed.map((f) => ({ reason: f.reason, count: f.count, examples: f.examples })),
    where: r.perAccount.map((a) => `${a.label}: ${formatCount(a.files)} ${plural(a.files, 'file', 'files')}, ${googleBytes(a.bytes)}`),
    finished: finishedAt,
  };
}
