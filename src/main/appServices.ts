import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from './db';
import { CountCache } from './cache/countCache';
import { DataVersion } from './cache/dataVersion';
import { windowsPowerSource, type PowerSource } from './hashing/battery';
import { FingerprintService } from './hashing/fingerprintService';
import { hashFilesHandler } from './hashing/hashJob';
import { createFileHasher, type FileHasher } from './hashing/hasher';
import { GoogleAuth } from './google/auth';
import { DriveApi } from './google/driveApi';
import { DriveService } from './google/driveService';
import { SharedWithMeService } from './google/sharedWithMe';
import { GoogleHttp } from './google/googleHttp';
import { DriveUploader } from './google/driveUpload';
import { DriveDownloader } from './google/driveDownload';
import { refreshHandler } from './google/refreshJob';
import { AdbCleanClient, type AdbCleanPort } from './cleanup/adbClean';
import { AdbClient, type PhoneBackupAdb } from './adb/adbPort';
import { PhoneBackupService } from './phoneBackup/phoneBackupService';
import { MirrorService, mirrorPlaceIds } from './mirror/mirrorService';
import { FolderBackupService } from './folderBackup/folderBackupService';
import { realSourceFor } from './folderBackup/folderSource';
import { FOLDER_BACKUP_JOB_KIND, FOLDER_LOOK_JOB_KIND } from '../shared/folderBackup';
import { realMirrorDrive } from './mirror/mirrorDrive';
import { MIRROR_COPY_JOB_KIND, MIRROR_LOOK_JOB_KIND } from '../shared/mirror';
import { MIRROR_CHECK_JOB_KIND } from '../shared/mirrorCheck';
import { behindInWorker } from './query/queryService';
import { RulesService } from './rules/rulesService';
import { DecisionService } from './decisions/decisionService';
import { WhyService } from './why/whyService';
import { realBackupDrive } from './phoneBackup/backupDrive';
import { PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND, PHONE_LOOK_JOB_KIND } from '../shared/phoneBackup';
import type { CleanDestination } from '../shared/cleanup';
import { CleanStore } from './cleanup/cleanStore';
import { CleanupService } from './cleanup/cleanupService';
import { diskSizeFor } from './cleanup/diskAccess';
import { laptopCleanHandler } from './cleanup/laptopCleanJob';
import { phoneCleanHandler, putBackHandler } from './cleanup/phoneCleanJob';
import { copyToLocalHandler } from './localCopy/localCopyJob';
import { LocalCopyService } from './localCopy/localCopyService';
import { restoreHandler } from './restore/restoreJob';
import { defaultRestoreParent, RestoreService } from './restore/restoreService';
import { freeBytesOf, freeBytesOfAsync } from './localCopy/freeSpace';
import { signInAgain } from './google/signIn';
import { GoogleAccountsService } from './google/accounts';
import { GoogleCopyService } from './googleCopy/googleCopyService';
import { hashUnbuffered } from './localCopy/directRead';
import { rawFs } from './rawFs';
import { GOOGLE_COPY_JOB_KIND } from '../shared/googleCopy';
import { fleetV1Handler, resolveSourceDir } from './import/fleetV1/importer';
import { IMPORT_V1_JOB_KIND } from '../shared/importV1';
import type { JobService } from './jobs/jobService';
import { listPlaceHandler, unpluggedMessage, type ListJobDeps, type ListedPlace, type Located } from './listing/listJob';
import { LOOK_AGAIN_JOB_KIND } from '../shared/listing';
import { WorkerQuickWalkRunner } from './listing/quickWalkRunner';
import { DataSpace } from './dataSpace';
import { WalKeeper } from './db/walKeeper';
import { EjectService } from './places/eject';
import { UsbHealth, parseUsbEvents, USB_EVENT_COMMAND } from './places/usbHealth';
import { appDataSnapshotHandler } from './appdata/snapshotJob';
import { APPDATA_SNAPSHOT_JOB_KIND } from '../shared/plans';
import { LIST_PLACE_JOB_KIND } from '../shared/listing';
import { COPY_TO_LOCAL_JOB_KIND } from '../shared/localCopy';
import { RESTORE_JOB_KIND } from '../shared/restore';
import { runPowerShell } from './listing/powershell';
import { usbPhonePlugged } from './adb/phoneUsbProbe';
import { HASH_FILES_JOB_KIND } from '../shared/fingerprint';
import { DRIVE_REFRESH_JOB_KIND } from '../shared/drive';
import { isFinished } from '../shared/jobs';
import { isListingJobKind } from '../shared/listing';
import { ListingService } from './listing/listingService';
import { readKnownFolders } from './listing/knownFolders';
import { detectOneDrive, oneDriveEnvFolders } from './listing/oneDrive';
import { RootService } from './listing/roots';
import { listDiskLetters } from './places/disks';
import { backupSizesInWorker, checkOldCountsInWorker, QueryService, onlyHereInWorker, wouldLoseFilesInWorker, wouldLoseInWorker } from './query/queryService';
import { InsightsService } from './insights/insightsService';
import { ScanGate } from './query/scanGate';
import { wireRecountOnJobEnd } from './query/recountOnJobEnd';
import { SearchService } from './query/searchService';
import { SearchIndexService } from './query/searchIndexService';
import { SavedSearches } from './search/savedSearches';
import { PlaceService, type PlaceLogger, type PlaceServiceDeps } from './places/placeService';
import { ProfileService } from './profiles/profileService';
import { BackupProfileService } from './backupProfiles/backupProfileService';
import { phoneBackupConfigPath } from './backupProfiles/history';
import { electronProtector } from './vault/electronProtector';
import { VaultService } from './vault/vaultService';
import { recoveryHandler } from './recovery/recoveryJob';
import { configureWriteGuard, protectedDriveFor, protectedDriveMessage } from './fsutil';
import { KIND_SAVE_SETTINGS, saveToDriveHandler } from './settings/saveToDrive';
import { SettingsStore } from './settings/settingsStore';
import { PauseState, settingsRowPauseStore } from './pause/pauseState';
import { isPauseOn } from '../shared/pause';
import { QUIT_RELEASE_MS, releaseWithin, type ReleaseOutcome } from './adb/adbRelease';
import { PhoneAdbService } from './adb/phoneAdbService';
import { KindStore } from './search/kindStore';
import { phoneCleanDestinations } from './cleanup/phoneRule';
import { FreeUpResults, freeUpCheckHandler, type FreeUpAdb } from './freeUp/freeUpCheck';
import { freeUpRemoveHandler } from './freeUp/freeUpRemove';
import { FreeUpService } from './freeUp/freeUpService';
import { DriveGoogleAsk } from './freeUp/googleAsk';
import { FREEUP_CHECK_JOB_KIND, FREEUP_REMOVE_JOB_KIND } from '../shared/freeUp';

