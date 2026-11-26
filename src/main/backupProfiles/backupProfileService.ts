import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Db } from '../db';
import type { ArchiveResult, BackupSize, BackupSizesResult, BackupsOverview, HistoryFileInfo, HistoryLine, HistoryPlan, HistoryResult } from '../../shared/backups';
import { HISTORY_BACKUPS, HISTORY_FILE, newestSessionAt, staleReasons } from './history';
import { profileDraftsFromConfig, saveDrafts, SEED_SWITCHED_OFF, type ProfileDraft, type SeedReport, type SkippedProfile } from './importConfig';
import { historySideFile, importLedgerFile, sideFileMessage, type LedgerImportResult } from './ledgerImport';
import { cleanRoot, isUnder, pathKey, splitDrivePath } from './pathForms';
import { BackupProfileStore, type BackupDestination, type BackupProfile } from './profileStore';
import { RulesStore } from '../rules/rulesStore';
import { loadDestinations } from '../look/lookStore';
import { absOn, findT7, type PluggedDrive } from './t7Drive';

/**
 * What the rest of the app calls for backup profiles (Profiles step 1a): bring in PhoneBackup's settings, list and edit profiles
 * (through `store`), and bring in an old history file (ledger.db). Nothing here runs by itself: no timer, no startup call, no job.
 * Every method is a direct answer to a call from the person (the screens and IPC come later).
 */
export interface BackupProfileServiceDeps {
  db: Db;
  /** Named drives that are plugged in right now: their place (= identity card), name and root folder such as "F:\\" (the letter is never used to pick a drive). */
  connectedDrives: () => PluggedDrive[];
  /** Where PhoneBackup's old settings file (config.json) is, or null when it cannot be found. Read only. */
  phoneBackupConfig?: () => string | null;
  now?: () => number;
  uuid?: () => string;
  yieldNow?: () => Promise<void>;
  /** Tests may name the place that holds a folder backup's source folder; the default looks at the OneDrive places, then the laptop. */
  sourcePlaceFor?: (sourceRoot: string) => { placeId: string; base: string } | null;
  /** Counts the files and bytes of each backup's first drive folder off the window's thread (the query worker). Null = could not be counted. */
  sizesInWorker?: (asks: { backupId: number; placeId: string; root: string }[]) => Promise<BackupSize[] | null>;
}

export interface BackupProfileView {
  profile: BackupProfile;
  destinations: BackupDestination[];
  exclusionCount: number;
  /** The history files already brought in for it. */
  imports: { id: number; importedAt: number; rows: number }[];
}

export type SeedResult = { ok: true; report: SeedReport; notBackups: SkippedProfile[] } | { ok: false; message: string };

type Located =
  | { ok: false; message: string }
  | {
      ok: true;
      configPath: string;
      configText: string;
      drafts: ProfileDraft[];
      drive: { placeId: string; root: string; label: string };
      /** The old history files, by backup: the backup folder (store form) and the file. */
      files: { importKey: string; rel: string; file: string; keptOnlyOnOtherDrive: readonly string[]; draft: ProfileDraft }[];
    };

export interface ImportLedgerRequest {
  profileId: number;
  ledgerPath: string;
  /** Which backup folder of the profile the history belongs to; the first enabled one when left out. */
  destinationId?: number | undefined;
  /** Folders whose gone rows are marked 'kept_only_on_other_drive' (for example the Spare folders). */
  keptOnlyOnOtherDrive?: readonly string[] | undefined;
  force?: boolean | undefined;
}

export class BackupProfileService {
  readonly store: BackupProfileStore;
  private readonly running = new Set<string>();
  private historyRunning = false;

  constructor(private readonly deps: BackupProfileServiceDeps) {
    this.store = new BackupProfileStore(deps.db, deps.now, deps.uuid ?? randomUUID);
  }

