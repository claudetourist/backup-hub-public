import { parseJsonLoose } from '../fsutil';
import { mergeFilters, type Filters } from './filters';
import { cleanRoot, splitDrivePath } from './pathForms';
import { changeRuleFor, type BackupProfileStore, type ChangeRule, type SourceKind } from './profileStore';

/**
 * Bringing PhoneBackup's config.json in as backup profiles (Profiles step 1a). `profileDraftsFromConfig` is pure (text in, drafts
 * out); `saveDrafts` writes them through the store. Read only on the old tool: the file is never changed.
 */
export interface ProfileDraft {
  /** The key in config.json ('poco', 'samsung_phone', 'onedrive', 'ddrive', 'onedrive_imp'). */
  importKey: string;
  name: string;
  folderPrefix: string;
  /** As written in config.json ("F:\\MyData\\POCO"). The drive letter is never used to find the drive (the T7 is found by its card) and never stored. */
  backupRoot: string;
  sourceKind: SourceKind;
  /** Folder profiles: the folder that is backed up. Phone profiles: ''. */
  sourceRoot: string;
  changeRule: ChangeRule;
  /** The six filter lists, defaults merged exactly like PhoneBackup's get_filters. */
  filters: Filters;
}

export interface SkippedProfile {
  key: string;
  reason: string;
}

export type ConfigDrafts = { ok: true; drafts: ProfileDraft[]; skipped: SkippedProfile[] } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** JSON, tolerant of a byte order mark and of trailing commas (an old hand-edited file); tabs and loose spacing are plain JSON. */
function parseTolerant(raw: string): unknown {
  try {
    return parseJsonLoose(raw);
  } catch {
    // Remove a comma that sits just before a closing bracket, outside text.
    let out = '';
    let inString = false;
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i]!;
      if (inString) {
        out += c;
        if (c === '\\') {
          out += raw[i + 1] ?? '';
          i += 1;
        } else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      if (c === ',') {
        const rest = /^\s*([\]}])/.exec(raw.slice(i + 1, i + 200));
        if (rest) continue;
      }
      out += c;
    }
    return parseJsonLoose(out);
  }
}

/**
 * The profiles of config.json that become backup profiles. Skipped: keys starting with "_" (examples), a backup_root of "skip" and
 * anything that goes to the cloud (`destination.type` "cloud", e.g. local_to_gdrive), and sources that are neither a phone (adb) nor a folder.
 */
export function profileDraftsFromConfig(configText: string): ConfigDrafts {
  let parsed: unknown;
  try {
    parsed = parseTolerant(configText);
  } catch {
    return { ok: false, message: 'The settings file of the old tool could not be read.' };
  }
  const profiles = isObject(parsed) ? parsed['profiles'] : undefined;
  if (!isObject(profiles)) return { ok: false, message: 'The settings file of the old tool has no list of backups.' };
  const drafts: ProfileDraft[] = [];
  const skipped: SkippedProfile[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    if (key.startsWith('_')) {
      skipped.push({ key, reason: 'An example, not a real backup.' });
      continue;
    }
    if (!isObject(value)) {
      skipped.push({ key, reason: 'Not a backup.' });
      continue;
    }
    const backupRoot = text(value['backup_root']);
    const destination = value['destination'];
    if (backupRoot.toLowerCase() === 'skip' || (isObject(destination) && text(destination['type']) === 'cloud')) {
      skipped.push({ key, reason: 'Goes to Google Drive, not to a drive.' });
      continue;
    }
    const source = isObject(value['source']) ? value['source'] : {};
    const type = text(source['type']);
    const sourceKind: SourceKind | null = type === 'adb' ? 'phone' : type === 'local' ? 'folder' : null;
    if (sourceKind === null) {
      skipped.push({ key, reason: 'Not a phone and not a folder.' });
      continue;
    }
    const sourceRoot = sourceKind === 'folder' ? text(source['path']) : '';
    if (sourceKind === 'folder' && sourceRoot === '') {
      skipped.push({ key, reason: 'No folder to back up.' });
      continue;
    }
    const folderPrefix = text(value['folder_prefix']);
    if (folderPrefix === '') {
      skipped.push({ key, reason: 'No folder name prefix.' });
      continue;
    }
    drafts.push({
      importKey: key,
      name: text(value['name']) || key,
      folderPrefix,
      backupRoot,
      sourceKind,
      sourceRoot,
      changeRule: changeRuleFor(sourceKind),
      filters: mergeFilters(value['filters']),
    });
  }
  return { ok: true, drafts, skipped };
}

