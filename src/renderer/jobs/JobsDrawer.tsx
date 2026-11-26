import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isContinuable, parseJobError, progressPercent, type DemoJobOptions, type JobEvent, type JobRecord } from '../../shared/jobs';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ProgressBar } from '../components/ProgressBar';
import { wholePercent } from '../components/progressModel';
import { JobStatusPill } from '../components/StatusPill';
import { Report } from '../components/Report';
import { reportData } from '../backups/phoneBackupModel';
import { folderReportData } from '../backups/folderBackupModel';
import { FOLDER_BACKUP_JOB_KIND, type FolderBackupReport } from '../../shared/folderBackup';
import { MIRROR_COPY_JOB_KIND, type MirrorReport } from '../../shared/mirror';
import { MIRROR_CHECK_JOB_KIND, type MirrorCheckReport } from '../../shared/mirrorCheck';
import { checkReportLines, reportData as mirrorReportData } from '../backups/mirrorModel';
import { PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND, type CheckOldReport, type PhoneBackupReport } from '../../shared/phoneBackup';
import { CheckOldReportView } from '../backups/CheckOldView';
import { Toggle } from '../components/Toggle';
import { useScopedJobs } from '../profiles/ProfileScopeProvider';
import { useJobs } from './JobsProvider';
import { useNow } from './useNow';
import {
  countByFilter,
  explainInList,
  filterJobs,
  formatClock,
  formatDuration,
  formatFullDateTime,
  formatProgressText,
  formatWhen,
  jobRowLine,
  jobStatus,
  JOB_FILTERS,
  keyedLines,
  splitRecent,
  visibleJobs,
  type JobFilterId,
} from './jobsModel';

const FILTER_EMPTY: Record<JobFilterId, string> = {
  all: 'No jobs yet. Anything the app does in the background shows up here.',
  running: 'Nothing is running or waiting.',
  needs_you: 'Nothing needs you right now.',
  failed: 'No failed jobs.',
  finished: 'No finished jobs yet.',
};

const LEVEL_TONE: Record<JobEvent['level'], string> = {
  debug: 'neutral',
  info: 'neutral',
  warn: 'warn',
  error: 'crit',
};

function ProgressCell({ job }: { job: JobRecord }) {
  if (job.state !== 'running' && job.state !== 'needs_you') {
    return <span className="cell-sub">{job.state === 'queued' ? (job.paused ? (job.pausing === true ? 'Pausing' : 'Paused') : 'Waiting') : ''}</span>;
  }
  const percent = progressPercent(job);
  const text = formatProgressText(job);
  return (
    <span className="cell-stack cell-stack--tight job-progress">
      <ProgressBar
        label={`Progress of ${job.title}`}
        tone={job.state === 'needs_you' ? 'warn' : 'info'}
        {...(percent === null ? { indeterminate: true } : { value: percent })}
        {...(text ? { valueText: text } : {})}
      />
      <span className="cell-sub">{percent === null ? 'Working' : `${wholePercent(percent)}%${text ? ` · ${text}` : ''}`}</span>
    </span>
  );
}

/** The text the Copy button puts on the clipboard: everything in the folded block, for passing on. */
export function technicalText(job: JobRecord, events: readonly JobEvent[]): string {
  const { code } = parseJobError(job.error);
  const when = (ms: number | null) => (ms === null ? 'not yet' : formatFullDateTime(ms));
  return [
    `Job #${job.id} (${job.kind})`,
    `Error code: ${code ?? 'none'}`,
    `Message: ${job.error ?? 'none'}`,
    `Started: ${when(job.startedAt)}`,
    `Finished: ${when(job.finishedAt)}`,
    'Last events:',
    ...events.slice(-20).map((event) => `${formatClock(event.at)} [${event.level}] ${event.text}`),
  ].join('\n');
}

