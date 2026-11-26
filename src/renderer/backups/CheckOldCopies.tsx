import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobRecord } from '../../shared/jobs';
import type { CheckOldCountsResult, CheckOldPlanResult, CheckOldReport, ConnectedPhone } from '../../shared/phoneBackup';
import { Button } from '../components/Button';
import { ProgressPanel } from '../components/ProgressPanel';
import { elapsedProps } from '../components/progressModel';
import { useJobs } from '../jobs/JobsProvider';
import { CHECK_OLD_BUTTON, tickAll, toggleFolder, untickAll } from './checkOldModel';
import { DecisionsAfterRun } from '../decisions/DecisionsAfterRun';
import { CheckOldHeadline, CheckOldPreview, CheckOldReportView } from './CheckOldView';

type Counts = Extract<CheckOldCountsResult, { ok: true }>;
type Plan = Extract<CheckOldPlanResult, { ok: true }>;

type Step =
  | { name: 'idle' }
  | { name: 'planning' }
  | { name: 'refused'; message: string }
  | { name: 'preview'; plan: Plan }
  | { name: 'running'; jobId: number }
  | { name: 'done'; jobId: number; report: CheckOldReport | null; job: JobRecord | null };

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * "Check old copies" on the card of a connected phone: the headline of how many files have a checked copy, the button, the preview with
 * ticks, the progress and the report. The numbers come from the index; the check itself starts only from the button after the preview.
 */
export function CheckOldCopies({ phone, onFinished }: { phone: ConnectedPhone; onFinished: () => void }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const { jobs } = useJobs();
  const recount = useRef<number | null>(null);
  const job = step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;

  const loadCounts = useCallback((): void => {
    if (recount.current !== null) window.clearTimeout(recount.current);
    recount.current = null;
    void window.backupHub.phoneBackup
      .checkOldCounts(phone.backupId)
      .then((c) => {
        if (c.ok) {
          setCounts(c);
          setProblem(null);
          // The last numbers came back at once and a fresh count is running: ask again in a moment.
          if (c.stale === true) recount.current = window.setTimeout(loadCounts, 1500);
        } else setProblem(c.message);
        return c;
      })
      .catch(() => setProblem('The numbers for this backup could not be read.'));
  }, [phone.backupId]);
  useEffect(() => {
    loadCounts();
    return () => {
      if (recount.current !== null) window.clearTimeout(recount.current);
    };
  }, [loadCounts]);

  const preview = (): void => {
    setStep({ name: 'planning' });
    void (async () => {
      try {
        const plan = await window.backupHub.phoneBackup.checkOldPlan(phone.backupId);
        if (plan.ok) {
          setUnticked(new Set());
          setStep({ name: 'preview', plan });
        } else setStep({ name: 'refused', message: plan.message });
      } catch {
        setStep({ name: 'refused', message: 'That did not work. Nothing was changed.' });
      }
    })();
  };

  const start = (plan: Plan): void => {
    setStarting(true);
    void (async () => {
      try {
        const r = await window.backupHub.phoneBackup.checkOldStart({ backupId: phone.backupId, folders: plan.folders.filter((f) => !unticked.has(f.folder)).map((f) => f.folder) });
        if (r.ok && r.jobId !== null) setStep({ name: 'running', jobId: r.jobId });
        else setStep({ name: 'refused', message: r.message });
      } catch {
        setStep({ name: 'refused', message: 'That did not work. Nothing was checked.' });
      }
      setStarting(false);
    })();
  };

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || (runState !== 'done' && runState !== 'done_warnings' && runState !== 'failed')) return;
    const jobId = step.jobId;
    void (async () => {
      let report: CheckOldReport | null = null;
      try {
        report = await window.backupHub.phoneBackup.checkOldReport(jobId);
      } catch {
        report = null;
      }
      setStep({ name: 'done', jobId, report, job });
      loadCounts();
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setProblem('That did not work. Please try again.'));
  const waiting = counts !== null && counts.total.unchecked.files > 0;

  return (
    <div className="settings-stack" aria-label="Check old copies">
      {counts ? (
        <CheckOldHeadline
          backupName={phone.backupName}
          counts={counts}
          formatWhen={when}
          action={
            step.name === 'idle' || step.name === 'planning' || step.name === 'refused' || step.name === 'done' ? (
              waiting ? (
                <>
                  <Button disabled={step.name === 'planning' || !phone.driveConnected} onClick={preview}>
                    {CHECK_OLD_BUTTON}
                  </Button>
                  {!phone.driveConnected ? <span className="cell-sub">The drive for this backup is not plugged in.</span> : null}
                </>
              ) : (
                <span className="cell-sub">Every copy on {counts.driveLabel} that came from the old tool has been checked.</span>
              )
            ) : null
          }
        />
      ) : problem === null ? (
        <div className="cell-stack cell-stack--tight check-old-pending" role="group" aria-label="Checked copies">
          <span role="status" className="cell-sub">
            Counting…
          </span>
        </div>
      ) : null}
      {problem ? (
        <span role="alert" className="cell-sub">
          {problem}
        </span>
      ) : null}
      {step.name === 'planning' ? (
        <span role="status" className="cell-sub">
          Looking at which copies were never checked.
        </span>
      ) : null}
      {step.name === 'refused' ? (
        <span role="alert" className="cell-sub">
          {step.message}
        </span>
      ) : null}
      {step.name === 'preview' ? <CheckOldPreview plan={step.plan} unticked={unticked} busy={starting} onToggle={(folder) => setUnticked((cur) => toggleFolder(cur, folder))} onTickAll={() => setUnticked(tickAll())} onUntickAll={() => setUnticked(untickAll(step.plan.folders))} onConfirm={() => start(step.plan)} onCancel={() => setStep({ name: 'idle' })} /> : null}
      {step.name === 'running' ? (
        job && job.state === 'needs_you' ? (
          <>
            <span role="alert" className="cell-sub">
              {job.message ?? 'The check is waiting for you.'}
            </span>
            <span className="settings-actions">
              {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
                <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>
                  {c}
                </Button>
              ))}
            </span>
          </>
        ) : (
          <ProgressPanel
            what={`Checking old copies of ${phone.backupName} on ${counts?.driveLabel ?? 'the drive'}`}
            detail={<span className="cell-sub">{job?.message ?? 'Starting'}</span>}
            {...(job ? { doneBytes: job.bytesDone, totalBytes: job.bytesTotal, doneFiles: job.progressDone, totalFiles: job.progressTotal, bytesPerSecond: job.speed?.unit === 'bytes' ? job.speed.perSecond : null, filesPerSecond: job.speed?.unit === 'bytes' ? job.speed.itemsPerSecond : null, ...elapsedProps(job.startedAt, Date.now(), job.pausedMs) } : {})}
            paused={job?.paused === true}
              pausing={job?.pausing === true}
            onPause={() => job && act(() => window.backupHub.jobs.pause(job.id))}
            onResume={() => job && act(() => window.backupHub.jobs.resume(job.id))}
            onStop={() => job && act(() => window.backupHub.jobs.cancel(job.id))}
          />
        )
      ) : null}
      {step.name === 'done' ? (
        <>
          {step.report ? (
            <>
              <CheckOldReportView report={step.report} formatWhen={when} />
              <DecisionsAfterRun backupId={phone.backupId} since={step.report.startedAt} />
            </>
          ) : <span role="alert" className="cell-sub">{step.job?.error ?? 'The check stopped. See Activity for what happened. Nothing was changed on the phone or the drive.'}</span>}
          <span className="settings-actions">
            <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>
              Done
            </Button>
          </span>
        </>
      ) : null}
    </div>
  );
}
