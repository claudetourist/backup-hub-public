/**
 * Copy a backup to Google (R1.4 "Google destination", PLAN.md Google features G1 to G3): types and pure rules shared by main and the window.
 *
 * THE CONTRACT with "Free up phone space" (written once here, relied on by the clean-up code):
 *   - A phone file is on Google when a files row of a Google account (places.kind = 'gdrive') has `sha256` equal to the phone file's sha256
 *     AND `verified_how = 'google-md5'` AND `gone_at IS NULL`.
 *   - Backup Hub writes such a row only after (1) the copy on the T7 was read again and its SHA-256 equalled the row's, (2) the file was
 *     uploaded whole to one account, and (3) Google's md5Checksum equalled the MD5 read from the same T7 bytes. The row holds: ext_id (the Drive
 *     file id), rel_path ("My Drive/Backup Hub/<backup name>/<path inside the backup folder>"), size, md5 (Google's), sha256 (read from the T7 copy),
 *     origin_file_id (the T7 copy's files.id), verified_at, verified_how = 'google-md5'. The T7 row gets its md5 too when it had none.
 *   - A kind of file the person left out of Google is stored as a backup_rules row: scope 'pattern', pattern 'kind:<kind>' (for example
 *     'kind:video-whatsapp'), choice 'leave_out', destination 'google', backup_id = the backup. Phone clean-up must never offer a file of such a kind
 *     (the person said it does not belong in Google). The older code that reads backup_rules ignores every row that has a destination.
 *   - Nothing in Google is ever deleted or changed by this work.
 */
import { FILE_KINDS, KIND_LABELS, type FileKind } from './fileKinds';
import type { ReasonLine } from './phoneBackup';

export const GOOGLE_COPY_JOB_KIND = 'google.copy';
/** The one folder in each account's My Drive that holds everything Backup Hub puts there. */
export const GOOGLE_TOP_FOLDER = 'Backup Hub';
export const GOOGLE_VERIFIED_HOW = 'google-md5';
export const GOOGLE_LEAVE_OUT_DESTINATION = 'google';
/** An account keeps this share of its space free: a file is only placed where the account stays at or below 75% used. */
export const GOOGLE_KEEP_FREE_PERCENT = 25;

export const googleKindPattern = (kind: FileKind): string => `kind:${kind}`;
export const kindOfGooglePattern = (pattern: string): FileKind | null => {
  const kind = pattern.startsWith('kind:') ? pattern.slice(5) : '';
  return (FILE_KINDS as readonly string[]).includes(kind) ? (kind as FileKind) : null;
};

/** Ticked when the capacity screen is opened for the first time (a kind the person left out earlier stays unticked). */
export const DEFAULT_GOOGLE_KINDS: readonly FileKind[] = ['video-camera', 'video-whatsapp', 'video-other', 'photo-screenshot', 'photo-camera', 'photo-whatsapp'];

/** The order of the list and of the upload: camera videos, WhatsApp videos, other videos, screenshots, photos, then the rest. Biggest files first inside a kind. */
export const GOOGLE_KIND_ORDER: readonly FileKind[] = [
  'video-camera',
  'video-whatsapp',
  'video-other',
  'photo-screenshot',
  'photo-camera',
  'photo-whatsapp',
  'photo-other',
  'audio-recording',
  'audio-music',
  'documents',
  'google-docs',
  'archives',
  'other',
  'empty',
];

export function kindRank(kind: FileKind): number {
  const at = GOOGLE_KIND_ORDER.indexOf(kind);
  return at === -1 ? GOOGLE_KIND_ORDER.length : at;
}

/** Bytes an account can still take while staying at or below 75% used. Null limit or usage = not known = nothing can be placed. */
export function accountRoomBytes(limit: number | null, usage: number | null): number {
  if (limit === null || usage === null || limit <= 0) return 0;
  return Math.max(0, Math.floor((limit * (100 - GOOGLE_KEEP_FREE_PERCENT)) / 100) - usage);
}

export interface PoolAccount {
  placeId: string;
  /** Bytes still free to place into (already keeping the 25% free). */
  room: number;
}

/**
 * The account for one file: the one with the least room that still fits it (so big rooms stay for big files). A file is never split: null when no
 * account has room for the whole file.
 */
export function chooseAccount<T extends PoolAccount>(size: number, accounts: readonly T[]): T | null {
  let best: T | null = null;
  for (const a of accounts) if (a.room >= size && (best === null || a.room < best.room)) best = a;
  return best;
}

