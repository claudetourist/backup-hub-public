/**
 * "Why?" on a file (PLAN.md section 3b): one click explains where each copy of the file is and how it was checked, whether one of the
 * person's choices or a built-in filter leaves it out, whether it counts as safe for Free up phone space (and what is missing if not),
 * and what happened to it and when. Read only: it asks the index and nothing else (no phone, no drive, no file is opened) and writes
 * nothing. Every query goes through an existing index (the file's id, `origin_file_id`, the checksum, the checksum of Google, the
 * place and path), so one file takes a few milliseconds on a catalog of two million rows (why.test.ts measures it).
 * Words: only plain ones; the names of choices and filters come from shared/rules.ts and shared/phoneBackup.ts, the same as the preview.
 */
import { LEFT_OUT_WORDS } from '../../shared/phoneBackup';
import { ruleWords } from '../../shared/rules';
import type { WhyLine, WhyRequest, WhyResult, WhySection } from '../../shared/decisions';
import { checkedWords, dayWords, goneWords } from '../../shared/whyWords';
import { parseFilters } from '../backupProfiles/filters';
import { phoneCleanDestinations } from '../cleanup/phoneRule';
import type { Db } from '../db';
import { leftOutBy } from '../phoneBackup/filterModel';
import { RulesStore } from '../rules/rulesStore';
import { relOfRulePath, resolveSourcePlace, rulePathOf } from '../folderBackup/folderPaths';
import { KEEP_SYNC_KEY } from '../../shared/folderBackup';

interface FileRow {
  id: number;
  place_id: string;
  rel_path: string;
  size: number | null;
  sha256: string | null;
  md5: string | null;
  first_seen_at: number;
  last_seen_at: number;
  gone_at: number | null;
  gone_reason: string | null;
  origin_file_id: number | null;
  backup_run_id: number | null;
  verified_at: number | null;
  verified_how: string | null;
  place_kind: string;
  place_label: string;
}

const COLUMNS = `f.id, f.place_id, f.rel_path, f.size, f.sha256, f.md5, f.first_seen_at, f.last_seen_at, f.gone_at, f.gone_reason, f.origin_file_id, f.backup_run_id, f.verified_at, f.verified_how, p.kind AS place_kind, p.label AS place_label`;
const FROM = 'FROM files f JOIN places p ON p.id = f.place_id';
/** At most this many other copies are looked up and at most this many are named (the rest are counted). */
export { checkedWords, dayWords, goneWords };
const COPY_LIMIT = 50;
const NAMED_LIMIT = 12;

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const folderOf = (rel: string): string => {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
};
/** The folder in plain words. A phone's paths begin with "sdcard/": that is the phone's own storage, so it is left off. */
const folderWords = (row: FileRow): string => {
  const folder = folderOf(row.rel_path);
  const shown = row.place_kind === 'phone' ? folder.replace(/^sdcard\/?/, '') : folder;
  return shown === '' ? 'the top folder' : shown;
};
const whereWords = (row: FileRow): string => (row.place_kind === 'phone' ? `On the phone, in ${folderWords(row)}` : row.place_kind === 'gdrive' ? `In Google (${row.place_label}), in ${folderWords(row)}` : `On ${row.place_label}, in ${folderWords(row)}`);

const line = (text: string, tone: WhyLine['tone'] = 'quiet'): WhyLine => ({ text, tone });

export interface WhyDeps {
  db: Db;
  now?: () => number;
}

/** The folder backup that backs up this file's folder (its name, id and the path below the folder), or null. A few backups, so one place lookup each. */
function folderBackupOf(db: Db, row: { place_id: string; place_kind: string; rel_path: string }): { id: number; name: string; below: string } | null {
  if (row.place_kind === 'phone' || row.place_kind === 'drive' || row.place_kind === 'gdrive') return null;
  const backups = db.prepare("SELECT id, name, source_root FROM backup_profiles WHERE source_kind = 'folder' AND import_key IS NOT ?").all(KEEP_SYNC_KEY) as { id: number; name: string; source_root: string }[];
  for (const b of backups) {
    const place = resolveSourcePlace(db, b.source_root);
    if (place === null || place.placeId !== row.place_id) continue;
    const prefix = place.relBase === '' ? '' : place.relBase + '/';
    if (row.rel_path.toLowerCase().startsWith(prefix.toLowerCase()) && row.rel_path.length > prefix.length) return { id: b.id, name: b.name, below: row.rel_path.slice(prefix.length) };
  }
  return null;
}

