/**
 * The index side of a look (R1.0a): reads the rows the compare needs and, only for a look that passed the guard, records what it saw.
 * It writes only the phone's own rows in `files` (new, changed in place, came back, gone with a reason). Nothing is ever deleted, and no
 * row of a destination is touched: a backed-up version stays as it is.
 */
import type { Db } from '../db';
import { upsertFilesSliced } from '../listing/fileStore';
import { prefixUpperBound } from '../listing/skipRules';
import { finishSync, sliceClock, turn, type Steps } from '../sliceWork';
import { phoneRel, type CompareResult, type CopyRow, type DestinationRef, type IndexedPhoneFile } from './compare';

interface FileRow {
  id: number;
  rel_path: string;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  gone_at: number | null;
}

/** Rows read per query of the phone index and ids asked about per query of the copies (a few milliseconds each). */
const PAGE_ROWS = 2000;

/** Every row of the phone place below the folders (gone rows too: a file that comes back is found by its old row). */
export function loadPhoneIndex(db: Db, placeId: string, folders: readonly string[]): IndexedPhoneFile[] {
  return finishSync(loadPhoneIndexSteps(db, placeId, folders));
}

/** `loadPhoneIndex` in slices: the rows are read a page at a time, in path order (see sliceWork.ts). The answer is the same. */
export function* loadPhoneIndexSteps(db: Db, placeId: string, folders: readonly string[]): Steps<IndexedPhoneFile[]> {
  const first = db.prepare(`SELECT id, rel_path, size, mtime, sha256, gone_at FROM files WHERE place_id = ? AND rel_path >= ? AND rel_path < ? ORDER BY rel_path LIMIT ${PAGE_ROWS}`);
  const after = db.prepare(`SELECT id, rel_path, size, mtime, sha256, gone_at FROM files WHERE place_id = ? AND rel_path > ? AND rel_path < ? ORDER BY rel_path LIMIT ${PAGE_ROWS}`);
  const out: IndexedPhoneFile[] = [];
  const seen = new Set<number>();
  for (const folder of folders) {
    const prefix = `${phoneRel(folder).replace(/\/+$/, '')}/`;
    const hi = prefixUpperBound(prefix);
    let page = first.all(placeId, prefix, hi) as FileRow[];
    for (;;) {
      for (const r of page) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, relPath: r.rel_path, size: r.size, mtimeMs: r.mtime, sha256: r.sha256, goneAt: r.gone_at });
      }
      if (page.length < PAGE_ROWS) break;
      yield;
      page = after.all(placeId, page[page.length - 1]!.rel_path, hi) as FileRow[];
    }
  }
  return out;
}

/** The rows that point at these phone rows (every backed-up version, at every destination). */
export function loadCopies(db: Db, phoneRowIds: readonly number[]): CopyRow[] {
  return finishSync(loadCopiesSteps(db, phoneRowIds));
}

/** `loadCopies` in slices: the phone rows are asked about `PAGE_ROWS` at a time (see sliceWork.ts). The answer is the same. */
export function* loadCopiesSteps(db: Db, phoneRowIds: readonly number[]): Steps<CopyRow[]> {
  const stmt = db.prepare(
    `SELECT id, place_id, rel_path, size, mtime, sha256, expected_sha256, origin_file_id, verified_how, gone_at
     FROM files WHERE origin_file_id IN (SELECT value FROM json_each(?))`,
  );
  const out: CopyRow[] = [];
  for (let i = 0; i < phoneRowIds.length; i += PAGE_ROWS) {
    const rows = stmt.all(JSON.stringify(phoneRowIds.slice(i, i + PAGE_ROWS))) as (FileRow & { place_id: string; expected_sha256: string | null; origin_file_id: number; verified_how: string | null })[];
    for (const r of rows) {
      out.push({
        id: r.id,
        placeId: r.place_id,
        relPath: r.rel_path,
        size: r.size,
        mtimeMs: r.mtime,
        sha256: r.sha256,
        expectedSha256: r.expected_sha256,
        originFileId: r.origin_file_id,
        verifiedHow: r.verified_how,
        goneAt: r.gone_at,
      });
    }
    yield;
  }
  return out;
}

/** A backup's destinations in order (1 = copied from the phone, 2 = mirrored from 1, ...). */
export function loadDestinations(db: Db, backupProfileId: number): DestinationRef[] {
  return (db.prepare('SELECT id, place_id, root, position FROM backup_destinations WHERE backup_profile_id = ? AND enabled = 1 ORDER BY position, id').all(backupProfileId) as {
    id: number;
    place_id: string;
    root: string;
    position: number;
  }[]).map((r) => ({ id: r.id, placeId: r.place_id, root: r.root, position: r.position }));
}

export interface RecordedLook {
  added: number;
  changed: number;
  cameBack: number;
  markedGone: number;
}

/** Rows touched per transaction when the second half of a look is recorded (250 gone rows took about 50 ms on a big table). */
const GONE_CHUNK = 250;

/**
 * Records a look that passed the guard: new and changed files get their row (a changed row is updated in place and loses its old
 * checksum), a file that came back loses its gone mark, files not seen are marked gone with the reason 'gone_from_source'.
 * Call it ONLY with the compare of an `ok` outcome; an incomplete look never reaches here.
 *
 * It writes in short slices (a look of 60,000 new files in one transaction froze the window for seconds), so a stop part-way is possible
 * (the person quits, a job is aborted). The ORDER keeps that harmless: first every new, changed and came-back row (each is a true fact
 * about a file that is on the phone), then the came-back marks, then the gone marks, and `last_looked_at` last. A look that stops
 * before the gone marks marks nothing gone; one that stops inside them has marked only files the complete listing really did not show.
 * The next look recomputes everything from the index, so nothing is lost or invented. Never deletes a row.
 */
export async function recordLook(db: Db, placeId: string, compare: CompareResult, now: number, pause: () => Promise<void> = turn): Promise<RecordedLook> {
  const wanted = compare.entries.filter((e) => e.kind !== 'same');
  await upsertFilesSliced(
    db,
    placeId,
    wanted.map((e) => ({ relPath: e.relPath, size: e.size, mtimeMs: e.mtimeSec * 1000, cloudOnly: false })),
    now,
    false,
    pause,
  );
  const due = sliceClock(pause);
  const clearReason = db.prepare("UPDATE files SET gone_reason = NULL WHERE id = ? AND gone_reason = 'gone_from_source'");
  const cameBack = wanted.filter((e) => e.kind === 'came_back' && e.indexId !== null);
  for (let i = 0; i < cameBack.length; i += GONE_CHUNK) {
    db.transaction(() => {
      for (const e of cameBack.slice(i, i + GONE_CHUNK)) clearReason.run(e.indexId);
    })();
    await due();
  }
  const markGone = db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'gone_from_source' WHERE gone_at IS NULL AND id IN (SELECT value FROM json_each(?))");
  let markedGone = 0;
  for (let i = 0; i < compare.gone.length; i += GONE_CHUNK) {
    markedGone += markGone.run(now, JSON.stringify(compare.gone.slice(i, i + GONE_CHUNK).map((r) => r.id))).changes;
    await due();
  }
  db.prepare('UPDATE places SET last_looked_at = ? WHERE id = ?').run(now, placeId);
  return { added: compare.counts.new, changed: compare.counts.changed, cameBack: compare.counts.cameBack, markedGone };
}