/** How many files go to Google at the same time: at most this many in all, and at most GOOGLE_COPY_PER_ACCOUNT into one account. */
export const GOOGLE_COPY_AT_ONCE = 6;
export const GOOGLE_COPY_PER_ACCOUNT = 4;

/** What one ticked account has been sent in a copy, live: the window shows "email: 60 MB of 144 MB". */
export interface GoogleSentLine {
  placeId: string;
  label: string;
  /** Files of this copy that are in this account and checked (recorded). */
  files: number;
  /** Bytes sent to this account in this copy: the checked files plus the part of the file on its way. */
  bytes: number;
  /** What this account is planned to get in this copy in all (never less than what it already has). */
  toSend: number;
}

/** One kind of file on the capacity screen. */
export interface GoogleKindRow {
  kind: FileKind;
  label: string;
  /** Files of this kind in the backup with a known checksum, and their size. */
  files: number;
  bytes: number;
  /** Of those, already on Google (same checksum, checked against Google's own). */
  onGoogleFiles: number;
  onGoogleBytes: number;
  /** Still to go (not on Google yet). */
  toGoFiles: number;
  toGoBytes: number;
  /** Files of this kind still to go that are repeats of another file in the list (the same picture in an older phone backup). They are NOT in files / toGoFiles: each content is sent once. */
  repeatFiles: number;
  ticked: boolean;
  /** The person left this kind out of Google earlier. */
  leftOut: boolean;
}

export interface GoogleRoom {
  /** Accounts that can take files now (signed in, size known, of the backup's owner). */
  accounts: number;
  /** Total room in them, keeping 25% free. */
  roomBytes: number;
}

/** Why an account is greyed out on the capacity screen (plain words, shown as they are). */
export const ACCOUNT_FULL_REASON = `full: keeps ${GOOGLE_KEEP_FREE_PERCENT}% free`;
export const ACCOUNT_SIGNIN_REASON = 'needs signing in';
export const ACCOUNT_UNKNOWN_REASON = 'space not known yet: press Refresh on Devices';
export const accountCheckFailedReason = (why: string): string => `could not check: ${why}`;
/** The question a copy asks (state needs_you) when the accounts the person picked have no room for the next file. The window shows the picker again for this exact text. */
export const ACCOUNTS_FULL_MESSAGE = 'The accounts you picked are full. Pick more accounts to continue.';
/** An account's room is asked from Google again before a file goes into it when the last answer is older than this. */
export const ACCOUNT_ROOM_STALE_MS = 120_000;

/** One Google account of the backup's owner as a row of the "Which accounts?" step. */
export interface GoogleAccountPick {
  placeId: string;
  label: string;
  email: string | null;
  limit: number | null;
  usage: number | null;
  /** limit - usage, null when either is not known. */
  free: number | null;
  /** Bytes it can still take inside the keep-free line. */
  room: number;
  /** Used share in whole percent, null when not known. */
  percent: number | null;
  /** The numbers were asked from Google just now (false for an account that needs signing in, or when Google could not be asked). */
  checkedNow: boolean;
  canTake: boolean;
  /** Why it cannot take anything now, or null. */
  reason: string | null;
  needsSignIn: boolean;
  /** Ticked the last time this backup was copied to Google (nothing the first time). Only ever true when it can take files. */
  ticked: boolean;
}

/** The row of one account from what is known about it (a size known only from Google right now counts the same as a stored one). */
export function accountPick(a: { placeId: string; label: string; email: string | null; limit: number | null; usage: number | null; needsSignIn: boolean; remembered: boolean; checkedNow: boolean; checkFailed: string | null }): GoogleAccountPick {
  const failed = a.checkFailed !== null;
  const known = !failed && a.limit !== null && a.usage !== null && a.limit > 0;
  const room = a.needsSignIn || failed ? 0 : accountRoomBytes(a.limit, a.usage);
  const reason = a.needsSignIn ? ACCOUNT_SIGNIN_REASON : failed ? accountCheckFailedReason(a.checkFailed as string) : !known ? ACCOUNT_UNKNOWN_REASON : room <= 0 ? ACCOUNT_FULL_REASON : null;
  return {
    placeId: a.placeId,
    label: a.label,
    email: a.email,
    limit: failed ? null : a.limit,
    usage: failed ? null : a.usage,
    free: known ? Math.max(0, (a.limit as number) - (a.usage as number)) : null,
    room,
    percent: known ? Math.min(100, Math.round(((a.usage as number) / (a.limit as number)) * 100)) : null,
    checkedNow: a.checkedNow && !failed,
    canTake: reason === null,
    reason,
    needsSignIn: a.needsSignIn,
    ticked: reason === null && a.remembered,
  };
}

