import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { JOB_STATES } from '../../shared/jobs';
import { FILE_KINDS } from '../../shared/fileKinds';
import { SEARCH_CATEGORIES } from '../../shared/fileCategories';
import { MAX_PLACE_FILTERS, SEARCH_SORTS } from '../../shared/search';
import { KIND_MAX_TARGETS } from '../../shared/kinds';
import { SETTING_KEYS } from '../../shared/settings';
import { FREEUP_GROUPS, FREEUP_MAX_PUT_BACK, FREEUP_PAGE, FREEUP_REMOVED_PAGE } from '../../shared/freeUp';

/**
 * One zod schema per IPC channel: the argument list the window may send (an exact tuple, so extra arguments are refused).
 * Main side only: zod must never be imported by the renderer or the preload bundle. The wrapper in secureIpc.ts parses
 * every call with the channel's schema before any handler runs, so a handler only ever sees checked values.
 *
 * Limits follow the old hand-written checks (ids 80 characters, names and labels 200, folders 1000). Booleans such as
 * `confirmed` must be real booleans: only `true` ever counts as a confirmation.
 */

const none = z.tuple([]);
/** A whole number of at least 1 (job, file, profile and removal ids). */
const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const flag = z.boolean();
/** Place ids ("laptop", a drive id, a Google account id). */
const placeId = z.string().max(80);
const name = z.string().max(200);
const pathText = z.string().max(4000);
const passphrase = z.string().max(1000);
const planId = z.string().max(100);
const planHash = z.string().max(200);

const ruleScope = z.enum(['file', 'folder', 'pattern']);
const ruleChoice = z.enum(['leave_out', 'include']);
const ruleChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), draft: z.object({ scope: ruleScope, pattern: pathText.min(1), choice: ruleChoice }).strict() }).strict(),
  z.object({ kind: z.literal('remove'), ruleId: id }).strict(),
]);

