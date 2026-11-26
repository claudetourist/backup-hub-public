import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, runMigrations, type Db } from '../db';
import { readDriveCard } from '../places/driveCard';
import { T7_NAME } from '../../shared/start';
import type { HistoryResult } from '../../shared/backups';
import { BackupProfileService } from './backupProfileService';
import { phoneBackupConfigPath } from './history';

/**
 * Dry run of R1.1 (run by scripts/r11-dryrun.mjs): the same seed and import as the Backups screen's button, against a COPY of the
 * database given by the caller. It reads the real history files read only from the T7 (found by its identity card, never by a
 * letter), writes only to the copy, and prints the counts. It refuses the real database.
 */

const norm = (p: string): string => path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase();

/** The app's own data folder by its name: "...\Backup Hub\data" or "...\BackupHub\data" (the default is below %APPDATA%). Never a target of a dry run. */
const REAL_DATA_FOLDER_NAME = /\\backup ?hub\\data(\\|$)/;

/** A reason when this path is (or is inside the folder of) the real database, else null. */
export function refuseRealDatabase(dbPath: string, realDir?: string): string | null {
  const p = norm(dbPath);
  const dir = realDir === undefined ? null : norm(realDir);
  if (REAL_DATA_FOLDER_NAME.test(p) || (dir !== null && (p === dir || p.startsWith(dir + '\\')))) return 'This is the real database folder. A dry run only ever works on a copy. Nothing was done.';
  return null;
}

export interface DryRunOptions {
  /** The copy of the database. */
  dbPath: string;
  /** The T7's root, such as "F:\\". Left out: every drive letter is tried and the one whose identity card is named T7 is used. */
  t7Root?: string | undefined;
  /** PhoneBackup's settings file. Left out: found below the OneDrive folder the database knows. */
  configPath?: string | undefined;
  /** Run it a second time and show that nothing changed. */
  repeat?: boolean | undefined;
  print: (line: string) => void;
}

async function findT7Root(print: (line: string) => void): Promise<{ root: string; cardId: string; cardName: string } | null> {
  const found: { root: string; cardId: string; cardName: string }[] = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
    const root = String.fromCharCode(c) + ':\\';
    if (!fs.existsSync(root)) continue;
    const card = await readDriveCard(root, 3000);
    if (card.status === 'ok' && card.card.name.trim().toLowerCase() === T7_NAME.toLowerCase()) found.push({ root, cardId: card.card.id, cardName: card.card.name });
  }
  if (found.length !== 1) {
    print(found.length === 0 ? 'No plugged-in drive has an identity card named T7.' : 'More than one plugged-in drive has an identity card named T7.');
    return null;
  }
  return found[0]!;
}

const when = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC)');

function printResult(print: (line: string) => void, r: HistoryResult): void {
  if (!r.ok) {
    print('NOT BROUGHT IN: ' + r.message);
    return;
  }
  print('Made: ' + (r.made.join(', ') || 'nothing') + '. Already there: ' + (r.alreadyThere.join(', ') || 'nothing') + '.');
  for (const l of r.lines) {
    print(l.backup + ': ' + (l.ok ? 'rows in ' + l.rowsIn + ', linked ' + l.linked + ', loose ' + l.loose + ', stale ' + l.stale : 'NOT BROUGHT IN: ' + l.message));
    for (const s of l.staleReasons) print('    stale ' + s.count + ': ' + s.reason + (s.examples.length ? ' e.g. ' + s.examples.join(' | ') : ''));
  }
  print('Totals: rows in ' + r.totals.rowsIn + ', linked ' + r.totals.linked + ', loose ' + r.totals.loose + ', stale ' + r.totals.stale);
  print('Spare: ' + r.spare.inHistory + ' rows in the history, ' + r.spare.marked + ' marked kept only on the Seagate, ' + r.spare.stillShown + ' still shown as on the T7');
  for (const n of r.notes) print('Note: ' + n);
}

function snapshot(db: Db): Record<string, number> {
  const one = (sql: string): number => db.prepare(sql).pluck().get() as number;
  return {
    files: one('SELECT count(*) FROM files'),
    filesWithOrigin: one('SELECT count(*) FROM files WHERE origin_file_id IS NOT NULL'),
    imported: one("SELECT count(*) FROM files WHERE verified_how = 'imported'"),
    keptOnSeagate: one("SELECT count(*) FROM files WHERE gone_reason = 'kept_only_on_other_drive'"),
    phoneRows: one("SELECT count(*) FROM files WHERE place_id IN (SELECT id FROM places WHERE kind = 'phone')"),
    backups: one('SELECT count(*) FROM backup_profiles'),
    backupsOff: one('SELECT count(*) FROM backup_profiles WHERE enabled = 0'),
    folders: one('SELECT count(*) FROM backup_destinations'),
    exclusions: one('SELECT count(*) FROM backup_exclusions'),
    historyImports: one('SELECT count(*) FROM ledger_imports'),
  };
}