/** The T7, found by its identity card (see `findT7`), never by the drive letter written in the old settings. */
export interface SeedDrive {
  placeId: string;
}

/** Backups that are made but switched off: OneDrive IMP's files belong to the one OneDrive backup (user decision, 17 Nov). */
export const SEED_SWITCHED_OFF: readonly string[] = ['onedrive_imp'];

export interface SeedReport {
  /** Made now. `destination` says whether its backup folder could be saved. */
  created: { importKey: string; profileId: number; destination: 'saved' | 'none'; enabled: boolean }[];
  /** Already there from an earlier seed: left exactly as they are (the person may have edited them). */
  alreadyThere: string[];
  /** Made without a backup folder, with the reason (the drive was not found, or the path is not on a drive). */
  noDestination: { importKey: string; backupRoot: string; reason: string }[];
  /** Not made, with the reason; also failures to save. */
  skipped: SkippedProfile[];
}

/**
 * Saves the drafts as backup profiles. A backup_root such as `F:\MyData\POCO` becomes a backup folder = `drive` (the T7, found by
 * its card) + `MyData/POCO`. The letter in the old settings is NOT used to find a drive and is never stored; it is only compared:
 * a backup that the old settings put on another letter than the first one (poco) gets no backup folder (nothing is assumed).
 * No drive (null): the profiles are saved without a backup folder and reported. A profile whose key is already there is left alone,
 * so running this twice changes nothing. The keys in `SEED_SWITCHED_OFF` are made switched off.
 */
export function saveDrafts(store: BackupProfileStore, drafts: readonly ProfileDraft[], drive: SeedDrive | null, options: { personId?: (importKey: string) => number | undefined } = {}): SeedReport {
  const report: SeedReport = { created: [], alreadyThere: [], noDestination: [], skipped: [] };
  const oldLetter = splitDrivePath((drafts.find((d) => d.importKey === 'poco') ?? drafts[0])?.backupRoot ?? '')?.letter ?? null;
  for (const d of drafts) {
    if (store.getByImportKey(d.importKey)) {
      report.alreadyThere.push(d.importKey);
      continue;
    }
    const enabled = !SEED_SWITCHED_OFF.includes(d.importKey);
    const made = store.create({
      personId: options.personId?.(d.importKey),
      name: d.name,
      sourceKind: d.sourceKind,
      sourceRoot: d.sourceRoot,
      folderPrefix: d.folderPrefix,
      changeRule: d.changeRule,
      filters: d.filters,
      importKey: d.importKey,
      enabled,
    });
    if (!made.ok) {
      report.skipped.push({ key: d.importKey, reason: made.message });
      continue;
    }
    const where = splitDrivePath(d.backupRoot);
    const root = where ? cleanRoot(where.rel) : null;
    let saved = false;
    if (where === null || root === null) {
      report.noDestination.push({ importKey: d.importKey, backupRoot: d.backupRoot, reason: 'The backup folder is not on a lettered drive.' });
    } else if (where.letter !== oldLetter) {
      report.noDestination.push({ importKey: d.importKey, backupRoot: d.backupRoot, reason: 'The old settings put this backup on a different drive than the first one, so it was not given the T7.' });
    } else if (drive === null) {
      report.noDestination.push({ importKey: d.importKey, backupRoot: d.backupRoot, reason: 'The T7 was not found.' });
    } else {
      const dest = store.addDestination({ profileId: made.id, placeId: drive.placeId, root, role: 'primary' });
      if (dest.ok) saved = true;
      else report.noDestination.push({ importKey: d.importKey, backupRoot: d.backupRoot, reason: dest.message });
    }
    report.created.push({ importKey: d.importKey, profileId: made.id, destination: saved ? 'saved' : 'none', enabled });
  }
  return report;
}
