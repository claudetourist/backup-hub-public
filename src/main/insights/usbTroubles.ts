import type { Db } from '../db';
import { MIRROR_COPY_JOB_KIND } from '../../shared/mirror';
import { MIRROR_CHECK_JOB_KIND } from '../../shared/mirrorCheck';
import { USB_TROUBLE_DAYS } from '../../shared/insights';

const DAY_MS = 86_400_000;

/**
 * How many times a copy or a check paused for USB trouble in the last 30 days, per drive label. The jobs' own reports hold the number
 * (`usbPauses`); each is counted for the drives the job wrote to (the report names them). A few dozen small reads, never the file list.
 */
export function usbTroublesByDrive(db: Db, now: number): Map<string, number> {
  const since = now - USB_TROUBLE_DAYS * DAY_MS;
  const out = new Map<string, number>();
  const jobs = db
    .prepare('SELECT id, kind FROM jobs WHERE kind IN (?, ?) AND finished_at >= ? ORDER BY finished_at DESC LIMIT 200')
    .all(MIRROR_COPY_JOB_KIND, MIRROR_CHECK_JOB_KIND, since) as { id: number; kind: string }[];
  const get = db.prepare('SELECT value FROM meta WHERE key = ?').pluck();
  for (const job of jobs) {
    const text = get.get((job.kind === MIRROR_COPY_JOB_KIND ? 'mirror.report.' : 'mirror.checkReport.') + job.id) as string | undefined;
    if (text === undefined) continue;
    try {
      const report = JSON.parse(text) as { usbPauses?: unknown; backups?: { targetLabel?: unknown }[] };
      const pauses = typeof report.usbPauses === 'number' ? report.usbPauses : 0;
      if (pauses <= 0) continue;
      const labels = new Set((report.backups ?? []).map((b) => b.targetLabel).filter((l): l is string => typeof l === 'string' && l !== ''));
      for (const label of labels) out.set(label, (out.get(label) ?? 0) + pauses);
    } catch {
      // An unreadable report counts nothing.
    }
  }
  return out;
}