/** Everything built on the open database. Created once, after the window is visible. */
export interface AppServices {
  db: Db;
  /** Lets go of the phone (adb kill-server) when the app closes. Waits at most a few seconds and does nothing when adb.exe is missing. */
  releasePhoneOnQuit: () => Promise<ReleaseOutcome>;
  jobs: JobService;
  places: PlaceService;
  listing: ListingService;
  /** Read-only Google Drive refresh and the "Sign in again" flow. */
  drive: DriveService;
  fingerprints: FingerprintService;
  /** Heavy read queries (coverage, file stats) on a worker thread with its own read-only connection. */
  query: QueryService;
  /** Search on its own query worker thread. */
  search: SearchService;
  /** Goes up whenever something the Home numbers are counted from changes; the saved counts are recounted only when it moved. */
  dataVersion: DataVersion;
  quickRunner: WorkerQuickWalkRunner;
  /** Keeps the write-ahead log small from a worker thread (never the main one). */
  walKeeper: WalKeeper;
  /** Room on the disk that holds the data folder: warnings, the start gate for heavy jobs, the sizes shown in Settings. */
  dataSpace: DataSpace;
  /** "Eject" for a plugged-in named drive. */
  eject: EjectService;
  /** Files search: give files a category of your own (the only writer of `kind_overrides`). */
  kinds: KindStore;
  /** "Back up now" to a plugged-in drive: the plan and the start (the job is `copy.toLocal`). */
  localCopy: LocalCopyService;
  /** Which plugged-in drives are having USB trouble (read from the System log). */
  usb: UsbHealth;
  /** The phone's cable connection for the clean-up screen: adb status and letting go of the phone. */
  phone: PhoneAdbService;
  /** Clean up (the only feature that removes anything): plans, the removal jobs, undo. */
  cleanup: CleanupService;
  /** Google Drive "shared with me": listed on its own, read only, never counted as a backup copy. */
  sharedWithMe: SharedWithMeService;
  roots: RootService;
  /** After the first drive listing: fill in the laptop's default folders. Starts NOTHING (no listing, no job, no timer except drive detection and USB health). */
  prepareListing(): Promise<void>;
  /** The plain "read-only (protected)" line for a plugged-in named drive that must not be written to, else null. */
  writeProtectedLine(placeId: string): string | null;
  profiles: ProfileService;
  /** "Back up <phone> now" (R1.2a): look and plan, preview, the confirmed copy to the T7, the report. Only from clicks. */
  phoneBackup: PhoneBackupService;
  /** The second drive (R1.3): "Also keep a copy on ...", the look and list, the confirmed copy from the first drive, the status per drive. Only from clicks. */
  mirror: MirrorService;
  /** Folder backups (R2.1) and the Google Keep notes backup (R2.8): look, list, confirmed verified copy, report. Starts nothing by itself. */
  folderBackup: FolderBackupService;
  /** "Your choices" (never back up / always include) and the things no backup can copy, per phone backup. Only from clicks; it never touches a file. */
  rules: RulesService;
  /** "Needs your decision": the open cases from the parts that own them, and the person's answers (handed back to those parts). */
  decisions: DecisionService;
  /** "Why?" on a file: one read-only explanation from the index. */
  why: WhyService;
  /** Keeps the search index (R3.1) filled on its own worker thread; says how ready it is. */
  searchIndex: SearchIndexService;
  /** The searches saved on the Files screen. */
  savedSearches: SavedSearches;
  /** Free up phone space (R1.5): the check of the three copies, the removal of what was confirmed, Keep on the phone, Put back. */
  freeUp: FreeUpService;
  /** Backup profiles (Person = people, Profile = one backup): seed from PhoneBackup's config, edit, bring in the old history files (only from the Backups screen's button). Starts nothing by itself. */
  backupProfiles: BackupProfileService;
  settings: SettingsStore;
  /** "Pause everything": kept in the settings table, ends timed pauses by itself, holds the job queue while on. */
  pause: PauseState;
  vault: VaultService;
  appVersion: string;
  dataDir: string;
  logsDir: string;
  /** The folder the v1 import reads (the archive unless a dev run overrides it). */
  importSourceDir: string;
  /** Drive health, the reminder days and "What would I lose?": read only (its one write is the reminder days). Starts nothing by itself. */
  insights: InsightsService;
  /** Add, sign out and remove Google accounts; the Google app key. Only from clicks. */
  googleAccounts: GoogleAccountsService;
  /** "Copy to Google" (G3): status, the capacity screen, the confirmed copy job, the report. Only from clicks. */
  googleCopy: GoogleCopyService;
  /** "Get files back": browse a backup, make the list, copy it back into a new folder (job `restore.files`). Never overwrites. */
  restore: RestoreService;
}

