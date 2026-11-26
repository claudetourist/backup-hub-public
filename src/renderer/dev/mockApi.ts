/**
 * Dev only (compiled out of production builds): a stand-in for the preload bridge with sample data,
 * so the Sources screen can be shown in a plain browser or headless screenshot at any window width.
 * Open the Vite dev server with `#sources,mock` in the URL. Nothing here touches real data.
 */
import type { PlaceFingerprint } from '../../shared/fingerprint';
import type { JobChangedEvent, JobEvent, JobRecord } from '../../shared/jobs';
import type { BackupHubApi } from '../../shared/ipc';
import { categoryOf } from '../../shared/fileCategories';
import { kindOf } from '../../shared/fileKinds';
import { defaultSavedName, DEFAULT_SORT_DIR, effectiveSortDir, savedRequestOf, searchWords, type SavedSearch, type SearchFacets, type SearchHit, type SearchRequest, type SearchResponse } from '../../shared/search';
import type { PlacesSnapshot, PlaceView, UnnamedDriveView } from '../../shared/places';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { DataSpaceInfo } from '../../shared/dataSpace';
import type { BackupRow, BackupsOverview, HistoryPlan, RemovedBackup } from '../../shared/backups';
import { PAUSE_OFF } from '../../shared/pause';
import { createPhoneBackupMock } from './mockPhoneBackup';
import { createDecisionsMock } from './mockDecisions';
import { createMirrorMock } from './mockMirror';
import { createRestoreMock } from './mockRestore';
import { createFolderBackupMock } from './mockFolderBackup';
import { createPeopleMock } from './mockPeople';
import { createInsightsMock } from './mockInsights';

const mockBackups: BackupsOverview = {
  backups: [
    { id: 1, personId: 1, name: 'Poco F4', kind: 'phone', from: 'Phone', driveLabel: 'T7', folder: 'MyData/POCO', driveConnected: true, lastBackupAt: Date.UTC(2026, 6, 17, 12), enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: true, choices: 1, fromOldTool: true },
    { id: 2, personId: 1, name: 'OneDrive Local Backup', kind: 'folder', from: 'C:\\Users\\you\\OneDrive', driveLabel: 'T7', folder: 'MyData/OneDriveBackup', driveConnected: true, lastBackupAt: Date.UTC(2026, 9, 26, 12), enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: false, choices: 0, fromOldTool: true },
    { id: 3, personId: 1, name: 'OneDrive IMP Folder', kind: 'folder', from: 'C:\\Users\\you\\OneDrive\\IMP', driveLabel: 'T7', folder: 'MyData/OneDriveBackup/IMP', driveConnected: true, lastBackupAt: null, enabled: false, lastRunFailed: false, hubHasRun: false, phoneLinked: false, choices: 0 },
  ],
  historyBroughtInAt: null,
};

const mockHistoryPlan: HistoryPlan = {
  ok: true,
  driveLabel: 'T7',
  settingsPath: 'C:\\Users\\you\\Documents\\PhoneBackup\\config.json',
  files: [
    { backup: 'Poco F4', path: 'F:\\MyData\\POCO\\ledger.db', found: true, bytes: 14_553_088, modifiedAt: Date.UTC(2026, 9, 26), lastBroughtInAt: null },
  ],
  newBackups: ['Poco F4', 'OneDrive IMP Folder (switched off)'],
  stop: null,
};

const mockDataSpace: DataSpaceInfo = {
  dataDir: 'D:/BackupHub/data',
  disk: 'D:',
  freeBytes: 3_300_000_000,
  dbBytes: 1_270_000_000,
  walBytes: 0,
  snapshotsBytes: 3_800_000_000,
  snapshotCount: 5,
  level: 'low',
  message: "The disk that holds Backup Hub's data (D:) has only 3.3 GB free. Backup Hub grows as it learns about more files. Free some space on D:, or move old saved copies to a backup drive, before it runs short. Nothing is wrong yet.",
  warnBelowBytes: 5_000_000_000,
  blockBelowBytes: 2_000_000_000,
};