  /**
   * Make the backup profiles of PhoneBackup's config.json (poco, samsung_phone, onedrive, ddrive, onedrive_imp), with their backup
   * folder on the T7. The T7 is found by its identity card (its name), never by the letter in the old settings, and nothing is made
   * unless the Poco's old history file is on that drive. onedrive_imp is made switched off. Safe to run twice: a profile that is
   * already there is left exactly as it is.
   */
  seedFromConfig(configText: string, options: { personId?: (importKey: string) => number | undefined } = {}): SeedResult {
    const parsed = profileDraftsFromConfig(configText);
    if (!parsed.ok) return parsed;
    const t7 = this.t7For(parsed.drafts);
    if (!t7.ok) return t7;
    const report = this.deps.db.transaction(() => saveDrafts(this.store, parsed.drafts, t7.drive, options))();
    return { ok: true, report, notBackups: parsed.skipped };
  }

  /** The T7 for these drafts: the plugged-in drive named T7 that holds the Poco's old history file. */
  private t7For(drafts: readonly ProfileDraft[]): ReturnType<typeof findT7> {
    const poco = drafts.find((d) => d.importKey === 'poco');
    const where = poco ? splitDrivePath(poco.backupRoot) : null;
    const rel = where ? cleanRoot(where.rel) : null;
    if (rel === null) return { ok: false, message: "The old settings have no backup folder for the Poco, so the T7 cannot be checked. Nothing was changed." };
    return findT7(this.deps.connectedDrives(), `${rel}/${HISTORY_FILE}`);
  }

  /** Reads PhoneBackup's settings (read only) and finds the T7 and the three old history files. Writes nothing. */
  private locate(): Located {
    const configPath = this.deps.phoneBackupConfig?.() ?? null;
    if (configPath === null) return { ok: false, message: "PhoneBackup's settings file was not found on this PC. Nothing was changed." };
    let configText: string;
    try {
      configText = fs.readFileSync(configPath, 'utf8');
    } catch {
      return { ok: false, message: `PhoneBackup's settings file could not be read (${configPath}). Nothing was changed.` };
    }
    const parsed = profileDraftsFromConfig(configText);
    if (!parsed.ok) return parsed;
    const t7 = this.t7For(parsed.drafts);
    if (!t7.ok) return t7;
    const files: Extract<Located, { ok: true }>['files'] = [];
    for (const item of HISTORY_BACKUPS) {
      const draft = parsed.drafts.find((d) => d.importKey === item.importKey);
      const where = draft ? splitDrivePath(draft.backupRoot) : null;
      const rel = where ? cleanRoot(where.rel) : null;
      if (draft && rel !== null) files.push({ importKey: item.importKey, rel, file: absOn(t7.drive.root, `${rel}/${HISTORY_FILE}`), keptOnlyOnOtherDrive: item.keptOnlyOnOtherDrive, draft });
    }
    return { ok: true, configPath, configText, drafts: parsed.drafts, drive: t7.drive, files };
  }

  private lastBroughtIn(profileId: number | undefined): number | null {
    if (profileId === undefined) return null;
    return (this.deps.db.prepare('SELECT max(imported_at) FROM ledger_imports WHERE backup_profile_id = ?').pluck().get(profileId) as number | null) ?? null;
  }

  /**
   * What "Bring in PhoneBackup history" would read, for the confirm screen. Reads nothing but file sizes and dates; writes nothing.
   * `stop` is set when a history file has unsaved changes beside it: then nothing can be brought in.
   */
  historyPlan(): HistoryPlan {
    const where = this.locate();
    if (!where.ok) return where;
    const files: HistoryFileInfo[] = where.files.map((f) => {
      let bytes = 0;
      let modifiedAt: number | null = null;
      let found = false;
      try {
        const st = fs.statSync(f.file);
        found = st.isFile();
        bytes = st.size;
        modifiedAt = Math.round(st.mtimeMs);
      } catch {
        found = false;
      }
      return { backup: f.draft.name, path: f.file, found, bytes, modifiedAt, lastBroughtInAt: this.lastBroughtIn(this.store.getByImportKey(f.importKey)?.id) };
    });
    const side = where.files.map((f) => ({ f, side: historySideFile(f.file) })).find((x) => x.side !== null);
    const newBackups = where.drafts.filter((d) => this.store.getByImportKey(d.importKey) === null).map((d) => (SEED_SWITCHED_OFF.includes(d.importKey) ? `${d.name} (switched off)` : d.name));
    return { ok: true, driveLabel: where.drive.label, settingsPath: where.configPath, files, newBackups, stop: side ? sideFileMessage(side.f.file) : null };
  }