export interface GoogleCopyPreview {
  backupId: number;
  backupName: string;
  /** A phone backup: the screen offers "Only what is still on the phone" and "Fit what I have room for". */
  isPhone: boolean;
  /** The counts below only hold files whose content is still on the phone (the phone's latest listing). Always false for a backup that is not a phone backup. */
  onlyOnPhone: boolean;
  driveLabel: string;
  driveConnected: boolean;
  kinds: GoogleKindRow[];
  room: GoogleRoom;
  /** Files with no checksum yet: they cannot go until "Check old copies" has read them. */
  noChecksumFiles: number;
  /** Why nothing can be started now (vault locked, no Google app key, no account), or null. */
  blocker: string | null;
  /** Every Google account of the backup's owner (not removed), for the "Which accounts?" step. */
  accounts: GoogleAccountPick[];
}

export type GoogleCopyPreviewResult = { ok: true; preview: GoogleCopyPreview } | { ok: false; message: string };

export interface GoogleCopyStatus {
  backupId: number;
  /** Files of the backup that are on Google (kinds left out of Google are not counted), and their size. */
  filesOnGoogle: number;
  bytesOnGoogle: number;
  /** Still to go (kinds left out of Google are not counted). */
  filesToGo: number;
  bytesToGo: number;
}

export type GoogleCopyStatusResult = { ok: true; status: GoogleCopyStatus } | { ok: false; message: string };

export interface GoogleCopyStartRequest {
  backupId: number;
  /** The kinds that are ticked. Every other kind in the list is saved as "leave out of Google". */
  kinds: string[];
  /** The ticked Google accounts (place ids): the only ones the copy may use. The main side checks them. */
  accountIds: string[];
  /** True only when the person confirmed the accounts on the confirm step. Anything else is refused. */
  confirmedAccounts: boolean;
  /** The room (bytes, keeping 25% free) each ticked account had on the screen. If a fresh check finds less, nothing starts and the screen is updated. */
  seenRoom: Record<string, number>;
  /** Phone backups only: send only files whose content is still on the phone (default false when left out; the window sends true by default). */
  onlyOnPhone?: boolean | undefined;
  /** Send only what the ticked accounts have room for, biggest files first (default false: every ticked file must fit, else nothing starts). */
  fitBiggest?: boolean | undefined;
}

/** `changed`: the numbers moved since the screen was drawn (or the files no longer fit): the window reloads the picker and says so; nothing was started. */
export type GoogleCopyStartResult = { ok: true; jobId: number; message: string } | { ok: false; message: string; changed?: boolean };

export interface GoogleAccountLine {
  label: string;
  files: number;
  bytes: number;
}

export interface GoogleCopyReport {
  copied: { files: number; bytes: number };
  /** Already on Google from an earlier copy (same checksum, checked): not sent again. */
  alreadyThere: number;
  /** Files that are repeats of another file of this copy (the same picture in another phone backup): the content is sent once. */
  repeats: number;
  /** Files not sent because the copy on the T7 did not match its checksum, or was not there or changed. */
  heldBack: ReasonLine[];
  /** Files that could not be sent or did not check out in Google (nothing was deleted). */
  failed: ReasonLine[];
  /** Files no account had room for (keeping 25% free). */
  noRoom: { files: number; bytes: number };
  /** Files whose copy in Google came back different. They are in Google; Backup Hub did not count them and did not delete them. */
  mismatches: number;
  perAccount: GoogleAccountLine[];
  /** True when the run was stopped before the end. */
  stopped: boolean;
}

// ---- words (pure, shared by the capacity screen and tests) ------------------------------------------------------------------------------------