const NOW = Date.now();
const DAY = 86_400_000;

const baseFp: PlaceFingerprint = {
  fileCount: 148_321,
  fingerprintedFiles: 56_300,
  totalBytes: 76_000_000_000,
  fingerprintedBytes: 12_000_000_000,
  failedFiles: 0,
  state: 'running',
  speedBytesPerSec: 2_100_000,
  speedFilesPerSec: 812,
  job: { id: 11, paused: false },
  failedReason: null,
  detail: null,
  countedAt: NOW - 120_000,
  coverage: {
    none: { files: 40_100, bytes: 9_000_000_000 },
    one: { files: 12_000, bytes: 2_000_000_000 },
    twoPlus: { files: 4_200, bytes: 1_000_000_000 },
    notFingerprinted: { files: 91_900, bytes: 64_000_000_000 },
    cloudOnly: { files: 0, bytes: 0 },
    empty: { files: 312, bytes: 0 },
  },
};

const place = (over: Partial<PlaceView>): PlaceView => ({
  id: 'p',
  kind: 'drive',
  label: 'Place',
  profileId: 1,
  profileName: 'You',
  status: 'connected',
  rootHint: null,
  capacityBytes: null,
  freeBytes: null,
  lastLookedAt: NOW - 3_600_000,
  lastConnectedAt: NOW,
  files: null,
  listing: 'idle',
  listingDetail: null,
  listJob: null,
  canList: true,
  problem: null,
  fingerprint: null,
  canFingerprint: false,
  roots: null,
  thisDevice: false,
  gdrive: null,
  laptopVolumes: null,
  ...over,
});

function sample(): PlacesSnapshot {
  const google = Array.from({ length: 27 }, (_, i) =>
    place({
      id: `g${i}`,
      kind: 'gdrive',
      label: `family.account.${i + 1}@example.com`,
      status: i % 9 === 4 ? 'needs_signin' : 'connected',
      lastLookedAt: i % 3 === 0 ? null : NOW - (i + 1) * DAY,
      canList: false,
      gdrive: {
        quotaLimitBytes: 15_000_000_000,
        quotaUsageBytes: 600_000_000 + i * 520_000_000,
        quotaDriveBytes: i % 4 === 1 ? null : (300_000_000 + i * 200_000_000),
        quotaTrashBytes: i % 4 === 1 ? null : 20_000_000,
        refresh:
          i === 2
            ? { state: 'running', detail: `Refreshing family.account.3@example.com: 12,000 items`, job: { id: 40, paused: false }, signingIn: false }
            : i === 6
              ? { state: 'queued', detail: null, job: { id: 40, paused: false }, signingIn: false }
              : { state: 'idle', detail: null, job: null, signingIn: false },
        canRefresh: i % 9 !== 4 && i !== 2 && i !== 6,
        fileCount: 800 + i * 137,
        fromV1: i % 4 === 1,
      },
    }),
  );
  const places: PlaceView[] = [
    place({
      id: 'laptop',
      kind: 'laptop',
      label: 'STUDY-PC',
      thisDevice: true,
      capacityBytes: 476_000_000_000,
      freeBytes: 120_000_000_000,
      files: { files: 148_321, totalBytes: 76_000_000_000, cloudOnly: 0 },
      roots: ['C:/Users/someone/Documents', 'D:/MyData'],
      fingerprint: baseFp,
    }),
    place({
      id: 'od',
      kind: 'onedrive',
      label: 'OneDrive',
      capacityBytes: 1_000_000_000_000,
      freeBytes: 322_000_000_000,
      files: { files: 39_100, totalBytes: 41_000_000_000, cloudOnly: 1_204 },
      listing: 'paused',
      listingDetail: 'Listing OneDrive: 12,345 files so far · 1,200 files per second',
      listJob: { id: 12, paused: true },
      fingerprint: {
        ...baseFp,
        fileCount: 37_900,
        fingerprintedFiles: 0,
        fingerprintedBytes: 0,
        totalBytes: 41_000_000_000,
        failedFiles: 12,
        failedReason: 'Could not read it (the file is in use by another program, EBUSY).',
        state: 'idle',
        speedBytesPerSec: null,
        speedFilesPerSec: null,
        job: null,
        coverage: null,
      },
      canFingerprint: true,
    }),
    place({
      id: 't7',
      kind: 'drive',
      label: 'T7',
      // Add "offline" to the address (#search,mock,offline) to see the screen with the T7 unplugged.
      status: /offline/.test(window.location.hash) ? 'disconnected' : 'connected',
      lastLookedAt: NOW - 2 * DAY,
      rootHint: 'E:',
      capacityBytes: 2_000_000_000_000,
      freeBytes: 640_000_000_000,
      files: { files: 422_000, totalBytes: 1_300_000_000_000, cloudOnly: 0 },
      fingerprint: { ...baseFp, fileCount: 422_000, fingerprintedFiles: 422_000, fingerprintedBytes: 1_300_000_000_000, totalBytes: 1_300_000_000_000, state: 'idle', speedBytesPerSec: null, speedFilesPerSec: null, job: null },
    }),
    ...google,
  ];
  const unnamed: UnnamedDriveView[] = [
    { letter: 'F:', label: 'Spare SSD', fileSystem: 'NTFS', capacityBytes: 500_000_000_000, freeBytes: 200_000_000_000, driveType: 'removable', canName: true, reason: null, probable: null },
  ];
  return { places, unnamed, listedAt: NOW, listError: null, statsCountedAt: NOW - 120_000 };
}