  /**
   * "Bring in PhoneBackup history", started by the person: seeds the backups from PhoneBackup's settings (the T7 found by its card),
   * then brings in the three old history files (POCO, OneDrive, DDrive) read only. Repeatable: run again and only the rows that are
   * new in the old files change anything. Stops, before anything is made, when a history file has unsaved changes beside it.
   * Spare (only on the Seagate) is marked on the DDrive rows. Never throws.
   */
  async bringInHistory(): Promise<HistoryResult> {
    if (this.historyRunning) return { ok: false, message: 'The history is being brought in right now.' };
    this.historyRunning = true;
    try {
      const where = this.locate();
      if (!where.ok) return where;
      for (const f of where.files) {
        if (historySideFile(f.file) !== null) return { ok: false, message: sideFileMessage(f.file) };
      }
      const seeded = this.seedFromConfig(where.configText);
      if (!seeded.ok) return seeded;
      const lines: HistoryLine[] = [];
      const notes: string[] = [];
      const spare = { inHistory: 0, marked: 0, stillShown: 0 };
      for (const f of where.files) {
        const profile = this.store.getByImportKey(f.importKey);
        const name = profile?.name ?? f.draft.name;
        const fail = (message: string): void => {
          lines.push({ backup: name, ok: false, message, rowsIn: 0, linked: 0, loose: 0, stale: 0, staleReasons: [] });
        };
        if (!profile) {
          fail('This backup could not be made.');
          continue;
        }
        if (!fs.existsSync(f.file)) {
          fail('PhoneBackup has no history file for this backup on the T7.');
          continue;
        }
        const destination = this.store.destinations(profile.id).find((d) => d.enabled && d.placeId === where.drive.placeId && d.root.toLowerCase() === f.rel.toLowerCase());
        if (!destination) {
          fail(`This backup has no backup folder ${f.rel} on the ${where.drive.label}.`);
          continue;
        }
        const result = await this.importLedger({ profileId: profile.id, ledgerPath: f.file, destinationId: destination.id, keptOnlyOnOtherDrive: f.keptOnlyOnOtherDrive, force: true });
        if (!result.ok) {
          fail(result.message);
          continue;
        }
        if (result.alreadyImported) {
          fail(result.message);
          continue;
        }
        const s = result.summary;
        const { stale, reasons } = staleReasons(s);
        lines.push({ backup: name, ok: true, message: null, rowsIn: s.rowsRead, linked: s.linked, loose: s.looseRows, stale, staleReasons: reasons });
        spare.inHistory += s.keptInHistory;
        spare.marked += s.keptMarked;
        spare.stillShown += s.keptStillShown;
        for (const note of s.notes) notes.push(`${name}: ${note}`);
      }
      const totals = lines.reduce((t, l) => ({ rowsIn: t.rowsIn + l.rowsIn, linked: t.linked + l.linked, loose: t.loose + l.loose, stale: t.stale + l.stale }), { rowsIn: 0, linked: 0, loose: 0, stale: 0 });
      const names = (keys: readonly string[]): string[] => keys.map((k) => this.store.getByImportKey(k)?.name ?? k);
      return {
        ok: true,
        driveLabel: where.drive.label,
        made: names(seeded.report.created.map((c) => c.importKey)),
        alreadyThere: names(seeded.report.alreadyThere),
        lines,
        totals,
        spare,
        notes,
      };
    } catch (err) {
      return { ok: false, message: `The history could not be brought in: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.historyRunning = false;
    }
  }

  /** The Backups list: name, what is backed up, the drive, the last backup date known from the history, on or off. */
  overview(): BackupsOverview {
    const db = this.deps.db;
    const labelOf = db.prepare('SELECT label FROM places WHERE id = ?').pluck();
    const plugged = new Set(this.deps.connectedDrives().map((d) => d.placeId));
    // Runs of the FIRST drive only: a copy to the second drive (R1.3) is not "the last backup" of the phone.
    const lastRun = db.prepare('SELECT max(coalesce(ended_at, started_at)) FROM backup_runs WHERE backup_profile_id = ? AND (destination_place_id = ? OR ? IS NULL)').pluck();
    const newestRun = db.prepare('SELECT state FROM backup_runs WHERE backup_profile_id = ? AND (destination_place_id = ? OR ? IS NULL) ORDER BY id DESC LIMIT 1').pluck();
    const everImported = db.prepare('SELECT 1 FROM ledger_imports WHERE backup_profile_id = ? LIMIT 1');
    const hubRuns = db.prepare("SELECT count(*) FROM backup_runs WHERE backup_profile_id = ? AND (destination_place_id = ? OR ? IS NULL) AND state IN ('done', 'done_warnings')").pluck();
    const rules = new RulesStore(db);
    const backups = this.store.list().map((profile) => {
      const dest = this.store.destinations(profile.id).find((d) => d.enabled) ?? this.store.destinations(profile.id)[0] ?? null;
      const firstDrive = dest ? dest.placeId : null;
      let last = (lastRun.get(profile.id, firstDrive, firstDrive) as number | null) ?? null;
      if (dest) {
        const session = newestSessionAt(db, dest.placeId, dest.root, profile.folderPrefix);
        if (session !== null && (last === null || session > last)) last = session;
      }
      return {
        id: profile.id,
        name: profile.name,
        personId: profile.personId,
        kind: profile.sourceKind,
        from: profile.sourceKind === 'phone' ? 'Phone' : profile.sourceRoot,
        driveLabel: dest ? ((labelOf.get(dest.placeId) as string | undefined) ?? null) : null,
        destinations: loadDestinations(db, profile.id).map((d) => ({ placeId: d.placeId, label: (labelOf.get(d.placeId) as string | undefined) ?? 'a drive', position: d.position, connected: plugged.has(d.placeId) })),
        folder: dest ? dest.root : null,
        driveConnected: dest ? plugged.has(dest.placeId) : false,
        lastBackupAt: last,
        enabled: profile.enabled,
        lastRunFailed: (newestRun.get(profile.id, firstDrive, firstDrive) as string | undefined) === 'failed',
        hubHasRun: profile.sourceKind === 'phone' && (hubRuns.get(profile.id, firstDrive, firstDrive) as number) > 0,
        phoneLinked: profile.sourceKind === 'phone' && profile.phoneSerial !== null,
        choices: rules.countLeftOut(profile.id),
        fromOldTool: everImported.get(profile.id) !== undefined,
      };
    });
    const brought = (db.prepare('SELECT max(imported_at) FROM ledger_imports').pluck().get() as number | null) ?? null;
    const removed = this.store.list({ archived: 'only' }).map((p) => ({ id: p.id, name: p.name, personId: p.personId, from: p.sourceKind === 'phone' ? 'Phone' : p.sourceRoot, removedAt: p.archivedAt ?? 0 }));
    return { backups, removed, historyBroughtInAt: brought };
  }

  /**
   * "Remove from list": a backup that is switched off leaves the list (and Home's counts). Nothing is deleted: not a file on any drive, not a row of
   * the file list, not a run or history import; "Put back" undoes it. `confirmed` must be true.
   */
  archive(backupId: number, confirmed: boolean): ArchiveResult {
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was changed.' };
    const profile = this.store.get(backupId);
    if (!profile) return { ok: false, message: 'That backup does not exist.' };
    const done = this.store.archive(backupId);
    return done.ok ? { ok: true, message: profile.name + ' is off the list. Nothing on any drive was deleted. You can put it back.' } : { ok: false, message: done.message };
  }

  /** "Put back": the removed backup is on the list again (still switched off). */
  unarchive(backupId: number): ArchiveResult {
    const profile = this.store.get(backupId);
    if (!profile) return { ok: false, message: 'That backup does not exist.' };
    const done = this.store.unarchive(backupId);
    return done.ok ? { ok: true, message: profile.name + ' is back on the list.' } : { ok: false, message: done.message };
  }

  /**
   * How many files and bytes each backup holds on its first drive, for the Backups list ("1,204 files, 3.2 GB"). Read from the file list on the
   * query worker, never on the main thread; when the worker is not there the numbers stay unknown (the list shows a placeholder).
   */
  async sizes(): Promise<BackupSizesResult> {
    if (!this.deps.sizesInWorker) return { ok: false, message: 'The sizes are not known yet.' };
    const asks: { backupId: number; placeId: string; root: string }[] = [];
    for (const profile of this.store.list()) {
      const dest = this.store.destinations(profile.id).find((d) => d.enabled) ?? this.store.destinations(profile.id)[0];
      if (dest) asks.push({ backupId: profile.id, placeId: dest.placeId, root: dest.root });
    }
    try {
      const sizes = await this.deps.sizesInWorker(asks);
      return sizes === null ? { ok: false, message: 'The sizes could not be counted.' } : { ok: true, sizes };
    } catch {
      return { ok: false, message: 'The sizes could not be counted.' };
    }
  }

  list(options: { includeDisabled?: boolean } = {}): BackupProfileView[] {
    return this.store.list(options).map((profile) => ({
      profile,
      destinations: this.store.destinations(profile.id),
      exclusionCount: this.store.exclusions(profile.id).length,
      imports: (this.deps.db.prepare('SELECT id, imported_at, rows FROM ledger_imports WHERE backup_profile_id = ? ORDER BY id').all(profile.id) as { id: number; imported_at: number; rows: number }[]).map((r) => ({
        id: r.id,
        importedAt: r.imported_at,
        rows: r.rows,
      })),
    }));
  }

  /** Where a folder backup's source folder lives: the OneDrive place that contains it, else the laptop. */
  private sourcePlaceFor(sourceRoot: string): { placeId: string; base: string } | null {
    if (this.deps.sourcePlaceFor) return this.deps.sourcePlaceFor(sourceRoot);
    const key = pathKey(sourceRoot);
    const oneDrives = this.deps.db.prepare("SELECT id, identity_json FROM places WHERE kind = 'onedrive' ORDER BY created_at").all() as { id: string; identity_json: string }[];
    for (const od of oneDrives) {
      let folder: unknown;
      try {
        folder = (JSON.parse(od.identity_json) as Record<string, unknown>)['userFolder'];
      } catch {
        folder = undefined;
      }
      if (typeof folder === 'string' && folder !== '' && isUnder(key, pathKey(folder))) return { placeId: od.id, base: folder };
    }
    if (!/^[a-z]:/.test(key)) return null;
    const laptop = this.deps.db.prepare("SELECT id FROM places WHERE kind = 'laptop' ORDER BY created_at LIMIT 1").pluck().get() as string | undefined;
    return laptop ? { placeId: laptop, base: '' } : null;
  }

  /**
   * Bring in ONE old history file (ledger.db) for ONE backup. Read only on the old file. Importing the same file again does nothing
   * (unless `force`). A phone backup gets its phone place made here when it has none. Returns the summary, never throws.
   */
  async importLedger(request: ImportLedgerRequest): Promise<LedgerImportResult> {
    const profile = this.store.get(request.profileId);
    if (!profile) return { ok: false, message: 'That backup does not exist.' };
    const destinations = this.store.destinations(profile.id);
    const destination = request.destinationId !== undefined ? destinations.find((d) => d.id === request.destinationId) : destinations.find((d) => d.enabled);
    if (!destination) return { ok: false, message: 'This backup has no backup folder on a drive yet. Add one first.' };
    if (this.running.has(request.ledgerPath)) return { ok: false, message: 'This history file is being brought in right now.' };
    this.running.add(request.ledgerPath);
    try {
      const phonePlaceId = profile.sourceKind === 'phone' ? this.store.ensurePhonePlace(profile.id) : null;
      const sourcePlace = profile.sourceKind === 'folder' ? this.sourcePlaceFor(profile.sourceRoot) : null;
      return await importLedgerFile({
        db: this.deps.db,
        store: this.store,
        ledgerPath: request.ledgerPath,
        profile: { id: profile.id, sourceKind: profile.sourceKind, sourceRoot: profile.sourceRoot },
        destination: { placeId: destination.placeId, root: destination.root },
        phonePlaceId,
        sourcePlace,
        ...(request.keptOnlyOnOtherDrive ? { keptOnlyOnOtherDrive: request.keptOnlyOnOtherDrive } : {}),
        ...(request.force ? { force: true } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(this.deps.yieldNow ? { yieldNow: this.deps.yieldNow } : {}),
      });
    } catch (err) {
      return { ok: false, message: `The history file could not be brought in: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.running.delete(request.ledgerPath);
    }
  }
}
