/**
 * Where a folder backup's files go and how they are found again. Pure, except `resolveSourcePlace` (reads the places table).
 *
 * The old tool's layout, kept: `<backup folder>/<prefix>-DDMonYY/<path below the backed-up folder>` holds only the files that were new or changed that
 * day (the phone backup's layout too). A name Windows cannot store is cleaned and tagged (the same rules as the phone backup). The Google Keep notes
 * are the one flat layout: `<keep-sync folder>/<path below the source>`, no dated folders.
 */
import path from 'node:path';
import type { Db } from '../db';
import { sessionDate } from '../backupProfiles/history';
import { isUnder, pathKey } from '../backupProfiles/pathForms';
import { normalizeRoot } from '../listing/roots';
import type { RelMode } from '../listing/relPaths';
import { toSlashes } from '../listing/skipRules';
import { windowsSafeParts } from '../phoneBackup/pathMap';
import { FOLDER_ROOT_FOLDER } from '../../shared/rules';

/** "Photos/a.jpg" -> "/source/Photos/a.jpg": the path choices, the list and the explanations use. */
export const rulePathOf = (rel: string): string => `${FOLDER_ROOT_FOLDER}/${rel}`;

/** "/source/Photos/a.jpg" -> "Photos/a.jpg"; null for a path that is not one of ours. */
export function relOfRulePath(p: string): string | null {
  return p.startsWith(FOLDER_ROOT_FOLDER + '/') && p.length > FOLDER_ROOT_FOLDER.length + 1 ? p.slice(FOLDER_ROOT_FOLDER.length + 1) : null;
}

/** The path of one file on the drive, relative to the drive root; null when the name has no usable form. `session` '' = the flat layout. */
export function placeInFolder(i: { root: string; session: string; rel: string }): { rel: string; nameChanged: boolean } | null {
  const safe = windowsSafeParts(i.rel, rulePathOf(i.rel));
  if (safe === null) return null;
  const parts = [...i.root.split('/').filter((s) => s !== ''), ...(i.session === '' ? [] : [i.session]), ...safe.parts];
  return { rel: parts.join('/'), nameChanged: safe.changed };
}

/** The key two names are compared by (Windows does not tell "A.jpg" and "a.jpg" apart; names in normal form). */
export const nameKey = (rel: string): string => rel.normalize('NFC').toLowerCase();

/**
 * A row of the backup folder on the drive: "<session>/<path below the folder>" -> the date of its dated folder and the path below it. Null for anything
 * that is not under a dated folder of this backup (a history file, a folder kept for another purpose).
 */
export function parseSessionRel(folderPrefix: string, below: string): { sessionAt: number; rest: string } | null {
  const slash = below.indexOf('/');
  if (slash <= 0 || slash === below.length - 1) return null;
  const at = sessionDate(folderPrefix, below.slice(0, slash));
  return at === null ? null : { sessionAt: at, rest: below.slice(slash + 1) };
}

export interface SourcePlace {
  placeId: string;
  kind: 'onedrive' | 'laptop';
  rel: RelMode;
  /** The rel_path of the backed-up folder inside the place ('' = the whole place). */
  relBase: string;
  /** The folder as Windows spells it (drive letter in capitals, no trailing slash). */
  root: string;
}

/** Where a folder backup's source rows live: the OneDrive place that holds the folder, else the laptop (whole paths). Null when there is no place for it. */
export function resolveSourcePlace(db: Db, sourceRoot: string): SourcePlace | null {
  const root = normalizeRoot(sourceRoot);
  const key = pathKey(root);
  const oneDrives = db.prepare("SELECT id, identity_json FROM places WHERE kind = 'onedrive' ORDER BY created_at").all() as { id: string; identity_json: string }[];
  for (const od of oneDrives) {
    let folder: unknown;
    try {
      folder = (JSON.parse(od.identity_json) as Record<string, unknown>)['userFolder'];
    } catch {
      folder = undefined;
    }
    if (typeof folder === 'string' && folder !== '' && isUnder(key, pathKey(folder))) {
      const rel = toSlashes(path.relative(folder, root));
      return { placeId: od.id, kind: 'onedrive', rel: { kind: 'under', base: folder }, relBase: rel === '.' ? '' : rel, root };
    }
  }
  if (!/^[A-Za-z]:/.test(root)) return null;
  const laptop = db.prepare("SELECT id FROM places WHERE kind = 'laptop' ORDER BY created_at LIMIT 1").pluck().get() as string | undefined;
  return laptop ? { placeId: laptop, kind: 'laptop', rel: { kind: 'absolute' }, relBase: toSlashes(root), root } : null;
}