const copy = (fileId: number, placeId: string, placeLabel: string, placeKind: string, relPath: string, size: number, link = false) => ({
  fileId,
  placeId,
  placeLabel,
  placeKind,
  lastLookedAt: placeKind === 'laptop' ? NOW - 3_600_000 : NOW - 2 * DAY,
  relPath,
  size,
  mtime: 1_666_000_000_000,
  cloudOnly: false,
  hasWebLink: link,
  checked: true,
  verified: placeKind === 'drive',
});

function sampleHits(): SearchHit[] {
  const hit = (key: string, name: string, folder: string, size: number, copies: SearchHit['copies'], fingerprint: SearchHit['fingerprint'] = 'sha256'): SearchHit => ({
    key,
    name,
    folder,
    size,
    mtime: 1_666_000_000_000,
    category: categoryOf(name, null),
    kind: kindOf(`${folder}/${name}`, name, null),
    fingerprint,
    places: new Set(copies.map((c) => c.placeId)).size,
    copies,
    moreCopies: 0,
    perPlace: [...new Set(copies.map((c) => c.placeId))].map((placeId) => {
      const here = copies.filter((c) => c.placeId === placeId);
      return { placeId, placeLabel: here[0]!.placeLabel, placeKind: here[0]!.placeKind, files: here.length };
    }),
  });
  const reunion = 'D:/MyData/Reunion/final';
  return [
    hit('s1', 'thread.mp4', `${reunion}/math & thread`, 7_070_000_000, [
      copy(1, 'laptop', 'STUDY-PC', 'laptop', `${reunion}/math & thread/thread.mp4`, 7_070_000_000),
      copy(2, 't7', 'T7', 'drive', 'BackupHub/reunion-rescue/final/math & thread/thread.mp4', 7_070_000_000),
    ]),
    hit('s2', 'final cinamatic ok effects.mp4', reunion, 1_470_000_000, [
      copy(3, 'laptop', 'STUDY-PC', 'laptop', `${reunion}/final cinamatic ok effects.mp4`, 1_470_000_000),
      copy(4, 't7', 'T7', 'drive', 'DDriveBackup/Reunion/final/final cinamatic ok effects.mp4', 1_470_000_000),
      copy(5, 'g1', 'family.account.2@example.com', 'gdrive', 'My Drive/final cinamatic ok effects.mp4', 1_470_000_000, true),
    ]),
    hit('r1', 'rec.mp4', reunion, 5_950_000_000, [copy(6, 'laptop', 'STUDY-PC', 'laptop', `${reunion}/rec.mp4`, 5_950_000_000)], 'none'),
    hit('p1', 'IMG_0412.jpg', 'D:/Pictures/Camera Roll', 4_200_000, [
      copy(7, 'laptop', 'STUDY-PC', 'laptop', 'D:/Pictures/Camera Roll/IMG_0412.jpg', 4_200_000),
      copy(8, 't7', 'T7', 'drive', 'Photos/2022/IMG_0412.jpg', 4_200_000),
    ]),
    hit('p2', 'Screenshot 2023-04-02.png', 'D:/Pictures/Screenshots', 820_000, [copy(9, 'laptop', 'STUDY-PC', 'laptop', 'D:/Pictures/Screenshots/Screenshot 2023-04-02.png', 820_000)]),
    hit('d1', 'Reunion budget.xlsx', 'D:/MyData/Reunion/plan', 64_000, [
      copy(10, 'laptop', 'STUDY-PC', 'laptop', 'D:/MyData/Reunion/plan/Reunion budget.xlsx', 64_000),
      copy(11, 'g1', 'family.account.2@example.com', 'gdrive', 'My Drive/Reunion budget.xlsx', 64_000, true),
    ]),
    hit('a1', 'Voice 031.m4a', 'D:/MyData/Recordings', 2_300_000, [copy(12, 't7', 'T7', 'drive', 'Recordings/Voice 031.m4a', 2_300_000)]),
    hit('k1', 'IMG_20261112_101502.jpg', 'MyData/Sam phone/Sam-phone-12Nov26/DCIM/Camera', 3_900_000, [copy(21, 't7', 'T7', 'drive', 'MyData/Sam phone/Sam-phone-12Nov26/DCIM/Camera/IMG_20261112_101502.jpg', 3_900_000)]),
    hit('k2', 'Sam birthday.mp4', 'MyData/Sam phone/Sam-phone-12Nov26/Movies', 212_000_000, [copy(22, 't7', 'T7', 'drive', 'MyData/Sam phone/Sam-phone-12Nov26/Movies/Sam birthday.mp4', 212_000_000), copy(23, 'phone-sam', 'Sam phone', 'phone', '/sdcard/Movies/Sam birthday.mp4', 212_000_000)]),
    hit('k3', 'IMG_20260717_184411.jpg', 'MyData/POCO/POCO-17Jul26/DCIM/Camera', 4_400_000, [copy(24, 't7', 'T7', 'drive', 'MyData/POCO/POCO-17Jul26/DCIM/Camera/IMG_20260717_184411.jpg', 4_400_000)]),
    hit('z1', 'old-photos-2012.zip', 'D:/MyData/Archive', 1_900_000_000, [copy(13, 't7', 'T7', 'drive', 'Archive/old-photos-2012.zip', 1_900_000_000)]),
  ];
}

