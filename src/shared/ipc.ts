import type { PauseChoice, PauseStatus } from './pause';
import type { DemoJobOptions, JobChangedEvent, JobEvent, JobListFilter, JobRecord } from './jobs';
import type { VaultResult, VaultStatus } from './vault';
import type { OwnerResult } from './people';
import type { ChosenRestoreFile, FileActionResult, ProfileResult, RestoreResult, RestoreStatus, SaveNowResult, SavedCopiesOverview, SavedCopyActionResult, SettingResult, TestRestoreResult, SettingsState } from './settings';
import type { ImportV1Info, ImportV1StartResult } from './importV1';
import type { FingerprintNowResult, RetryFailedResult } from './fingerprint';
import type { CleanStartResult, CleanupOverview, EmptyQuarantineRequest, EmptyQuarantineResult, LaptopCleanPlanResult, LaptopCleanStartRequest, UndoResult, PhoneCleanPlanResult, PhoneCleanStartRequest, PutBackRequest } from './cleanup';
import type { PhoneEjectResult, PhoneStatus } from './phone';
import type { LocalCopyStartRequest, LocalCopyStartResult, LocalPlanResult, LocalTarget } from './localCopy';
import type { DriveRefreshResult, DriveSignInResult } from './drive';
import type { AddRootResult, ListNowResult, RemoveRootResult } from './listing';
import type { OpenInDriveResult, SavedSearchResult, SearchIndexStatus, SearchRequest, SearchResponse, ShowInFolderResult } from './search';
import type { SharedLookResult, SharedWithMeOverview } from './sharedWithMe';
import type { StartupStatus } from './startup';
import type { KindChangeResult, SimilarFiles } from './kinds';
import type { DriveHealthResult, OnlyHereResult, ReminderDaysResult, WouldLoseFilesRequest, WouldLoseFilesResult, WouldLoseResult } from './insights';
import type { EjectResult, NameDriveRequest, NameDriveResult, PlacesSnapshot, RenameResult } from './places';
import type { DataSpaceInfo } from './dataSpace';
import type { ArchiveResult, BackupSizesResult, BackupsOverview, HistoryPlan, HistoryResult } from './backups';
import type { DecisionAnswerRequest, DecisionAnswerResult, DecisionList, DecisionListRequest, WhyRequest, WhyResult } from './decisions';
import type { NotCoveredResult, NotCoveredTickRequest, RuleAddRequest, RuleAddResult, RuleEffectRequest, RuleEffectResult, RuleRemoveRequest, RuleRemoveResult, RulesListResult } from './rules';
import type { FolderBackupCards, FolderBackupProgress, FolderBackupReport, FolderBackupSelection, FolderBackupStartResult, FolderCopiedFiles, FolderLookResult, KeepSyncAddResult } from './folderBackup';
import type { MirrorCheckPreviewResult, MirrorCheckReport, MirrorCheckSelection } from './mirrorCheck';
import type { GoogleAccountActionResult, GoogleAddResult, GoogleCopyAddAccountsRequest, GoogleCopyMoreResult, GoogleCopyPlanRequest, GoogleCopyPlanResult, GoogleCopyPreviewResult, GoogleCopyReport, GoogleCopyStartRequest, GoogleSentLine, GoogleCopyStartResult, GoogleCopyStatusResult, GoogleKeyInput, GoogleKeyStatus } from './googleCopy';
import type { MirrorAddRequest, MirrorAddResult, MirrorChoicesResult, MirrorLookResult, MirrorReport, MirrorSelection, MirrorStartResult, MirrorStatusResult } from './mirror';
import type { FreeUpMode, FreeUpFilesRequest, FreeUpFilesResult, FreeUpKeepRequest, FreeUpKeepResult, FreeUpOverviewResult, FreeUpPrepareRequest, FreeUpPrepareResult, FreeUpPutBackRequest, FreeUpRemovedIdsResult, FreeUpRemovedPageRequest, FreeUpRemovedPageResult, FreeUpResultResult, FreeUpShowCopyRequest, FreeUpShowCopyResult, FreeUpStartRequest, FreeUpStartResult, FreeUpTickRequest, FreeUpTickResult } from './freeUp';
import type { RestoreBrowseRequest, RestoreBrowseResult, RestoreChooseFolderResult, RestoreDatesResult, RestoreInfoResult, RestorePlanRequest, RestorePlanResult, RestoreStartResult } from './restore';
import type { CheckOldCountsResult, CheckOldPlanResult, CheckOldReport, CheckOldRequest, ConnectedPhones, CopiedFiles, CreatePhoneBackupRequest, CreatePhoneBackupResult, LinkPhoneRequest, LinkPhoneResult, NewBackupChoices, PhoneBackupProgress, PhoneBackupReport, PhoneBackupSelection, PhoneBackupStartResult, PhoneLookResult, SafeUnplugResult } from './phoneBackup';

/**
 * The single contract between renderer, preload and main. Later packages add channels here;
 * nothing else in the renderer may reach Electron or Node.
 */