export interface AppServicesDeps {
  db: Db;
  dataDir: string;
  logsDir: string;
  appVersion: string;
  jobs: JobService;
  log: PlaceLogger;
  /** Whether the laptop is on battery power (Electron's powerMonitor); the default says it never is. */
  isOnBattery?: (() => boolean) | undefined;
  /** Absolute path of the built hashing worker script. Without it (or if it cannot start) files are read in the main process. */
  hashWorkerPath?: string | undefined;
  /** Absolute path of the built query worker script. Without it (or if it cannot start) the counts run in the main process, at most once a minute. */
  queryWorkerPath?: string | undefined;
  /** The way to reach a phone (adb). Tests pass a fake. */
  adb?: AdbCleanPort | undefined;
  /** The phone backup's way to the phone (default: the real adb client). Tests pass a fake. */
  phoneBackupAdb?: PhoneBackupAdb | undefined;
  /** Stops the laptop from sleeping during a phone backup (Electron's powerSaveBlocker); returns the function that lets it sleep again. */
  keepAwake?: (() => () => void) | undefined;
  /** Absolute path of the built quick-walk worker script ("Look again"). Without it (or if it cannot start) the walk runs in the main process. */
  quickWalkWorkerPath?: string | undefined;
  /** The database file the query worker opens read-only (null for in-memory databases: no worker). */
  dbFile?: string | null | undefined;
  /** The app (main.ts) sets this: the search index is filled and kept up to date on a worker thread. Tests leave it off. */
  keepSearchIndex?: boolean | undefined;
  /** Replaces the file hasher and the power source (tests). */
  hasherOverride?: FileHasher | undefined;
  powerOverride?: PowerSource | undefined;
  /** Opens an address in the person's own browser (Electron shell.openExternal); the sign-in uses it. */
  openExternal?: ((url: string) => Promise<void>) | undefined;
  /** Replaces the network layer (tests). Without it the real one is used. */
  googleHttp?: GoogleHttp | undefined;
  /** Dev runs only: read the v1 files from here instead of the archive (never set in the packaged app). */
  importSourceDir?: string | undefined;
  /** Tests only: replace drive detection (volume list, where a letter lives), the OneDrive lookup and the computer name. */
  placeDeps?: Partial<Pick<PlaceServiceDeps, 'listVolumes' | 'listDisks' | 'rootOf' | 'detectOneDrive' | 'hostname' | 'systemDrive'>> | undefined;
}