const JOB_BASE = {
  progressDone: 0,
  progressTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  message: null,
  warnings: [],
  error: null,
  hasCheckpoint: false,
  speed: null,
  etaSeconds: null,
  paused: false,
  choices: [],
} as const;

/** Sample jobs for #jobs,mock: running, waiting, failed, warnings, stopped, done, and quiet system jobs. */
function sampleJobs(): JobRecord[] {
  const at = (minutesAgo: number): number => NOW - minutesAgo * 60_000;
  const job = (id: number, kind: string, title: string, state: JobRecord['state'], startedMin: number | null, tookSec: number | null, over: Partial<JobRecord> = {}): JobRecord => ({
    ...JOB_BASE,
    warnings: [],
    choices: [],
    id,
    kind,
    title,
    state,
    createdAt: at(startedMin ?? 1),
    startedAt: startedMin === null ? null : at(startedMin),
    finishedAt: startedMin === null || tookSec === null ? null : at(startedMin) + tookSec * 1000,
    ...over,
  });
  return [
    job(21, 'hash.files', 'Fingerprinting STUDY-PC', 'running', 42, null, { message: 'Reading D:/MyData/Reunion/final', progressDone: 56_300, progressTotal: 148_321, bytesDone: 12_000_000_000, bytesTotal: 76_000_000_000, speed: { unit: 'bytes', perSecond: 2_100_000, itemsPerSecond: 812 }, etaSeconds: 30_500, hasCheckpoint: true }),
    job(20, 'drive.refresh', 'Refreshing Google Drive', 'queued', null, null, { message: 'Waiting for another job to finish' }),
    job(19, 'copy.toLocal', 'Copy Reunion to the T7', 'failed', 190, 840, { error: 'The drive is full. Free some space.', progressDone: 12, progressTotal: 60, bytesDone: 31_000_000_000, bytesTotal: 140_000_000_000, hasCheckpoint: true }),
    job(18, 'settings.saveToDrive', 'Saving settings to the backup drive', 'failed', 300, 4, { error: 'The drive card does not match this backup drive.' }),
    job(17, 'list.place', 'Listing T7', 'done_warnings', 1500, 130, { message: '422,000 files listed', warnings: ['3 folders could not be read (access denied).', 'Skipped 12 files with very long names.'] }),
    job(16, 'list.place', 'Listing OneDrive', 'failed', 1700, 12, { error: '[stopped-by-you] Stopped by you' }),
    job(15, 'db.snapshot', 'Saving a safety copy of the database', 'done', 2000, 31, { message: 'Saved' }),
    job(13, 'list.place', 'Listing STUDY-PC', 'done', 2800, 186, { message: '148,321 files listed' }),
    job(12, 'db.integrityCheck', 'Checking the database', 'done', 3000, 9, { message: 'No problems found' }),
    job(11, 'import.fleetV1', 'Bringing in Fleet Manager v1', 'done', 9000, 640, { message: 'Brought in 24 accounts' }),
  ];
}