/** Request/response channels (renderer -> main). */
export const IPC = {
  appVersion: 'app:version',
  appTimings: 'app:timings',
  /** Fire-and-forget: renderer tells main it has painted. */
  reportFirstPaint: 'timing:first-paint',
  /** Bench runs only (BACKUPHUB_BENCH): the window's screen-switch measurements. Refused otherwise. */
  benchReport: 'bench:report',
  jobsList: 'jobs:list',
  jobsGet: 'jobs:get',
  jobsEvents: 'jobs:events',
  jobsRetry: 'jobs:retry',
  appDataReady: 'app:data-ready',
  appStartupStatus: 'app:startup-status',
  jobsCancel: 'jobs:cancel',
  jobsPause: 'jobs:pause',
  jobsResume: 'jobs:resume',
  jobsResolve: 'jobs:resolve',
  /** An interrupted job carries on from its checkpoint (only ever from the person's click). */
  jobsContinue: 'jobs:continue',
  /** An interrupted job is marked as seen: no more Continue. Nothing is deleted. */
  jobsDismiss: 'jobs:dismiss',
  pauseGet: 'pause:get',
  pauseSet: 'pause:set',
  /** Dev builds only: main registers no handler when packaged. */
  jobsCreateDemo: 'jobs:create-demo',
  placesList: 'places:list',
  placesRefresh: 'places:refresh',
  placesNameDrive: 'places:name-drive',
  placesRename: 'places:rename',
  placesEject: 'places:eject',
  dataSpaceGet: 'data-space:get',
  listingListNow: 'listing:list-now',
  listingLookAgain: 'listing:look-again',
  listingAddRoot: 'listing:add-root',
  listingRemoveRoot: 'listing:remove-root',
  driveRefresh: 'drive:refresh',
  driveRefreshAll: 'drive:refresh-all',
  driveSignIn: 'drive:sign-in',
  sharedOverview: 'shared:overview',
  sharedLook: 'shared:look',
  fingerprintNow: 'fingerprint:now',
  fingerprintRetry: 'fingerprint:retry',
  fingerprintCheckAll: 'fingerprint:check-all',
  profilesList: 'profiles:list',
  profilesCreate: 'profiles:create',
  profilesRename: 'profiles:rename',
  profilesDelete: 'profiles:delete',
  peopleSetBackupOwner: 'people:set-backup-owner',
  peopleSetPlaceOwner: 'people:set-place-owner',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsOpenDataFolder: 'settings:open-data-folder',
  settingsSaveNow: 'settings:save-now',
  settingsSavedCopies: 'settings:saved-copies',
  settingsRemoveOldCopies: 'settings:remove-old-copies',
  settingsTestSavedCopy: 'settings:test-saved-copy',
  settingsRestoreStatus: 'settings:restore-status',
  settingsRestoreFromDrive: 'settings:restore-from-drive',
  settingsChooseRestoreFile: 'settings:choose-restore-file',
  settingsRestoreFromFile: 'settings:restore-from-file',
  settingsCancelRestore: 'settings:cancel-restore',
  settingsRecoveryNow: 'settings:recovery-now',
  vaultStatus: 'vault:status',
  vaultSetPassphrase: 'vault:set-passphrase',
  vaultChangePassphrase: 'vault:change-passphrase',
  vaultRemovePassphrase: 'vault:remove-passphrase',
  vaultUnlock: 'vault:unlock',
  vaultForgot: 'vault:forgot',
  importV1Info: 'import:v1-info',
  importV1Start: 'import:v1-start',
  searchRun: 'search:run',
  searchShowInFolder: 'search:show-in-folder',
  searchOpenInDrive: 'search:open-in-drive',
  kindsSimilar: 'kinds:similar',
  kindsChange: 'kinds:change',
  phoneStatus: 'phone:status',
  phoneEject: 'phone:eject',
  localCopyTargets: 'local-copy:targets',
  localCopyPlan: 'local-copy:plan',
  localCopyStart: 'local-copy:start',
  cleanupOverview: 'cleanup:overview',
  cleanupPhonePlan: 'cleanup:phone-plan',
  cleanupPhoneProgress: 'cleanup:phone-progress',
  cleanupPhoneStart: 'cleanup:phone-start',
  cleanupPutBack: 'cleanup:put-back',
  cleanupLaptopPlan: 'cleanup:laptop-plan',
  cleanupLaptopStart: 'cleanup:laptop-start',
  cleanupUndo: 'cleanup:undo',
  cleanupEmptyQuarantine: 'cleanup:empty-quarantine',
  backupsOverview: 'backups:overview',
  backupsSizes: 'backups:sizes',
  backupsArchive: 'backups:archive',
  backupsUnarchive: 'backups:unarchive',
  backupsHistoryPlan: 'backups:history-plan',
  backupsHistoryRun: 'backups:history-run',
  backupsLinkPhone: 'backups:link-phone',
  backupsUnlinkPhone: 'backups:unlink-phone',
  backupsNewPhoneChoices: 'backups:new-phone-choices',
  backupsCreatePhoneBackup: 'backups:create-phone-backup',
  phoneBackupConnected: 'phone-backup:connected',
  phoneBackupSafeUnplug: 'phone-backup:safe-unplug',
  phoneBackupUseAgain: 'phone-backup:use-again',
  phoneBackupLook: 'phone-backup:look',
  phoneBackupPreview: 'phone-backup:preview',
  phoneBackupStart: 'phone-backup:start',
  phoneBackupReport: 'phone-backup:report',
  phoneBackupProgress: 'phone-backup:progress',
  phoneBackupCopied: 'phone-backup:copied',
  phoneBackupCheckOldCounts: 'phone-backup:check-old-counts',
  phoneBackupCheckOldPlan: 'phone-backup:check-old-plan',
  phoneBackupCheckOldStart: 'phone-backup:check-old-start',
  phoneBackupCheckOldReport: 'phone-backup:check-old-report',
  rulesList: 'rules:list',
  rulesEffect: 'rules:effect',
  rulesAdd: 'rules:add',
  rulesRemove: 'rules:remove',
  notCoveredGet: 'rules:not-covered',
  notCoveredTick: 'rules:not-covered-tick',
  folderBackupCards: 'folder-backup:cards',
  folderBackupLook: 'folder-backup:look',
  folderBackupPreview: 'folder-backup:preview',
  folderBackupStart: 'folder-backup:start',
  folderBackupReport: 'folder-backup:report',
  folderBackupProgress: 'folder-backup:progress',
  folderBackupCopied: 'folder-backup:copied',
  folderBackupAddKeepSync: 'folder-backup:add-keep-sync',
  mirrorChoices: 'mirror:choices',
  mirrorAdd: 'mirror:add',
  mirrorStatus: 'mirror:status',
  mirrorLook: 'mirror:look',
  mirrorPreview: 'mirror:preview',
  mirrorStart: 'mirror:start',
  mirrorReport: 'mirror:report',
  mirrorCheckPreview: 'mirror:checkPreview',
  mirrorCheckStart: 'mirror:checkStart',
  mirrorCheckReport: 'mirror:checkReport',
  decisionsList: 'decisions:list',
  decisionsAnswer: 'decisions:answer',
  fileWhy: 'file:why',
  searchIndexStatus: 'search:index-status',
  searchSavedList: 'search:saved-list',
  searchSavedSave: 'search:saved-save',
  searchSavedRemove: 'search:saved-remove',
  insightsDriveHealth: 'insights:drive-health',
  insightsReminderDays: 'insights:reminder-days',
  insightsSetReminderDays: 'insights:set-reminder-days',
  insightsWouldLose: 'insights:would-lose',
  insightsOnlyHere: 'insights:only-here',
  insightsWouldLoseFiles: 'insights:would-lose-files',
  googleAccountAdd: 'google-accounts:add',
  googleAccountSignOut: 'google-accounts:sign-out',
  googleAccountRemove: 'google-accounts:remove',
  googleKeyStatus: 'google-accounts:key-status',
  googleKeySave: 'google-accounts:key-save',
  googleCopyStatus: 'google-copy:status',
  googleCopyPreview: 'google-copy:preview',
  googleCopyStart: 'google-copy:start',
  googleCopyReport: 'google-copy:report',
  googleCopyPlan: 'google-copy:plan',
  googleCopyMore: 'google-copy:more',
  googleCopyAddAccounts: 'google-copy:add-accounts',
  googleCopySent: 'google-copy:sent',
  freeUpOverview: 'freeUp:overview',
  freeUpStartCheck: 'freeUp:startCheck',
  freeUpResult: 'freeUp:result',
  freeUpFiles: 'freeUp:files',
  freeUpPrepare: 'freeUp:prepare',
  freeUpStart: 'freeUp:start',
  freeUpKeep: 'freeUp:keep',
  freeUpUnkeep: 'freeUp:unkeep',
  freeUpPutBack: 'freeUp:putBack',
  freeUpRemovedPage: 'freeUp:removedPage',
  freeUpRemovedIds: 'freeUp:removedIds',
  freeUpShowCopy: 'freeUp:showCopy',
  freeUpTick: 'freeUp:tick',
  restoreInfo: 'restore:info',
  restoreDates: 'restore:dates',
  restoreBrowse: 'restore:browse',
  restorePlan: 'restore:plan',
  restoreStart: 'restore:start',
  restoreChooseFolder: 'restore:choose-folder',
} as const;