export function createAppServices(deps: AppServicesDeps): AppServices {
  const findOneDrive = deps.placeDeps?.detectOneDrive ?? (() => detectOneDrive({ folderExists: (folder) => fs.existsSync(folder) }));
  const places = new PlaceService({
    db: deps.db,
    listDisks: () => listDiskLetters(),
    detectOneDrive: findOneDrive,
    dataDir: deps.dataDir,
    hostname: process.env['COMPUTERNAME'] ?? os.hostname(),
    appVersion: deps.appVersion,
    log: deps.log,
    ...deps.placeDeps,
  });
  places.init();
  // A drive that logs USB errors gets no job (per-drive start gate) until 30 minutes after its last error.
  const usb = new UsbHealth({
    readEvents: async () => parseUsbEvents(await runPowerShell(USB_EVENT_COMMAND, { timeoutMs: 20_000 })),
    drives: () => places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root })),
    disks: () => listDiskLetters(),
    log: deps.log,
  });
  // Fast start: the last counts are saved and shown at once; they are counted again only when the data version moved on,
  // and the heavy counts of all kinds run one at a time through one gate.
  const dataVersion = new DataVersion(deps.db);
  const countCache = new CountCache(deps.db);
  const gate = new ScanGate();
  const query = new QueryService({
    dbFile: deps.dbFile ?? null,
    db: deps.db,
    workerPath: deps.dbFile ? (deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js')) : null,
    log: deps.log,
    version: dataVersion,
    cache: countCache,
    gate,
  });
  const search = new SearchService({
    dbFile: deps.dbFile ?? null,
    db: deps.db,
    workerPath: deps.dbFile ? (deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js')) : null,
    log: deps.log,
  });
  const searchIndex = new SearchIndexService({
    dbFile: deps.dbFile ?? null,
    workerPath: deps.dbFile ? (deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js')) : null,
    log: deps.log,
  });
  if (deps.keepSearchIndex === true) searchIndex.start();
  // The fill of the search index waits while any job runs (it writes to the same file; see SearchIndexService.setPaused).
  const runningJobs = new Set<number>();
  deps.jobs.onChanged((event) => {
    if (event.reason !== 'state') return;
    if (event.job.state === 'running') runningJobs.add(event.job.id);
    else runningJobs.delete(event.job.id);
    searchIndex.setPaused(runningJobs.size > 0);
  });
  places.setStatsSource(
    () => {
      const snap = query.stats();
      // Sources asks every poll: a plain request counts only when nothing is cached yet. Later recounts come from
      // events that change the numbers (see query/recountOnJobEnd.ts), never from this poll.
      query.requestStats();
      return snap?.files ?? new Map();
    },
    () => {
      dataVersion.bump();
      query.requestStats({ force: true });
    },
    () => query.stats()?.at ?? null,
  );
  query.onUpdated(() => {
    places.republish();
  });
  wireRecountOnJobEnd(deps.jobs, query, dataVersion);
  const profiles = new ProfileService(deps.db);
  const backupProfiles = new BackupProfileService({
    db: deps.db,
    connectedDrives: () => places.connectedDrives().map((d) => ({ placeId: d.place.id, root: d.root, label: d.place.label })),
    phoneBackupConfig: () => phoneBackupConfigPath(),
    ...(deps.dbFile ? { sizesInWorker: (asks) => backupSizesInWorker(deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js'), deps.dbFile!, asks) } : {}),
  });
  const settings = new SettingsStore(deps.db);
  // T7 WRITE BAN: from here on every write that can reach a drive asks the guard (fsutil.assertWritable). The list is the setting
  // `writeProtectedDrives` (default empty; the person protects drives in Settings > Drives).
  configureWriteGuard({ protectedDrives: () => settings.get().writeProtectedDrives, volumeOf: (root) => places.volumeFact(root), identityBlock: (cardId) => places.identityBlock(cardId) });
  if (protectedDriveFor(deps.dataDir) !== null) deps.log.warn('the data folder is on a write-protected drive: the database cannot be protected there');
  /** The plain "read-only (protected)" line for a plugged-in named drive that must not be written to, else null. */
  const writeProtectedLine = (placeId: string): string | null => {
    const drive = places.connectedDrives().find((d) => d.place.id === placeId);
    if (!drive) return null;
    const names = new Set(settings.get().writeProtectedDrives.map((n) => n.toLowerCase()));
    if (names.has(drive.place.label.toLowerCase()) || names.has(drive.place.id.toLowerCase())) return protectedDriveMessage(drive.place.label);
    const guarded = protectedDriveFor(drive.root);
    return guarded === null ? null : protectedDriveMessage(guarded);
  };
  const vault = new VaultService({ db: deps.db, dataDir: deps.dataDir, protector: electronProtector });

  // P4b-1: listing. Folders to list, the `list.place` job, and the buttons/timers that start it.
  const allOneDriveFolders = (): string[] => [...new Set([...places.oneDriveFolders(), ...oneDriveEnvFolders()])];
  const roots = new RootService({
    db: deps.db,
    readKnownFolders: () => readKnownFolders(),
    oneDriveFolders: allOneDriveFolders,
    appFolders: () => [deps.dataDir, deps.logsDir],
    isListing: (placeId) => listing.isListing(placeId),
    log: deps.log,
  });
  const listing: ListingService = new ListingService({
    db: deps.db,
    jobs: deps.jobs,
    isConnected: (placeId) => places.isConnected(placeId),
    onStateChanged: () => places.republish(),
    log: deps.log,
  });
  places.setListingSources({
    stateOf: (placeId) => listing.stateOf(placeId),
    rootsOf: (placeId) => roots.list(placeId),
    detailOf: (placeId) => listing.detailOf(placeId),
    jobOf: (placeId) => listing.jobOf(placeId),
  });
  /** Where a place's folders are right now: re-reads a drive's card and OneDrive's folder every time it is asked. */
  const locate = async (place: ListedPlace): Promise<Located> => {
    if (place.kind === 'laptop') return { ok: true, base: '' };
    if (place.kind === 'drive') {
      await places.refresh();
      const drive = places.connectedDrives().find((d) => d.place.id === place.id);
      return drive ? { ok: true, base: drive.root } : { ok: false, reason: 'unplugged', message: unpluggedMessage(place.label) };
    }
    const account = await findOneDrive();
    return account
      ? { ok: true, base: account.userFolder }
      : { ok: false, reason: 'missing', message: 'OneDrive was not found on this PC, so it could not be checked. Nothing was changed.' };
  };
  // "Look again" saves thousands of rows on the first pass: it runs on a worker thread, never on the main one.
  const quickRunner = new WorkerQuickWalkRunner({
    dbFile: deps.dbFile ?? null,
    db: deps.db,
    workerPath: deps.dbFile ? (deps.quickWalkWorkerPath ?? path.join(__dirname, 'quickWalkWorker.js')) : null,
    log: deps.log,
  });
  // The write-ahead log is folded back by the worker thread (every 30 s, and emptied after big jobs), never by a main-thread commit.
  const walKeeper = new WalKeeper({ db: deps.db, checkpoint: (mode) => quickRunner.checkpoint(mode), log: deps.log });
  if (quickRunner.usesWorker) walKeeper.start();
  const BIG_JOB_KINDS = new Set<string>([HASH_FILES_JOB_KIND, DRIVE_REFRESH_JOB_KIND, IMPORT_V1_JOB_KIND]);
  deps.jobs.onChanged((event) => {
    if (event.reason !== 'state' || !isFinished(event.job.state)) return;
    if (isListingJobKind(event.job.kind) || BIG_JOB_KINDS.has(event.job.kind)) walKeeper.truncateSoon();
  });
  // Room on the data disk: heavy jobs do not start under 2 GB free (they say why), and Home warns under 5 GB.
  const dataSpace = new DataSpace(deps.dataDir);
  deps.jobs.setStartGate((kind) => dataSpace.refusalFor(kind));
  const spaceAtStart = dataSpace.info();
  if (spaceAtStart.message !== null) deps.log.warn(`data disk: ${spaceAtStart.message}`);
  const listDeps: ListJobDeps = {
      db: deps.db,
      quickRunner,
      log: deps.log,
      env: {
        started: (jobId, placeId) => listing.noteStarted(jobId, placeId),
        dataChanged: () => dataVersion.bump(),
        roots: (place) => roots.ensureDefaults(place),
        excludeDirs: (place) => [deps.dataDir, deps.logsDir, ...(place.kind === 'laptop' ? allOneDriveFolders() : [])],
        // The skip list applies to the sources only; the backup drives are indexed exactly as they are.
        skipFolders: (place) => (place.kind === 'drive' ? [] : settings.get().skipFolders),
        locate,
      },
  };
  deps.jobs.register(listPlaceHandler(listDeps));
  // "Look again" runs the same code with `quick` set, as a quiet upkeep job of its own kind.
  deps.jobs.register(listPlaceHandler(listDeps, LOOK_AGAIN_JOB_KIND));
  const eject = new EjectService({
    drives: () => places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root })),
    refresh: () => places.refresh(),
    jobs: deps.jobs,
    powershell: (script, timeoutMs) => runPowerShell(script, { timeoutMs }),
    stillThere: (root) => fs.promises.access(root).then(() => true, () => false),
    log: deps.log,
  });
  // P4b-2: fingerprints (SHA-256 + MD5 read once per file, in a worker thread) and the copies index.
  const fingerprints: FingerprintService = new FingerprintService({
    db: deps.db,
    query,
    jobs: deps.jobs,
    isConnected: (placeId) => places.isConnected(placeId),
    onStateChanged: () => places.republish(),
    dataChanged: () => dataVersion.bump(),
    log: deps.log,
  });
  places.setFingerprintSource((placeId, kind) => fingerprints.fingerprintOf(placeId, kind));
  const hasher =
    deps.hasherOverride ??
    createFileHasher({ workerPath: deps.hashWorkerPath ?? path.join(__dirname, 'hashWorker.js'), log: deps.log });
  deps.jobs.register(
    hashFilesHandler({
      db: deps.db,
      log: deps.log,
      totals: (placeId) => quickRunner.queueTotals(placeId),
      hasher,
      power: deps.powerOverride ?? windowsPowerSource(deps.isOnBattery ?? (() => false)),
      megabytesPerSecond: () => settings.get().hashMegabytesPerSecond,
      env: {
        locate,
        started: (jobId, placeId) => fingerprints.noteStarted(jobId, placeId),
        paused: (reason) => fingerprints.notePaused(reason),
      },
    }),
  );
  // F5: save settings and a database copy to a named backup drive when it is plugged in.
  deps.jobs.register(
    saveToDriveHandler({ db: deps.db, settings, places, appVersion: deps.appVersion, log: deps.log }),
  );
  // No plug-in trigger: copies of the index are made only on request.

  // P4a: bring in Google accounts and the Drive file list from the archived Fleet Manager v1 copy.
  const importSourceDir = resolveSourceDir(deps.importSourceDir);
  deps.jobs.register(
    fleetV1Handler({
      db: deps.db,
      vault,
      tempRoot: path.join(deps.dataDir, 'import-tmp'),
      log: deps.log,
      sourceDir: importSourceDir,
    }),
  );
  deps.jobs.onChanged((event) => {
    if (event.job.kind === IMPORT_V1_JOB_KIND && event.reason === 'state') places.catalogChanged();
  });

  // P4c: read-only Google Drive refresh (the only network code is google/googleHttp.ts).
  const googleHttp = deps.googleHttp ?? new GoogleHttp();
  const googleAuth = new GoogleAuth(vault, googleHttp);
  const drive: DriveService = new DriveService({
    db: deps.db,
    jobs: deps.jobs,
    auth: googleAuth,
    signIn: (placeId) =>
      signInAgain(
        {
          db: deps.db,
          vault,
          auth: googleAuth,
          http: googleHttp,
          openBrowser: deps.openExternal ?? (() => Promise.reject(new Error('No browser available'))),
        },
        placeId,
      ).then((result) => {
        places.republish();
        return result;
      }),
    onStateChanged: () => places.republish(),
    log: deps.log,
  });
  places.setDriveSource((placeId) => {
    const row = deps.db.prepare("SELECT label FROM places WHERE id = ?").get(placeId) as { label: string } | undefined;
    return drive.viewOf(placeId, row?.label ?? '');
  });
  deps.jobs.register(
    refreshHandler({
      db: deps.db,
      api: new DriveApi(googleHttp, googleAuth),
      auth: googleAuth,
      log: deps.log,
      tempRoot: path.join(deps.dataDir, 'drive-tmp'),
      started: (jobId, placeIds) => drive.noteStarted(jobId, placeIds),
      accountDone: () => places.catalogChanged(),
    }),
  );

  const googleApi = new DriveApi(googleHttp, googleAuth);
  const uploader = new DriveUploader(googleHttp, googleAuth);
  const sharedWithMe = new SharedWithMeService({ db: deps.db, api: googleApi });
  /** Where a local place's folders are right now: '' for the laptop, the drive's letter root for a plugged-in named drive. */
  const localBase = async (placeId: string): Promise<string | null> => {
    const row = deps.db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined;
    if (row?.kind === 'laptop') return '';
    if (row?.kind === 'drive') {
      await places.refresh();
      return places.connectedDrives().find((d) => d.place.id === placeId)?.root ?? null;
    }
    // OneDrive: where its folder is on this PC now (files that are only online are never read from it).
    if (row?.kind === 'onedrive') return places.baseFolderOf({ id: placeId, kind: 'onedrive' });
    return null;
  };
  // Recovery copy of the database to ONE chosen Google account: encrypted, OFF until the person picks the account in Settings.
  deps.jobs.register(
    recoveryHandler({
      db: deps.db,
      settings,
      vault,
      uploader,
      auth: googleAuth,
      http: googleHttp,
      room: async (placeId, signal) => {
        try {
          const about = await googleApi.about(placeId, signal);
          return { limit: about.limit, usage: about.usage };
        } catch {
          return null;
        }
      },
      isGoogleAccount: (placeId) => (deps.db.prepare('SELECT kind FROM places WHERE id = ?').get(placeId) as { kind: string } | undefined)?.kind === 'gdrive',
      freeBytes: freeBytesOf,
      scratchRoot: os.tmpdir(),
      appVersion: deps.appVersion,
      log: deps.log,
    }),
  );
  // The recovery copy has no timer: it starts only from the person (Backups > Backup Hub itself).

  // "Back up now" to a plugged-in drive (the T7): read-only plan, then a verified copy job that never overwrites or deletes.
  const localCopy = new LocalCopyService({
    planner: { db: deps.db, baseOf: localBase, freeBytes: freeBytesOf },
    drives: async () => {
      await places.refresh();
      return places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root }));
    },
    jobs: deps.jobs,
    writeProtected: writeProtectedLine,
    log: deps.log,
  });
  deps.jobs.register(copyToLocalHandler({ db: deps.db, log: deps.log, baseOf: localBase, freeBytes: freeBytesOf }));

  // "Get files back": the copy from the T7, the Seagate or (a download) Google into a new folder (or back where it was), verified, never replacing anything.
  const restoreDownloader = new DriveDownloader(googleHttp, googleAuth);
  deps.jobs.register(restoreHandler({ db: deps.db, log: deps.log, baseOf: localBase, freeBytes: freeBytesOfAsync, download: (placeId, extId, tmpFile, o) => restoreDownloader.download(placeId, extId, tmpFile, o) }));
  const restore = new RestoreService({
    db: deps.db,
    jobs: deps.jobs,
    drives: async () => {
      await places.refresh();
      return places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root }));
    },
    defaultParent: () => defaultRestoreParent(),
    freeBytes: freeBytesOfAsync,
    log: deps.log,
  });

  // The phone: adb only reads it (status, and the clean-up screen's plans); the clean-up jobs below remove only what the person confirmed.
  const adb = deps.adb ?? new AdbCleanClient();
  const phone = new PhoneAdbService({ adb, jobs: deps.jobs });
  // The phone backup: the complete-listing look, a plan, and a verified copy to the drive of the backup (never overwrites or deletes).
  const phoneBackup = new PhoneBackupService(
    {
      db: deps.db,
      adb: deps.phoneBackupAdb ?? (adb instanceof AdbClient ? adb : new AdbClient()),
      log: deps.log,
      phonesSeen: (serials) => places.notePhones(serials),
      phonesReleased: (serials) => places.noteReleased(serials),
      phonePlugged: (serial) => usbPhonePlugged((script) => runPowerShell(script, { timeoutMs: 15_000 }), serial),
      driveFor: async (placeId) => {
        await places.refresh();
        const d = places.connectedDrives().find((x) => x.place.id === placeId);
        return d ? { drive: realBackupDrive(d.root), label: d.place.label } : null;
      },
      connectedDrives: async () => {
        await places.refresh();
        return places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root, unreadable: d.place.status === 'problem', blocked: places.identityBlock(d.place.id) }));
      },
      writeProtected: writeProtectedLine,
      ...(deps.dbFile ? { countsInWorker: (backupId: number) => checkOldCountsInWorker(deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js'), deps.dbFile!, backupId) } : {}),
      ...(deps.keepAwake ? { keepAwake: deps.keepAwake } : {}),
      wakeCount: () => deps.jobs.wakeCount,
    },
    deps.jobs,
  );
  for (const handler of phoneBackup.handlers()) deps.jobs.register(handler);
  // The second drive: a mirror of the first drive's backup folder (read from the T7, checked, copied with the safe copy; never replaces, never deletes).
  const mirror = new MirrorService(
    {
      db: deps.db,
      log: deps.log,
      pluggedPlaces: async () => {
        await places.refresh();
        return new Set(places.connectedDrives().map((d) => d.place.id));
      },
      drivesFor: async (srcPlaceId, dstPlaceId) => {
        await places.refresh();
        const open = (placeId: string): ReturnType<typeof realMirrorDrive> | null => {
          const d = places.connectedDrives().find((x) => x.place.id === placeId);
          return d ? realMirrorDrive({ db: deps.db, placeId, label: d.place.label, root: d.root, quickRunner }) : null;
        };
        return { src: open(srcPlaceId), dst: open(dstPlaceId) };
      },
      usbTrouble: async (placeId, sinceMs) => {
        await usb.check();
        return usb.troubleSince(placeId, sinceMs);
      },
      writeProtected: writeProtectedLine,
      ...(deps.dbFile ? { behindInWorker: (pair) => behindInWorker(deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js'), deps.dbFile!, pair) } : {}),
      ...(deps.keepAwake ? { keepAwake: deps.keepAwake } : {}),
      wakeCount: () => deps.jobs.wakeCount,
    },
    deps.jobs,
  );
  for (const handler of mirror.handlers()) deps.jobs.register(handler);
  // Folder backups (OneDrive, a data folder, the Google Keep notes): the folder and the drive are looked at (the listing's quick look, off the window's thread), the person
  // looks through the list and confirms, then a verified copy adds new dated folders to the drive of the backup. Never overwrites, never deletes.
  const folderBackup = new FolderBackupService(
    {
      db: deps.db,
      log: deps.log,
      pluggedPlaces: async () => {
        await places.refresh();
        return new Set(places.connectedDrives().map((d) => d.place.id));
      },
      driveFor: async (placeId) => {
        await places.refresh();
        const d = places.connectedDrives().find((x) => x.place.id === placeId);
        return d ? { drive: realMirrorDrive({ db: deps.db, placeId, label: d.place.label, root: d.root, quickRunner }), label: d.place.label } : null;
      },
      sourceFor: realSourceFor({ db: deps.db, quickRunner, skipFolders: () => settings.get().skipFolders }),
      writeProtected: writeProtectedLine,
      ...(deps.keepAwake ? { keepAwake: deps.keepAwake } : {}),
      wakeCount: () => deps.jobs.wakeCount,
    },
    deps.jobs,
  );
  for (const handler of folderBackup.handlers()) deps.jobs.register(handler);
  // Google accounts (add, sign out, remove, the app key) and "Copy to Google": the file is read again from the drive, uploaded whole to one account and counted only when Google's own checksum agrees.
  const googleAccounts = new GoogleAccountsService({
    db: deps.db,
    vault,
    auth: googleAuth,
    http: googleHttp,
    openBrowser: deps.openExternal ?? (() => Promise.reject(new Error('No browser available'))),
    busy: (placeId) => drive.isRefreshing(placeId),
    changed: () => places.republish(),
  });
  const googleCopy = new GoogleCopyService({
    db: deps.db,
    log: deps.log,
    uploader,
    auth: googleAuth,
    http: googleHttp,
    room: async (placeId, signal) => {
      const about = await googleApi.about(placeId, signal);
      return { limit: about.limit, usage: about.usage };
    },
    driveRoot: async (placeId) => {
      await places.refresh();
      return places.connectedDrives().find((d) => d.place.id === placeId)?.root ?? null;
    },
    hashFile: async (file, yieldNow) => {
      const h = await hashUnbuffered(file, { md5: true, yieldNow });
      return { sha256: h.sha256, md5: h.md5, bytes: h.bytes };
    },
    fileSize: async (file) => {
      try {
        return (await rawFs.promises.stat(file)).size;
      } catch {
        return null;
      }
    },
    jobs: deps.jobs,
    pluggedPlaces: async () => {
      await places.refresh();
      return new Set(places.connectedDrives().map((d) => d.place.id));
    },
    ...(deps.keepAwake ? { keepAwake: deps.keepAwake } : {}),
  });
  for (const handler of googleCopy.handlers()) deps.jobs.register(handler);
  // The Devices screen shows a plugged-in phone as connected (adb devices only, at most every 30 seconds, only when a phone place has a serial).
  places.setPhoneSource(() => phoneBackup.pluggedSerials());
  const rules = new RulesService({ db: deps.db, plans: { effectFiles: (backupId, planId) => phoneBackup.effectFiles(backupId, planId) ?? folderBackup.effectFiles(backupId, planId) }, log: deps.log });
  const decisions = new DecisionService({ db: deps.db, places, phoneBackup, log: deps.log, changed: () => { dataVersion.bump(); phoneBackup.countsChanged(); } });
  const why = new WhyService({ db: deps.db });

  // Clean up: removes only what the person ticked and confirmed, after checking again file by file (see cleanup/safety.ts).
  const diskSize = diskSizeFor(deps.db, localBase);
  // "Safe to remove from the phone" = a verified copy on the T7 AND the Seagate (Backups layout) AND in Google (cleanup/phoneRule.ts).
  const phoneDestinations = (): CleanDestination[] => phoneCleanDestinations(deps.db);
  deps.jobs.register(phoneCleanHandler({ db: deps.db, log: deps.log, adb, baseOf: localBase, diskSize, changed: () => dataVersion.bump(), destinations: phoneDestinations }));
  deps.jobs.register(putBackHandler({ db: deps.db, log: deps.log, adb, baseOf: localBase, diskSize }));
  const cleanStoreForRoots = new CleanStore(deps.db);
  const oneDriveRoots = (): string[] => cleanStoreForRoots.oneDriveRoots();
  const driveRoots = async (): Promise<string[]> => {
    await places.refresh();
    return places.connectedDrives().map((d) => d.root);
  };
  // Files in the Windows profile (Documents, Desktop, Pictures, Downloads...) are only offered when the person switched that on.
  const userFolderRoots = (): string[] => (settings.get().duplicatesInUserFolders ? [] : [os.homedir()]);
  deps.jobs.register(laptopCleanHandler({ db: deps.db, log: deps.log, oneDriveRoots, driveRoots, userFolderRoots, changed: () => dataVersion.bump() }));
  const cleanup = new CleanupService({
    db: deps.db,
    phone: { db: deps.db, adb, baseOf: localBase, diskSize, destinations: phoneDestinations },
    laptop: { db: deps.db, oneDriveRoots, driveRoots, userFolderRoots },
    jobs: deps.jobs,
    log: deps.log,
    changed: () => dataVersion.bump(),
  });

  // Free up phone space (R1.5): a file leaves the phone only when its checksum read from the phone now equals copies re-read now on the
  // T7 and the Seagate and Google's own answer now (freeUp/freeUpCheck.ts, freeUpRemove.ts; every removal goes through danger/).
  const freeUpResults = new FreeUpResults();
  const freeUpAdb = adb as FreeUpAdb; // the real client (AdbCleanClient) has the batch calls the removal uses
  const freeUpDeps = { db: deps.db, adb: freeUpAdb, baseOf: localBase, google: new DriveGoogleAsk(googleHttp, googleAuth), results: freeUpResults, changed: () => dataVersion.bump() };
  deps.jobs.register(freeUpCheckHandler(freeUpDeps));
  deps.jobs.register(freeUpRemoveHandler({ ...freeUpDeps, log: deps.log }));
  const freeUp = new FreeUpService({ db: deps.db, jobs: deps.jobs, results: freeUpResults, baseOf: localBase, putBack: (request) => cleanup.putBack(request), log: deps.log });

  // Laptop app data snapshot (job kind appdata.snapshot): nothing creates it until R2.3 builds its screen.
  deps.jobs.register(
    appDataSnapshotHandler({
      log: deps.log,
      baseOf: localBase,
      freeBytes: freeBytesOf,
      sources: () => settings.get().appDataSources,
      laptop: () => ({ id: places.thisDevice.id, name: places.thisDevice.label }),
    }),
  );
  // One job at a time per drive (anything that reads or writes it), and none on a drive with USB trouble.
  const drivePlaceIds = (): Set<string> => new Set((deps.db.prepare("SELECT id FROM places WHERE kind = 'drive'").pluck().all() as string[]));
  const destOfBackup = (backupId: unknown): string | null => (typeof backupId === 'number' ? ((deps.db.prepare('SELECT place_id FROM backup_destinations WHERE backup_profile_id = ? AND enabled = 1 ORDER BY position, id LIMIT 1').pluck().get(backupId) as string | undefined) ?? null) : null);
  deps.jobs.setDriveResolver((kind, params) => {
    const p = (params ?? {}) as { placeId?: unknown; placeIds?: unknown; preferPlaces?: unknown; pick?: { kind?: unknown }; plan?: { targetPlaceId?: unknown; files?: { sourcePlaceId?: unknown }[] } };
    let ids: unknown[] = [];
    if (kind === LIST_PLACE_JOB_KIND || kind === LOOK_AGAIN_JOB_KIND || kind === HASH_FILES_JOB_KIND || kind === APPDATA_SNAPSHOT_JOB_KIND) ids = [p.placeId];
    else if (kind === PHONE_LOOK_JOB_KIND || kind === PHONE_BACKUP_JOB_KIND || kind === PHONE_CHECK_OLD_JOB_KIND) ids = [(params as { destPlaceId?: unknown } | null)?.destPlaceId ?? destOfBackup((params as { backupId?: unknown } | null)?.backupId)];
    else if (kind === FOLDER_LOOK_JOB_KIND || kind === FOLDER_BACKUP_JOB_KIND) ids = [(params as { destPlaceId?: unknown } | null)?.destPlaceId ?? destOfBackup((params as { backupId?: unknown } | null)?.backupId)];
    else if (kind === MIRROR_LOOK_JOB_KIND || kind === MIRROR_COPY_JOB_KIND || kind === MIRROR_CHECK_JOB_KIND) ids = mirrorPlaceIds(params);
    else if (kind === GOOGLE_COPY_JOB_KIND) ids = mirrorPlaceIds(params);
    else if (kind === COPY_TO_LOCAL_JOB_KIND) ids = [p.plan?.targetPlaceId, ...(p.plan?.files ?? []).map((f) => f.sourcePlaceId)];
    else if (kind === KIND_SAVE_SETTINGS) ids = Array.isArray(p.placeIds) ? p.placeIds : places.connectedDrives().map((d) => d.place.id);
    else if (kind === FREEUP_CHECK_JOB_KIND || kind === FREEUP_REMOVE_JOB_KIND) ids = typeof (params as { backupId?: unknown } | null)?.backupId === 'number' ? (deps.db.prepare('SELECT place_id FROM backup_destinations WHERE backup_profile_id = ? AND enabled = 1').pluck().all((params as { backupId: number }).backupId) as string[]) : [];
    else if (kind === RESTORE_JOB_KIND) ids = Array.isArray(p.preferPlaces) ? p.preferPlaces : [];
    const drives = drivePlaceIds();
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && drives.has(id)))];
  });
  // Whose job it is: the owner of the backup, phone or Google account it works on (drives and the laptop are shared: no owner).
  const ownerOfBackup = deps.db.prepare('SELECT person_id FROM backup_profiles WHERE id = ?').pluck();
  const ownerOfSerial = deps.db.prepare('SELECT person_id FROM backup_profiles WHERE phone_serial = ?').pluck();
  const ownerOfPlace = deps.db.prepare("SELECT profile_id FROM places WHERE id = ? AND kind IN ('phone', 'gdrive')").pluck();
  deps.jobs.setOwnerResolver((_kind, params) => {
    const p = (params ?? {}) as { backupId?: unknown; serial?: unknown; placeId?: unknown };
    if (typeof p.backupId === 'number') return (ownerOfBackup.get(p.backupId) as number | undefined) ?? null;
    if (typeof p.serial === 'string') return (ownerOfSerial.get(p.serial) as number | undefined) ?? null;
    if (typeof p.placeId === 'string') return (ownerOfPlace.get(p.placeId) as number | undefined) ?? null;
    return null;
  });
  // The backups a job works on (a job over several backups names each), so each backup's page shows its jobs.
  deps.jobs.setBackupsResolver((_kind, params) => {
    const p = (params ?? {}) as { backupId?: unknown; backupIds?: unknown };
    const ids = Array.isArray(p.backupIds) ? p.backupIds.filter((n): n is number => typeof n === 'number') : [];
    if (typeof p.backupId === 'number' && !ids.includes(p.backupId)) ids.push(p.backupId);
    return ids;
  });
  deps.jobs.setDriveGate((_kind, drives) => {
    for (const id of drives) {
      const line = usb.troubleFor(id);
      if (line !== null) return `${line} Nothing was copied.`;
    }
    return null;
  });

  // Files search: "Change category" (your own kinds; the counts follow through the data version).
  const kinds = new KindStore({ db: deps.db, changed: () => dataVersion.bump() });

  // Pause everything: the saved state (it survives a restart) holds the job queue before anything starts, and later changes follow at once.
  const pause = new PauseState({ store: settingsRowPauseStore(deps.db), log: deps.log });
  deps.jobs.setHeld(isPauseOn(pause.start()));
  pause.onChanged((status) => deps.jobs.setHeld(isPauseOn(status)));

  const insightsWorker = deps.queryWorkerPath ?? path.join(__dirname, 'queryWorker.js');
  const insights = new InsightsService({
    db: deps.db,
    places: () => places.snapshot().places,
    runScript: (script) => runPowerShell(script, { timeoutMs: 30_000 }),
    dataVersion,
    log: deps.log,
    ...(deps.dbFile ? { loseInWorker: (placeId: string) => wouldLoseInWorker(insightsWorker, deps.dbFile!, placeId), loseFilesInWorker: (request) => wouldLoseFilesInWorker(insightsWorker, deps.dbFile!, request), onlyHereInWorker: () => onlyHereInWorker(insightsWorker, deps.dbFile!) } : {}),
  });

  return {
    db: deps.db,
    jobs: deps.jobs,
    places,
    listing,
    drive,
    fingerprints,
    query,
    search,
    quickRunner,
    walKeeper,
    dataSpace,
    eject,
    kinds,
    localCopy,
    phoneBackup,
    mirror,
    folderBackup,
    rules,
    decisions,
    why,
    searchIndex,
    savedSearches: new SavedSearches(deps.db),
    usb,
    phone,
    cleanup,
    sharedWithMe,
    roots,
    dataVersion,
    releasePhoneOnQuit: () => releaseWithin(adb, QUIT_RELEASE_MS),
    writeProtectedLine,
    prepareListing: async () => {
      const laptop = { id: places.thisDevice.id, kind: 'laptop' };
      await roots.ensureDefaults(laptop);
      places.republish();
      usb.start();
    },
    profiles,
    backupProfiles,
    settings,
    pause,
    vault,
    appVersion: deps.appVersion,
    dataDir: deps.dataDir,
    logsDir: deps.logsDir,
    importSourceDir,
    insights,
    googleAccounts,
    googleCopy,
    freeUp,
    restore,
  };
}