/** The folded "Technical details" block: error code, raw message, kind and number, times, the last 20 events, and a Copy button. */
function TechnicalDetails({ job, events }: { job: JobRecord; events: readonly JobEvent[] }) {
  const [copied, setCopied] = useState(false);
  const { code } = parseJobError(job.error);
  const last = events.slice(-20);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(technicalText(job, events))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <details className="job-tech">
      <summary>Technical details</summary>
      <dl className="facts job-facts">
        <dt>Error code</dt>
        <dd className="mono">{code ?? 'none'}</dd>
        <dt>Message</dt>
        <dd className="mono">{job.error ?? 'none'}</dd>
        <dt>Kind</dt>
        <dd className="mono">{job.kind}</dd>
        <dt>Job number</dt>
        <dd className="mono">{job.id}</dd>
        <dt>Started</dt>
        <dd>{job.startedAt === null ? 'Not yet' : formatFullDateTime(job.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>{job.finishedAt === null ? 'Not yet' : formatFullDateTime(job.finishedAt)}</dd>
      </dl>
      <b className="job-log__title">Last {last.length === 1 ? 'event' : `${last.length} events`}</b>
      {last.length === 0 ? (
        <p className="cell-sub">Nothing logged yet.</p>
      ) : (
        <ol className="job-log" aria-label={`Log of ${job.title}`}>
          {last.map((event) => (
            <li key={event.id} className="job-log__line">
              <span className="job-log__time mono">{formatClock(event.at)}</span>
              <span className={`tone-text tone-text--${LEVEL_TONE[event.level]}`}>{event.text}</span>
            </li>
          ))}
        </ol>
      )}
      <Button size="sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </details>
  );
}

/** The details of one job inside the drawer: its own scroll and the buttons pinned at the bottom. Opens when a row is clicked. */
function JobDetails({ job, jobs, onSelect, onClose }: { job: JobRecord; jobs: readonly JobRecord[]; onSelect: (id: number) => void; onClose: () => void }) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [busy, setBusy] = useState<false | 'retry' | 'other'>(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow();

  // Re-read the log when this job changes (debounced: a running job reports several times a second).
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await window.backupHub.jobs.events(job.id);
          if (!cancelled) setEvents(rows);
        } catch {
          // Leave the log as it was.
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  const act = useCallback(
    async (run: () => Promise<unknown>, selectResult?: boolean) => {
      // Retry makes a new job: the button says so at once, before main has answered.
      setBusy(selectResult ? 'retry' : 'other');
      setProblem(null);
      try {
        const result = await run();
        if (selectResult && typeof result === 'number') onSelect(result);
      } catch {
        setProblem('That did not work. Please try again.');
      } finally {
        setBusy(false);
      }
    },
    [onSelect],
  );

  // The report of a phone backup is kept with its job: shown here, in Activity, once the job has ended.
  const [phoneReport, setPhoneReport] = useState<PhoneBackupReport | null>(null);
  const reportable = job.kind === PHONE_BACKUP_JOB_KIND && (job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');
  useEffect(() => {
    if (!reportable) return;
    let cancelled = false;
    void window.backupHub.phoneBackup
      .report(job.id)
      .then((r) => {
        if (!cancelled) setPhoneReport(r);
        return r;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, reportable]);

  // The report of a folder backup is kept with its job the same way.
  const [folderReport, setFolderReport] = useState<FolderBackupReport | null>(null);
  const folderReportable = job.kind === FOLDER_BACKUP_JOB_KIND && (job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');
  useEffect(() => {
    if (!folderReportable) return;
    let cancelled = false;
    void window.backupHub.folderBackup
      .report(job.id)
      .then((r) => {
        if (!cancelled) setFolderReport(r);
        return r;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, folderReportable]);

  // And the report of a copy to the second drive.
  const [mirrorReport, setMirrorReport] = useState<MirrorReport | null>(null);
  const mirrorReportable = job.kind === MIRROR_COPY_JOB_KIND && (job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');
  useEffect(() => {
    if (!mirrorReportable) return;
    let cancelled = false;
    void window.backupHub.mirror
      .report(job.id)
      .then((r) => {
        if (!cancelled) setMirrorReport(r);
        return r;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, mirrorReportable]);

  // And the report of "Check old copies on <second drive>" (it is kept when the job is stopped too).
  const [mirrorCheckReport, setMirrorCheckReport] = useState<MirrorCheckReport | null>(null);
  const mirrorCheckReportable = job.kind === MIRROR_CHECK_JOB_KIND && (job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');
  useEffect(() => {
    if (!mirrorCheckReportable) return;
    let cancelled = false;
    void window.backupHub.mirror
      .checkReport(job.id)
      .then((r) => {
        if (!cancelled) setMirrorCheckReport(r);
        return r;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, mirrorCheckReportable]);

  // So is the report of a "Check old copies" run.
  const [checkReport, setCheckReport] = useState<CheckOldReport | null>(null);
  const checkReportable = job.kind === PHONE_CHECK_OLD_JOB_KIND && (job.state === 'done' || job.state === 'done_warnings' || job.state === 'failed');
  useEffect(() => {
    if (!checkReportable) return;
    let cancelled = false;
    void window.backupHub.phoneBackup
      .checkOldReport(job.id)
      .then((r) => {
        if (!cancelled) setCheckReport(r);
        return r;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, checkReportable]);

  const explained = explainInList(job, jobs);
  const finishedBad = job.state === 'failed' || job.state === 'done_warnings';
  const canCancel = job.state === 'queued' || job.state === 'running' || job.state === 'needs_you';
  const canPause = (job.state === 'queued' || job.state === 'running') && !job.paused;
  const canResume = job.state === 'queued' && job.paused;
  const canRetry = finishedBad && explained.retry.allowed;
  const canContinue = isContinuable(job);
  const answers = job.choices.length > 0 ? job.choices : ['Continue'];
  const duration = formatDuration(job, now);

  return (
    <aside className="panel job-panel" aria-label={`Details of ${job.title}`}>
      <header className="job-panel__head">
        <span className="cell-stack cell-stack--tight">
          <h2 className="job-panel__title">{job.title}</h2>
          <span>
            <JobStatusPill job={job} />
          </span>
        </span>
        <button type="button" className="job-panel__close" aria-label="Back to the list" title="Back to the list (Esc)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="job-panel__body">
        {job.state === 'needs_you' ? (
          <div className="job-question" role="group" aria-label="This job needs your answer">
            <p className="job-question__text">{job.message ?? 'This job is waiting for you.'}</p>
            <span className="job-actions">
              {answers.map((answer, index) => (
                <Button key={answer} variant={index === 0 ? 'primary' : 'secondary'} disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.resolve(job.id, answer))}>
                  {answer}
                </Button>
              ))}
            </span>
          </div>
        ) : null}
        <p className={explained.status === 'failed' ? 'job-error' : 'job-note'}>{explained.headline}</p>
        {finishedBad || explained.status === 'stopped' || explained.status === 'interrupted' ? (
          <dl className="facts job-facts">
            {explained.whatWasNotChanged ? (
              <>
                <dt>Not changed</dt>
                <dd>{explained.whatWasNotChanged}</dd>
              </>
            ) : null}
            <dt>What to do</dt>
            <dd>{explained.whatToDo}</dd>
          </dl>
        ) : null}
        {job.state === 'running' || job.state === 'needs_you' ? <ProgressCell job={job} /> : null}
        {phoneReport ? <Report data={reportData(phoneReport, formatFullDateTime)} title="Phone backup report" /> : null}
        {folderReport ? <Report data={folderReportData(folderReport, formatFullDateTime)} title="Folder backup report" /> : null}
        {mirrorReport ? <Report data={mirrorReportData(mirrorReport, formatFullDateTime)} title="Second copy report" /> : null}
        {mirrorCheckReport ? (
          <section className="report report--ok" aria-label="Check old copies report">
            {checkReportLines(mirrorCheckReport, mirrorCheckReport.backups[0]?.targetLabel ?? 'the second drive').map((line, i) => (i === 0 ? <h2 key={line} className="report__headline">{line}</h2> : <p key={line} className="cell-sub">{line}</p>))}
          </section>
        ) : null}
        {checkReport ? <CheckOldReportView report={checkReport} formatWhen={formatFullDateTime} /> : null}
        {job.warnings.length > 0 ? (
          <div className="job-warnings">
            <b>Warnings</b>
            <ul>
              {keyedLines(job.warnings).map((line) => (
                <li key={line.key}>{line.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="cell-sub">
          {job.startedBy ? `${job.startedBy}. ` : ''}
          {duration ? `${job.finishedAt === null ? 'So far' : 'Took'} ${duration}.` : ''}
        </p>
        <TechnicalDetails job={job} events={events} />
      </div>
      {canCancel || finishedBad || canContinue || problem ? (
        <footer className="job-panel__foot">
          <span className="job-actions">
            {canContinue ? (
              <>
                <Button variant="primary" disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.continueInterrupted(job.id))}>
                  Continue
                </Button>
                <Button disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.dismiss(job.id))}>
                  Dismiss
                </Button>
              </>
            ) : null}
            {canRetry ? (
              <Button variant="primary" disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.retry(job.id), true)}>
                {busy === 'retry' ? 'Retrying...' : 'Retry'}
              </Button>
            ) : null}
            {canPause ? (
              <Button disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.pause(job.id))}>
                Pause
              </Button>
            ) : null}
            {canResume ? (
              <Button variant="primary" disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.resume(job.id))}>
                Resume
              </Button>
            ) : null}
            {canCancel ? (
              <Button disabled={busy !== false} onClick={() => void act(() => window.backupHub.jobs.cancel(job.id))}>
                Stop job
              </Button>
            ) : null}
            {finishedBad && !canRetry && explained.retry.why ? <span className="cell-sub">{explained.retry.why}</span> : null}
            {problem ? <span className="tone-text tone-text--crit">{problem}</span> : null}
          </span>
        </footer>
      ) : null}
    </aside>
  );
}

/** Dev builds only: make jobs to look at. */
function DemoButtons() {
  const make = (options: DemoJobOptions) => {
    void window.backupHub.jobs.createDemo(options).catch(() => undefined);
  };
  return (
    <>
      <Button size="sm" onClick={() => make({ steps: 12, stepMs: 600, bytesPerStep: 50_000_000 })}>
        Demo: ok
      </Button>
      <Button size="sm" onClick={() => make({ steps: 8, stepMs: 400, mode: 'warn' })}>
        Demo: warning
      </Button>
      <Button size="sm" onClick={() => make({ steps: 8, stepMs: 400, mode: 'fail' })}>
        Demo: fail
      </Button>
      <Button size="sm" onClick={() => make({ steps: 8, stepMs: 400, mode: 'ask' })}>
        Demo: ask
      </Button>
      <Button size="sm" onClick={() => make({ steps: 20, stepMs: 700, heavy: true, bytesPerStep: 200_000_000 })}>
        Demo: heavy
      </Button>
    </>
  );
}

/** One job in the list, on one line: what it is, the plain result, when, and its state. */
function JobRow({ job, jobs, now, onPick }: { job: JobRecord; jobs: readonly JobRecord[]; now: number; onPick: (id: number) => void }) {
  const when = job.state === 'queued' ? '' : formatWhen(job.finishedAt ?? job.startedAt ?? job.createdAt, now);
  return (
    <li>
      <button type="button" className={`jobs-drawer__row jobs-drawer__row--line jobs-drawer__row--${jobStatus(job).tone}`} onClick={() => onPick(job.id)}>
        <b className="job-title">{job.title}</b>
        <span className="cell-sub jobs-drawer__line-text" title={jobRowLine(job, jobs)}>
          {jobRowLine(job, jobs)}
        </span>
        <span className="cell-sub jobs-drawer__when" title={formatFullDateTime(job.finishedAt ?? job.startedAt)}>
          {when}
        </span>
        <JobStatusPill job={job} />
      </button>
    </li>
  );
}

/**
 * The jobs panel: slides in from the right when you press the "working" line in the sidebar (or "See all jobs" on Home). The
 * list shows each job with who started it; press one for its log, Pause, Resume, Retry and Stop. Each backup's page keeps its own History.
 */
export function JobsDrawer({ onClose }: { onClose?: () => void }) {
  // With no `onClose` it is the Activity screen (a page); with one it is the panel that slides in over the screen.
  const asPage = onClose === undefined;
  const Root = asPage ? 'section' : 'aside';
  const { jobs: everyJob, loaded, refreshing, refresh } = useJobs();
  // The Activity screen shows the person in focus; the panel that slides in over a screen shows everything that is running.
  const scopedJobs = useScopedJobs(false);
  const jobs = asPage ? scopedJobs : everyJob;
  const [filter, setFilter] = useState<JobFilterId>('all');
  const [showSystem, setShowSystem] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const now = useNow();
  const drawerRef = useRef<HTMLElement>(null);

  // Fresh read whenever the panel opens (change events keep it current afterwards), and focus moves into it.
  useEffect(() => {
    refresh();
    if (!asPage) drawerRef.current?.focus();
  }, [refresh, asPage]);

  // Esc goes back from a job to the list, then closes the panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (picked !== null) setPicked(null);
      else onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked, onClose]);

  const everything = useMemo(() => visibleJobs(jobs, showSystem), [jobs, showSystem]);
  // The last 7 days and anything still going; older work sits behind one "Show older" link.
  const { recent, older } = useMemo(() => splitRecent(everything, now), [everything, now]);
  const listed = showOlder ? everything : recent;
  const counts = useMemo(() => countByFilter(listed), [listed]);
  const visible = useMemo(() => filterJobs(listed, filter), [listed, filter]);
  const olderCount = useMemo(() => filterJobs(older, filter).length, [older, filter]);
  const selected = picked === null ? null : (jobs.find((job) => job.id === picked) ?? null);
  const hiddenCount = jobs.length - listed.length;
  const emptyText = filter === 'all' && hiddenCount > 0 ? 'Nothing to show. Background upkeep is hidden; turn on "Show system jobs" to see it.' : FILTER_EMPTY[filter];
  const subtitle =
    listed.length === 0
      ? 'Everything running, waiting for you, or finished.'
      : `${counts.running} running or waiting · ${counts.needs_you} need you · ${counts.failed} failed · ${counts.finished} finished`;

  return (
    <Root className={`jobs-drawer${asPage ? ' jobs-drawer--page' : ''}`} role={asPage ? undefined : 'dialog'} aria-label={asPage ? 'Activity' : 'Jobs'} tabIndex={-1} ref={drawerRef}>
      {selected ? (
        <JobDetails key={selected.id} job={selected} jobs={jobs} onSelect={setPicked} onClose={() => setPicked(null)} />
      ) : (
        <>
          <header className="jobs-drawer__head">
            <span className="cell-stack cell-stack--tight">
              {asPage ? null : <h2 className="job-panel__title">Jobs</h2>}
              <span className="cell-sub">{subtitle}</span>
            </span>
            <span className="job-actions">
              <Button size="sm" disabled={refreshing} onClick={refresh}>
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </Button>
              {onClose ? (
                <button type="button" className="job-panel__close" aria-label="Close the jobs panel" title="Close (Esc)" onClick={onClose}>
                  ×
                </button>
              ) : null}
            </span>
          </header>
          {import.meta.env.DEV ? (
            <div className="jobs-drawer__demo">
              <DemoButtons />
            </div>
          ) : null}
          <div className="jobs-drawer__tools">
            <div className="chips" role="group" aria-label="Filter jobs">
              {JOB_FILTERS.map((def) => (
                <button key={def.id} type="button" className="chip" aria-pressed={filter === def.id} onClick={() => setFilter(def.id)}>
                  {def.label}
                  <span className="chip__count">{counts[def.id]}</span>
                </button>
              ))}
            </div>
            <Toggle label="Show system jobs" checked={showSystem} onChange={setShowSystem} hint={hiddenCount > 0 && !showSystem ? `${hiddenCount} hidden: upkeep the app does itself` : 'Upkeep the app does itself'} />
          </div>
          <div className="jobs-drawer__body">
            {!loaded ? (
              <EmptyState title="Loading jobs">One moment.</EmptyState>
            ) : jobs.length === 0 ? (
              <EmptyState title="No jobs yet">{FILTER_EMPTY.all}</EmptyState>
            ) : visible.length === 0 ? (
              <p className="row-list__empty">{emptyText}</p>
            ) : (
              <ul className="jobs-drawer__list" aria-label="Jobs">
                {visible.map((job) => (
                  <JobRow key={job.id} job={job} jobs={jobs} now={now} onPick={setPicked} />
                ))}
              </ul>
            )}
            {older.length > 0 && (olderCount > 0 || showOlder) ? (
              <p className="jobs-drawer__older">
                <Button variant="quiet" size="sm" onClick={() => setShowOlder(!showOlder)}>
                  {showOlder ? 'Hide older' : `Show older (${olderCount})`}
                </Button>
              </p>
            ) : null}
          </div>
        </>
      )}
    </Root>
  );
}
