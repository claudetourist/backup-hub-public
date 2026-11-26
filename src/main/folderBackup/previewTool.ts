import path from 'node:path';
import { rawFs as fs } from '../rawFs';
import Database from 'better-sqlite3';
import { KEEP_SYNC_KEY } from '../../shared/folderBackup';
import { DEFAULT_SETTINGS, validSettingValue } from '../../shared/settings';
import { fsIdOf } from '../listing/fsId';
import { compileRules } from '../rules/ruleMatcher';
import { RulesStore } from '../rules/rulesStore';
import type { BackupRule } from '../../shared/rules';
import { checkCloudOnlyPaths, type CloudCheckState } from '../listing/cloudOnly';
import { isSkippedEntry, prefixUpperBound } from '../listing/skipRules';
import { loadDestinations } from '../look/lookStore';
import { sessionFolderName } from '../phoneBackup/pathMap';
import { finishSync } from '../sliceWork';
import { loadDestSteps } from './destIndex';
import { classifySteps, loadSourceRowsSteps } from './folderPlan';
import { relOfRulePath, resolveSourcePlace } from './folderPaths';
import { groupMovesSteps } from './movedGroups';
import { keepSyncSource } from './keepSync';
import type { SourceEntry } from './folderTypes';

/**
 * R2.1 proof helper (run by scripts/r21-preview.mjs): prints what a folder backup would do right now, for one backup, WITHOUT doing it: how many files and
 * bytes would be copied (new and changed), how many are already backed up (and how many of those by their content), how many are in use by another program,
 * how many are online only (OneDrive), and how many are excluded. The database is opened READ ONLY: nothing is written to it (so it also works on the real
 * file), nothing is copied, no drive is written, no file is changed. The folder is only walked (names, sizes, dates); the drive's side is the file list as of
 * its last look. Files that would be copied are asked about (a OneDrive file's attributes; a plain open and close of any other file, no byte is read).
 * The Google Keep notes are never opened at all: their names, sizes and dates only.
 */
export interface FolderPreviewOptions {
  dbPath: string;
  /** A backup's number or name; the first folder backup when left out. */
  backup?: string | undefined;
  /** Print every file that would be copied (default: the 20 largest). */
  all?: boolean;
  /** Most files opened to see whether another program holds them (default 5,000). */
  maxOpen?: number | undefined;
  /** Where keep-sync keeps its files (default %LOCALAPPDATA%). */
  localAppData?: string | undefined;
  print: (line: string) => void;
  /** Tests swap the PowerShell attribute check. */
  checkCloud?: ((paths: readonly string[]) => Promise<Map<string, CloudCheckState>>) | undefined;
}

const gb = (n: number): string => `${(n / 1e9).toFixed(2)} GB`;

/** Names, sizes and dates of the files below `root` (never opened), with the names the listing never enters left out. */
async function walk(root: string, skip: ReadonlySet<string>): Promise<{ entries: SourceEntry[]; complete: boolean; ids: Map<string, string> }> {
  const entries: SourceEntry[] = [];
  /** The file system's id of each file (the same lstat; nothing is opened), by its path below `root`. */
  const ids = new Map<string, string>();
  let complete = true;
  const stack: { dir: string; rel: string }[] = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!;
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const e of names) {
      if (isSkippedEntry(dir, e.name)) continue;
      const abs = path.join(dir, e.name);
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!skip.has(e.name.toLowerCase())) stack.push({ dir: abs, rel: childRel });
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.lstat(abs, { bigint: true });
          entries.push({ rel: childRel, size: Number(st.size), mtimeMs: Number(st.mtimeMs), rowId: null, sha256: null, cloudOnly: false });
          const id = fsIdOf(st);
          if (id !== null) ids.set(childRel, id);
        } catch {
          complete = false;
        }
      }
    }
  }
  return { entries, complete, ids };
}