/** Returns the exit code. */
export async function runDryRun(options: DryRunOptions): Promise<number> {
  const { print } = options;
  const refusal = refuseRealDatabase(options.dbPath);
  if (refusal) {
    print(refusal);
    return 2;
  }
  if (!fs.existsSync(options.dbPath)) {
    print('The copy of the database was not found: ' + options.dbPath);
    return 2;
  }
  const t7 = options.t7Root ? { root: options.t7Root, cardId: '', cardName: '' } : await findT7Root(print);
  if (!t7) return 3;
  const card = await readDriveCard(t7.root, 3000);
  if (card.status !== 'ok') {
    print('The drive ' + t7.root + ' has no usable identity card. Nothing was done.');
    return 3;
  }
  print('T7 found by its identity card: "' + card.card.name + '" (' + card.card.id + '), at ' + t7.root + ' right now');

  const db = openDatabase(options.dbPath);
  try {
    const migrated = runMigrations(db);
    print('Schema of the copy: ' + JSON.stringify(migrated).slice(0, 200));
    const place = db.prepare("SELECT id, label, last_looked_at FROM places WHERE id = ? AND kind = 'drive'").get(card.card.id) as { id: string; label: string; last_looked_at: number | null } | undefined;
    if (!place) {
      print("The copy of the database does not know a drive with this card's id. Nothing was done.");
      return 3;
    }
    const configPath = options.configPath ?? phoneBackupConfigPath();
    const service = new BackupProfileService({
      db,
      connectedDrives: () => [{ placeId: card.card.id, root: t7.root, label: card.card.name }],
      phoneBackupConfig: () => configPath,
    });

    print('');
    print('How old is the copy\'s file list of the T7?');
    const newest = db.prepare('SELECT max(last_seen_at) FROM files WHERE place_id = ?').pluck().get(card.card.id) as number | null;
    print('  The T7 was last checked at: ' + when(place.last_looked_at) + '; newest file row seen: ' + when(newest) + '; copy of the database written: ' + when(fs.statSync(options.dbPath).mtimeMs));
    const ddFolder = path.join(t7.root, 'MyData', 'DDriveBackup', 'DDrive-29Jun26');
    if (fs.existsSync(ddFolder)) print('  The DDrive-29Jun26 folder on the T7 was last changed at: ' + when(fs.statSync(ddFolder).mtimeMs) + ' (Spare was removed then)');
    print('  Rows the copy has for the T7: ' + (db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get(card.card.id) as number));

    print('');
    const plan = service.historyPlan();
    if (!plan.ok) {
      print('PLAN: ' + plan.message);
      return 4;
    }
    print('WHAT WOULD BE READ on ' + plan.driveLabel + ':');
    for (const f of plan.files) print('  ' + f.backup + ': ' + f.path + (f.found ? ', ' + f.bytes + ' bytes, written ' + when(f.modifiedAt) : ' (not found)'));
    print('  settings: ' + plan.settingsPath);
    print('  backups to make: ' + (plan.newBackups.join(', ') || 'none'));
    if (plan.stop) {
      print('STOP: ' + plan.stop);
      return 4;
    }

    print('');
    print('BEFORE: ' + JSON.stringify(snapshot(db)));
    const started = Date.now();
    const first = await service.bringInHistory();
    print('RUN 1 (' + Math.round((Date.now() - started) / 1000) + ' s):');
    printResult(print, first);
    const afterFirst = snapshot(db);
    print('AFTER 1: ' + JSON.stringify(afterFirst));
    if (!first.ok) return 5;
    if (options.repeat) {
      const t2 = Date.now();
      const second = await service.bringInHistory();
      print('RUN 2 (' + Math.round((Date.now() - t2) / 1000) + ' s):');
      printResult(print, second);
      const afterSecond = snapshot(db);
      print('AFTER 2: ' + JSON.stringify(afterSecond));
      const same = JSON.stringify(afterFirst) === JSON.stringify(afterSecond);
      print(same ? 'REPEAT: the second run changed no count (no duplicates).' : 'REPEAT: THE COUNTS CHANGED BETWEEN RUN 1 AND RUN 2.');
      if (!same) return 6;
    }
    return 0;
  } finally {
    db.close();
  }
}
