import Database from 'better-sqlite3';
import { AdbClient, type PhoneBackupAdb } from '../adb/adbPort';
import { parseFilters } from '../backupProfiles/filters';
import { evaluateLook } from '../look/lookGuard';
import { loadCopies, loadDestinations, loadPhoneIndex } from '../look/lookStore';
import { LEFT_OUT_WORDS } from '../../shared/phoneBackup';
import { sessionFolderName } from './pathMap';
import { buildPlan, type LooseRow } from './planModel';
import { PHONE_ROOT } from './planJob';
import type { BackupRule } from '../../shared/rules';
import { compileRules } from '../rules/ruleMatcher';
import { RulesStore } from '../rules/rulesStore';

/**
 * R1.2a proof helper (run by scripts/r12-preview.mjs): prints the preview list of a phone backup for comparison with PhoneBackup's
 * --list-pending. It READS the phone (the one fixed listing command, read only) and the index (opened read only); it copies nothing,
 * hashes nothing, records nothing (not even the phone's rows) and writes nothing anywhere.
 */
export interface PreviewToolOptions {
  dbPath: string;
  /** A backup's number or name; the first phone backup when left out. */
  backup?: string | undefined;
  print: (line: string) => void;
  /** Tests pass a fake phone. */
  adb?: PhoneBackupAdb | undefined;
}

export async function runPreviewTool(options: PreviewToolOptions): Promise<number> {
  const { print } = options;
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  const client = options.adb ?? new AdbClient();
  try {
    const rows = db.prepare("SELECT id, name, source_place_id, phone_serial, folder_prefix, filters_json, change_rule FROM backup_profiles WHERE source_kind = 'phone' ORDER BY id").all() as {
      id: number;
      name: string;
      source_place_id: string | null;
      phone_serial: string | null;
      folder_prefix: string;
      filters_json: string;
      change_rule: 'size_and_date' | 'size_or_date';
    }[];
    const profile = options.backup === undefined ? rows[0] : rows.find((r) => String(r.id) === options.backup || r.name.toLowerCase() === options.backup!.toLowerCase());
    if (!profile || profile.phone_serial === null || profile.source_place_id === null) {
      print('No such phone backup in this database.');
      return 2;
    }
    const dest = loadDestinations(db as never, profile.id)[0];
    if (!dest) {
      print('This backup has no drive folder.');
      return 2;
    }
    print(`Backup: ${profile.name} (phone ${profile.phone_serial}), folder ${dest.root} on drive ${dest.placeId}`);
    const devices = await client.devices();
    const mine = devices.find((d) => d.serial === profile.phone_serial);
    if (!mine || mine.state !== 'device') {
      print(`The phone is not ready: ${mine ? mine.state : 'not plugged in'}. Unlock it, allow this computer, and try again.`);
      return 3;
    }
    const look = await client.lookFiles(profile.phone_serial, [PHONE_ROOT], undefined, { allowRoot: true });
    if (!look.complete) {
      print("The phone's file list is NOT complete, so nothing is planned:");
      for (const p of look.problems) print(`  ${p.folder}: ${p.detail}`);
      return 3;
    }
    const indexed = loadPhoneIndex(db as never, profile.source_place_id, look.folders);
    const destinations = loadDestinations(db as never, profile.id);
    const copies = loadCopies(db as never, indexed.map((r) => r.id));
    const outcome = evaluateLook({ look, indexed, destinations, copies, changeRule: profile.change_rule });
    if (!outcome.ok) {
      print(`The look needs a decision: ${outcome.decision.title}. ${outcome.decision.plain}`);
      return 3;
    }
    const ids = new Map(indexed.map((r) => [r.relPath, r.id]));
    // The person's choices (a database made before they existed still has the old never-back-up list: those are file choices).
    const hasRules = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_rules'").get() !== undefined;
    const rules = hasRules
      ? new RulesStore(db).compiled(profile.id)
      : compileRules((db.prepare('SELECT source_path FROM backup_exclusions WHERE backup_profile_id = ?').pluck().all(profile.id) as string[]).map((p, i): BackupRule => ({ id: i + 1, backupId: profile.id, scope: 'file', pattern: p, choice: 'leave_out', destination: null, note: null, createdAt: 0 })));
    const prefix = dest.root.replace(/\/+$/, '') + '/';
    const hi = prefix.slice(0, -1) + '0';
    const stmt = db.prepare('SELECT id, rel_path, size, sha256 FROM files WHERE place_id = ? AND size = ? AND name = ? AND origin_file_id IS NULL AND gone_at IS NULL AND rel_path >= ? AND rel_path < ? ORDER BY id LIMIT 5');
    const looseFor = (name: string, size: number): LooseRow[] => (stmt.all(dest.placeId, size, name, prefix, hi) as { id: number; rel_path: string; size: number; sha256: string | null }[]).map((r) => ({ id: r.id, relPath: r.rel_path, size: r.size, sha256: r.sha256 }));
    const now = new Date();
    const plan = buildPlan({
      entries: outcome.compare.entries,
      filters: parseFilters(profile.filters_json),
      rules,
      root: dest.root,
      sessionFolder: sessionFolderName(profile.folder_prefix, now),
      now,
      rowIdOf: (rel) => ids.get(rel) ?? null,
      taken: new Map(),
      looseFor,
      listedPaths: look.files.map((f) => f.path),
    });
    const c = outcome.compare.counts;
    print(`On the phone: ${look.files.length} files. New ${c.new}, changed ${c.changed}, came back ${c.cameBack}, same ${c.same}, gone from the phone ${c.gone}.`);
    print(`Already backed up at the drive (index): ${plan.alreadyBackedUp}.`);
    const candidates = plan.items.filter((i) => i.candidates.length > 0).length;
    const bytes = plan.items.reduce((s, i) => s + i.size, 0);
    print(`TO COPY: ${plan.items.length} files, ${bytes} bytes (${(bytes / 1e9).toFixed(2)} GB). Of these ${candidates} have a name-and-size match on the drive: PhoneBackup would call them already backed up; the Hub confirms each by checksum (not checked here).`);
    for (const b of plan.leftOut) print(`LEFT OUT: ${b.files.length} files, ${b.bytes} bytes: ${LEFT_OUT_WORDS[b.filter]} in ${b.folder}`);
    if (look.unreadable.length > 0) print(`Refused by the phone (private app folders): ${look.unreadable.length} folders.`);
    print('--- to copy: path|size|mtime (sorted by path, like --list-pending) ---');
    for (const i of plan.items) print(`${i.path}|${i.size}|${i.mtimeSec}|${i.kind}${i.candidates.length > 0 ? '|candidate' : ''}`);
    if (plan.unplaceable.length > 0) print(`Names that cannot be stored on Windows at all: ${plan.unplaceable.length}`);
    return 0;
  } finally {
    db.close();
    await client.killServer();
  }
}
