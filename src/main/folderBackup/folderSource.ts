/**
 * The real folder that is backed up (R2.1): looking at it with the listing's quick look (on its own thread when the app runs, never on the window's),
 * its facts by lstat, the ONE way its content is read (the unbuffered stream of the copy, which hashes while it hands each block on), and the
 * attribute check that tells a OneDrive file that is online only (never opened, so never downloaded). The Google Keep notes have their own source
 * (keepSync.ts): their names stay out of the file list and nothing but the copy stream ever reads them.
 */
import type { Db } from '../db';
import { absIn, fileOps } from './fileOps';
import { checkCloudOnlyPaths, type CloudCheckState } from '../listing/cloudOnly';
import type { QuickWalkRunner } from '../listing/quickWalkRunner';
import { KEEP_SYNC_KEY } from '../../shared/folderBackup';
import { MAX_KEEP_PREFIXES } from '../listing/fileStore';
import { folderPrefix } from '../listing/skipRules';
import { resolveSourcePlace } from './folderPaths';
import { keepSyncSource } from './keepSync';
import type { FolderBackupDeps, FolderSource } from './folderTypes';

/** Files saved per batch by the walk (the listing's own default). */
const WALK_CHUNK = 500;

export interface RealSourceOptions {
  db: Db;
  quickRunner: QuickWalkRunner;
  /** The folder names the listing never enters (the person's setting); none by default. */
  skipFolders?: () => readonly string[];
  /** Tests swap the PowerShell attribute check. */
  checkCloud?: (paths: readonly string[], o: { signal?: AbortSignal }) => Promise<Map<string, CloudCheckState>>;
  /** Where keep-sync keeps its files (tests point it at a temp folder; the default is %LOCALAPPDATA%). */
  localAppData?: string | undefined;
}

export function realSourceFor(o: RealSourceOptions): FolderBackupDeps['sourceFor'] {
  return async (profile) => {
    if (profile.importKey === KEEP_SYNC_KEY) return keepSyncSource(o.localAppData);
    const place = resolveSourcePlace(o.db, profile.sourceRoot);
    if (!place) return { ok: false, message: `Backup Hub has no file list for ${profile.sourceRoot}. Nothing was changed.` };
    const root = place.root;
    const check = o.checkCloud ?? ((paths, opts) => checkCloudOnlyPaths(paths, opts));
    const source: FolderSource = {
      words: root,
      placeId: place.placeId,
      relBase: place.relBase,
      cloudAware: place.kind === 'onedrive',
      // The whole folder is walked, file by file (names, sizes, dates; no file is opened). The quick look of the listing skips a folder whose own date did not
      // move, and a file edited in place does not move its folder's date: a backup must not miss that. A walk that did not finish marks nothing as gone.
      async look({ signal, progress }) {
        const runStart = Date.now();
        const prefix = place.relBase === '' ? '' : folderPrefix(place.relBase);
        const result = await o.quickRunner.fullWalk(
          { placeId: place.placeId, root, rel: place.rel, excludeDirs: [], skipFolders: [...(o.skipFolders?.() ?? [])], oneDriveRoot: place.kind === 'onedrive' ? (place.rel.kind === 'under' ? place.rel.base : null) : null, cloudRels: null, chunkSize: WALK_CHUNK, trustFsId: true },
          { signal, tick: (c) => progress(`Looking at ${root}: ${c.filesSeen.toLocaleString('en-GB')} files so far. Nothing is copied.`) },
        );
        if (result.rootMissing) return { complete: false, rootMissing: true, message: null };
        const keepPrefixes = result.deniedFolders.map((f) => folderPrefix(f));
        if (!result.complete || keepPrefixes.length > MAX_KEEP_PREFIXES) {
          return { complete: false, rootMissing: false, message: result.firstError ?? 'The list of files could not be read completely.' };
        }
        await o.quickRunner.finishWalk({ placeId: place.placeId, scopePrefix: prefix, keepPrefixes, keepPaths: result.deniedFiles, runStart, folderRoot: place.relBase, trustFsId: true });
        return { complete: true, rootMissing: false, message: null };
      },
      ...fileOps(async (rel) => absIn(root, rel)),
      async cloudStates(rels, signal) {
        const paths = rels.map((r) => absIn(root, r));
        const states = await check(paths, { signal });
        return new Map(rels.map((r, i) => [r, states.get(paths[i]!) ?? 'unknown']));
      },
    };
    return { ok: true, source };
  };
}
