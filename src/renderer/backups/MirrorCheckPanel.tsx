import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobRecord } from '../../shared/jobs';
import type { BackupRow } from '../../shared/backups';
import type { MirrorStatusResult } from '../../shared/mirror';
import type { MirrorCheckPlanView, MirrorCheckReport } from '../../shared/mirrorCheck';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { ProgressPanel } from '../components/ProgressPanel';
import { elapsedProps } from '../components/progressModel';
import { DecisionsAfterRun } from '../decisions/DecisionsAfterRun';
import { useJobs } from '../jobs/JobsProvider';
import { formatCount } from '../lib/format';
import type { ResumeJob } from './backupListModel';
import { bringUpState, checkAllButton, checkButton, checkConfirmText, checkHeadline, checkPlanLines, checkReportLines, estimateLine, MIRROR_CHECK_COUNTING, MIRROR_CHECK_TITLE } from './mirrorModel';

type Step =
  | { name: 'idle' }
  | { name: 'counting' }
  | { name: 'refused'; message: string; backupId: number | null }
  | { name: 'preview'; plan: MirrorCheckPlanView; backupId: number | null }
  | { name: 'running'; jobId: number; label: string }
  | { name: 'done'; jobId: number; report: MirrorCheckReport | null; job: JobRecord | null; label: string };

const finished = (state: string | undefined): boolean => state === 'done' || state === 'done_warnings' || state === 'failed';

/**
 * "Check old copies on <second drive>": the files that are already there with the same size (old copies of an older tool) are proven in a job of their
 * own, after "Bring <drive> up to date" has copied what was missing. The preview is counted from the file list (no drive is read) and says an honest
 * time; only "Check N files on <drive>" starts the job, which can be paused, stopped and continued. Nothing here starts by itself.
 */