const sampleEvents = (jobId: number): JobEvent[] =>
  [
    ['info', 'Started'],
    ['info', 'Checked 1,200 files'],
    ['warn', 'Skipped a file in use by another program'],
    ['error', 'Google said no (403, storageQuotaExceeded)'],
  ].map(([level, text], i) => ({ id: jobId * 10 + i, jobId, at: NOW - (30 - i) * 60_000, level: level as JobEvent['level'], text: text! }));

/** A rough stand-in for the search: words must be in the name, everything else only changes the order. */
function mockSearch(request: SearchRequest, scopeHits: (hits: SearchHit[], person: number | null) => SearchHit[]): SearchResponse {
  const words = searchWords(request.text);
  let hits = scopeHits(sampleHits(), request.person).filter((h) => words.every((w) => h.name.toLowerCase().includes(w)));
  if (request.category !== null) hits = hits.filter((h) => h.category === request.category);
  if (request.fewCopies) hits = hits.filter((h) => h.places <= 2);
  if (request.sort === 'size') hits.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (request.sort === 'copies') hits.sort((a, b) => a.places - b.places);
  if (request.sortDir !== null && request.sort !== null) {
    const flip = effectiveSortDir(request) !== DEFAULT_SORT_DIR[request.sort];
    if (flip) hits.reverse();
  }
  if (request.part === 'counts') {
    const categories: SearchFacets['categories'] = {};
    for (const h of hits) categories[h.category] = (categories[h.category] ?? 0) + 1;
    const places: SearchFacets['places'] = {};
    for (const h of hits) for (const c of h.copies) places[c.placeId] = (places[c.placeId] ?? 0) + 1;
    return { status: 'counts', facets: { categories, places }, years: [2022, 2023], total: hits.length, ms: 1 };
  }
  // "many" gives a long list (1,200 files in pages of 100 by cursor), to look at scrolling: the next page loads near the end of the list.
  if (words.includes('many')) {
    const base = sampleHits()[0]!;
    const from = request.after?.id ?? 0;
    const page = Array.from({ length: Math.max(0, Math.min(100, 1200 - from)) }, (_, i) => {
      const n = from + i + 1;
      return { ...base, key: `many${n}`, name: `IMG_${String(n).padStart(4, '0')}.jpg`, size: 1_000_000 + n };
    });
    const last = from + page.length;
    return { status: 'done', hits: page, total: 1200, ms: 1, offset: 0, next: last < 1200 ? { v: null, id: last, n: null } : null, indexed: true };
  }
  return { status: 'done', hits, total: hits.length, ms: 1, offset: request.offset };
}

