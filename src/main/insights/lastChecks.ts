import type { Db } from '../db';
import { MIRROR_CHECK_JOB_KIND } from '../../shared/mirrorCheck';
import { PHONE_CHECK_OLD_JOB_KIND } from '../../shared/phoneBackup';
import type { DriveCheckInfo } from '../../shared/insights';

/**
 * The last "Check old copies" per drive label, from the reports the checks kept (a second drive's check, a phone's check against the first
 * drive). A few dozen small reads of finished jobs, never the file list. The newest job wins for a drive.
 */
export function lastChecksByDrive(db: Db): Map<string, DriveCheckInfo> {
  const out = new Map<string, DriveCheckInfo>();
  const jobs = db
    .prepare("SELECT id, kind, finished_at FROM jobs WHERE kind IN (?, ?) AND state IN ('done', 'done_warnings') AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 100")
    .all(MIRROR_CHECK_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND) as { id: number; kind: string; finished_at: number }[];
  const get = db.prepare('SELECT value FROM meta WHERE key = ?').pluck();
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  for (const job of jobs) {
    const mirror = job.kind === MIRROR_CHECK_JOB_KIND;
    const text = get.get((mirror ? 'mirror.checkReport.' : 'phoneBackup.checkOld.report.') + job.id) as string | undefined;
    if (text === undefined) continue;
    try {
      const report = JSON.parse(text) as Record<string, unknown>;
      if (mirror) {
        const complete = report['complete'] !== false;
        const per = new Map<string, DriveCheckInfo>();
        for (const b of (Array.isArray(report['backups']) ? report['backups'] : []) as Record<string, unknown>[]) {
          const label = b['targetLabel'];
          if (typeof label !== 'string' || label === '') continue;
          const sum = per.get(label) ?? { at: job.finished_at, verified: 0, differs: 0, couldNotRead: 0, complete };
          sum.verified += count(b['verified']);
          sum.differs += count(b['differs']);
          sum.couldNotRead += count(b['failed']);
          per.set(label, sum);
        }
        for (const [label, info] of per) if (!out.has(label)) out.set(label, info);
      } else {
        const label = report['driveLabel'];
        if (typeof label !== 'string' || label === '' || out.has(label)) continue;
        const verified = report['verified'] as { files?: unknown } | undefined;
        const unread = (Array.isArray(report['couldNotRead']) ? report['couldNotRead'] : []) as { count?: unknown }[];
        out.set(label, { at: job.finished_at, verified: count(verified?.files), differs: count(report['differCount']), couldNotRead: unread.reduce((s, r) => s + count(r.count), 0), complete: true });
      }
    } catch {
      // An unreadable report says nothing about the drive.
    }
  }
  return out;
}

/** Open problems found by the second drive's checks, per place: damaged copies and copies that differ. Few rows (the table holds the problems only). */
export function openProblemsByPlace(db: Db): Map<string, { damaged: number; differs: number }> {
  const out = new Map<string, { damaged: number; differs: number }>();
  const rows = db
    .prepare("SELECT f.place_id AS place, p.kind AS kind, count(*) AS n FROM file_problems p JOIN files f ON f.id = p.file_id WHERE p.state = 'open' AND p.kind IN ('mirror_damaged', 'mirror_differs') GROUP BY f.place_id, p.kind")
    .all() as { place: string; kind: string; n: number }[];
  for (const r of rows) {
    const entry = out.get(r.place) ?? { damaged: 0, differs: 0 };
    if (r.kind === 'mirror_damaged') entry.damaged += r.n;
    else entry.differs += r.n;
    out.set(r.place, entry);
  }
  return out;
}
