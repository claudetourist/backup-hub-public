import { useEffect, useState } from 'react';
import { parseJobError } from '../../shared/jobs';
import type { RestoreDestination, RestorePick, RestorePlanView } from '../../shared/restore';
import { Button } from '../components/Button';
import { ProgressPanel } from '../components/ProgressPanel';
import { elapsedProps } from '../components/progressModel';
import { useJobs } from '../jobs/JobsProvider';
import { googleLine, heldHeadline, planHeadline, RESTORE_GO_BUTTON, roomWarning } from './restoreModel';

type Step = { name: 'planning' } | { name: 'refused'; message: string } | { name: 'review'; plan: RestorePlanView } | { name: 'running'; jobId: number } | { name: 'done'; jobId: number };

/**
 * After the pick: the list main made (how many files, where from, where to, what will not come back), the one button that starts the copy, the progress, and the
 * report. Nothing is copied before the button.
 */
export function RestoreRun({ pick, destination, onBack, onFinished }: { pick: RestorePick; destination: RestoreDestination; onBack: () => void; onFinished?: () => void }) {
  const [step, setStep] = useState<Step>({ name: 'planning' });
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { jobs } = useJobs();
  const jobId = step.name === 'running' || step.name === 'done' ? step.jobId : null;
  const job = jobId === null ? null : (jobs.find((j) => j.id === jobId) ?? null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.backupHub.restore.plan({ pick, destination });
        if (alive) setStep(r.ok ? { name: 'review', plan: r.plan } : { name: 'refused', message: r.message });
      } catch {
        if (alive) setStep({ name: 'refused', message: 'That did not work. Nothing was copied.' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [pick, destination]);

  const start = (plan: RestorePlanView): void => {
    setStarting(true);
    setProblem(null);
    void (async () => {
      try {
        const r = await window.backupHub.restore.start({ planId: plan.planId, confirmed: true });
        if (r.ok) setStep({ name: 'running', jobId: r.jobId });
        else setProblem(r.message);
      } catch {
        setProblem('That did not work. Nothing was copied.');
      }
      setStarting(false);
    })();
  };

  const state = job?.state;
  useEffect(() => {
    if (step.name === 'running' && (state === 'done' || state === 'done_warnings' || state === 'failed')) {
      setStep({ name: 'done', jobId: step.jobId });
      onFinished?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setProblem('That did not work. Please try again.'));

  if (step.name === 'planning')
    return (
      <p className="cell-sub" role="status">
        Making the list…
      </p>
    );
  if (step.name === 'refused')
    return (
      <div className="settings-stack">
        <span role="alert">{step.message}</span>
        <span className="settings-actions">
          <Button variant="secondary" onClick={onBack}>
            Change my choice
          </Button>
        </span>
      </div>
    );
  if (step.name === 'review') {
    const { plan } = step;
    const room = roomWarning(plan);
    return (
      <div className="settings-stack" aria-label="What will come back">
        <b>{planHeadline(plan)}</b>
        {googleLine(plan) ? <span className="cell-sub">{googleLine(plan)}</span> : null}
        <span>They go: {plan.toWords}</span>
        <span className="cell-sub">Nothing on the drive is changed. A file that is already there is never replaced.</span>
        {plan.held.count > 0 ? (
          <div className="cell-stack cell-stack--tight">
            <b>{heldHeadline(plan.held.count)}</b>
            {plan.held.examples.map((h) => (
              <span key={h.path} className="cell-sub">
                {h.path}: {h.why}
              </span>
            ))}
            {plan.held.count > plan.held.examples.length ? <span className="cell-sub">and {plan.held.count - plan.held.examples.length} more</span> : null}
          </div>
        ) : null}
        {plan.notAvailable > 0 ? <span className="cell-sub">{plan.notAvailable} {plan.notAvailable === 1 ? 'file' : 'files'} cannot be reached now: no plugged-in drive and no Google copy.</span> : null}
        {room ? <span role="alert">{room}</span> : null}
        {problem ? <span role="alert">{problem}</span> : null}
        <span className="settings-actions">
          <Button variant="primary" disabled={starting || room !== null} onClick={() => start(plan)}>
            {RESTORE_GO_BUTTON}
          </Button>
          <Button variant="quiet" onClick={onBack}>
            Change my choice
          </Button>
        </span>
      </div>
    );
  }
  if (step.name === 'running')
    return job && job.state === 'needs_you' ? (
      <div className="settings-stack">
        <span role="alert">{job.message ?? 'Getting the files back is waiting for you.'}</span>
        <span className="settings-actions">
          {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
            <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>
              {c}
            </Button>
          ))}
        </span>
      </div>
    ) : (
      <ProgressPanel
        what="Getting files back"
        detail={<span className="cell-sub">{job?.message ?? 'Starting'}</span>}
        {...(job ? { doneBytes: job.bytesDone, totalBytes: job.bytesTotal, doneFiles: job.progressDone, totalFiles: job.progressTotal, bytesPerSecond: job.speed?.unit === 'bytes' ? job.speed.perSecond : null, filesPerSecond: job.speed?.unit === 'bytes' ? job.speed.itemsPerSecond : null, ...elapsedProps(job.startedAt, Date.now(), job.pausedMs) } : {})}
        paused={job?.paused === true}
        onPause={() => job && act(() => window.backupHub.jobs.pause(job.id))}
        onResume={() => job && act(() => window.backupHub.jobs.resume(job.id))}
        onStop={() => job && act(() => window.backupHub.jobs.cancel(job.id))}
      />
    );
  // done
  const failed = job?.state === 'failed';
  return (
    <div className="settings-stack" aria-label="Report" role="status">
      {failed ? <b>The files were not all brought back.</b> : <b>Done.</b>}
      <span>{failed ? parseJobError(job?.error ?? null).text || 'Getting the files back stopped. Nothing was overwritten or deleted.' : (job?.message ?? '')}</span>
      {job && job.warnings.length > 0 ? (
        <div className="cell-stack cell-stack--tight">
          {[...new Set(job.warnings)].slice(0, 5).map((w) => (
            <span key={w} className="cell-sub">
              {w}
            </span>
          ))}
          {job.warnings.length > 5 ? <span className="cell-sub">and {job.warnings.length - 5} more in Activity</span> : null}
        </div>
      ) : null}
      <span className="settings-actions">
        <Button variant="secondary" onClick={onBack}>
          Done
        </Button>
      </span>
    </div>
  );
}
