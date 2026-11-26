import path from 'node:path';
import fs from 'node:fs';
import { dialog, powerMonitor, shell, type BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc';
import { IMPORT_V1_JOB_KIND, type ImportV1Info, type ImportV1StartResult } from '../shared/importV1';
import { IMPORT_TITLE } from './import/fleetV1/importer';
import { sourceFilesPresent } from './import/fleetV1/source';
import type { AddRootResult } from '../shared/listing';
import type { HistoryResult } from '../shared/backups';
import { toSearchRequest } from '../shared/search';
import type { FileActionResult, SaveNowResult, SettingsState } from '../shared/settings';
import type { AppServices } from './appServices';
import { assertWritable, DriveWriteProtectedError } from './fsutil';
import { SearchActions } from './search/searchActions';
import { applyImport, MAX_IMPORT_BYTES, parseExport, writeSettingsExport } from './settings/exportImport';
import { KIND_SAVE_SETTINGS, listSavedCopies } from './settings/saveToDrive';
import { cancelPendingRestore, readPendingRestore } from './db/restore';
import { RECOVERY_JOB_KIND, RECOVERY_TITLE } from './recovery/recoveryJob';
import { restoreFromChosenFile, restoreFromSavedCopy, sniffFile, type RestoreDeps } from './recovery/restore';
import type { ChosenRestoreFile } from '../shared/settings';
import { removeOldCopies, testSavedCopy, type SavedCopyActionDeps } from './settings/savedCopyActions';
import { freeBytesOf } from './localCopy/freeSpace';
import { quickCheckInWorker } from './query/queryService';
import type { SecureIpc } from './ipc/secureIpc';
import type { ArgsOf, InvokeChannel } from './ipc/schemas';

export interface AppIpcOptions {
  /** The only way to register a handler: checks the sender and the arguments of every call (see ipc/secureIpc.ts). */
  secure: SecureIpc;
  /** Resolves once the database is open and the services exist; calls wait for it. */
  ready: Promise<AppServices>;
  getWindow: () => BrowserWindow | null;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

function settingsState(s: AppServices): SettingsState {
  return { settings: s.settings.get(), dataDir: s.dataDir, logsDir: s.logsDir };
}

function exportStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** IPC for places, profiles and settings, plus the pushes of place and settings changes to the window. */
export function wireAppIpc(options: AppIpcOptions): void {
  const { secure, ready, getWindow, log } = options;

  // Sender and arguments are already checked by `secure`; the handler waits for the services, then gets the checked arguments.
  const handle = <C extends InvokeChannel>(channel: C, fn: (services: AppServices, ...args: ArgsOf<C>) => unknown): void => {
    secure.handle(channel, async (...args: ArgsOf<C>) => fn(await ready, ...args));
  };

  handle(IPC.placesList, (s) => s.places.snapshot());
  handle(IPC.placesRefresh, (s) => s.places.refresh());
  handle(IPC.placesNameDrive, (s, request) => s.places.nameDrive({ letter: request.letter, name: request.name, confirmed: request.confirmed, ...(request.existingPlaceId !== undefined ? { existingPlaceId: request.existingPlaceId } : {}) }));
  handle(IPC.placesRename, (s, id, label) => s.places.renamePlace(id, label));
  handle(IPC.placesEject, (s, placeId, confirmed) => s.eject.eject(placeId, confirmed));
  handle(IPC.dataSpaceGet, (s) => s.dataSpace.info());
  handle(IPC.pauseGet, (s) => s.pause.get());
  handle(IPC.pauseSet, (s, choice) => s.pause.set(choice));

  handle(IPC.listingListNow, (s, placeId) => s.listing.listNow(placeId));
  handle(IPC.listingLookAgain, (s, placeId) => s.listing.lookAgain(placeId));
  handle(IPC.listingAddRoot, async (s, placeId): Promise<AddRootResult> => {
    const win = getWindow();
    const dialogOptions = { title: 'Pick a folder to add', properties: ['openDirectory' as const] };
    const chosen = await (win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions));
    const folder = chosen.filePaths[0];
    if (chosen.canceled || !folder) return { ok: false, canceled: true, message: 'Nothing was added.' };
    const result = s.roots.addLaptopRoot(placeId, folder);
    if (result.ok) s.places.republish();
    return result;
  });
  handle(IPC.listingRemoveRoot, (s, placeId, root, confirmed) => {
    const result = s.roots.removeLaptopRoot(placeId, root, confirmed);
    if (result.ok) {
      s.dataVersion.bump();
      s.places.catalogChanged();
      s.query.requestCoverage({ force: true });
    }
    return result;
  });

  handle(IPC.driveRefresh, (s, placeId) => s.drive.refresh(placeId));
  handle(IPC.driveRefreshAll, (s) => s.drive.refreshAll());
  handle(IPC.driveSignIn, (s, placeId) => s.drive.signIn(placeId));
  handle(IPC.sharedOverview, (s) => s.sharedWithMe.overview());
  handle(IPC.sharedLook, (s, placeId) => s.sharedWithMe.look(placeId));

  handle(IPC.fingerprintNow, (s, placeId) => s.fingerprints.fingerprintNow(placeId));
  handle(IPC.fingerprintRetry, (s, placeId) => s.fingerprints.retryFailed(placeId));
  handle(IPC.fingerprintCheckAll, (s) => s.fingerprints.checkAllNow());

  handle(IPC.profilesList, (s) => ({ ok: true, profiles: s.profiles.list() }));
  handle(IPC.profilesCreate, (s, name, color) => s.profiles.create(name, color));
  handle(IPC.profilesRename, (s, id, name) => {
    const result = s.profiles.rename(id, name);
    s.places.republish();
    return result;
  });
  handle(IPC.profilesDelete, (s, id, confirmed) => s.profiles.delete(id, confirmed));
  // Who a backup, a phone or a Google account belongs to: the database only (nothing on a drive is moved or renamed).
  handle(IPC.peopleSetBackupOwner, (s, backupId, personId) => {
    const result = s.profiles.setBackupOwner(backupId, personId);
    if (result.ok) {
      s.places.republish();
      s.dataVersion.bump();
    }
    return result;
  });
  handle(IPC.peopleSetPlaceOwner, (s, placeId, personId) => {
    const result = s.profiles.setPlaceOwner(placeId, personId);
    if (result.ok) {
      s.places.republish();
      s.dataVersion.bump();
    }
    return result;
  });

  handle(IPC.settingsGet, (s) => settingsState(s));
  handle(IPC.settingsSet, (s, key, value) => s.settings.set(key, value));
  handle(IPC.settingsOpenDataFolder, async (s) => {
    const failure = await shell.openPath(s.dataDir);
    if (failure) log.warn(`could not open the data folder: ${failure}`);
  });

  handle(IPC.settingsExport, async (s): Promise<FileActionResult> => {
    const win = getWindow();
    const dialogOptions = {
      title: 'Export settings',
      defaultPath: `backuphub-settings-${exportStamp(new Date())}.json`,
      filters: [{ name: 'Settings file', extensions: ['json'] }],
    };
    const chosen = await (win ? dialog.showSaveDialog(win, dialogOptions) : dialog.showSaveDialog(dialogOptions));
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true, message: 'Nothing was exported.' };
    try {
      assertWritable(chosen.filePath); // T7 write ban: the person may pick any folder, including a protected drive
      const data = writeSettingsExport(chosen.filePath, s.db, s.settings, s.appVersion); // checks the guard again
      return { ok: true, message: `Saved ${data.profiles} profiles, ${data.places} places and your settings. No passwords or sign-ins are included.` };
    } catch (err) {
      if (err instanceof DriveWriteProtectedError) return { ok: false, canceled: false, message: `${err.message} Pick another place.` };
      log.warn('settings export failed', err);
      return { ok: false, canceled: false, message: 'Could not write that file. Pick another place and try again.' };
    }
  });

  handle(IPC.settingsImport, async (s): Promise<FileActionResult> => {
    const win = getWindow();
    const dialogOptions = {
      title: 'Import settings',
      properties: ['openFile' as const],
      filters: [{ name: 'Settings file', extensions: ['json'] }],
    };
    const chosen = await (win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions));
    const file = chosen.filePaths[0];
    if (chosen.canceled || !file) return { ok: false, canceled: true, message: 'Nothing was imported.' };
    try {
      if (fs.statSync(file).size > MAX_IMPORT_BYTES) {
        return { ok: false, canceled: false, message: 'That file is too large to be a Backup Hub settings file.' };
      }
      const parsed = parseExport(fs.readFileSync(file, 'utf8'));
      if (!parsed.ok) return { ok: false, canceled: false, message: parsed.message };
      const summary = applyImport(s.db, s.settings, parsed.data);
      s.places.republish();
      return {
        ok: true,
        message:
          `Imported ${summary.settingsApplied} settings, ${summary.profilesAdded} new profiles and ${summary.placesAdded} new places` +
          (summary.placesSkipped > 0 ? ` (${summary.placesSkipped} places you already had were left as they are).` : '.'),
      };
    } catch (err) {
      log.warn('settings import failed', err);
      return { ok: false, canceled: false, message: 'Could not read that file. Nothing was changed.' };
    }
  });

  handle(IPC.settingsSaveNow, (s): SaveNowResult => {
    const drives = s.places.connectedDrives();
    if (drives.length === 0) {
      return { ok: false, message: 'No named drive is plugged in. Name your backup drive under Settings, Drives and accounts first.' };
    }
    // T7 write ban: a manual button that would only write to protected drives is refused with the plain line.
    const protectedLines = drives.map((d) => s.writeProtectedLine(d.place.id));
    if (protectedLines.every((line) => line !== null)) return { ok: false, message: protectedLines[0]! };
    return { ok: true, jobId: s.jobs.create(KIND_SAVE_SETTINGS, 'Save settings to the backup drive', { force: true }, 'Started by you: Save now') };
  });

  // Read only: what is saved on each connected named drive (nothing is removed from here).
  handle(IPC.settingsSavedCopies, (s) =>
    listSavedCopies(
      s.places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root })),
      s.settings.get().savedCopiesKeep,
    ),
  );

  const savedCopyDeps = (s: AppServices): SavedCopyActionDeps => ({
    drives: () => s.places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root })),
    keep: () => s.settings.get().savedCopiesKeep,
    writeProtected: (placeId) => s.writeProtectedLine(placeId),
    checkInWorker: (file) => quickCheckInWorker(path.join(__dirname, 'queryWorker.js'), file),
    freeBytes: freeBytesOf,
  });
  // Only Backup Hub's own saved copies, only after the window asked with `confirmed`.
  handle(IPC.settingsRemoveOldCopies, (s, placeId, confirmed) => removeOldCopies(savedCopyDeps(s), placeId, confirmed));
  handle(IPC.settingsTestSavedCopy, (s, placeId, name) => testSavedCopy(savedCopyDeps(s), placeId, name));

  // Restore Backup Hub: a copy is checked and staged now; the swap happens at the next start (the old database is moved aside).
  let chosenRestoreFile: string | null = null;
  const restoreDeps = (s: AppServices): RestoreDeps => ({
    dataDir: s.dataDir,
    vault: s.vault,
    drives: () => s.places.connectedDrives().map((d) => ({ placeId: d.place.id, label: d.place.label, root: d.root })),
    checkInWorker: (file) => quickCheckInWorker(path.join(__dirname, 'queryWorker.js'), file),
    freeBytes: freeBytesOf,
    log,
  });
  handle(IPC.settingsRestoreStatus, (s) => ({ pending: readPendingRestore(s.dataDir) }));
  handle(IPC.settingsRestoreFromDrive, (s, placeId, name, confirmed) => restoreFromSavedCopy(restoreDeps(s), placeId, name, confirmed));
  handle(IPC.settingsChooseRestoreFile, async (): Promise<ChosenRestoreFile> => {
    const win = getWindow();
    const dialogOptions = {
      title: 'Choose a Backup Hub database copy or recovery file',
      properties: ['openFile' as const],
      filters: [{ name: 'Backup Hub copy', extensions: ['db', 'bhrc'] }, { name: 'All files', extensions: ['*'] }],
    };
    const chosen = await (win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions));
    const file = chosen.filePaths[0];
    if (chosen.canceled || !file) return { ok: false, canceled: true, message: 'No file was chosen.' };
    const kind = sniffFile(file);
    if (kind === 'unknown') {
      chosenRestoreFile = null;
      return { ok: false, canceled: false, message: 'That file is not a Backup Hub database copy or recovery file.' };
    }
    chosenRestoreFile = file;
    return { ok: true, name: path.basename(file), kind, bytes: fs.statSync(file).size };
  });
  handle(IPC.settingsRestoreFromFile, (s, passphrase, confirmed) => restoreFromChosenFile(restoreDeps(s), chosenRestoreFile, passphrase, confirmed));
  handle(IPC.settingsCancelRestore, (s) => cancelPendingRestore(s.dataDir));
  handle(IPC.settingsRecoveryNow, (s): SaveNowResult => {
    const current = s.settings.get();
    if (current.recoveryGoogleAccount === null) return { ok: false, message: 'Pick the Google account for the recovery copy first.' };
    return { ok: true, jobId: s.jobs.create(RECOVERY_JOB_KIND, RECOVERY_TITLE, { force: true }, 'Started by you: Save now') };
  });

  // Vault: arguments may hold a passphrase, so they are never logged; the vault returns plain results.
  handle(IPC.vaultStatus, (s) => s.vault.status());
  handle(IPC.vaultSetPassphrase, (s, pass) => s.vault.setPassphrase(pass));
  handle(IPC.vaultChangePassphrase, (s, current, next) => s.vault.changePassphrase(current, next));
  handle(IPC.vaultRemovePassphrase, (s, current) => s.vault.removePassphrase(current));
  handle(IPC.vaultUnlock, (s, pass) => s.vault.unlock(pass));
  handle(IPC.vaultForgot, (s, confirmed) => s.vault.forgetEverything(confirmed));

  // Search: the query runs on its worker; the two actions only open Explorer or the browser (guards in searchActions.ts).
  let actions: SearchActions | null = null;
  const searchActions = (s: AppServices): SearchActions => {
    actions ??= new SearchActions({
      db: s.db,
      baseOf: (place) => s.places.baseFolderOf(place),
      rootsOf: (placeId) => s.roots.list(placeId),
      exists: (p) => fs.existsSync(p),
      showItem: (p) => shell.showItemInFolder(p),
      openExternal: (url) => shell.openExternal(url),
    });
    return actions;
  };
  handle(IPC.searchRun, (s, request) => s.search.run(toSearchRequest(request)));
  handle(IPC.searchShowInFolder, (s, fileId) => searchActions(s).showInFolder(fileId));
  handle(IPC.searchOpenInDrive, (s, fileId) => searchActions(s).openInDrive(fileId));
  handle(IPC.searchIndexStatus, (s) => s.searchIndex.status());
  handle(IPC.searchSavedList, (s) => ({ ok: true as const, saved: s.savedSearches.list() }));
  handle(IPC.searchSavedSave, (s, name, request) => s.savedSearches.save(name, request));
  handle(IPC.searchSavedRemove, (s, id) => s.savedSearches.remove(id));

  handle(IPC.kindsSimilar, (s, fileId) => s.kinds.similar(fileId));
  handle(IPC.kindsChange, (s, change) => s.kinds.changeKind({ kind: change.kind, targets: change.targets, similar: change.similar === true }));

  handle(IPC.phoneStatus, (s) => s.phone.status());
  handle(IPC.phoneEject, (s) => s.phone.eject());
  handle(IPC.cleanupOverview, (s) => s.cleanup.overview());
  handle(IPC.cleanupPhonePlan, (s, serial, scope) => s.cleanup.phonePlan(serial, scope));
  handle(IPC.cleanupPhoneProgress, (s) => s.cleanup.phoneProgress());
  handle(IPC.cleanupPhoneStart, (s, request) => s.cleanup.phoneStart(request));
  handle(IPC.cleanupPutBack, (s, request) => s.cleanup.putBack(request));
  handle(IPC.cleanupLaptopPlan, (s) => s.cleanup.laptopPlan());
  handle(IPC.cleanupLaptopStart, (s, request) => s.cleanup.laptopStart(request));
  handle(IPC.cleanupUndo, (s, id) => s.cleanup.undo(id));
  handle(IPC.cleanupEmptyQuarantine, (s, request) => s.cleanup.emptyQuarantine(request));
  // Backups: the list, and "Bring in PhoneBackup history" (only ever from the person's click; nothing runs by itself).
  handle(IPC.backupsOverview, (s) => s.backupProfiles.overview());
  handle(IPC.backupsSizes, (s) => s.backupProfiles.sizes());
  handle(IPC.backupsArchive, (s, backupId, confirmed) => {
    const result = s.backupProfiles.archive(backupId, confirmed);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.backupsUnarchive, (s, backupId) => {
    const result = s.backupProfiles.unarchive(backupId);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.backupsHistoryPlan, (s) => s.backupProfiles.historyPlan());
  handle(IPC.backupsHistoryRun, async (s, confirmed): Promise<HistoryResult> => {
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was changed.' };
    const result = await s.backupProfiles.bringInHistory();
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  // Which phone a phone backup is for: only from the person's click ("Yes, this is ..." / "Change phone"); nothing is linked by itself.
  handle(IPC.backupsLinkPhone, (s, request) => s.phoneBackup.linkPhone(request.backupId, request.serial));
  handle(IPC.backupsUnlinkPhone, (s, backupId, confirmed) => s.phoneBackup.unlinkPhone(backupId, confirmed));
  // "Make a new backup for this phone": the form's choices are read only; the backup is made only from the person's click (database only).
  handle(IPC.backupsNewPhoneChoices, (s, serial) => s.phoneBackup.newBackupChoices(serial));
  handle(IPC.backupsCreatePhoneBackup, async (s, request) => {
    // "Whose phone is this?": a person that exists, or someone new, made here and taken back if the backup is refused.
    let madeId: number | null = null;
    let personId: number | undefined;
    if (request.owner && 'id' in request.owner) {
      personId = request.owner.id;
    } else if (request.owner) {
      const made = s.profiles.create(request.owner.newName);
      if (!made.ok) return { ok: false as const, message: made.message };
      madeId = Math.max(...made.profiles.map((p) => p.id)); // the new person has the highest id
      personId = madeId;
    }
    const result = await s.phoneBackup.createForPhone(request, personId);
    if (result.ok) {
      s.places.republish();
      s.dataVersion.bump();
    } else if (madeId !== null) {
      s.profiles.delete(madeId, true);
    }
    return result;
  });
  // The phone backup: only ever from the person's click (look, preview, confirm); nothing here runs by itself.
  handle(IPC.phoneBackupConnected, (s) => s.phoneBackup.connected());
  handle(IPC.phoneBackupSafeUnplug, (s) => s.phoneBackup.safeUnplug());
  handle(IPC.phoneBackupUseAgain, (s) => s.phoneBackup.useAgain());
  handle(IPC.phoneBackupLook, (s, backupId, accept) => s.phoneBackup.startLook(backupId, accept));
  handle(IPC.phoneBackupPreview, (s, jobId) => s.phoneBackup.preview(jobId));
  handle(IPC.phoneBackupStart, async (s, selection) => {
    const result = await s.phoneBackup.confirmSliced(selection);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.phoneBackupReport, (s, jobId) => s.phoneBackup.report(jobId));
  handle(IPC.phoneBackupProgress, (s, jobId) => s.phoneBackup.progress(jobId));
  handle(IPC.phoneBackupCopied, (s, jobId) => s.phoneBackup.copied(jobId));
  // "Check old copies": the counts and the preview only read; the check starts only from the person's click and changes nothing on the phone or a drive.
  handle(IPC.phoneBackupCheckOldCounts, (s, backupId) => s.phoneBackup.checkOldCounts(backupId));
  handle(IPC.phoneBackupCheckOldPlan, (s, backupId) => s.phoneBackup.checkOldPlan(backupId));
  handle(IPC.phoneBackupCheckOldStart, async (s, request) => {
    const result = await s.phoneBackup.startCheckOld(request);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.phoneBackupCheckOldReport, (s, jobId) => s.phoneBackup.checkOldReport(jobId));
  // "Your choices": the effect only reads; saving or removing a choice changes what the next preview offers and nothing else.
  handle(IPC.rulesList, (s, backupId) => s.rules.list(backupId));
  handle(IPC.rulesEffect, (s, request) => s.rules.effect(request));
  handle(IPC.rulesAdd, (s, request) => {
    const result = s.rules.add(request);
    if (result.ok && result.added) {
      s.dataVersion.bump();
      s.phoneBackup.countsChanged();
    }
    return result;
  });
  handle(IPC.rulesRemove, (s, request) => {
    const result = s.rules.remove(request);
    if (result.ok) {
      s.dataVersion.bump();
      s.phoneBackup.countsChanged();
    }
    return result;
  });
  handle(IPC.notCoveredGet, (s, backupId) => s.rules.notCovered(backupId));
  handle(IPC.notCoveredTick, (s, request) => s.rules.tick(request));
  // "Needs your decision" and "Why?": the list and the explanation only read; an answer goes to the part that owns the case.
  // Folder backups and the Google Keep notes backup: only ever from the person's click (look, preview, confirm; the notes backup is made by its own button).
  handle(IPC.folderBackupCards, (s) => s.folderBackup.cards());
  handle(IPC.folderBackupLook, (s, backupId) => s.folderBackup.startLook(backupId));
  handle(IPC.folderBackupPreview, (s, jobId) => s.folderBackup.preview(jobId));
  handle(IPC.folderBackupStart, async (s, selection) => {
    const result = await s.folderBackup.confirmSliced(selection);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.folderBackupReport, (s, jobId) => s.folderBackup.report(jobId));
  handle(IPC.folderBackupProgress, (s, jobId) => s.folderBackup.progress(jobId));
  handle(IPC.folderBackupCopied, (s, jobId) => s.folderBackup.copied(jobId));
  handle(IPC.folderBackupAddKeepSync, async (s) => {
    const result = await s.folderBackup.addKeepSync();
    if (result.ok) {
      s.places.republish();
      s.dataVersion.bump();
    }
    return result;
  });
  // The second drive: the choices, the status and the look only read; "Also keep a copy" only writes the database; the copy starts only from the person's click.
  handle(IPC.mirrorChoices, (s, backupId) => s.mirror.choices(backupId));
  handle(IPC.mirrorAdd, (s, request) => {
    const result = s.mirror.addCopy(request);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.mirrorStatus, (s) => s.mirror.status());
  handle(IPC.mirrorLook, (s, backupId) => s.mirror.startLook(backupId));
  handle(IPC.mirrorPreview, (s, jobId) => s.mirror.preview(jobId));
  handle(IPC.mirrorStart, async (s, selection) => {
    const result = await s.mirror.confirmSliced(selection);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.mirrorReport, (s, jobId) => s.mirror.report(jobId));
  handle(IPC.mirrorCheckPreview, (s, backupId) => s.mirror.checkPreview(backupId));
  handle(IPC.mirrorCheckStart, async (s, selection) => {
    const result = await s.mirror.checkStart(selection);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.mirrorCheckReport, (s, jobId) => s.mirror.checkReport(jobId));
  // Google accounts and "Copy to Google": only from clicks; nothing in a Google account is deleted.
  handle(IPC.googleAccountAdd, (s, profileId) => s.googleAccounts.addAccount(profileId));
  handle(IPC.googleAccountSignOut, (s, placeId) => s.googleAccounts.signOut(placeId));
  handle(IPC.googleAccountRemove, (s, placeId, confirmed) => s.googleAccounts.remove(placeId, confirmed));
  handle(IPC.googleKeyStatus, (s) => s.googleAccounts.keyStatus());
  handle(IPC.googleKeySave, (s, input) => s.googleAccounts.saveKey(input));
  handle(IPC.googleCopyStatus, (s, backupId) => s.googleCopy.status(backupId));
  handle(IPC.googleCopyPreview, (s, backupId, onlyOnPhone) => s.googleCopy.preview(backupId, onlyOnPhone));
  handle(IPC.googleCopyStart, async (s, request) => {
    const result = await s.googleCopy.start(request);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.googleCopyReport, (s, jobId) => s.googleCopy.report(jobId));
  handle(IPC.googleCopySent, (s, jobId) => s.googleCopy.sent(jobId));
  handle(IPC.googleCopyPlan, (s, request) => s.googleCopy.plan(request));
  handle(IPC.googleCopyMore, (s, jobId) => s.googleCopy.more(jobId));
  handle(IPC.googleCopyAddAccounts, async (s, request) => {
    const result = await s.googleCopy.addAccounts(request);
    if (result.ok) s.dataVersion.bump();
    return result;
  });
  handle(IPC.decisionsList, (s, request) => s.decisions.list(request));
  handle(IPC.decisionsAnswer, (s, request) => s.decisions.answer(request));
  handle(IPC.fileWhy, (s, request) => s.why.why(request));
  handle(IPC.insightsDriveHealth, (s) => s.insights.driveHealth());
  handle(IPC.insightsReminderDays, (s) => s.insights.reminderDays());
  handle(IPC.insightsSetReminderDays, (s, backupId, days) => s.insights.setReminderDays(backupId, days));
  handle(IPC.insightsWouldLose, (s, placeId) => s.insights.wouldLose(placeId));
  handle(IPC.insightsOnlyHere, (s) => s.insights.onlyHere());
  handle(IPC.insightsWouldLoseFiles, (s, request) => s.insights.wouldLoseFiles(request));
  handle(IPC.freeUpOverview, (s, backupId) => s.freeUp.overview(backupId));
  handle(IPC.freeUpStartCheck, (s, backupId, mode) => s.freeUp.startCheck(backupId, mode));
  handle(IPC.freeUpResult, (s, checkId) => s.freeUp.result(checkId));
  handle(IPC.freeUpFiles, (s, request) => s.freeUp.files(request));
  handle(IPC.freeUpPrepare, (s, request) => s.freeUp.prepare(request));
  handle(IPC.freeUpStart, (s, request) => s.freeUp.start(request));
  handle(IPC.freeUpKeep, (s, request) => s.freeUp.keep(request));
  handle(IPC.freeUpUnkeep, (s, request) => s.freeUp.unkeep(request));
  handle(IPC.freeUpPutBack, (s, request) => s.freeUp.putBack(request));
  handle(IPC.freeUpRemovedPage, (s, request) => s.freeUp.removedPage(request));
  handle(IPC.freeUpRemovedIds, (s, request) => s.freeUp.removedIds(request));
  handle(IPC.freeUpTick, (s, request) => s.freeUp.tick(request));
  handle(IPC.freeUpShowCopy, async (s, request) => {
    const found = await s.freeUp.copyPath(request);
    if (!found.ok) return found;
    shell.showItemInFolder(found.abs);
    return { ok: true as const };
  });
  handle(IPC.restoreInfo, (s, backupId) => s.restore.info(backupId));
  handle(IPC.restoreDates, (s, backupId) => s.restore.dates(backupId));
  handle(IPC.restoreBrowse, (s, request) => s.restore.browse(request));
  handle(IPC.restorePlan, (s, request) => s.restore.plan(request));
  handle(IPC.restoreStart, (s, request) => s.restore.start(request));
  handle(IPC.restoreChooseFolder, async (s) => {
    const win = getWindow();
    const dialogOptions = { title: 'Choose a folder for the files you get back', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const chosen = await (win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions));
    return s.restore.chooseFolder(chosen.canceled ? null : (chosen.filePaths[0] ?? null));
  });
  handle(IPC.localCopyTargets, (s) => s.localCopy.targets());
  handle(IPC.localCopyPlan, (s, collectionId, targetPlaceId) => s.localCopy.plan(collectionId, targetPlaceId));
  handle(IPC.localCopyStart, (s, request) => s.localCopy.start(request));

  handle(IPC.importV1Info, (s): ImportV1Info => ({ sourceDir: s.importSourceDir, sourceFound: sourceFilesPresent(s.importSourceDir) }));
  handle(IPC.importV1Start, (s, confirmed): ImportV1StartResult => {
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was changed.' };
    if (!sourceFilesPresent(s.importSourceDir)) {
      return { ok: false, message: 'The archived Fleet Manager v1 files were not found, so there is nothing to bring in.' };
    }
    if (s.jobs.list({ states: ['queued', 'running', 'needs_you'] }).some((job) => job.kind === IMPORT_V1_JOB_KIND)) {
      return { ok: false, message: 'The import is already running. Watch it in Jobs.' };
    }
    return { ok: true, jobId: s.jobs.create(IMPORT_V1_JOB_KIND, IMPORT_TITLE, { confirmed: true }) };
  });

  void (async () => {
    const services = await ready;
    services.places.onChanged((snapshot) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('places:changed', snapshot);
    });
    services.settings.onChanged(() => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('settings:changed', settingsState(services));
    });
    services.pause.onChanged((status) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('pause:changed', status);
    });
    powerMonitor.on('suspend', () => services.places.suspend());
    powerMonitor.on('resume', () => {
      services.places.resume();
      services.pause.check(); // a timed pause may have run out while the computer slept
    });
  })().catch((err: unknown) => log.error('app ipc wiring failed', err));
}
