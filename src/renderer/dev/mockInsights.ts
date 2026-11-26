/**
 * Dev only (compiled out of production builds): the pretend answers of "Drive health" and "What would I lose?" for the sample places
 * (`#/devices?mock`, `#/devices/lose%3At7?mock`, `#/home?mock`). The T7 is healthy; the Seagate had USB trouble and a check with
 * 2 different files; the laptop has one folder only here; a pretend T7 holds 3,420 files with no checked copy. Nothing here touches real data.
 */
import { LOSE_PAGE_SIZE, verdictOf, type DriveHealth, type HealthFacts, type LoseKind, type LoseSection, type OnlyHereSummary, type WouldLoseDetail, type WouldLoseFilesRequest, type WouldLoseFilesPage } from '../../shared/insights';
import type { PlaceView } from '../../shared/places';

const DAY = 86_400_000;

const kind = (k: string, files: number, bytes: number, folders: [string, number, number][]): LoseKind => ({
  kind: k,
  files,
  bytes,
  folders: folders.map(([folder, f, b]) => ({ folder, files: f, bytes: b })),
  rest: { folders: 0, files: 0, bytes: 0 },
});

const section = (kinds: LoseKind[], byBackup: LoseSection['byBackup']): LoseSection => ({ files: kinds.reduce((s, k) => s + k.files, 0), bytes: kinds.reduce((s, k) => s + k.bytes, 0), kinds, byBackup });

const T7_ONLY = section(
  [
    kind('photo-camera', 2_900, 9_400_000_000, [['MyData/POCO/DCIM/Camera', 2_700, 8_800_000_000], ['MyData/POCO/DCIM/Trip', 200, 600_000_000]]),
    kind('video-camera', 120, 2_300_000_000, [['MyData/POCO/DCIM/Camera', 120, 2_300_000_000]]),
    kind('documents', 400, 600_000_000, [['MyData/OneDriveBackup/IMP', 400, 600_000_000]]),
  ],
  [
    { backupId: 1, name: 'Poco F4', files: 3_020, bytes: 11_700_000_000 },
    { backupId: 3, name: 'OneDrive IMP Folder', files: 400, bytes: 600_000_000 },
  ],
);
const T7_MAYBE = section([kind('documents', 30, 40_000_000, [['MyData/Old', 30, 40_000_000]])], [{ backupId: null, name: 'Not part of any backup', files: 30, bytes: 40_000_000 }]);
const LAPTOP_ONLY = section([kind('documents', 12, 90_000_000, [['Documents/Taxes', 12, 90_000_000]])], [{ backupId: null, name: 'Not part of any backup', files: 12, bytes: 90_000_000 }]);
const EMPTY: LoseSection = { files: 0, bytes: 0, kinds: [], byBackup: [] };

const DETAILS: Record<string, WouldLoseDetail> = {
  t7: { placeId: 't7', onlyHere: T7_ONLY, maybeCopied: T7_MAYBE, notChecked: { files: 3_450, bytes: 12_340_000_000 }, totalFiles: 61_000 },
  laptop: { placeId: 'laptop', onlyHere: LAPTOP_ONLY, maybeCopied: EMPTY, notChecked: { files: 12, bytes: 90_000_000 }, totalFiles: 48_000 },
};

/** What a place with nothing special answers: every file has a checked copy. */
const SAFE = (placeId: string): WouldLoseDetail => ({ placeId, onlyHere: EMPTY, maybeCopied: EMPTY, notChecked: { files: 0, bytes: 0 }, totalFiles: 8_000 });

const mockFiles = (request: WouldLoseFilesRequest): WouldLoseFilesPage => {
  const total = request.placeId === 't7' ? (request.part === 'onlyHere' ? 3_420 : 30) : request.placeId === 'laptop' ? 12 : 0;
  const words = request.search.toLowerCase().split(/\s+/).filter((w) => w !== '');
  const all = Array.from({ length: total }, (_unused, i) => ({
    path: request.placeId === 't7' ? `MyData/POCO/DCIM/Camera/IMG_${String(20_000 - i).padStart(5, '0')}.jpg` : `Documents/Taxes/return-${i + 1}.pdf`,
    size: Math.max(1_000, 9_000_000 - i * 2_500),
    kind: request.placeId === 't7' ? (i % 25 === 0 ? 'video-camera' : 'photo-camera') : 'documents',
    unchecked: i % 3 === 0,
  })).filter((f) => words.every((w) => f.path.toLowerCase().includes(w)) && (request.kind === null || f.kind === request.kind));
  const files = all.slice(request.offset, request.offset + LOSE_PAGE_SIZE);
  return { files, more: request.offset + LOSE_PAGE_SIZE < all.length };
};

export function createInsightsMock(places: () => readonly PlaceView[]): Record<string, unknown> {
  const now = Date.now();
  const drives = (): DriveHealth[] =>
    places().map((p): DriveHealth => {
      const disk = p.kind === 'drive' || p.kind === 'laptop';
      const seagate = p.label === 'Seagate2TB';
      const facts: HealthFacts = {
        kind: p.kind,
        status: p.status,
        lastSeenAt: p.status === 'connected' ? now : (p.lastConnectedAt ?? now - 3 * DAY),
        freeBytes: p.freeBytes,
        capacityBytes: p.capacityBytes,
        smart: disk ? 'good' : null,
        windowsErrors: disk ? (seagate ? 2 : 0) : null,
        usbTroubles: seagate ? 2 : 0,
        readErrors: 0,
        damaged: 0,
        differs: seagate ? 2 : 0,
      };
      const { verdict, reasons } = verdictOf(facts, now);
      return Object.assign(facts, {
        placeId: p.id,
        label: p.label,
        smartNote: disk ? 'Windows says this disk is healthy' : '',
        lastCheck: p.kind === 'drive' ? { at: now - (seagate ? 10 : 3) * DAY, verified: seagate ? 4_310 : 18_200, differs: seagate ? 2 : 0, couldNotRead: 0, complete: true } : null,
        nextBackupBytes: null,
        verdict,
        reasons,
      });
    });
  const summary = (): OnlyHereSummary[] => places().filter((p) => p.id === 't7').map((p) => ({ placeId: p.id, files: T7_ONLY.files + T7_MAYBE.files, bytes: T7_ONLY.bytes + T7_MAYBE.bytes }));
  const later = <T,>(value: T, ms: number): Promise<T> => new Promise((resolve) => window.setTimeout(() => resolve(value), ms));
  return {
    'insights.driveHealth': () => later({ ok: true as const, drives: drives() }, 500),
    'insights.onlyHere': () => later({ ok: true as const, places: summary() }, 700),
    'insights.wouldLose': (placeId: string) => later({ ok: true as const, detail: DETAILS[placeId] ?? SAFE(placeId) }, 900),
    'insights.wouldLoseFiles': (request: WouldLoseFilesRequest) => later({ ok: true as const, page: mockFiles(request) }, 250),
    'insights.reminderDays': () => Promise.resolve({ ok: true as const, days: {} }),
  };
}