/** The id of the file a request names (null when Backup Hub has not seen it). */
export function resolveWhyRequest(db: Db, request: WhyRequest): number | null {
  if ('fileId' in request) return Number.isInteger(request.fileId) && request.fileId > 0 ? request.fileId : null;
  if (!Number.isInteger(request.backupId) || request.backupId <= 0 || typeof request.phonePath !== 'string' || !request.phonePath.startsWith('/') || request.phonePath.length > 4000) return null;
  const profile = db.prepare('SELECT source_kind, source_place_id, source_root, import_key FROM backup_profiles WHERE id = ?').get(request.backupId) as { source_kind: string; source_place_id: string | null; source_root: string; import_key: string | null } | undefined;
  if (!profile) return null;
  if (profile.source_kind === 'folder') {
    // A folder backup's file is named "/source/<path below the folder>": its row is in the place that holds the folder.
    const below = relOfRulePath(request.phonePath);
    const place = below === null || profile.import_key === KEEP_SYNC_KEY ? null : resolveSourcePlace(db, profile.source_root);
    if (below === null || place === null) return null;
    const rel = place.relBase === '' ? below : `${place.relBase}/${below}`;
    return (db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(place.placeId, rel) as number | undefined) ?? null;
  }
  if (profile.source_kind !== 'phone' || !profile.source_place_id) return null;
  return (db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(profile.source_place_id, request.phonePath.slice(1)) as number | undefined) ?? null;
}