/** Screens main can ask the renderer to open (e.g. when a notification is clicked). */
export type NavigateTarget = 'jobs';

/** Push channels (main -> renderer) and their payloads. */
export interface IpcEventMap {
  'timings:updated': TimingsSnapshot;
  'jobs:changed': JobChangedEvent;
  'app:navigate': { screen: NavigateTarget };
  'places:changed': PlacesSnapshot;
  'settings:changed': SettingsState;
  'pause:changed': PauseStatus;
}
export type EventChannel = keyof IpcEventMap;
export const EVENT_CHANNELS: readonly EventChannel[] = ['timings:updated', 'jobs:changed', 'app:navigate', 'places:changed', 'settings:changed', 'pause:changed'];

/** Startup marks, in the order they normally happen. Values are ms since process start. */
export const TIMING_MARKS = ['appReady', 'dbReady', 'windowCreated', 'readyToShow', 'firstPaint'] as const;
export type TimingMark = (typeof TIMING_MARKS)[number];

export interface TimingsSnapshot {
  /** ms since the process was created, per mark reached so far. */
  marks: Partial<Record<TimingMark, number>>;
  /** One-line human summary, e.g. "startup: appReady=310ms ... total=742ms". */
  summary: string;
  /** True once every mark in TIMING_MARKS has been reached. */
  complete: boolean;
}

export interface FirstPaintReport {
  /** First-contentful-paint reported by the renderer (ms since navigation start), if known. */
  fcpMs: number | null;
}

/** What the window measured during a bench run (npm run bench): when Home was usable, and each screen switch in ms. */
export interface BenchReport {
  /** Epoch ms (performance.timeOrigin + now) when Home was drawn with its data ready. */
  homeReadyEpochMs: number;
  switches: { screen: string; ms: number[] }[];
}

