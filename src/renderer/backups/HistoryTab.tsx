import { useState } from 'react';
import type { BackupRow } from '../../shared/backups';
import type { JobRecord } from '../../shared/jobs';
import { Button } from '../components/Button';
import { JobStatusPill } from '../components/StatusPill';
import { formatWhen } from '../jobs/jobsModel';
import { formatBytes, formatCount, plural } from '../lib/format';
import { checkReportLines } from './mirrorModel';
import { jobsOf, jobWhat } from './backupListModel';

const SHOWN = 20;

/** What a finished job did, in lines: the numbers and where the run's list is on the drive. Null when this kind of job keeps no report. */
async function reportLines(row: BackupRow, job: JobRecord): Promise<string[] | null> {
  const copied = (c: { files: number; bytes: number }): string => `Copied ${formatCount(c.files)} ${plural(c.files, 'file', 'files')} (${formatBytes(c.bytes)}).`;
  const hub = window.backupHub;
  switch (job.kind) {
    case 'phone.backup': {
      const r = await hub.phoneBackup.report(job.id);
      return r ? [copied(r.copied), ...(r.listPath ? ['The list of this run is on the drive: ' + r.listPath] : [])] : null;
    }
    case 'folder.backup': {
      const r = await hub.folderBackup.report(job.id);
      return r ? [copied(r.copied), ...(r.listPath ? ['The list of this run is on the drive: ' + r.listPath] : [])] : null;
    }
    case 'mirror.copy': {
      const r = await hub.mirror.report(job.id);
      return r ? [copied(r.copied), ...r.listPaths.map((p) => 'The list of this run is on the drive: ' + p)] : null;
    }
    case 'mirror.checkOld': {
      const r = await hub.mirror.checkReport(job.id);
      return r ? checkReportLines(r, row.destinations?.[1]?.label ?? 'the second drive') : null;
    }
    default:
      return null;
  }
}

function JobLine({ row, job, now }: { row: BackupRow; job: JobRecord; now: number }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[] | null | 'loading'>(null);
  const finished = job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed';
  const toggle = (): void => {
    setOpen(!open);
    if (!open && lines === null) {
      setLines('loading');
      void reportLines(row, job).then(
        (l) => setLines(l ?? []),
        () => setLines([]),
      );
    }
  };
  const what = jobWhat(row, job);
  return (
    <li className="bk-history__row">
      <span className="bk-history__main">
        <JobStatusPill job={job} />
        <span className="bk-history__title" title={job.title}>{what === job.title ? job.title : what + ': ' + job.title}</span>
        <span className="cell-sub">{formatWhen(job.finishedAt ?? job.startedAt ?? job.createdAt, now)}</span>
        {finished ? (
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={toggle}>
            {open ? 'Hide details' : 'Details'}
          </Button>
        ) : null}
      </span>
      {open ? (
        <span className="cell-stack cell-stack--tight">
          {lines === 'loading' ? <span className="cell-sub" role="status">Reading the report…</span> : null}
          {Array.isArray(lines) ? lines.map((l) => <span key={l} className="cell-sub">{l}</span>) : null}
          {Array.isArray(lines) && lines.length === 0 ? <span className="cell-sub">{job.error ?? job.message ?? 'This job kept no report.'}</span> : null}
          {job.error && Array.isArray(lines) && lines.length > 0 ? <span role="alert" className="cell-sub">{job.error}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

/** History: this backup's jobs, newest first (a job over several backups is here too), each with its report and the run list's place on the drive when opened. */
export function HistoryTab({ row, jobs, now }: { row: BackupRow; jobs: readonly JobRecord[]; now: number }) {
  const [all, setAll] = useState(false);
  const mine = jobsOf(jobs, row.id);
  if (mine.length === 0) return <p className="cell-sub">No job has run for this backup since Backup Hub started keeping the list.</p>;
  const shown = all ? mine : mine.slice(0, SHOWN);
  return (
    <div className="settings-stack">
      <span className="cell-sub">Newest first. Details shows what was copied and where the list of the run is on the drive.</span>
      <ul className="bk-history" aria-label="Jobs of this backup">
        {shown.map((job) => (
          <JobLine key={job.id} row={row} job={job} now={now} />
        ))}
      </ul>
      {mine.length > SHOWN ? (
        <span>
          <Button size="sm" variant="quiet" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${mine.length}`}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