/** Sizes on the Google screens are shown the way Google Drive shows them (1 MB = 1,048,576 bytes, 1 GB = 1024^3), so they match the account's storage line. Other screens keep their own units. */
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const gb = (n: number): string => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB).toLocaleString('en-US')} MB`);
export const googleBytes = gb;

export function ticked(rows: readonly GoogleKindRow[]): GoogleKindRow[] {
  return rows.filter((r) => r.ticked);
}

export function toPlaceBytes(rows: readonly GoogleKindRow[]): number {
  return ticked(rows).reduce((s, r) => s + r.toGoBytes, 0);
}

export function toPlaceFiles(rows: readonly GoogleKindRow[]): number {
  return ticked(rows).reduce((s, r) => s + r.toGoFiles, 0);
}

/** "12.3 GB to place / 80.0 GB room in 5 accounts (keeping 25% free)". */
export function capacityLine(toPlace: number, room: GoogleRoom): string {
  return `${gb(toPlace)} to place / ${gb(room.roomBytes)} room in ${room.accounts} ${room.accounts === 1 ? 'account' : 'accounts'} (keeping ${GOOGLE_KEEP_FREE_PERCENT}% free)`;
}

/** True when the ticked kinds fit in the room (as one pool; each file still needs one account with room for it). */
export function fitsInRoom(toPlace: number, room: GoogleRoom): boolean {
  return toPlace <= room.roomBytes;
}

/** The kinds as a list sorted for the screen (see GOOGLE_KIND_ORDER); kinds with no files are dropped. */
export function sortKindRows(rows: readonly GoogleKindRow[]): GoogleKindRow[] {
  return rows.filter((r) => r.files > 0).toSorted((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

export const kindLabel = (kind: FileKind): string => KIND_LABELS[kind];

/** "1,200 files, 30.1 GB on Google. 300 files (4.0 GB) to go." */
export function googleStatusLine(s: GoogleCopyStatus): string {
  const on = s.filesOnGoogle === 0 ? 'Nothing is on Google yet.' : `${s.filesOnGoogle.toLocaleString('en-US')} ${s.filesOnGoogle === 1 ? 'file' : 'files'}, ${gb(s.bytesOnGoogle)} on Google.`;
  const go = s.filesToGo === 0 ? 'Nothing left to go.' : `${s.filesToGo.toLocaleString('en-US')} ${s.filesToGo === 1 ? 'file' : 'files'} (${gb(s.bytesToGo)}) to go.`;
  return `${on} ${go}`;
}

// ---- Google accounts: add, whose, sign out, remove, the Google app key (G1, G2) -------------------------------------------------------------------

export type GoogleAddResult = { ok: true; placeId: string; label: string; message: string } | { ok: false; message: string };
export type GoogleAccountActionResult = { ok: true; message: string } | { ok: false; message: string };

export interface GoogleKeyStatus {
  /** The Google app key (client id and secret) is saved. The secret itself is never sent to the window. */
  saved: boolean;
  /** Why the key cannot be read or saved right now (the saved sign-ins are locked), or null. */
  problem: string | null;
}

export interface GoogleKeyInput {
  clientId: string;
  clientSecret: string;
}

// ---- where the files go: the real per-file plan, the live words, suggestion, more accounts (the person always chooses) -------------------------------

/** The accounts as the plan and the run see them: the room is already inside the keep-free line. */
export interface PlacerAccount {
  placeId: string;
  label: string;
  email: string | null;
  limit: number | null;
  usage: number | null;
  room: number;
}

export interface GooglePlanLine {
  placeId: string;
  label: string;
  email: string | null;
  files: number;
  bytes: number;
  /** How full the account is when this is done, in whole percent, null when its size is not known. */
  endsPercent: number | null;
}

export interface GoogleCopyPlan {
  /** Only the accounts that get at least one file. */
  lines: GooglePlanLine[];
  toPlaceFiles: number;
  toPlaceBytes: number;
  /** Files that fit in none of the ticked accounts (never split, never sent anywhere else). Always 0 in "fit what I have room for" mode. */
  unplacedFiles: number;
  unplacedBytes: number;
  /** "Fit what I have room for" mode only: toPlace* is then what WILL be sent and these are the files that wait for another account. */
  fit?: true;
  waitingFiles?: number;
  waitingBytes?: number;
}

/**
 * The same rule as the run, file by file: among the ticked accounts that have a free place for another file (fewer than GOOGLE_COPY_PER_ACCOUNT on
 * their way, and fewer than GOOGLE_COPY_AT_ONCE in all), the one with the least room that still fits the whole file (see chooseAccount). The room is
 * reserved when a file is picked, so the plan can never put more into an account than it has. A file takes its place until its bytes are sent (every
 * upload is thought to go at the same speed), and a file that finds no free place waits for the first one to finish. A file that fits no account at
 * all (counting what is already reserved) is "unplaced".
 */
export class Placer {
  private readonly pool: (PlacerAccount & { files: number; bytes: number; ends: number[] })[];
  private unplaced = { files: 0, bytes: 0 };
  /** Fit mode: a file that fits nowhere is left out (it waits for another account), not counted as unplaced. */
  private waiting = { files: 0, bytes: 0 };
  private all = { files: 0, bytes: 0 };
  /** The plan's own clock: bytes "sent" so far by every upload going together. */
  private clock = 0;

  constructor(
    accounts: readonly PlacerAccount[],
    private readonly fit = false,
  ) {
    this.pool = accounts.map((a) => ({ ...a, files: 0, bytes: 0, ends: [] }));
  }

  /** Places one file; true when it went into an account. A file that fits nowhere is "unplaced" (or, in fit mode, left out to wait) and gives false. */
  put(size: number): boolean {
    for (;;) {
      let running = 0;
      for (const a of this.pool) {
        a.ends = a.ends.filter((e) => e > this.clock);
        running += a.ends.length;
      }
      const a = running < GOOGLE_COPY_AT_ONCE ? chooseAccount(size, this.pool.filter((x) => x.ends.length < GOOGLE_COPY_PER_ACCOUNT)) : null;
      if (a !== null) {
        a.room -= size; // reserved before it is sent, as the run does
        a.files += 1;
        a.bytes += size;
        a.ends.push(this.clock + Math.max(size, 1));
        this.all.files += 1;
        this.all.bytes += size;
        return true;
      }
      if (running === 0 || chooseAccount(size, this.pool) === null) {
        if (this.fit) {
          this.waiting.files += 1;
          this.waiting.bytes += size;
        } else {
          this.all.files += 1;
          this.all.bytes += size;
          this.unplaced.files += 1;
          this.unplaced.bytes += size;
        }
        return false;
      }
      this.clock = Math.min(...this.pool.flatMap((x) => x.ends)); // only places that are taken have room: one is free again when its file is sent
    }
  }

  result(): GoogleCopyPlan {
    return {
      lines: this.pool
        .filter((a) => a.files > 0)
        .map((a) => ({ placeId: a.placeId, label: a.label, email: a.email, files: a.files, bytes: a.bytes, endsPercent: a.limit !== null && a.usage !== null && a.limit > 0 ? Math.min(100, Math.round(((a.usage + a.bytes) / a.limit) * 100)) : null })),
      toPlaceFiles: this.all.files,
      toPlaceBytes: this.all.bytes,
      unplacedFiles: this.unplaced.files,
      unplacedBytes: this.unplaced.bytes,
      ...(this.fit ? { fit: true as const, waitingFiles: this.waiting.files, waitingBytes: this.waiting.bytes } : {}),
    };
  }
}

/** "Short by 12.4 GB: tick more accounts or fewer kinds". */
export const shortLine = (bytes: number): string => `Short by ${gb(Math.max(bytes, 1))}: tick more accounts or fewer kinds`;

/**
 * The accounts Backup Hub SUGGESTS (the person confirms or changes the ticks): the fewest accounts that can take `needBytes`, most "can still take"
 * first. When even all of them cannot, all that can take anything. `skip` = accounts already in use (never suggested again).
 */
export function suggestAccounts(accounts: readonly GoogleAccountPick[], needBytes: number, skip: ReadonlySet<string> = new Set()): string[] {
  if (needBytes <= 0) return [];
  const usable = accounts.filter((a) => a.canTake && !skip.has(a.placeId)).toSorted((a, b) => b.room - a.room || (a.label < b.label ? -1 : 1));
  const out: string[] = [];
  let have = 0;
  for (const a of usable) {
    if (have >= needBytes && out.length > 0) break;
    out.push(a.placeId);
    have += a.room;
  }
  return out;
}

export interface GoogleCopyPlanRequest {
  backupId: number;
  kinds: string[];
  accountIds: string[];
  /** Same two switches as the start (see GoogleCopyStartRequest). */
  onlyOnPhone?: boolean | undefined;
  fitBiggest?: boolean | undefined;
}

export type GoogleCopyPlanResult = { ok: true; plan: GoogleCopyPlan } | { ok: false; message: string };

/** The picker again for a copy that stopped because the ticked accounts are full. */
export type GoogleCopyMoreResult =
  | {
      ok: true;
      preview: GoogleCopyPreview;
      /** The accounts the copy already uses (ticked, cannot be unticked). */
      inUse: string[];
      /** The kinds the copy sends. */
      kinds: string[];
      /** What is still to go for those kinds. */
      needBytes: number;
      /** The switches the copy was started with (so the picker plans the same way). */
      onlyOnPhone?: boolean;
      fitBiggest?: boolean;
    }
  | { ok: false; message: string };

export interface GoogleCopyAddAccountsRequest {
  jobId: number;
  /** The accounts to add to the copy (the person's ticks, after the confirm step). */
  accountIds: string[];
  confirmedAccounts: boolean;
}