/** What preload exposes as `window.backupHub`. */
export interface BackupHubApi {
  app: {
    version(): Promise<string>;
    /** Resolves when the database is open and the services are ready (the window shows "Opening your data" until then). */
    dataReady(): Promise<boolean>;
    /** What the start is doing while data is not ready: the safety check of the database file, or bringing it up to this version. */
    startupStatus(): Promise<StartupStatus>;
    timings(): Promise<TimingsSnapshot>;
    reportFirstPaint(report: FirstPaintReport): void;
    /** Bench runs only; main refuses it otherwise. */
    benchReport(report: BenchReport): Promise<boolean>;
  };
  jobs: {
    /** Newest first. */
    list(filter?: JobListFilter): Promise<JobRecord[]>;
    get(id: number): Promise<JobRecord | null>;
    events(id: number): Promise<JobEvent[]>;
    /** Creates a NEW job with the same kind and parameters; resolves to its id. */
    retry(id: number): Promise<number>;
    cancel(id: number): Promise<boolean>;
    /** Pause a queued or running job; it keeps its place and frees the heavy slot. */
    pause(id: number): Promise<boolean>;
    /** Let a paused job go on (it waits for a free slot first). */
    resume(id: number): Promise<boolean>;
    /** Answer a job that needs you. */
    resolve(id: number, answer: string): Promise<boolean>;
    /** Carry on an interrupted job from its last checkpoint (false when it cannot). */
    continueInterrupted(id: number): Promise<boolean>;
    /** Mark an interrupted job as seen (false when it is not one). It stays in the list. */
    dismiss(id: number): Promise<boolean>;
    onChanged(callback: (event: JobChangedEvent) => void): () => void;
    /** Dev builds only; rejects in the packaged app. */
    createDemo(options?: DemoJobOptions): Promise<number>;
  };
  /** "Pause everything": the state is kept by main (it survives a restart; a timed pause ends by itself). */
  pause: {
    get(): Promise<PauseStatus>;
    set(choice: PauseChoice): Promise<PauseStatus>;
    onChanged(callback: (state: PauseStatus) => void): () => void;
  };
  places: {
    /** Last known picture; does not list anything. */
    list(): Promise<PlacesSnapshot>;
    /** Lists the attached drives now. */
    refresh(): Promise<PlacesSnapshot>;
    /** The only call that writes to a drive (its ID card). Needs the user's confirmation. */
    nameDrive(request: NameDriveRequest): Promise<NameDriveResult>;
    rename(id: string, label: string): Promise<RenameResult>;
    /**
     * Eject a plugged-in named drive. If jobs are using it the answer is `needsConfirm` (nothing was stopped); call again with
     * `confirmed` true to stop them and eject. Windows has the last word; nothing is forced.
     */
    eject(placeId: string, confirmed: boolean): Promise<EjectResult>;
    onChanged(callback: (snapshot: PlacesSnapshot) => void): () => void;
  };
  /** The disk that holds Backup Hub's data folder: free space, database size, and the plain warning when it is short. */
  dataSpace: {
    get(): Promise<DataSpaceInfo>;
  };
  listing: {
    /** Start a listing job for one connected place (laptop, named drive or OneDrive). Reads names, sizes and dates only. */
    listNow(placeId: string): Promise<ListNowResult>;
    /** "Look again": a quick pass over the laptop or a named drive that reads only the folders that changed. Never deletes anything. */
    lookAgain(placeId: string): Promise<ListNowResult>;
    /** Opens a folder picker and adds the folder to the laptop's list (refused inside OneDrive or another listed folder). */
    addRoot(placeId: string): Promise<AddRootResult>;
    /** Takes a folder off the laptop's list. Needs `confirmed: true`; its files are marked as no longer seen, never deleted. */
    removeRoot(placeId: string, root: string, confirmed: boolean): Promise<RemoveRootResult>;
  };
  /** Read-only Google Drive refresh: asks Google for space used and the list of owned files (or only the changes). Never changes anything in Google. */
  drive: {
    /** Refresh one account. */
    refresh(placeId: string): Promise<DriveRefreshResult>;
    /** Refresh every account that has a sign-in (accounts needing a new sign-in are skipped). */
    refreshAll(): Promise<DriveRefreshResult>;
    /** Opens the browser so the person can sign in to the account again; resolves when it is finished or closed. */
    signIn(placeId: string): Promise<DriveSignInResult>;
  };
  /** Google Drive "shared with me": files other people own. Read only; never counted as a backup copy of the person's files. */
  shared: {
    /** What the last look found (nothing is asked of Google). */
    overview(): Promise<SharedWithMeOverview>;
    /** Asks one Google account what is shared with it and replaces that account's list. Changes nothing in Google. */
    look(placeId: string): Promise<SharedLookResult>;
  };
  fingerprints: {
    /** Start fingerprinting one connected local place: reads each file once to get its SHA-256 and MD5. Changes nothing. */
    now(placeId: string): Promise<FingerprintNowResult>;
    /** Puts the files that could not be read back in the queue and fingerprints them if the place is connected. */
    retryFailed(placeId: string): Promise<RetryFailedResult>;
    /** "Check them now": one job that fingerprints the new or changed files waiting in every connected local place. */
    checkAll(): Promise<FingerprintNowResult>;
  };
  profiles: {
    list(): Promise<ProfileResult>;
    /** `color` is one of the palette colours (src/shared/people.ts); left out, the next one in turn is used. */
    create(name: string, color?: string): Promise<ProfileResult>;
    rename(id: number, name: string): Promise<ProfileResult>;
    /** `confirmed` must be true: the UI asks "always ask before deleting" first. */
    delete(id: number, confirmed: boolean): Promise<ProfileResult>;
  };
  /** Who a backup, a phone or a Google account belongs to. Changes the database only: nothing on a drive is moved or renamed. */
  people: {
    setBackupOwner(backupId: number, personId: number): Promise<OwnerResult>;
    /** A phone or a Google account (drives, the laptop and OneDrive are shared). */
    setPlaceOwner(placeId: string, personId: number): Promise<OwnerResult>;
  };
  settings: {
    get(): Promise<SettingsState>;
    set(key: string, value: unknown): Promise<SettingResult>;
    /** Opens a save dialog; writes profiles, places metadata and settings (never secrets). */
    exportToFile(): Promise<FileActionResult>;
    /** Opens a file dialog and applies the settings file (adds only; nothing is removed). */
    importFromFile(): Promise<FileActionResult>;
    openDataFolder(): Promise<void>;
    /** Queue the settings.saveToDrive job now (needs a named drive plugged in). */
    saveToDriveNow(): Promise<SaveNowResult>;
    /** Read only: the saved copies on each connected named drive and how many are older than the newest `savedCopiesKeep`. */
    savedCopies(): Promise<SavedCopiesOverview>;
    /** Deletes only Backup Hub's own saved copies older than the newest `savedCopiesKeep` of each kind, on one plugged-in drive. Needs `confirmed` true. */
    removeOldCopies(placeId: string, confirmed: boolean): Promise<SavedCopyActionResult>;
    /** Proves a saved copy opens and holds data, using a scratch copy; nothing on the drive is changed. */
    testSavedCopy(placeId: string, name: string): Promise<TestRestoreResult>;
    /** The restore waiting for the next start, if any. */
    restoreStatus(): Promise<RestoreStatus>;
    /** Checks a database copy saved on a plugged-in drive and stages it for the next start. `confirmed` must be true. Nothing in use is changed now. */
    restoreFromDrive(placeId: string, name: string, confirmed: boolean): Promise<RestoreResult>;
    /** Opens a file dialog (database copy or recovery file); the file stays in main until `restoreFromFile`. */
    chooseRestoreFile(): Promise<ChosenRestoreFile>;
    /** Checks the chosen file (a recovery file needs the passphrase) and stages it for the next start. `confirmed` must be true. */
    restoreFromFile(passphrase: string | null, confirmed: boolean): Promise<RestoreResult>;
    /** Drops the staged restore (only Backup Hub's own staged files). */
    cancelRestore(): Promise<boolean>;
    /** Queue the encrypted recovery copy to the chosen Google account now (needs the setting and an account). */
    recoveryNow(): Promise<SaveNowResult>;
    onChanged(callback: (state: SettingsState) => void): () => void;
  };
  /** Recovery passphrase and saved sign-ins. Passphrases are never logged or stored; results are plain objects, never thrown. */
  vault: {
    status(): Promise<VaultStatus>;
    setPassphrase(passphrase: string): Promise<VaultResult>;
    changePassphrase(current: string, next: string): Promise<VaultResult>;
    removePassphrase(current: string): Promise<VaultResult>;
    unlock(passphrase: string): Promise<VaultResult>;
    /** Deletes the saved sign-ins (the app's own data) so the vault starts over. `confirmed` must be true. */
    forgot(confirmed: boolean): Promise<VaultResult>;
  };
  /** Bring in the Google accounts and Drive file list from the archived Fleet Manager v1 copy. */
  importV1: {
    info(): Promise<ImportV1Info>;
    /** Queues the `import.fleetV1` job. `confirmed` must be true: the UI asks first. */
    start(confirmed: boolean): Promise<ImportV1StartResult>;
  };
  /** Read-only search over the catalog. The two actions open Explorer or the browser and change nothing. */
  search: {
    /** Runs on a worker thread. A newer search replaces the one in flight (the older answers 'superseded'). */
    run(request: SearchRequest): Promise<SearchResponse>;
    /** Opens the file's folder in Explorer. Refused unless the place is connected, the file is inside a listed folder and it exists. */
    showInFolder(fileId: number): Promise<ShowInFolderResult>;
    /** Opens the file in the browser. Refused unless its link is https on drive.google.com or docs.google.com. */
    openInDrive(fileId: number): Promise<OpenInDriveResult>;
    /** How ready the search index is ("Search is getting ready: 40%"). Read from memory: nothing waits for the database. */
    indexStatus(): Promise<SearchIndexStatus>;
    /** The saved searches (a few rows). */
    savedList(): Promise<SavedSearchResult>;
    /** Saves the search under a name (an empty name takes the typed words); a name already used is replaced. */
    savedSave(name: string, request: SearchRequest): Promise<SavedSearchResult>;
    savedRemove(id: number): Promise<SavedSearchResult>;
  };
  /** Give files a kind of your own (it wins over the automatic one and survives sorting again). */
  kinds: {
    /** How many other files would change as well if the same kind were given to the files like this one. */
    similar(fileId: number): Promise<SimilarFiles>;
    change(change: unknown): Promise<KindChangeResult>;
  };
  /**
   * "Back up now" to a plugged-in drive (the T7): a plan (read only) and the start of the copy. Start writes nothing unless it
   * gets the id and hash of a plan main made, with `confirmed` true. Nothing is overwritten or deleted.
   */
  localCopy: {
    targets(): Promise<LocalTarget[]>;
    plan(collectionId: number, targetPlaceId: string): Promise<LocalPlanResult>;
    start(request: LocalCopyStartRequest): Promise<LocalCopyStartResult>;
  };
  /** The phone's cable connection for the clean-up screen. Nothing on the phone is changed. */
  phone: {
    status(): Promise<PhoneStatus>;
    /** Stops the adb server so the phone can be unplugged. */
    eject(): Promise<PhoneEjectResult>;
  };
  /**
   * Clean up: the only feature that removes anything. Plans are read only; a start needs the id and hash of a plan main made,
   * the exact count and size the person confirmed, and `confirmed: true`. Every file is checked again right before it is removed.
   */
  cleanup: {
    overview(): Promise<CleanupOverview>;
    /** Free up phone space: a plan of what is SAFE (copy on the T7 and in the cloud, same SHA-256). */
    /** `scope` 'camera' = the camera folder (DCIM) only, 'others' = the other phone folders, left out = all. */
    phonePlan(serial: string, scope?: 'camera' | 'others'): Promise<PhoneCleanPlanResult>;
    phoneProgress(): Promise<{ planning: boolean; done: number; total: number }>;
    phoneStart(request: PhoneCleanStartRequest): Promise<CleanStartResult>;
    /** Copies removed phone files back from the drive copy. */
    putBack(request: PutBackRequest): Promise<CleanStartResult>;
    /** Laptop duplicates: groups of identical files (same SHA-256) with one copy to keep each. */
    laptopPlan(): Promise<LaptopCleanPlanResult>;
    /** Moves the ticked duplicates to the quarantine (a move, never a delete). */
    laptopStart(request: LaptopCleanStartRequest): Promise<CleanStartResult>;
    /** Moves one quarantined laptop file back where it came from (never overwrites). */
    undo(removalId: number): Promise<UndoResult>;
    /** Deletes a quarantine day for good: only after 30 days, only with the exact count and size confirmed. */
    emptyQuarantine(request: EmptyQuarantineRequest): Promise<EmptyQuarantineResult>;
  };
  /** The Backups screen: the list, and "Bring in PhoneBackup history" (read only on the old files; started only by a click). */
  backups: {
    overview(): Promise<BackupsOverview>;
    /** How many files and bytes each backup holds on its first drive, counted off the window's thread (the list shows a placeholder until it arrives). Read only. */
    sizes(): Promise<BackupSizesResult>;
    /** "Remove from list" (a backup that is switched off). Deletes nothing anywhere; reversible. `confirmed` must be true. */
    archive(backupId: number, confirmed: boolean): Promise<ArchiveResult>;
    /** "Put back": a removed backup is on the list again. */
    unarchive(backupId: number): Promise<ArchiveResult>;
    /** What bringing in the history would read (the T7, the three old history files), for the confirm screen. Changes nothing. */
    historyPlan(): Promise<HistoryPlan>;
    /** Makes the backups from PhoneBackup's settings and brings in the three old history files. `confirmed` must be true. Repeatable. */
    bringInHistory(confirmed: boolean): Promise<HistoryResult>;
    /** "Yes, this is <backup>": the phone plugged in now is the phone of this phone backup. Refused for a phone adb does not report right now. */
    linkPhone(request: LinkPhoneRequest): Promise<LinkPhoneResult>;
    /** "Change phone": the backup forgets its phone. `confirmed` must be true. */
    unlinkPhone(backupId: number, confirmed: boolean): Promise<LinkPhoneResult>;
    /** What the "Make a new backup for this phone" form offers for a phone plugged in now: the suggested name, the drives and their folders. Read only. */
    newPhoneChoices(serial: string): Promise<NewBackupChoices>;
    /** "Make a new backup for this phone": a backup of its own, saved to the chosen drive and folder. Changes the list of backups only; nothing is written to the drive. */
    createPhoneBackup(request: CreatePhoneBackupRequest): Promise<CreatePhoneBackupResult>;
  };
  /** "Back up <phone> now" (R1.2a): only ever from a click. Look and plan, the preview, the confirmed copy, the report. */
  phoneBackup: {
    /** Which phones with a backup are plugged in (read only). */
    connected(): Promise<ConnectedPhones>;
    /** "Safe to unplug": waits for nothing (a phone job that uses the phone refuses, naming the job), lets go of adb and stops asking about phones until one is plugged in again. */
    safeUnplug(): Promise<SafeUnplugResult>;
    /** Ends the "Safe to unplug" state at once (adb is asked about phones again). */
    useAgain(): Promise<void>;
    /** Starts the look-and-plan job (nothing is copied). `accept` answers a doubtful look the person chose to accept. */
    look(backupId: number, accept?: string[]): Promise<PhoneBackupStartResult>;
    /** The answer of a finished look job (the preview), or null while it still runs. */
    preview(jobId: number): Promise<PhoneLookResult | null>;
    /** Starts the copy for what the person confirmed (the ids and the hash of the plan main made, plus their unticks). */
    start(selection: PhoneBackupSelection): Promise<PhoneBackupStartResult>;
    /** The report of a finished backup run (kept in Activity), or null. */
    report(jobId: number): Promise<PhoneBackupReport | null>;
    /** What a running copy is doing (read only): the file now, the files still waiting, the ones done. Null for a job that is not known. */
    progress(jobId: number): Promise<PhoneBackupProgress | null>;
    /** Every file a finished run copied (read only), for "Show all copied files". Null for a job without a report. */
    copied(jobId: number): Promise<CopiedFiles | null>;
    /** "Check old copies" (R1.4b): how many of the phone's files have a checked copy on the drive, per folder. From the index alone: no phone, no drive. */
    checkOldCounts(backupId: number): Promise<CheckOldCountsResult>;
    /** The preview of the check: the folders with copies not checked yet, largest first. Needs the phone and the drive; reads nothing from the files. */
    checkOldPlan(backupId: number): Promise<CheckOldPlanResult>;
    /** Starts the check for the ticked folders: reads each file on the phone and on the drive and compares them. Changes nothing on either. */
    checkOldStart(request: CheckOldRequest): Promise<PhoneBackupStartResult>;
    /** The report of a finished check (kept in Activity), or null. */
    checkOldReport(jobId: number): Promise<CheckOldReport | null>;
  };
  /** "Your choices" of a phone backup (never back up / always include) and the things no backup can copy. A choice only changes what the next preview offers; nothing is deleted. */
  rules: {
    /** The choices of one backup, in plain words, oldest first. */
    list(backupId: number): Promise<RulesListResult>;
    /** What saving or removing a choice would do to the plan main holds (files left out or brought back). Reads only. */
    effect(request: RuleEffectRequest): Promise<RuleEffectResult>;
    /** Saves a "never back up" or "always include" for this backup. */
    add(request: RuleAddRequest): Promise<RuleAddResult>;
    /** Removes a choice (only with confirmed: true). Changes only what the next backup offers. */
    remove(request: RuleRemoveRequest): Promise<RuleRemoveResult>;
    /** The list of things no backup can copy, with the ticks kept for this backup. */
    notCovered(backupId: number): Promise<NotCoveredResult>;
    /** Ticks or unticks one of them. */
    tickNotCovered(request: NotCoveredTickRequest): Promise<NotCoveredResult>;
  };
  /** Folder backups (R2.1) and the Google Keep notes backup (R2.8): the same run as the phone backup, only ever from a click. */
  folderBackup: {
    /** The folder backups that are switched on, and whether the keep-sync notes backup can be offered or exists. Read only. */
    cards(): Promise<FolderBackupCards>;
    /** Starts the look-and-plan job (nothing is copied). */
    look(backupId: number): Promise<FolderBackupStartResult>;
    /** The answer of a finished look job (the list), or null while it still runs. */
    preview(jobId: number): Promise<FolderLookResult | null>;
    /** Starts the copy for what the person confirmed (the ids and the hash of the plan main made, plus their unticks). */
    start(selection: FolderBackupSelection): Promise<FolderBackupStartResult>;
    /** The report of a finished run (kept in Activity), or null. */
    report(jobId: number): Promise<FolderBackupReport | null>;
    /** What a running copy is doing (read only). */
    progress(jobId: number): Promise<FolderBackupProgress | null>;
    /** Every file a finished run copied (read only). */
    copied(jobId: number): Promise<FolderCopiedFiles | null>;
    /** "Add Google Keep notes backup": database only; nothing is copied or written to a drive. */
    addKeepSync(): Promise<KeepSyncAddResult>;
  };
  /** The second drive (R1.3): "Also keep a copy on <drive>", "Bring <drive> up to date" (look, list, confirmed copy from the first drive), report and status. Only ever from a click. */
  mirror: {
    /** The drives that can hold the second copy of a backup, and which are plugged in. Read only. */
    choices(backupId: number): Promise<MirrorChoicesResult>;
    /** "Also keep a copy on <drive>": database only; nothing is copied or written to a drive. */
    add(request: MirrorAddRequest): Promise<MirrorAddResult>;
    /** Per backup with a second drive: which drives are plugged in and how far behind the second is (counted off the window's thread). */
    status(): Promise<MirrorStatusResult>;
    /** Starts the look-and-list job for one backup, or for every backup with a second drive (no id). Nothing is copied. */
    look(backupId?: number): Promise<MirrorStartResult>;
    /** The answer of a finished look job (the list), or null while it still runs. */
    preview(jobId: number): Promise<MirrorLookResult | null>;
    /** Starts the copy for what the person confirmed (the ids and the hash of the list main made, plus their unticks). */
    start(selection: MirrorSelection): Promise<MirrorStartResult>;
    /** The report of a finished copy (kept in Activity), or null. */
    report(jobId: number): Promise<MirrorReport | null>;
    /** "Check old copies on <drive>": the list made from the file list alone (one backup, or all; no drive is read), with an honest time guess. */
    checkPreview(backupId?: number): Promise<MirrorCheckPreviewResult>;
    /** Starts the check job for the list main made (id and hash). Reads the second drive; changes nothing on either drive. */
    checkStart(selection: MirrorCheckSelection): Promise<MirrorStartResult>;
    /** The report of a finished or stopped check (kept in Activity), or null. */
    checkReport(jobId: number): Promise<MirrorCheckReport | null>;
  };
  /** "Needs your decision": the open cases (drive questions, a refused look at the phone, copies found different), and the person's answer. */
  decisions: {
    /** The open cases, read only. `backupId` and `since` narrow it to one backup and to what a run just found. */
    list(request: DecisionListRequest): Promise<DecisionList>;
    /** Answers one case; main hands it to the part that owns the case. Nothing is removed, renamed or copied. */
    answer(request: DecisionAnswerRequest): Promise<DecisionAnswerResult>;
  };
  /** "Why?" on a file: where each copy is, how it was checked, what leaves it out, whether it is safe for Free up phone space, what happened to it. Read only. */
  why: {
    file(request: WhyRequest): Promise<WhyResult>;
  };
  /** Drive health, reminders and "What would I lose?". Read only: nothing is copied, changed or deleted. */
  insights: {
    /** Per named drive: what Windows says about the disk (or "could not tell"), USB trouble in the last 30 days, the size of the next backup. Runs a read-only PowerShell child process. */
    driveHealth(): Promise<DriveHealthResult>;
    /** The reminder days per backup (a backup not listed uses 7). */
    reminderDays(): Promise<ReminderDaysResult>;
    /** Sets the days of one backup's reminder (null = back to 7). The only thing this group writes. */
    setReminderDays(backupId: number, days: number | null): Promise<ReminderDaysResult>;
    /** The files of one device that have no checked copy anywhere else, by kind and folder (counted off the window's thread). */
    wouldLose(placeId: string): Promise<WouldLoseResult>;
    /** The one-line summary of every device ("12.3 GB only here"). */
    onlyHere(): Promise<OnlyHereResult>;
    /** One page of those files (biggest first), with the words typed in the search box and an optional kind. */
    wouldLoseFiles(request: WouldLoseFilesRequest): Promise<WouldLoseFilesResult>;
  };
  /** Google accounts (G1) and the Google app key (G2). Only from clicks; nothing in a Google account is deleted. */
  googleAccounts: {
    /** "Add a Google account": opens the browser, waits for the sign-in, adds the account (owner = `profileId`, else the first person). */
    add(profileId?: number): Promise<GoogleAddResult>;
    /** Gives the app's permission back to Google and forgets the saved sign-in; the account stays in the list. */
    signOut(placeId: string): Promise<GoogleAccountActionResult>;
    /** Takes the account off the list (needs `confirmed`). Refused while it holds copies of backups. Nothing is deleted. */
    remove(placeId: string, confirmed: boolean): Promise<GoogleAccountActionResult>;
    /** Is the Google app key saved? (never the key itself) */
    keyStatus(): Promise<GoogleKeyStatus>;
    /** Saves the Google app key (client id and secret). */
    saveKey(input: GoogleKeyInput): Promise<GoogleAccountActionResult>;
  };
  /** "Copy to Google" for a backup (G3): the first line, the capacity screen, the confirmed copy (a job), the report. Only ever from the person's click. */
  googleCopy: {
    status(backupId: number): Promise<GoogleCopyStatusResult>;
    /** The capacity screen. `onlyOnPhone` (phone backups): count only files whose content is still on the phone. */
    preview(backupId: number, onlyOnPhone?: boolean): Promise<GoogleCopyPreviewResult>;
    start(request: GoogleCopyStartRequest): Promise<GoogleCopyStartResult>;
    report(jobId: number): Promise<GoogleCopyReport | null>;
    /** What each ticked account has been sent so far in a copy (live while it runs; after a restart from what was written down). */
    sent(jobId: number): Promise<GoogleSentLine[]>;
    /** Where every file of the ticked kinds would go in the ticked accounts (the real per-file plan). Changes nothing. */
    plan(request: GoogleCopyPlanRequest): Promise<GoogleCopyPlanResult>;
    /** The picker again for a copy that waits because the accounts the person picked are full. */
    more(jobId: number): Promise<GoogleCopyMoreResult>;
    /** Adds the confirmed accounts to a waiting copy (the window then presses Continue). */
    addAccounts(request: GoogleCopyAddAccountsRequest): Promise<GoogleAccountActionResult>;
  };
  /** Free up phone space (a phone backup's page). A check reads the phone and the three copies now; only a confirmed list is ever removed. */
  freeUp: {
    /** What this backup's page needs: the kept files and folders, the newest fresh check, and what was removed and can be put back. */
    overview(backupId: number): Promise<FreeUpOverviewResult>;
    /** Starts the check job: quick (lists and sizes, seconds; the default) or full (phone, both drives and Google all read now). Changes nothing. */
    startCheck(backupId: number, mode?: FreeUpMode): Promise<CleanStartResult>;
    /** The groups and numbers of a finished check. */
    result(checkId: number): Promise<FreeUpResultResult>;
    /** One page of the names in a group (or the files that are not ready, with the copy that is missing). */
    files(request: FreeUpFilesRequest): Promise<FreeUpFilesResult>;
    /** The confirm screen's numbers for the ticked groups, with the hash of the list main made. */
    prepare(request: FreeUpPrepareRequest): Promise<FreeUpPrepareResult>;
    /** Starts the removal for the list main made (the hash and the exact count and size the person confirmed). */
    start(request: FreeUpStartRequest): Promise<FreeUpStartResult>;
    /** "Keep on the phone" for a file or a folder: never offered again. */
    keep(request: FreeUpKeepRequest): Promise<FreeUpKeepResult>;
    unkeep(request: { backupId: number; id: number }): Promise<FreeUpKeepResult>;
    /** "Put back": copies removed files back from the first drive and checks them on the phone. */
    putBack(request: FreeUpPutBackRequest): Promise<CleanStartResult>;
    /** One page (at most 100) of the removed files that can still be put back, newest first, with the total count and size. */
    removedPage(request: FreeUpRemovedPageRequest): Promise<FreeUpRemovedPageResult>;
    /** All the removed files not put back (ids and sizes) for "Tick all". One cheap query. */
    removedIds(request: { backupId: number }): Promise<FreeUpRemovedIdsResult>;
    /** Opens Explorer with the file's copy on the first drive selected (one lookup in the held check; the drive must be plugged in). */
    showCopy(request: FreeUpShowCopyRequest): Promise<FreeUpShowCopyResult>;
    /** Tick or untick files of one group ("stays this time"), or the whole group. The removal takes only ticked files. */
    tick(request: FreeUpTickRequest): Promise<FreeUpTickResult>;
  };
  /** "Get files back": look at a backup's dated folders and files (read only), make the list, start the copy for a list main made. Never overwrites; never writes under MyData. */
  restore: {
    info(backupId: number): Promise<RestoreInfoResult>;
    dates(backupId: number): Promise<RestoreDatesResult>;
    browse(request: RestoreBrowseRequest): Promise<RestoreBrowseResult>;
    plan(request: RestorePlanRequest): Promise<RestorePlanResult>;
    /** Starts the copy job for a plan main made; needs `confirmed: true`. */
    start(request: { planId: string; confirmed: boolean }): Promise<RestoreStartResult>;
    /** Opens the folder picker for "Choose another folder". */
    chooseFolder(): Promise<RestoreChooseFolderResult>;
  };
  /** Subscribe to a main -> renderer event. Returns an unsubscribe function. */
  onEvent<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): () => void;
}