/** Installs `window.backupHub`: sample places and settings, everything else answers with nothing. */
export function installMockApi(): void {
  const snapshot = sample();
  // People: three of them, who owns what, and the calls that change it (see mockPeople.ts).
  const placeListeners = new Set<(s: PlacesSnapshot) => void>();
  const settingsListeners = new Set<(s: unknown) => void>();
  const people = createPeopleMock(
    snapshot,
    () => placeListeners.forEach((cb) => cb({ ...snapshot, places: [...snapshot.places] })),
    () => settingsListeners.forEach((cb) => cb({ settings: people.settings() })),
  );
  const phone = createPhoneBackupMock();
  const savedSearches: SavedSearch[] = [];
  // "Needs your decision" (three cases on Home) and "Why?" on a file (a phone photo with one checked copy and one not checked yet).
  const decisions = createDecisionsMock();
  // The second drive: "Also keep a copy on Seagate2TB", the look and list, a copy that pauses once for USB trouble, a report with a damaged file (see mockMirror.ts).
  const mirror = createMirrorMock({ ...phone.env, addDecision: decisions.add });
  // Folder backups (OneDrive Local Backup, and the Google Keep notes once added): look, list, copy, report (see mockFolderBackup.ts).
  const folder = createFolderBackupMock(phone.env, phone.handlers);
  // "Get files back": days, a folder tree, the list, a copy that advances, a report (see mockRestore.ts).
  const restore = createRestoreMock(phone.env);
  if (/open-google/.test(window.location.hash)) window.localStorage.setItem('backuphub.section.sources.google', '1');
  // "Remove from list" and "Put back": the sample list keeps who was taken off (nothing is deleted anywhere).
  const removed = new Map<number, RemovedBackup>();
  // Which backups a sample job belongs to (the real app says so on every job: a second-copy job names each backup).
  const tagJob = (job: JobRecord): JobRecord => {
    const backupIds = job.kind.startsWith('phone.') || job.kind.startsWith('mirror.') || job.kind.startsWith('restore.') ? [1] : job.kind.startsWith('folder.') ? [job.title.includes('IMP') ? 3 : 2] : undefined;
    return backupIds ? { ...job, backupIds } : job;
  };
  const handlers: Record<string, unknown> = {
    'app.version': () => Promise.resolve('dev-mock'),
    'app.dataReady': () => Promise.resolve(true),
    'app.startupStatus': () => Promise.resolve({ phase: 'opening' as const, elapsedMs: 0, estimateMs: null }),
    'app.reportFirstPaint': () => undefined,
    'places.list': () => Promise.resolve(snapshot),
    'places.refresh': () => Promise.resolve(snapshot),
    'places.eject': () => Promise.resolve({ ok: true, message: 'T7 can be unplugged now.' }),
    'dataSpace.get': () => Promise.resolve(mockDataSpace),
    'backups.overview': () => Promise.resolve({ ...mockBackups, removed: [...removed.values()], backups: people.backups([...mockBackups.backups, ...folder.extraRows()].filter((b) => !removed.has(b.id)).map((b): BackupRow => mirror.row(b.id === 1 ? Object.assign({}, b, { choices: phone.choices() }) : b.id === 2 ? Object.assign({}, b, { choices: folder.choices() }) : b))) }),
    // How big each backup is: arrives a moment later, so the placeholder shows first.
    'backups.sizes': () => new Promise((resolve) => window.setTimeout(() => resolve({ ok: true, sizes: [{ backupId: 1, files: 18_204, bytes: 96_400_000_000 }, { backupId: 2, files: 9_310, bytes: 41_200_000_000 }, { backupId: 3, files: 0, bytes: 0 }] }), 900)),
    'backups.archive': (id: number, confirmed: boolean) => {
      const row = mockBackups.backups.find((b) => b.id === id);
      if (!confirmed || !row) return Promise.resolve({ ok: false, message: 'Nothing was changed.' });
      if (row.enabled) return Promise.resolve({ ok: false, message: 'Only a backup that is switched off can be removed from the list.' });
      removed.set(id, { id, name: row.name, personId: row.personId, from: row.from, removedAt: Date.now() });
      return Promise.resolve({ ok: true, message: row.name + ' is off the list. Nothing on any drive was deleted. You can put it back.' });
    },
    'backups.unarchive': (id: number) => {
      const row = removed.get(id);
      removed.delete(id);
      return Promise.resolve({ ok: true, message: (row?.name ?? 'The backup') + ' is back on the list.' });
    },
    'places.onChanged': (cb: (s: PlacesSnapshot) => void) => {
      placeListeners.add(cb);
      return () => placeListeners.delete(cb);
    },
    'settings.onChanged': (cb: (s: unknown) => void) => {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
    'backups.historyPlan': () => Promise.resolve(mockHistoryPlan),
    'backups.linkPhone': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is changed.' }),
    'backups.unlinkPhone': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is changed.' }),
    // A new phone plugged in (Redmi Note 12), the T7, and two folders already on it: the form of "Make a new backup for this phone".
    'backups.newPhoneChoices': () => Promise.resolve({ ok: true, suggestedName: 'Redmi Note 12', drives: [{ placeId: 'sample-t7', label: 'T7', folders: ['Sam phone', 'HJ'] }] }),
    'backups.createPhoneBackup': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is changed.' }),
    'backups.bringInHistory': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is brought in.' }),
    'phoneBackup.safeUnplug': () => Promise.resolve({ ok: true, message: 'Safe to unplug the phone' }),
    'phoneBackup.useAgain': () => Promise.resolve(undefined),
    'phoneBackup.connected': () => Promise.resolve({ adb: 'ready', phones: [{ backupId: 1, backupName: 'Poco F4', phoneName: 'Poco F4', serial: 'SAMPLE', driveConnected: true }], hint: null, newPhones: [{ serial: 'SAMPLE-NEW', phoneName: 'Redmi Note 12', ready: true, hint: null }], backupsWithoutPhone: [] }),
    // A pretend phone backup: a look, a list of about 230 files, a copy that advances, a report (see mockPhoneBackup.ts).
    ...phone.handlers,
    ...folder.handlers,
    ...decisions.handlers,
    ...mirror.handlers,
    ...restore.handlers,
    'jobs.list': () => Promise.resolve(people.jobs([...phone.jobs(), ...sampleJobs()]).map(tagJob)),
    'jobs.onChanged': (cb: (event: JobChangedEvent) => void) => phone.subscribe((event) => cb({ ...event, job: tagJob(event.job) })),
    'pause.get': () => Promise.resolve(PAUSE_OFF),
    'jobs.events': (jobId: number) => Promise.resolve(sampleEvents(jobId)),
    'settings.get': () => Promise.resolve({ settings: DEFAULT_SETTINGS }),
    'settings.removeOldCopies': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is removed.' }),
    'settings.testSavedCopy': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is tested.', details: null }),
    'settings.restoreStatus': () => Promise.resolve({ pending: null }),
    'settings.restoreFromDrive': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is restored.' }),
    'settings.chooseRestoreFile': () => Promise.resolve({ ok: false, canceled: true, message: 'This is a sample screen.' }),
    'settings.restoreFromFile': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is restored.' }),
    'settings.cancelRestore': () => Promise.resolve(false),
    'settings.recoveryNow': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is sent.' }),
    'settings.savedCopies': () => Promise.resolve({ keep: DEFAULT_SETTINGS.savedCopiesKeep, drives: [] }),
    'phone.status': () => Promise.resolve({ adb: 'ready', devices: [{ serial: 'ABC123', model: 'POCO F4', state: 'device' }] }),
    'phone.eject': () => Promise.resolve({ ok: true, message: 'Done. You can unplug the phone now.' }),
    'cleanup.overview': () => Promise.resolve({ removals: [], locks: [], quarantine: [] }),
    'cleanup.phonePlan': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is planned.' }),
    'cleanup.phoneProgress': () => Promise.resolve({ planning: false, done: 0, total: 0 }),
    'cleanup.phoneStart': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is removed.' }),
    'cleanup.putBack': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is changed.' }),
    'cleanup.laptopPlan': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is planned.' }),
    'cleanup.laptopStart': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is moved.' }),
    'cleanup.undo': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is changed.' }),
    'cleanup.emptyQuarantine': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is emptied.' }),
    'localCopy.targets': () => Promise.resolve([{ placeId: 't7', label: 'T7', freeBytes: 300_000_000_000 }]),
    'localCopy.plan': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is planned.' }),
    'localCopy.start': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is copied.' }),
    'search.run': (request: SearchRequest) => new Promise((resolve) => window.setTimeout(() => resolve(mockSearch(request, people.scopeHits)), 400)),
    'search.showInFolder': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is opened.' }),
    'search.openInDrive': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is opened.' }),
    'search.indexStatus': () => Promise.resolve({ available: true, ready: true, percent: 100, waiting: false }),
    'search.savedList': () => Promise.resolve({ ok: true, saved: [...savedSearches] }),
    'search.savedSave': (name: string, request: SearchRequest) => {
      const title = name.trim() || defaultSavedName(request);
      const at = savedSearches.findIndex((s) => s.name.toLowerCase() === title.toLowerCase());
      const entry = { id: at >= 0 ? savedSearches[at]!.id : savedSearches.length + 1, name: title, request: savedRequestOf(request), createdAt: NOW };
      if (at >= 0) savedSearches[at] = entry;
      else savedSearches.push(entry);
      return Promise.resolve({ ok: true, saved: [...savedSearches] });
    },
    'search.savedRemove': (id: number) => {
      const at = savedSearches.findIndex((s) => s.id === id);
      if (at >= 0) savedSearches.splice(at, 1);
      return Promise.resolve({ ok: true, saved: [...savedSearches] });
    },
    'drive.refresh': () => Promise.resolve({ ok: true, jobId: 1, started: 1, skipped: 0, note: null }),
    'drive.refreshAll': () => Promise.resolve({ ok: true, jobId: 1, started: 24, skipped: 3, note: '3 accounts need signing in again and were skipped.' }),
    'drive.signIn': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing happens here.' }),
    'shared.overview': () => Promise.resolve({ accounts: [], items: [], totalItems: 0 }),
    'shared.look': () => Promise.resolve({ ok: false, message: 'This is a sample screen; nothing is asked of Google.' }),
    // Drive health and "What would I lose?" (see mockInsights.ts).
    ...createInsightsMock(() => snapshot.places),
    // Last, so the people, the settings (the remembered person) and the new phone form answer from the sample people.
    ...people.handlers,
  };
  const area = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          const found = handlers[`${name}.${method}`];
          if (found) return found;
          if (method.startsWith('on')) return () => () => undefined;
          return () => Promise.resolve(undefined);
        },
      },
    );
  const api = new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (key === 'onEvent') return () => () => undefined;
        return area(key);
      },
    },
  ) as unknown as BackupHubApi;
  window.backupHub = api;
}