const jobFilter = z
  .object({
    states: z.array(z.enum(JOB_STATES)).max(JOB_STATES.length).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const demoOptions = z
  .object({
    steps: z.number().int().min(1).max(10_000).optional(),
    stepMs: z.number().int().min(0).max(60_000).optional(),
    mode: z.enum(['ok', 'warn', 'fail', 'ask']).optional(),
    heavy: z.boolean().optional(),
    bytesPerStep: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();

const nameDriveRequest = z
  .object({
    letter: z.string().max(10),
    name,
    confirmed: flag,
    existingPlaceId: placeId.optional(),
  })
  .strict();

/** A setting's value: the store checks it for its key and answers with a plain message; this only bounds its shape. */
const settingScalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const settingValue = z.union([
  settingScalar,
  z.array(z.union([settingScalar, z.record(z.string().max(100), settingScalar)])).max(500),
]);

const searchRequest = z
  .object({
    text: z.string().max(4000),
    includeFolders: flag,
    category: z.enum(SEARCH_CATEGORIES).nullable(),
    placeIds: z.array(placeId).max(MAX_PLACE_FILTERS),
    fewCopies: flag,
    kind: z.enum(FILE_KINDS).nullable(),
    onlyOnePlace: flag,
    /** Only this person's files (null = everyone's). */
    person: id.nullable(),
    unfingerprinted: flag,
    sort: z.enum(SEARCH_SORTS).nullable(),
    minSize: count.nullable(),
    maxSize: count.nullable(),
    folder: z.string().max(4000),
    extensions: z.array(z.string().max(50)).max(100),
    fromDate: count.nullable(),
    toDate: count.nullable(),
    sortDir: z.enum(['asc', 'desc']).nullable(),
    offset: count,
    part: z.enum(['page', 'counts']),
    notInPlaceIds: z.array(placeId).max(MAX_PLACE_FILTERS),
    gone: flag,
    after: z
      .object({ v: z.union([z.string().max(1000), z.number().finite(), z.null()]), id: count, n: z.string().max(1000).nullable() })
      .strict()
      .nullable(),
  })
  .partial()
  .strict();

const kindChange = z
  .object({
    kind: z.enum(FILE_KINDS),
    targets: z.array(z.object({ type: z.literal('file'), fileId: id }).strict()).min(1).max(KIND_MAX_TARGETS),
    similar: flag.optional(),
  })
  .strict();

const cleanStartBase = {
  planId,
  hash: planHash,
  confirmed: flag,
  expectCount: count,
  expectBytes: count,
};

const MAX_LIST = 1_000_000;

export const SCHEMAS = {
  [IPC.appVersion]: none,
  [IPC.appTimings]: none,
  [IPC.reportFirstPaint]: z.tuple([z.object({ fcpMs: z.number().finite().nonnegative().nullable() }).strict()]),
  [IPC.benchReport]: z.tuple([
    z
      .object({
        homeReadyEpochMs: z.number().finite().positive(),
        switches: z.array(z.object({ screen: z.string().max(40), ms: z.array(z.number().finite().nonnegative()).max(50) }).strict()).max(20),
      })
      .strict(),
  ]),
  [IPC.jobsList]: z.tuple([jobFilter.optional()]),
  [IPC.jobsGet]: z.tuple([id]),
  [IPC.jobsEvents]: z.tuple([id]),
  [IPC.jobsRetry]: z.tuple([id]),
  [IPC.appDataReady]: none,
  [IPC.appStartupStatus]: none,
  [IPC.jobsCancel]: z.tuple([id]),
  [IPC.jobsPause]: z.tuple([id]),
  [IPC.jobsResume]: z.tuple([id]),
  [IPC.jobsResolve]: z.tuple([id, z.string().max(500)]),
  [IPC.jobsContinue]: z.tuple([id]),
  [IPC.jobsDismiss]: z.tuple([id]),
  [IPC.pauseGet]: none,
  [IPC.pauseSet]: z.tuple([z.enum(['hour', 'tomorrow', 'manual', 'off'])]),
  [IPC.jobsCreateDemo]: z.tuple([demoOptions.optional()]),
  [IPC.placesList]: none,
  [IPC.placesRefresh]: none,
  [IPC.placesNameDrive]: z.tuple([nameDriveRequest]),
  [IPC.placesRename]: z.tuple([placeId, name]),
  [IPC.placesEject]: z.tuple([placeId, flag]),
  [IPC.dataSpaceGet]: none,
  [IPC.listingListNow]: z.tuple([placeId]),
  [IPC.listingLookAgain]: z.tuple([placeId]),
  [IPC.listingAddRoot]: z.tuple([placeId]),
  [IPC.listingRemoveRoot]: z.tuple([placeId, z.string().max(1000), flag]),
  [IPC.driveRefresh]: z.tuple([placeId]),
  [IPC.driveRefreshAll]: none,
  [IPC.driveSignIn]: z.tuple([placeId]),
  [IPC.sharedOverview]: none,
  [IPC.sharedLook]: z.tuple([placeId]),
  [IPC.fingerprintNow]: z.tuple([placeId]),
  [IPC.fingerprintRetry]: z.tuple([placeId]),
  [IPC.fingerprintCheckAll]: none,
  [IPC.profilesList]: none,
  [IPC.profilesCreate]: z.tuple([name, z.string().max(20).optional()]),
  [IPC.profilesRename]: z.tuple([id, name]),
  [IPC.profilesDelete]: z.tuple([id, flag]),
  [IPC.peopleSetBackupOwner]: z.tuple([id, id]),
  [IPC.peopleSetPlaceOwner]: z.tuple([placeId.min(1), id]),
  [IPC.settingsGet]: none,
  [IPC.settingsSet]: z.tuple([z.enum(SETTING_KEYS), settingValue]),
  [IPC.settingsExport]: none,
  [IPC.settingsImport]: none,
  [IPC.settingsOpenDataFolder]: none,
  [IPC.settingsSaveNow]: none,
  [IPC.settingsSavedCopies]: none,
  [IPC.settingsRemoveOldCopies]: z.tuple([placeId, flag]),
  [IPC.settingsTestSavedCopy]: z.tuple([placeId, z.string().max(300)]),
  [IPC.settingsRestoreStatus]: none,
  [IPC.settingsRestoreFromDrive]: z.tuple([placeId, z.string().max(300), flag]),
  [IPC.settingsChooseRestoreFile]: none,
  [IPC.settingsRestoreFromFile]: z.tuple([passphrase.nullable(), flag]),
  [IPC.settingsCancelRestore]: none,
  [IPC.settingsRecoveryNow]: none,
  [IPC.vaultStatus]: none,
  [IPC.vaultSetPassphrase]: z.tuple([passphrase]),
  [IPC.vaultChangePassphrase]: z.tuple([passphrase, passphrase]),
  [IPC.vaultRemovePassphrase]: z.tuple([passphrase]),
  [IPC.vaultUnlock]: z.tuple([passphrase]),
  [IPC.vaultForgot]: z.tuple([flag]),
  [IPC.importV1Info]: none,
  [IPC.importV1Start]: z.tuple([flag]),
  [IPC.searchRun]: z.tuple([searchRequest]),
  [IPC.searchShowInFolder]: z.tuple([id]),
  [IPC.searchOpenInDrive]: z.tuple([id]),
  [IPC.kindsSimilar]: z.tuple([id]),
  [IPC.kindsChange]: z.tuple([kindChange]),
  [IPC.phoneStatus]: none,
  [IPC.phoneEject]: none,
  [IPC.localCopyTargets]: none,
  [IPC.localCopyPlan]: z.tuple([id, placeId]),
  [IPC.localCopyStart]: z.tuple([z.object({ planId, hash: planHash, confirmed: flag }).strict()]),
  [IPC.cleanupOverview]: none,
  [IPC.cleanupPhonePlan]: z.tuple([z.string().max(100), z.enum(['camera', 'others']).optional()]),
  [IPC.cleanupPhoneProgress]: none,
  [IPC.cleanupPhoneStart]: z.tuple([z.object({ ...cleanStartBase, indexes: z.array(count).max(MAX_LIST) }).strict()]),
  [IPC.cleanupPutBack]: z.tuple([z.object({ serial: z.string().max(100), removalIds: z.array(id).max(MAX_LIST), confirmed: flag }).strict()]),
  [IPC.cleanupLaptopPlan]: none,
  [IPC.cleanupLaptopStart]: z.tuple([
    z.object({ ...cleanStartBase, groups: z.array(z.object({ id: z.string().max(200), keep: pathText }).strict()).max(MAX_LIST) }).strict(),
  ]),
  [IPC.cleanupUndo]: z.tuple([id]),
  [IPC.backupsOverview]: none,
  [IPC.backupsSizes]: none,
  [IPC.backupsArchive]: z.tuple([id, flag]),
  [IPC.backupsUnarchive]: z.tuple([id]),
  [IPC.backupsHistoryPlan]: none,
  [IPC.backupsHistoryRun]: z.tuple([flag]),
  [IPC.backupsLinkPhone]: z.tuple([z.object({ backupId: id, serial: z.string().min(1).max(100) }).strict()]),
  [IPC.backupsUnlinkPhone]: z.tuple([id, flag]),
  [IPC.backupsNewPhoneChoices]: z.tuple([z.string().min(1).max(100)]),
  [IPC.backupsCreatePhoneBackup]: z.tuple([
    z
      .object({
        serial: z.string().min(1).max(100),
        name,
        placeId: z.string().min(1).max(80),
        folder: z.discriminatedUnion('kind', [z.object({ kind: z.literal('new') }).strict(), z.object({ kind: z.literal('existing'), name: z.string().min(1).max(255) }).strict()]),
        owner: z.union([z.object({ id }).strict(), z.object({ newName: name.min(1) }).strict()]).optional(),
      })
      .strict(),
  ]),
  [IPC.phoneBackupConnected]: none,
  [IPC.phoneBackupSafeUnplug]: none,
  [IPC.phoneBackupUseAgain]: none,
  [IPC.phoneBackupLook]: z.tuple([id, z.array(z.enum(['look_empty', 'look_mass_change'])).max(2).optional()]),
  [IPC.phoneBackupPreview]: z.tuple([id]),
  [IPC.phoneBackupStart]: z.tuple([
    z
      .object({
        planId,
        hash: planHash,
        unticked: z.array(pathText).max(1_000_000),
        untickedFolders: z.array(pathText).max(10_000),
        included: z.array(z.string().max(1100)).max(10_000),
      })
      .strict(),
  ]),
  [IPC.phoneBackupReport]: z.tuple([id]),
  [IPC.phoneBackupProgress]: z.tuple([id]),
  [IPC.phoneBackupCopied]: z.tuple([id]),
  [IPC.phoneBackupCheckOldCounts]: z.tuple([id]),
  [IPC.phoneBackupCheckOldPlan]: z.tuple([id]),
  [IPC.phoneBackupCheckOldStart]: z.tuple([z.object({ backupId: id, folders: z.array(pathText).min(1).max(10_000) }).strict()]),
  [IPC.phoneBackupCheckOldReport]: z.tuple([id]),
  [IPC.rulesList]: z.tuple([id]),
  [IPC.rulesEffect]: z.tuple([z.object({ backupId: id, planId: planId.optional(), change: ruleChange }).strict()]),
  [IPC.rulesAdd]: z.tuple([z.object({ backupId: id, scope: ruleScope, pattern: pathText.min(1), choice: ruleChoice }).strict()]),
  [IPC.rulesRemove]: z.tuple([z.object({ backupId: id, ruleId: id, confirmed: flag }).strict()]),
  [IPC.notCoveredGet]: z.tuple([id]),
  [IPC.notCoveredTick]: z.tuple([z.object({ backupId: id, item: z.string().min(1).max(60), ticked: flag }).strict()]),
  [IPC.folderBackupCards]: none,
  [IPC.folderBackupLook]: z.tuple([id]),
  [IPC.folderBackupPreview]: z.tuple([id]),
  [IPC.folderBackupStart]: z.tuple([
    z
      .object({
        planId,
        hash: planHash,
        unticked: z.array(pathText).max(1_000_000),
        untickedFolders: z.array(pathText).max(10_000),
        included: z.array(z.string().max(1100)).max(10_000),
      })
      .strict(),
  ]),
  [IPC.folderBackupReport]: z.tuple([id]),
  [IPC.folderBackupProgress]: z.tuple([id]),
  [IPC.folderBackupCopied]: z.tuple([id]),
  [IPC.folderBackupAddKeepSync]: none,
  [IPC.mirrorChoices]: z.tuple([id]),
  [IPC.mirrorAdd]: z.tuple([z.object({ backupId: id, placeId: z.string().min(1).max(80) }).strict()]),
  [IPC.mirrorStatus]: none,
  [IPC.mirrorLook]: z.tuple([id.optional()]),
  [IPC.mirrorPreview]: z.tuple([id]),
  [IPC.mirrorStart]: z.tuple([z.object({ planId, hash: planHash, unticked: z.array(z.string().max(4100)).max(1_000_000) }).strict()]),
  [IPC.mirrorReport]: z.tuple([id]),
  [IPC.mirrorCheckPreview]: z.tuple([id.optional()]),
  [IPC.mirrorCheckStart]: z.tuple([z.object({ planId, hash: planHash }).strict()]),
  [IPC.mirrorCheckReport]: z.tuple([id]),
  [IPC.decisionsList]: z.tuple([z.object({ backupId: id.optional(), since: z.number().int().nonnegative().optional() }).strict()]),
  [IPC.decisionsAnswer]: z.tuple([
    z
      .object({
        key: z.string().min(3).max(40),
        choice: z.enum(['same_drive', 'other_drive', 'try_again', 'accept', 'copy_again', 'leave_as_is']),
        similar: flag.optional(),
      })
      .strict(),
  ]),
  [IPC.fileWhy]: z.tuple([z.union([z.object({ fileId: id }).strict(), z.object({ backupId: id, phonePath: pathText.min(2) }).strict()])]),
  [IPC.cleanupEmptyQuarantine]: z.tuple([z.object({ date: z.string().max(40), confirmed: flag, expectCount: count, expectBytes: count }).strict()]),
  [IPC.searchIndexStatus]: z.tuple([]),
  [IPC.searchSavedList]: z.tuple([]),
  [IPC.searchSavedSave]: z.tuple([z.string().max(200), searchRequest]),
  [IPC.searchSavedRemove]: z.tuple([id]),
  [IPC.insightsDriveHealth]: none,
  [IPC.insightsReminderDays]: none,
  [IPC.insightsSetReminderDays]: z.tuple([id, z.number().int().min(1).max(365).nullable()]),
  [IPC.insightsWouldLose]: z.tuple([placeId]),
  [IPC.insightsOnlyHere]: none,
  [IPC.insightsWouldLoseFiles]: z.tuple([z.object({ placeId, part: z.enum(['onlyHere', 'maybeCopied']), search: z.string().max(400), offset: count, kind: z.string().max(40).nullable() }).strict()]),
  [IPC.googleAccountAdd]: z.tuple([id.optional()]),
  [IPC.googleAccountSignOut]: z.tuple([z.string().min(1).max(80)]),
  [IPC.googleAccountRemove]: z.tuple([z.string().min(1).max(80), flag]),
  [IPC.googleKeyStatus]: none,
  [IPC.googleKeySave]: z.tuple([z.object({ clientId: z.string().max(400), clientSecret: z.string().max(400) }).strict()]),
  [IPC.googleCopyStatus]: z.tuple([id]),
  [IPC.googleCopyPreview]: z.tuple([id, z.boolean().optional()]),
  [IPC.googleCopyStart]: z.tuple([
    z.object({ backupId: id, kinds: z.array(z.string().max(40)).max(40), accountIds: z.array(z.string().max(200)).max(200), confirmedAccounts: z.boolean(), seenRoom: z.record(z.string().max(200), z.number().nonnegative()), onlyOnPhone: z.boolean().optional(), fitBiggest: z.boolean().optional() }).strict(),
  ]),
  [IPC.googleCopyReport]: z.tuple([id]),
  [IPC.googleCopySent]: z.tuple([id]),
  [IPC.googleCopyPlan]: z.tuple([z.object({ backupId: id, kinds: z.array(z.string().max(40)).max(40), accountIds: z.array(z.string().max(200)).max(200), onlyOnPhone: z.boolean().optional(), fitBiggest: z.boolean().optional() }).strict()]),
  [IPC.googleCopyMore]: z.tuple([id]),
  [IPC.googleCopyAddAccounts]: z.tuple([z.object({ jobId: id, accountIds: z.array(z.string().max(200)).max(200), confirmedAccounts: z.boolean() }).strict()]),
  [IPC.freeUpOverview]: z.tuple([id]),
  [IPC.freeUpStartCheck]: z.tuple([id, z.enum(['quick', 'full']).optional()]),
  [IPC.freeUpResult]: z.tuple([id]),
  [IPC.freeUpFiles]: z.tuple([z.object({ checkId: id, list: z.enum([...FREEUP_GROUPS, 'notReady']), offset: count }).strict()]),
  [IPC.freeUpPrepare]: z.tuple([z.object({ checkId: id, groups: z.array(z.enum(FREEUP_GROUPS)).max(FREEUP_GROUPS.length) }).strict()]),
  [IPC.freeUpTick]: z.tuple([z.object({ checkId: id, list: z.enum(FREEUP_GROUPS), ticked: flag, all: flag.optional(), paths: z.array(z.string().min(1).max(4100)).max(FREEUP_PAGE).optional() }).strict()]),
  [IPC.freeUpShowCopy]: z.tuple([z.object({ checkId: id, path: z.string().min(1).max(4096) }).strict()]),
  [IPC.freeUpStart]: z.tuple([z.object({ checkId: id, groups: z.array(z.enum(FREEUP_GROUPS)).max(FREEUP_GROUPS.length), hash: planHash, expectFiles: count, expectBytes: count, confirmed: flag, removeMode: z.enum(['quick', 'full']).optional() }).strict()]),
  [IPC.freeUpKeep]: z.tuple([z.object({ backupId: id, scope: z.enum(['file', 'folder']), path: z.string().min(2).max(4100) }).strict()]),
  [IPC.freeUpUnkeep]: z.tuple([z.object({ backupId: id, id }).strict()]),
  [IPC.freeUpPutBack]: z.tuple([z.object({ backupId: id, removalIds: z.array(id).max(FREEUP_MAX_PUT_BACK), confirmed: flag }).strict()]),
  [IPC.freeUpRemovedPage]: z.tuple([z.object({ backupId: id, offset: count, limit: z.number().int().min(1).max(FREEUP_REMOVED_PAGE) }).strict()]),
  [IPC.freeUpRemovedIds]: z.tuple([z.object({ backupId: id }).strict()]),
  [IPC.restoreInfo]: z.tuple([id]),
  [IPC.restoreDates]: z.tuple([id]),
  [IPC.restoreBrowse]: z.tuple([z.object({ backupId: id, folder: z.string().max(200).nullable(), path: z.string().max(1000) }).strict()]),
  [IPC.restorePlan]: z.tuple([
    z
      .object({
        pick: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('date'), backupId: id, folder: z.string().max(200).nullable(), items: z.array(z.string().max(1000)).max(500) }).strict(),
          z.object({ kind: z.literal('newest'), backupId: id }).strict(),
          z.object({ kind: z.literal('files'), fileIds: z.array(id).min(1).max(5000) }).strict(),
        ]),
        destination: z.object({ mode: z.enum(['new', 'original']), parent: pathText.optional() }).strict(),
      })
      .strict(),
  ]),
  [IPC.restoreStart]: z.tuple([z.object({ planId, confirmed: flag }).strict()]),
  [IPC.restoreChooseFolder]: z.tuple([]),
} as const satisfies Record<(typeof IPC)[keyof typeof IPC], z.ZodType<unknown[]>>;

export type IpcChannel = keyof typeof SCHEMAS;
/** Channels the window uses with `send` (no answer). Every other channel is request/response (`invoke`). */
export const FIRE_AND_FORGET = [IPC.reportFirstPaint] as const;
export type FireAndForgetChannel = (typeof FIRE_AND_FORGET)[number];
export type InvokeChannel = Exclude<IpcChannel, FireAndForgetChannel>;
/** The checked argument list of a channel. */
export type ArgsOf<C extends IpcChannel> = z.output<(typeof SCHEMAS)[C]>;