export async function runFolderPreview(o: FolderPreviewOptions): Promise<number> {
  const { print } = o;
  const db = new Database(o.dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT id, name, source_root, folder_prefix, change_rule, import_key, enabled FROM backup_profiles WHERE source_kind = 'folder' ORDER BY id").all() as { id: number; name: string; source_root: string; folder_prefix: string; change_rule: 'size_and_date' | 'size_or_date'; import_key: string | null; enabled: number }[];
    const profile = o.backup === undefined ? rows.find((r) => r.enabled === 1) : rows.find((r) => String(r.id) === o.backup || r.name.toLowerCase() === o.backup!.toLowerCase());
    if (!profile) {
      print(`No such folder backup in this database. Folder backups: ${rows.map((r) => `${r.id} ${r.name}${r.enabled === 1 ? '' : ' (off)'}`).join('; ') || 'none'}`);
      return 2;
    }
    const dest = loadDestinations(db as never, profile.id)[0];
    if (!dest) {
      print('This backup has no drive folder.');
      return 2;
    }
    const flat = profile.import_key === KEEP_SYNC_KEY;
    const looked = db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck().get(dest.placeId) as number | null | undefined;
    print(`Backup: ${profile.name} (${profile.id}), ${flat ? 'the keep-sync snapshots' : profile.source_root} -> drive ${dest.placeId}, folder ${dest.root}, ${flat ? 'flat and add-only' : 'a new dated folder ' + sessionFolderName(profile.folder_prefix, new Date())}`);
    print(`The drive's file list is as of its last look (${looked ? new Date(looked).toISOString().replace('T', ' ').slice(0, 16) : 'never'}). Nothing is written anywhere.`);

    // The folder: walked now (names, sizes, dates).
    let entries: SourceEntry[];
    let place = null as ReturnType<typeof resolveSourcePlace>;
    if (flat) {
      const made = keepSyncSource(o.localAppData);
      if (!made.ok) {
        print(made.message);
        return 2;
      }
      const look = await made.source.look({ signal: new AbortController().signal, progress: () => undefined });
      if (look.rootMissing || look.entries === undefined) {
        print('The keep-sync snapshots folder was not found.');
        return 3;
      }
      entries = look.entries;
    } else {
      place = resolveSourcePlace(db as never, profile.source_root);
      if (!place) {
        print(`Backup Hub has no file list for ${profile.source_root}.`);
        return 2;
      }
      if (!fs.existsSync(place.root)) {
        print(`The folder ${place.root} was not found.`);
        return 3;
      }
      // The folder names the listing never enters: the person's setting, and the app's own list (settings default) when none is saved, like the real look.
      let skip: string[] = [...DEFAULT_SETTINGS.skipFolders];
      try {
        const saved = db.prepare("SELECT value FROM settings WHERE key = 'skipFolders'").pluck().get() as string | undefined;
        if (saved !== undefined) skip = validSettingValue('skipFolders', JSON.parse(saved)) ?? skip;
      } catch {
        // An unreadable saved value: the default list, as the app uses.
      }
      skip = skip.map((s) => s.toLowerCase());
      const walked = await walk(place.root, new Set(skip));
      if (!walked.complete) print('WARNING: some folders could not be read, so the numbers below may be too small.');
      // The index knows each file's row and, while the file is unchanged, its checksum.
      const known = new Map(finishSync(loadSourceRowsSteps(db as never, { placeId: place.placeId, relBase: place.relBase })).map((r) => [r.rel, r]));
      entries = walked.entries;
      // A file renamed or moved since the last look has no row at its new path yet: its row is found by the file system's own id (NTFS), same size and date.
      const hasIds = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).some((c) => c.name === 'fs_id');
      const relOfRow = new Map([...known.values()].map((r) => [r.rowId, r.rel]));
      const byId = hasIds ? db.prepare('SELECT id FROM files WHERE place_id = ? AND fs_id = ? AND gone_at IS NULL') : null;
      const walkedRels = new Set(entries.map((e) => e.rel));
      for (const e of entries) {
        let row = known.get(e.rel);
        const id = walked.ids.get(e.rel);
        if (row === undefined && byId !== null && id !== undefined) {
          const same = (byId.pluck().all(place.placeId, id) as number[]).map((rowId) => ({ rowId, rel: relOfRow.get(rowId) })).filter((r) => r.rel !== undefined && !walkedRels.has(r.rel));
          const found = same.length === 1 ? [...known.values()].find((r) => r.rowId === same[0]!.rowId) : undefined;
          if (found !== undefined && found.size === e.size && Math.abs(found.mtimeMs - e.mtimeMs) <= 2000) row = found;
        }
        if (row === undefined) continue;
        e.rowId = row.rowId;
        if (row.size === e.size && Math.abs(row.mtimeMs - e.mtimeMs) <= 2000) {
          e.sha256 = row.sha256;
          e.cloudOnly = row.cloudOnly;
        }
      }
    }
    print(`In the folder: ${entries.length.toLocaleString('en-US')} files, ${gb(entries.reduce((s, e) => s + e.size, 0))}.`);

    const hasRules = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_rules'").get() !== undefined;
    const rules = hasRules
      ? new RulesStore(db as never).compiled(profile.id)
      : compileRules((db.prepare('SELECT source_path FROM backup_exclusions WHERE backup_profile_id = ?').pluck().all(profile.id) as string[]).map((p, i): BackupRule => ({ id: i + 1, backupId: profile.id, scope: 'file', pattern: p, choice: 'leave_out', destination: null, note: null, createdAt: 0 })));
    const index = finishSync(loadDestSteps(db as never, { placeId: dest.placeId, root: dest.root, prefix: profile.folder_prefix, flat }));
    print(`In the backup folder on the drive (as the file list has it): ${index.rows.toLocaleString('en-US')} files.`);
    const base = dest.root.replace(/\/+$/, '') + '/';
    const shaStmt = db.prepare('SELECT id, origin_file_id FROM files WHERE sha256 = ? AND place_id = ? AND gone_at IS NULL AND size = ? AND rel_path > ? AND rel_path < ? LIMIT 1');
    const byContent = flat ? null : (sha: string, size: number): { id: number; origin: number | null } | null => {
      const r = shaStmt.get(sha, dest.placeId, size, base, prefixUpperBound(base)) as { id: number; origin_file_id: number | null } | undefined;
      return r ? { id: r.id, origin: r.origin_file_id } : null;
    };
    const classified = finishSync(classifySteps({ entries, index, flat, rule: profile.change_rule, rules, byContent }));
    let items = classified.items;

    // OneDrive: which of the files to copy are online only.
    let online = { files: 0, bytes: 0, examples: [] as string[] };
    if (place !== null && place.kind === 'onedrive' && items.length > 0) {
      const root = place.root;
      const abs = (i: { path: string }): string => path.join(root, ...(relOfRulePath(i.path) ?? '').split('/'));
      const flagged = new Set(entries.filter((e) => e.cloudOnly).map((e) => `/source/${e.rel}`));
      const toCheck = items.filter((i) => !flagged.has(i.path));
      const states = await (o.checkCloud ?? ((p: readonly string[]) => checkCloudOnlyPaths(p)))(toCheck.map(abs));
      const keep: typeof items = [];
      for (const i of items) {
        const state = flagged.has(i.path) ? 'cloud' : (states.get(abs(i)) ?? 'unknown');
        if (state === 'cloud' || state === 'unknown') {
          online.files += 1;
          online.bytes += i.size;
          if (online.examples.length < 5) online.examples.push(relOfRulePath(i.path) ?? i.path);
        } else keep.push(i);
      }
      items = keep;
    }

    // Files in use: a plain open and close of each file that would be copied (no byte is read). Never for the keep-sync notes.
    let inUse = 0;
    const inUseExamples: string[] = [];
    let opened = 0;
    if (!flat && place !== null) {
      const limit = o.maxOpen ?? 5000;
      for (const i of items.toSorted((a, b) => b.size - a.size).slice(0, limit)) {
        opened += 1;
        try {
          const handle = await fs.promises.open(path.join(place.root, ...(relOfRulePath(i.path) ?? '').split('/')), 'r');
          await handle.close();
        } catch (err) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) {
            inUse += 1;
            if (inUseExamples.length < 5) inUseExamples.push(relOfRulePath(i.path) ?? i.path);
          }
        }
      }
    }

    const bytes = items.reduce((s, i) => s + i.size, 0);
    const news = items.filter((i) => i.kind === 'new');
    print(`TO COPY: ${items.length.toLocaleString('en-US')} files, ${bytes} bytes (${gb(bytes)}): ${news.length.toLocaleString('en-US')} new, ${(items.length - news.length).toLocaleString('en-US')} changed.`);
    print(`ALREADY BACKED UP: ${classified.alreadyBackedUp.toLocaleString('en-US')} files${flat ? '' : `, of which ${classified.sameElsewhere.toLocaleString('en-US')} by their content under another name or date (linked, not copied)`}.`);
    const grouped = finishSync(groupMovesSteps(classified.moves));
    if (grouped.files > 0) {
      print(`RENAMED OR MOVED since they were backed up: ${grouped.files.toLocaleString('en-US')} files (the same files: nothing to copy).`);
      for (const g of grouped.groups) print(g.kind === 'files' ? `  ${g.files} files renamed or moved on their own` : `  ${g.kind === 'folder_renamed' ? 'folder renamed' : 'folder moved'}: ${g.from === '' ? '(main folder)' : g.from} > ${g.to === '' ? '(main folder)' : g.to} (${g.files} files)`);
    }
    if (flat) print(`Same name on the drive with ANOTHER size (never replaced): ${classified.differentOnDrive}.`);
    print(flat ? 'IN USE: not checked (the notes files are never opened, not even to test them).' : `IN USE by another program: ${inUse} of the ${opened.toLocaleString('en-US')} files asked${opened < items.length ? ` (the ${opened.toLocaleString('en-US')} largest of ${items.length.toLocaleString('en-US')})` : ''}${inUseExamples.length > 0 ? ': ' + inUseExamples.join(', ') : ''}. They are skipped and tried again next time.`);
    if (place !== null && place.kind === 'onedrive') print(`ONLINE ONLY (not read, not copied this time): ${online.files.toLocaleString('en-US')} files, ${gb(online.bytes)}${online.examples.length > 0 ? ': ' + online.examples.join(', ') : ''}.`);
    const left = [...classified.buckets.values()];
    print(`EXCLUDED by your choices: ${left.reduce((s, b) => s + b.files.length, 0).toLocaleString('en-US')} files, ${left.reduce((s, b) => s + b.bytes, 0)} bytes${left.length > 0 ? ' (' + left.map((b) => `${b.files.length} by ${b.rule?.pattern ?? 'a choice'}`).join('; ') + ')' : ''}.`);
    print(`--- ${o.all ? 'every file to copy' : 'the 20 largest files to copy'}: path|size|date|kind ---`);
    for (const i of items.toSorted((a, b) => b.size - a.size).slice(0, o.all ? undefined : 20)) print(`${relOfRulePath(i.path)}|${i.size}|${new Date(i.mtimeSec * 1000).toISOString().slice(0, 16)}|${i.kind}`);
    return 0;
  } finally {
    db.close();
  }
}