export function whyFile(deps: WhyDeps, request: WhyRequest): WhyResult {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const fileId = resolveWhyRequest(db, request);
  if (fileId === null) return { ok: false, message: 'Backup Hub has not seen this file yet, so there is nothing to explain. Nothing was changed.' };
  const me = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE f.id = ?`).get(fileId) as FileRow | undefined;
  if (!me) return { ok: false, message: 'That file is not on the list any more. Nothing was changed.' };

  // The original: a phone file is its own original; a copy points at the file it was made from.
  let source: FileRow | null = me.place_kind === 'phone' ? me : null;
  if (source === null && me.origin_file_id !== null) source = (db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE f.id = ?`).get(me.origin_file_id) as FileRow | undefined) ?? null;
  const anchor = source ?? me;

  // Every copy: what was made from the original, and what has the same content (checksum). One indexed query each.
  const set = new Map<number, FileRow>([[me.id, me]]);
  if (source) set.set(source.id, source);
  const add = (rows: FileRow[]): void => {
    for (const r of rows) if (!set.has(r.id)) set.set(r.id, r);
  };
  add(db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE f.origin_file_id = ? ORDER BY f.id LIMIT ?`).all(anchor.id, COPY_LIMIT) as FileRow[]);
  const sha = anchor.sha256 ?? me.sha256;
  if (sha !== null && (anchor.size ?? me.size ?? 0) > 0) add(db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE f.sha256 = ? AND f.gone_at IS NULL ORDER BY f.id LIMIT ?`).all(sha, COPY_LIMIT) as FileRow[]);
  const md5s = new Set([...set.values()].map((r) => r.md5).filter((m): m is string => m !== null));
  const size = anchor.size ?? me.size;
  const googleMatch = new Set<number>();
  if (size !== null && size > 0) {
    for (const md5 of md5s) {
      const rows = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE f.md5 = ? AND f.size = ? AND f.gone_at IS NULL AND p.kind = 'gdrive' ORDER BY f.id LIMIT ?`).all(md5, size, COPY_LIMIT) as FileRow[];
      for (const r of rows) googleMatch.add(r.id);
      add(rows);
    }
  }
  if (me.place_kind === 'gdrive' && me.md5 !== null && me.size !== null) googleMatch.add(me.id);
  const rows = [...set.values()];
  const live = rows.filter((r) => r.gone_at === null);
  const gone = rows.filter((r) => r.gone_at !== null);

  const sections: WhySection[] = [];

  // 1. Where each copy is and how it was checked.
  const where: WhyLine[] = [];
  const ordered = live.toSorted((a, b) => (a.place_kind === 'phone' ? 0 : 1) - (b.place_kind === 'phone' ? 0 : 1) || a.id - b.id);
  for (const r of ordered.slice(0, NAMED_LIMIT)) {
    const prefix = r.id === me.id ? 'This file: ' : '';
    if (r.place_kind === 'phone') where.push(line(`${prefix}${whereWords(r)}: the original`, 'quiet'));
    else {
      const how = checkedWords(r, googleMatch.has(r.id));
      where.push(line(`${prefix}${whereWords(r)}: ${how.text}`, how.tone));
    }
  }
  if (ordered.length > NAMED_LIMIT) where.push(line(`and ${ordered.length - NAMED_LIMIT} more copies`));
  if (live.length === 0) where.push(line('Backup Hub has no copy of this file that is still there.', 'bad'));
  sections.push({ title: 'Where it is and how it was checked', lines: where });

  // 2. Is it left out of the backup? Only a phone file can be.
  const backup = source && source.place_kind === 'phone' ? (db.prepare("SELECT id, name, filters_json FROM backup_profiles WHERE source_place_id = ? AND source_kind = 'phone' LIMIT 1").get(source.place_id) as { id: number; name: string; filters_json: string } | undefined) : undefined;
  const choiceLines: WhyLine[] = [];
  // A file of a folder backup (OneDrive, a data folder ...): the backup whose folder holds it.
  const folder = backup === undefined ? folderBackupOf(db, source ?? me) : null;
  if (backup && source) {
    const path = '/' + source.rel_path;
    const rule = new RulesStore(db, now).compiled(backup.id).match(path);
    if (rule !== null) {
      choiceLines.push(
        rule.choice === 'leave_out'
          ? line(`Left out of ${backup.name} by your choice: ${ruleWords(rule)}, saved ${dayWords(rule.createdAt)}. It is not copied. Remove the choice in Your choices to change that.`, 'warn')
          : line(`Included in ${backup.name} by your choice: ${ruleWords(rule)}, saved ${dayWords(rule.createdAt)}. A built-in filter would otherwise leave it out.`, 'ok'),
      );
    } else {
      // A folder that holds a ".nomedia" file leaves its files out: look for that file in each folder above this one (one lookup each).
      const dirs: string[] = [];
      for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) dirs.push(path.slice(0, i + 1));
      const hasNomedia = db.prepare('SELECT 1 FROM files WHERE place_id = ? AND rel_path = ? AND gone_at IS NULL');
      const nomediaDirs = dirs.filter((d) => hasNomedia.get(source.place_id, d.slice(1) + '.nomedia') !== undefined);
      const filter = leftOutBy(path, parseFilters(backup.filters_json), nomediaDirs);
      choiceLines.push(
        filter !== null
          ? line(`Left out of ${backup.name} by a built-in filter: ${LEFT_OUT_WORDS[filter]}. "Always include" in Your choices brings it back.`, 'warn')
          : line(`Nothing leaves it out: ${backup.name} offers it for copying.`, 'ok'),
      );
    }
  } else if (folder !== null) {
    const rule = new RulesStore(db, now).compiled(folder.id).match(rulePathOf(folder.below));
    choiceLines.push(
      rule === null
        ? line(`Nothing leaves it out: ${folder.name} offers it for copying.`, 'ok')
        : rule.choice === 'leave_out'
          ? line(`Left out of ${folder.name} by your choice: ${ruleWords(rule)}, saved ${dayWords(rule.createdAt)}. It is not copied. Remove the choice in Your choices to change that.`, 'warn')
          : line(`Included in ${folder.name} by your choice: ${ruleWords(rule)}, saved ${dayWords(rule.createdAt)}.`, 'ok'),
    );
  } else if (me.place_kind === 'phone') choiceLines.push(line('This phone has no backup in Backup Hub, so no choice or filter applies to this file.'));
  else choiceLines.push(line('This file is not part of a phone backup, so none of your choices or filters apply to it.'));
  sections.push({ title: 'Is it left out?', lines: choiceLines });

  // 3. Does it count as safe for Free up phone space?
  const safeLines: WhyLine[] = [];
  if (!source || source.place_kind !== 'phone') safeLines.push(line('Free up phone space only looks at files on the phone; this file is not on a phone.'));
  else if (source.gone_at !== null) safeLines.push(line('It is not on the phone any more, so there is nothing to free up.'));
  else {
    const dests = phoneCleanDestinations(db);
    const missing: string[] = [];
    const parts: WhyLine[] = [];
    for (const d of dests) {
      const label = d.kind === 'google' ? 'Google' : d.label;
      const places = d.kind === 'google' ? d.accounts : d.placeId === null ? [] : [d.placeId];
      const mine = live.filter((r) => places.includes(r.place_id));
      const checked = mine.find((r) => (r.place_kind === 'gdrive' ? googleMatch.has(r.id) : r.verified_how === 'read_both'));
      if (checked) parts.push(line(`${label}: a checked copy`, 'ok'));
      else if (mine.length > 0) {
        missing.push(label);
        parts.push(line(`${label}: a copy, but ${checkedWords(mine[0]!, false).text}`, 'warn'));
      } else {
        missing.push(label);
        parts.push(line(`${label}: no copy`, 'bad'));
      }
    }
    safeLines.push(
      missing.length === 0
        ? line('Yes. It has a checked copy on all three: it counts as safe for Free up phone space.', 'ok')
        : line(`Not yet. Free up phone space needs a checked copy on ${dests.map((d) => (d.kind === 'google' ? 'Google' : d.label)).join(', ')}. Missing: ${missing.join(', ')}.`, 'warn'),
      ...parts,
    );
  }
  sections.push({ title: 'Free up phone space', lines: safeLines });

  // 4. What happened to it.
  const history: WhyLine[] = [line(`First seen on ${dayWords(anchor.first_seen_at)}.`)];
  if (anchor.place_kind === 'phone' && anchor.gone_at === null) history.push(line(`Last seen on the phone on ${dayWords(anchor.last_seen_at)}.`));
  for (const r of rows) {
    if (r.backup_run_id !== null && r.origin_file_id !== null) {
      const startedAt = db.prepare('SELECT started_at FROM backup_runs WHERE id = ?').pluck().get(r.backup_run_id) as number | undefined;
      if (startedAt !== undefined) history.push(line(`Copied to ${r.place_label} by the backup of ${dayWords(startedAt)}.`));
    }
  }
  for (const r of gone) history.push(line(`${r.place_kind === 'phone' ? 'The phone file' : `The copy on ${r.place_label}`} is gone: noticed on ${dayWords(r.gone_at!)}; ${goneWords(r.gone_reason)}.`, 'warn'));
  const problems = db.prepare(`SELECT kind, detected_at, state FROM file_problems WHERE file_id IN (SELECT value FROM json_each(?)) ORDER BY detected_at`).all(JSON.stringify(rows.map((r) => r.id))) as { kind: string; detected_at: number; state: string }[];
  for (const p of problems) {
    if (p.kind === 'copy_differs') history.push(line(`A copy was found different from the phone's file on ${dayWords(p.detected_at)}${p.state === 'open' ? ' and is waiting for your decision.' : p.state === 'acknowledged' ? '; you chose to copy it again at the next backup.' : '; it is settled.'}`, p.state === 'open' ? 'bad' : 'quiet'));
  }
  sections.push({ title: 'What happened to it', lines: history });

  const names = [...new Set(live.map((r) => (r.place_kind === 'phone' ? 'the phone' : r.place_kind === 'gdrive' ? 'Google' : r.place_label)))];
  const headline = live.length === 0 ? 'Backup Hub has no copy of it that is still there' : `${live.length === 1 ? 'One copy' : `${live.length} copies`}: ${names.join(', ')}`;
  return { ok: true, name: baseName(me.rel_path), headline, sections };
}
