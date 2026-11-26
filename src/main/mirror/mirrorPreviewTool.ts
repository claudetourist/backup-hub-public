import Database from 'better-sqlite3';
import { hashUnbuffered } from '../localCopy/directRead';
import { finishSync } from '../sliceWork';
import { pairOf } from './mirrorPairs';
import { checkScanSteps, scanPairSteps } from './mirrorScan';
import { MIRROR_CHECK_GROUPS, MIRROR_CHECK_GROUP_WORDS, checkGroupOf, estimateCheckSeconds } from '../../shared/mirrorCheck';

/**
 * R1.3 proof helper (run by scripts/r13-preview.mjs): prints what "Bring the second drive up to date" would copy for one backup and what "Check old copies" would read, from the file list
 * (the index, opened READ ONLY; it is as fresh as the last check of each drive: the screen's look refreshes it). It copies nothing, records nothing and
 * writes nothing anywhere. With `--hash` and the two drive roots it also READS some of the files that are already on the second drive with the same size
 * (the second drive's file, and the first drive's only when its checksum is not known; without the Windows cache; at most `--limit` of them) and says how many are the same and how many are different.
 */
export interface MirrorPreviewOptions {
  dbPath: string;
  /** A backup's number or name; the first backup that has a second drive when left out. */
  backup?: string | undefined;
  /** Print every path to copy (default: the 20 largest). */
  all?: boolean;
  /** Read and compare some of the same-size files that exist on the second drive (needs both roots). */
  hash?: boolean;
  srcRoot?: string | undefined;
  dstRoot?: string | undefined;
  limit?: number | undefined;
  print: (line: string) => void;
}

const gb = (n: number): string => `${(n / 1e9).toFixed(2)} GB`;
const when = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16));

export async function runMirrorPreview(o: MirrorPreviewOptions): Promise<number> {
  const { print } = o;
  const db = new Database(o.dbPath, { readonly: true, fileMustExist: true });
  try {
    const ids = db.prepare('SELECT id, name FROM backup_profiles WHERE enabled = 1 ORDER BY id').all() as { id: number; name: string }[];
    const wanted = o.backup === undefined ? ids : ids.filter((r) => String(r.id) === o.backup || r.name.toLowerCase() === o.backup!.toLowerCase());
    const pair = wanted.map((r) => pairOf(db as never, r.id)).find((p) => p !== null) ?? null;
    if (!pair) {
      print('No such backup with a second drive in this database. (Add "Also keep a copy" to the backup in the app first.)');
      return 2;
    }
    const looked = db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck();
    print(`Backup: ${pair.backupName} (${pair.backupId}). First drive ${pair.srcLabel} (${pair.srcPlaceId}), second drive ${pair.dstLabel} (${pair.dstPlaceId}), folder ${pair.srcRoot}`);
    print(`File list as of: ${pair.srcLabel} last checked ${when(looked.get(pair.srcPlaceId) as number | null)}, ${pair.dstLabel} last checked ${when(looked.get(pair.dstPlaceId) as number | null)}. Nothing is read from the drives unless --hash is given.`);
    const scan = finishSync(scanPairSteps(db as never, pair, 0));
    const sum = (items: { size: number }[]): number => items.reduce((s, i) => s + i.size, 0);
    const own = scan.copy.filter((i) => !i.expected);
    print(`TO COPY to ${pair.dstLabel}: ${scan.copy.length} files, ${sum(scan.copy)} bytes (${gb(sum(scan.copy))}). ${own.length} of them have no phone checksum (the ${pair.srcLabel}'s own checksum is read and recorded; flagged in the report).`);
    print(`ALREADY on ${pair.dstLabel} with the same size, not checked yet: ${scan.same.files} files, ${gb(scan.same.bytes)}. The COPY does not read them ("Check old copies" does, see below); ${scan.proven} more are proven already.`);
    print(`ALREADY on ${pair.dstLabel} with ANOTHER size: ${scan.different.length} files. Never replaced: each becomes a "Needs your decision" case.`);
    print(`Already asked about (a damaged copy or a different file, open or seen): ${scan.knownProblems} files. Not offered again.`);
    const check = finishSync(checkScanSteps(db as never, pair, 0));
    const one = check.items.filter((i) => i.sha256 !== null);
    const two = check.items.filter((i) => i.sha256 === null);
    const secs = estimateCheckSeconds({ files: check.items.length, bytes: sum(check.items) }, { files: two.length, bytes: sum(two) });
    print(`CHECK OLD COPIES on ${pair.dstLabel}: ${check.items.length} files, ${gb(sum(check.items))}; ${one.length} need ONE read (the ${pair.srcLabel}'s checksum is known), ${two.length} need TWO. Rough time: about ${secs < 5400 ? `${Math.max(1, Math.round(secs / 60))} min` : `${(secs / 3600).toFixed(1)} h`}${secs >= 7200 ? ' (fine to leave overnight)' : ''}. A stop part-way keeps what was proven.`);
    for (const g of MIRROR_CHECK_GROUPS) {
      const of = check.items.filter((i) => checkGroupOf(i.rel) === g);
      print(`  ${MIRROR_CHECK_GROUP_WORDS[g]}: ${of.length} files, ${gb(sum(of))}`);
    }
    const known = scan.copy.filter((i) => i.sha256 !== null).length;
    print(`Checksum known for ${known} of the ${scan.copy.length} files to copy; a ${pair.srcLabel} file that does not match it is NOT copied (it becomes "This ${pair.srcLabel} copy looks damaged").`);
    const shown = o.all === true ? scan.copy : scan.copy.toSorted((a, b) => b.size - a.size || (a.rel < b.rel ? -1 : 1)).slice(0, 20);
    print(o.all === true ? '--- every file to copy: size|path|checksum from phone or own ---' : '--- the 20 largest files to copy: size|path|checksum from phone or own ---');
    for (const i of shown) print(`${i.size}|${i.rel}|${i.sha256 === null ? 'unknown (read at copy)' : i.expected ? 'phone' : 'own'}`);
    if (scan.different.length > 0) {
      print('--- first different-size files ---');
      for (const i of scan.different.slice(0, 20)) print(`${i.size}|${i.rel}`);
    }
    if (o.hash === true) {
      if (!o.srcRoot || !o.dstRoot) {
        print('--hash needs --t7 <root of the first drive> and --seagate <root of the second drive>.');
        return 2;
      }
      const limit = o.limit ?? 200;
      let same = 0;
      let different = 0;
      let unreadable = 0;
      const join = (root: string, rel: string): string => `${root.replace(/[\\/]+$/, '')}\\${pair.srcRoot.split('/').join('\\')}\\${rel.split('/').join('\\')}`;
      for (const i of check.items.slice(0, limit)) {
        try {
          const a = i.sha256 ?? (await hashUnbuffered(join(o.srcRoot, i.rel))).sha256;
          const b = await hashUnbuffered(join(o.dstRoot, i.rel));
          if (a === b.sha256) same += 1;
          else different += 1;
        } catch {
          unreadable += 1;
        }
      }
      print(`READ AND COMPARED ${Math.min(limit, check.items.length)} of ${check.items.length} same-size files: ${same} same, ${different} different, ${unreadable} could not be read.`);
    }
    return 0;
  } finally {
    db.close();
  }
}
