/**
 * Place and drive types shared by main, preload and renderer. Pure data and pure functions only.
 */

import { CARD_WORDS } from './appFolders';
import type { DriveRefreshView } from './drive';
import type { PlaceFingerprint } from './fingerprint';
import type { PlaceJobRef } from './jobs';
import type { ListingState, PlaceFileStats } from './listing';

export type PlaceKind = 'laptop' | 'drive' | 'phone' | 'gdrive' | 'onedrive';
/** 'problem': a known drive that is plugged in but Windows cannot read it properly right now (see `PlaceView.problem`). Not usable. */
export type PlaceStatus = 'connected' | 'disconnected' | 'unknown' | 'needs_signin' | 'problem';

/** The plain words for a drive that is plugged in but cannot be read properly. */
export const DRIVE_PROBLEM_WORDS = (letter: string | null): string =>
  `Plugged in${letter ? ` at ${letter}` : ''}, but Windows can't read it properly right now. Nothing is written to it. Try another cable or USB port.`;

/** What the Sources screen shows for a Google Drive account (no email address: the label is enough). */
export interface GdrivePlaceInfo {
  quotaLimitBytes: number | null;
  quotaUsageBytes: number | null;
  /** Part of the usage that is Drive files (the rest is Gmail and Photos). Null until a refresh has asked Google. */
  quotaDriveBytes: number | null;
  /** Part of the Drive usage that sits in the Drive trash. */
  quotaTrashBytes: number | null;
  /** Refresh state, job and sign-in state. */
  refresh: DriveRefreshView;
  /** True when "Refresh" can be offered (signed in, no refresh under way). */
  canRefresh: boolean;
  /** Files listed for this account in the catalog. */
  fileCount: number;
  /** True while the catalog and quota still come from the Fleet Manager v1 import. */
  fromV1: boolean;
}

/** A place as the Sources screen shows it. Timestamps are epoch ms. */
export interface PlaceView {
  id: string;
  kind: PlaceKind;
  label: string;
  profileId: number;
  profileName: string;
  status: PlaceStatus;
  /** Last drive letter seen, e.g. "E:". Only a hint: drives are identified by their card. */
  rootHint: string | null;
  /** Live while connected, last known otherwise. */
  capacityBytes: number | null;
  freeBytes: number | null;
  /** When the last complete file listing of this place finished (epoch ms), or null if there never was one. */
  lastLookedAt: number | null;
  /** When the place was last seen connected (drives and OneDrive); null if never. */
  lastConnectedAt: number | null;
  /** Files, size and cloud-only count from the last listing; null for places that are not listed (yet). */
  files: PlaceFileStats | null;
  /** Whether a listing job for this place is waiting or running. */
  listing: ListingState;
  /** What a running listing is doing right now (files so far and speed), else null. */
  listingDetail: string | null;
  /** The listing job of this place, for Pause, Resume and Stop; null when none is queued, running or paused. */
  listJob: PlaceJobRef | null;
  /** True when "List now" can be offered (a listable place that is connected, with no listing under way). */
  canList: boolean;
  /** Plain words when a known drive is plugged in but cannot be read properly (status 'problem'), else null. */
  problem: string | null;
  /** Fingerprints and copies for the laptop, named drives and OneDrive; null for other places. */
  fingerprint: PlaceFingerprint | null;
  /** True when "Fingerprint now" can be offered (connected, files waiting, no fingerprinting under way). */
  canFingerprint: boolean;
  /** Folders to list. Only the laptop shows these (absolute paths); null for other places. */
  roots: string[] | null;
  /** True for the laptop this copy of the app runs on. */
  thisDevice: boolean;
  /** Only for kind 'gdrive'. */
  gdrive: GdrivePlaceInfo | null;
  /** Laptop only: drive letters on the same physical disk as Windows (never offered for naming). */
  laptopVolumes: string[] | null;
  /** Phones only: the person pressed "Safe to unplug"; adb is let go and not asked about this phone until it is plugged in again. */
  safeToUnplug?: boolean;
}

/** A connected drive with no usable ID card yet. */
export interface UnnamedDriveView {
  /** "E:" */
  letter: string;
  label: string;
  fileSystem: string | null;
  capacityBytes: number | null;
  freeBytes: number | null;
  driveType: 'removable' | 'fixed';
  /** False when "Name this drive" must not be offered; `reason` says why in plain words. */
  canName: boolean;
  reason: string | null;
  /** Serial-number match with a drive we already know: "probably T7, confirm". */
  probable: { placeId: string; label: string } | null;
}

export interface PlacesSnapshot {
  places: PlaceView[];
  unnamed: UnnamedDriveView[];
  /** When the volumes were last listed (epoch ms); null until the first listing. */
  listedAt: number | null;
  /** Plain-language problem from the last listing attempt, or null. */
  listError: string | null;
  /** When the file counts shown with the places were last counted (epoch ms); null before the first count. They are recounted in the background. */
  statsCountedAt: number | null;
}

export const MAX_LABEL_LENGTH = 60;

export type LabelCheck = { ok: true; value: string } | { ok: false; message: string };

/** Names for places, drives and profiles: trimmed, 1 to 60 characters, no control characters. */
export function checkLabel(raw: unknown, what = 'name'): LabelCheck {
  if (typeof raw !== 'string') return { ok: false, message: `Please type a ${what}.` };
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length === 0) return { ok: false, message: `Please type a ${what}.` };
  if (value.length > MAX_LABEL_LENGTH) return { ok: false, message: `Keep the ${what} under ${MAX_LABEL_LENGTH + 1} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(value)) {
    return { ok: false, message: `The ${what} cannot contain these characters: < > : " / \\ | ? *` };
  }
  return { ok: true, value };
}

/** The sentence the UI shows before a card is written, and the user confirms. */
export function nameDriveConfirmation(letter: string): string {
  return `This writes a small file (${CARD_WORDS}) to ${letter}. Nothing else changes.`;
}

export type NameDriveCode =
  | 'needs-confirmation'
  | 'bad-name'
  | 'name-in-use'
  | 'not-found'
  | 'system-drive'
  | 'not-allowed'
  | 'has-card'
  | 'write-failed'
  | 'no-database';

export type NameDriveResult =
  | { ok: true; placeId: string; name: string }
  | { ok: false; code: NameDriveCode; message: string };

export interface NameDriveRequest {
  letter: string;
  name: string;
  /** Must be true: set only after the user ticked the confirmation sentence in the UI. */
  confirmed: boolean;
  /** Re-writing the card for a drive we already know ("probably T7, confirm"). */
  existingPlaceId?: string;
}

export type RenameResult = { ok: true; label: string } | { ok: false; message: string };

/** "Eject": what the button gets back. Never forces anything; Windows has the last word. */
export type EjectResult =
  /** Windows let go of the drive: it can be unplugged. */
  | { ok: true; message: string }
  /** Jobs are still using the drive: the window asks first, then calls again with `confirmed`. */
  | { ok: false; needsConfirm: true; jobs: { id: number; title: string }[]; message: string }
  /** Windows refused, or the drive was not found. `blockedBy` is the program Windows named, when it said. */
  | { ok: false; needsConfirm?: false; message: string; blockedBy: string | null };