export function MirrorCheckPanel({ rows, status, onFinished, autoStart, onClose, resume = null }: { rows: readonly BackupRow[]; status: MirrorStatusResult | null; onFinished: () => void; /** A check that is still going: picked up instead of the button. */ resume?: ResumeJob | null; /** Count at once, as the button that opened this asked: for every backup ('all') or one (its id). */ autoStart?: 'all' | number; /** Called instead of going back to the idle list (the panel was opened on its own for all backups). */ onClose?: () => void }) {
  const [step, setStep] = useState<Step>(() => (resume?.phase === 'run' ? { name: 'running', jobId: resume.jobId, label: resume.driveLabel ?? 'the second drive' } : { name: 'idle' }));
  const single = rows.length === 1;
  const toIdle = (): void => (onClose ? onClose() : setStep({ name: 'idle' }));
  const started = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const { jobs } = useJobs();
  const job = step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;
  const mine = useMemo(() => (status?.backups ?? []).filter((m) => rows.some((r) => r.id === m.backupId)), [status, rows]);

  const begin = (backupId: number | null): void => {
    setMessage(null);
    setStep({ name: 'counting' });
    void (async () => {
      try {
        const r = await window.backupHub.mirror.checkPreview(backupId ?? undefined);
        setStep(r.ok ? { name: 'preview', plan: r.plan, backupId } : { name: 'refused', message: r.message, backupId });
      } catch {
        setStep({ name: 'refused', message: 'That did not work. Nothing was changed.', backupId });
      }
    })();
  };

  useEffect(() => {
    if (autoStart === undefined || started.current) return;
    started.current = true;
    begin(autoStart === 'all' ? null : autoStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (): void => {
    if (step.name !== 'preview') return;
    setMessage(null);
    const p = step.plan;
    const label = p.backups.every((b) => b.targetLabel === p.backups[0]!.targetLabel) ? p.backups[0]!.targetLabel : 'the second drives';
    void (async () => {
      try {
        const r = await window.backupHub.mirror.checkStart({ planId: p.planId, hash: p.hash });
        if (r.ok && r.jobId !== null) setStep({ name: 'running', jobId: r.jobId, label });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was checked.');
      }
    })();
  };

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || !finished(runState)) return;
    const { jobId, label } = step;
    void (async () => {
      let report: MirrorCheckReport | null = null;
      try {
        report = await window.backupHub.mirror.checkReport(jobId);
      } catch {
        report = null;
      }
      setStep({ name: 'done', jobId, report, job, label });
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setMessage('That did not work. Please try again.'));
  if (mine.length === 0 && step.name === 'idle') return null;
  const targetLabel = mine[0]?.mirrors[0]?.label ?? 'the second drive';
  const plan = step.name === 'preview' ? step.plan : null;
  const label = plan ? (plan.backups.every((b) => b.targetLabel === plan.backups[0]!.targetLabel) ? plan.backups[0]!.targetLabel : 'the second drives') : '';

  return (
    <div id="mirror-check">
      <Panel {...(single ? { label: MIRROR_CHECK_TITLE } : { title: MIRROR_CHECK_TITLE })} accent="drive">
        <div className="settings-stack">
          {step.name === 'idle' ? (
            <>
              <span className="cell-sub">Proves the files that were already on {targetLabel} before Backup Hub copied to it. You see the list and a time guess first.</span>
              <details className="more">
                <summary>Why?</summary>
                <span className="cell-sub">Those files are not read when you bring {targetLabel} up to date. Here the same checksum makes a file a verified copy; a different one is never replaced. You can pause or stop at any time.</span>
              </details>
              {single ? (
                mine.map((m) => {
                  const state = bringUpState(m);
                  return (
                    <span key={m.backupId} className="settings-actions">
                      {state.enabled ? <Button variant="primary" onClick={() => begin(m.backupId)}>{checkButton(m.mirrors[0]!.label)}</Button> : state.why ? <span className="cell-sub" role="status">{state.why}</span> : null}
                    </span>
                  );
                })
              ) : (
              <ul className="home-backups" aria-label="Old copies">
                {mine.map((m) => {
                  const row = rows.find((r) => r.id === m.backupId);
                  const state = bringUpState(m);
                  return row ? (
                    <li key={m.backupId} className="home-backup">
                      <span className="home-backup__who"><b className="home-backup__name">{row.name}</b></span>
                      <span className="home-backup__action">
                        {state.enabled ? <Button size="sm" variant="secondary" onClick={() => begin(m.backupId)}>{checkButton(m.mirrors[0]!.label)}</Button> : state.why ? <span className="cell-sub" role="status">{state.why}</span> : null}
                      </span>
                    </li>
                  ) : null;
                })}
              </ul>
              )}
              {!single && mine.length > 1 ? (
                <span className="settings-actions">
                  <Button variant="secondary" disabled={!mine.some((m) => bringUpState(m).enabled)} onClick={() => begin(null)}>{checkAllButton(targetLabel)}</Button>
                </span>
              ) : null}
            </>
          ) : null}
          {step.name === 'counting' ? <span role="status" className="cell-sub">{MIRROR_CHECK_COUNTING}</span> : null}
          {step.name === 'refused' ? (
            <>
              <span role="alert" className="cell-sub">{step.message}</span>
              <span className="settings-actions">
                <Button variant="primary" onClick={() => begin(step.backupId)}>Try again</Button>
                <Button variant="quiet" onClick={toIdle}>Cancel</Button>
              </span>
            </>
          ) : null}
          {plan ? (
            <>
              <b>{checkHeadline(plan, label)}</b>
              {plan.totals.files > 0 ? <span className="cell-sub" role="status"><b>{estimateLine(plan.estimateSeconds)}</b></span> : null}
              {checkPlanLines(plan, label).map((line) => (
                <span key={line} className="cell-sub">{line}</span>
              ))}
              {plan.notes.map((n) => (
                <span key={n} className="cell-sub">{n}</span>
              ))}
              <span className="settings-actions">
                {plan.totals.files > 0 ? <Button variant="primary" onClick={start}>{checkConfirmText(plan, label)}</Button> : null}
                <Button variant="quiet" onClick={toIdle}>{plan.totals.files > 0 ? 'Cancel' : 'Done'}</Button>
              </span>
            </>
          ) : null}
          {step.name === 'running' ? (
            job && job.state === 'needs_you' ? (
              <>
                <span role="alert" className="cell-sub">{job.message ?? 'The check is waiting for you.'}</span>
                <span className="settings-actions">
                  {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
                    <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>{c}</Button>
                  ))}
                </span>
              </>
            ) : (
              <ProgressPanel
                what={job ? job.title.replace(/^Check /, 'Checking ') : `Checking old copies on ${step.label}`}
                detail={<span className="cell-sub" role="status">{job?.message ?? 'Getting started.'}</span>}
                {...(job ? { doneFiles: job.progressDone, totalFiles: job.progressTotal, filesPerSecond: job.speed?.unit === 'items' ? job.speed.perSecond : null, filesOnly: true, ...elapsedProps(job.startedAt, Date.now(), job.pausedMs) } : {})}
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
                  {checkReportLines(step.report, step.label).map((line, i) => (
                    i === 0 ? <b key={line}>{line}</b> : <span key={line} className="cell-sub">{line}</span>
                  ))}
                  {step.report.skipped.map((s) => (
                    <span key={s.reason} className="cell-sub">{formatCount(s.count)} skipped: {s.reason}{s.examples.length > 0 ? ` For example: ${s.examples.join(', ')}` : ''}</span>
                  ))}
                  {step.report.failed.map((s) => (
                    <span key={s.reason} role="alert" className="cell-sub">{formatCount(s.count)} could not be checked: {s.reason}</span>
                  ))}
                  {step.report.usbPauses > 0 ? <span className="cell-sub">The check paused {step.report.usbPauses} {step.report.usbPauses === 1 ? 'time' : 'times'} for USB trouble and carried on.</span> : null}
                  {step.report.differs > 0 ? (step.report.backups.length === 1 ? <DecisionsAfterRun backupId={step.report.backups[0]!.backupId} since={step.report.startedAt} /> : <span className="cell-sub">Some files need your decision: they are listed on Home under Needs your decision.</span>) : null}
                </>
              ) : (
                <span role="alert" className="cell-sub">{step.job?.error ?? 'The check stopped. See Activity for what happened. Nothing was deleted or replaced.'}</span>
              )}
              <span className="settings-actions">
                <Button variant="quiet" onClick={toIdle}>Done</Button>
              </span>
            </>
          ) : null}
          {message ? <span role="alert" className="cell-sub">{message}</span> : null}
        </div>
      </Panel>
    </div>
  );
}
