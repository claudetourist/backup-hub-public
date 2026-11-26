import type { PlaceKind, PlaceStatus, PlaceView, UnnamedDriveView } from '../../shared/places';
import type { Tone } from '../components/status';
import { formatWhen } from '../jobs/jobsModel';
import { shortDate } from '../backups/backupsModel';
import { formatBytes, formatCount } from '../lib/format';

/** Pure helpers behind the Sources screen and the Home "Connected drives" line. */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A listing older than this is shown in amber. */
export const STALE_LISTING_MS = 7 * DAY_MS;

const KIND_LABELS: Record<PlaceKind, string> = {
  laptop: 'Laptop',
  drive: 'Drive',
  phone: 'Phone',
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
};

export function placeKindLabel(kind: PlaceKind): string {
  return KIND_LABELS[kind];
}

export function placeStatus(status: PlaceStatus, kind: PlaceKind): { tone: Tone; label: string } {
  if (status === 'connected') return { tone: 'ok', label: kind === 'laptop' ? 'This laptop' : 'Connected' };
  if (status === 'disconnected') return { tone: 'neutral', label: kind === 'drive' ? 'Not plugged in' : 'Not connected' };
  if (status === 'needs_signin') return { tone: 'amber', label: 'Needs sign-in' };
  if (status === 'problem') return { tone: 'amber', label: 'Plugged in, but not readable' };
  if (kind === 'gdrive') return { tone: 'neutral', label: 'Not checked yet' };
  return { tone: 'neutral', label: 'Checking' };
}

/** "322 GB free of 1 TB", or an empty string when the size is unknown. */
export function spaceText(freeBytes: number | null, capacityBytes: number | null): string {
  if (capacityBytes === null) return '';
  if (freeBytes === null) return `${formatBytes(capacityBytes)} in total`;
  return `${formatBytes(freeBytes)} free of ${formatBytes(capacityBytes)}`;
}

/** Fraction of the drive that is in use (0..1), or null when unknown. */
export function usedFraction(freeBytes: number | null, capacityBytes: number | null): number | null {
  if (freeBytes === null || capacityBytes === null || capacityBytes <= 0) return null;
  return Math.min(1, Math.max(0, 1 - freeBytes / capacityBytes));
}

/** When the place's files were last listed completely. Older than 7 days, or never, is amber. */
export function lastLookedText(lastLookedAt: number | null, now: number): { text: string; tone: Tone } {
  if (lastLookedAt === null) return { text: 'Never', tone: 'amber' };
  const stale = now - lastLookedAt > STALE_LISTING_MS;
  return { text: formatWhen(lastLookedAt, now), tone: stale ? 'amber' : 'neutral' };
}

/** When a place was last checked, in few words: "today 09:39", "yesterday", "9 Nov" (with the year when it is not this year). */
export function checkedWhen(ms: number, now: number): string {
  const day = (t: number): number => {
    const d = new Date(t);
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
  };
  const days = day(now) - day(ms);
  if (days <= 0) {
    const d = new Date(ms);
    return `today ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return days === 1 ? 'yesterday' : shortDate(ms, now);
}

/** A Google account row: "Checked 22 Nov", or "Not checked yet". */
export const accountCheckedText = (lastLookedAt: number | null, now: number): string => (lastLookedAt === null ? 'Not checked yet' : `Checked ${checkedWhen(lastLookedAt, now)}`);

/** "Seen connected": now for a connected place, otherwise when it was last plugged in. A phone has no plug-in time of its own: it was plugged in when the app last read it. */
export function seenConnectedText(place: Pick<PlaceView, 'status' | 'lastConnectedAt' | 'kind'> & Partial<Pick<PlaceView, 'lastLookedAt'>>, now: number): string {
  if (place.status === 'connected' || place.status === 'problem') return 'Now';
  if (place.lastConnectedAt === null && place.kind === 'phone' && typeof place.lastLookedAt === 'number') return formatWhen(place.lastLookedAt, now);
  if (place.lastConnectedAt === null) return place.kind === 'drive' || place.kind === 'onedrive' ? 'Never' : '';
  return formatWhen(place.lastConnectedAt, now);
}

/** Files line for a listed place: "12,345 files · 4.2 GB", or why there is nothing yet. */
export function filesText(place: Pick<PlaceView, 'files' | 'lastLookedAt'>): string {
  if (!place.files || place.files.files === 0) return place.lastLookedAt === null ? 'Not listed yet' : '0 files';
  return `${formatCount(place.files.files)} ${place.files.files === 1 ? 'file' : 'files'} · ${formatBytes(place.files.totalBytes)}`;
}

/** Second line under the files count when OneDrive placeholders are listed. */
export function cloudOnlyText(place: Pick<PlaceView, 'files'>): string {
  const n = place.files?.cloudOnly ?? 0;
  return n > 0 ? `${formatCount(n)} only in the cloud` : '';
}

/** What the listing is doing right now, in plain words ('' when idle). */
export function listingStateText(listing: PlaceView['listing']): string {
  if (listing === 'running') return 'Checking now';
  if (listing === 'queued') return 'Waiting to check';
  return '';
}

/** Why "List now" is not offered, or an empty string when it is. */
export function listNowBlockedReason(place: Pick<PlaceView, 'kind' | 'status' | 'listing'>): string {
  if (place.kind !== 'laptop' && place.kind !== 'drive' && place.kind !== 'onedrive') return '';
  if (place.listing !== 'idle') return listingStateText(place.listing);
  if (place.status === 'problem') return "Windows can't read it properly right now";
  if (place.status !== 'connected') return 'Not connected';
  return '';
}

/** One-line description of a drive the app has not named yet. */
export function unnamedDriveDetail(drive: UnnamedDriveView): string {
  const kind = drive.driveType === 'removable' ? 'Removable drive' : 'Fixed disk (it may be inside this laptop)';
  const parts = [kind];
  if (drive.fileSystem) parts.push(drive.fileSystem);
  const space = spaceText(drive.freeBytes, drive.capacityBytes);
  if (space) parts.push(space);
  return parts.join(' · ');
}

/** Home line: "T7 · 2 drives connected" style summary of the named drives that are plugged in. */
export function connectedDrivesSummary(places: readonly PlaceView[]): string {
  const connected = places.filter((p) => p.kind === 'drive' && p.status === 'connected');
  if (connected.length === 0) return 'No named drive is connected';
  const names = connected.map((p) => p.label);
  return `Connected: ${names.join(', ')}`;
}

/** Quota text for a Google account: "4.2 GB of 15 GB used", or an empty string when unknown. */
export function quotaText(usageBytes: number | null, limitBytes: number | null): string {
  if (usageBytes === null) return '';
  if (limitBytes === null) return `${formatBytes(usageBytes)} used`;
  return `${formatBytes(usageBytes)} of ${formatBytes(limitBytes)} used`;
}

/** How full a Google account is (0..1), or null when unknown. */
export function quotaFraction(usageBytes: number | null, limitBytes: number | null): number | null {
  if (usageBytes === null || limitBytes === null || limitBytes <= 0) return null;
  return Math.min(1, Math.max(0, usageBytes / limitBytes));
}
