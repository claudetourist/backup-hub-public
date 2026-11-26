import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobRecord } from '../../shared/jobs';
import type { BackupRow } from '../../shared/backups';
import type { MirrorBackupStatus, MirrorLookResult, MirrorPlanView, MirrorReport, MirrorStatusResult } from '../../shared/mirror';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { ProgressPanel } from '../components/ProgressPanel';
import { Report } from '../components/Report';
import { elapsedProps } from '../components/progressModel';
import { StatusPill } from '../components/StatusPill';
import { DecisionsAfterRun } from '../decisions/DecisionsAfterRun';
import { useJobs } from '../jobs/JobsProvider';
import { formatBytes, formatCount } from '../lib/format';
import { MirrorFileList } from './MirrorFileList';
import type { ResumeJob } from './backupListModel';
import { backupStatusOf } from './backupsModel';
import { bringAllButton, bringUpButton, bringUpState, combinedStatus, confirmText, listRows, MIRROR_LOOKING, MIRROR_PANEL_TITLE, ownChecksumLine, planLines, CHECK_LINK_TEXT, reportData, selectionTotals, statusLine } from './mirrorModel';

type Step =
  | { name: 'idle' }
  | { name: 'looking'; jobId: number }
  | { name: 'refused'; message: string; backupId: number | null }
  | { name: 'preview'; plan: MirrorPlanView }
  | { name: 'running'; jobId: number; label: string }
  | { name: 'done'; jobId: number; report: MirrorReport | null; job: JobRecord | null };

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const finished = (state: string | undefined): boolean => state === 'done' || state === 'done_warnings' || state === 'failed';

/**
 * The second copy of the backups that have a second drive: one line per backup ("T7: up to date · Seagate2TB: behind by 1,234 files (12 GB)") with
 * "Bring <drive> up to date" (and one button for all of them). The button first looks at both drives and shows the list (the same list as the phone
 * backup's: largest first, search, untick, counts); only "Copy N files (X GB) to <drive>" starts the copy. The copy only brings over files the second drive is missing; files already there with the same size are counted, not read (MirrorCheckPanel proves them). Nothing here starts by itself.
 */
export function MirrorPanel({ rows, status, now, onFinished, onShowCheck, autoStart, onClose, resume = null }: { rows: readonly BackupRow[]; status: MirrorStatusResult | null; now: number; onFinished: () => void; onShowCheck: () => void; /** A look or copy that is still going: picked up instead of the button. */ resume?: ResumeJob | null; /** Look at once, as the button that opened this asked: for every backup ('all') or one (its id). */ autoStart?: 'all' | number; /** Called instead of going back to the idle list (the panel was opened on its own for all backups). */ onClose?: () => void }) {
  const [step, setStep] = useState<Step>(() => (resume ? (resume.phase === 'look' ? { name: 'looking', jobId: resume.jobId } : { name: 'running', jobId: resume.jobId, label: resume.driveLabel ?? 'the second drive' }) : { name: 'idle' }));
  // One backup (its own page): no list of names, one line and one button. Several: a line for each and one button for all.
  const single = rows.length === 1;
  const toIdle = (): void => (onClose ? onClose() : setStep({ name: 'idle' }));
  const started = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const { jobs } = useJobs();
  const job = step.name === 'looking' || step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;
  const mine = useMemo(() => (status?.backups ?? []).filter((m) => rows.some((r) => r.id === m.backupId)), [status, rows]);

  const begin = (backupId?: number): void => {
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.mirror.look(backupId);
        if (r.ok && r.jobId !== null) setStep({ name: 'looking', jobId: r.jobId });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
    })();
  };

  useEffect(() => {
    if (autoStart === undefined || started.current) return;
    started.current = true;
    begin(autoStart === 'all' ? undefined : autoStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lookState = step.name === 'looking' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'looking' || !finished(lookState)) return;
    const jobId = step.jobId;
    void (async () => {
      let result: MirrorLookResult | null = null;
      try {
        result = await window.backupHub.mirror.preview(jobId);
      } catch {
        result = null;
      }
      if (result?.ok) {
        setUnticked(new Set());
        setStep({ name: 'preview', plan: result.plan });
      } else setStep({ name: 'refused', message: result ? result.message : (job?.error ?? 'The look did not finish.'), backupId: null });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookState]);

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || !finished(runState)) return;
    const jobId = step.jobId;
    void (async () => {
      let report: MirrorReport | null = null;
      try {
        report = await window.backupHub.mirror.report(jobId);
      } catch {
        report = null;
      }
      setStep({ name: 'done', jobId, report, job });
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const plan = step.name === 'preview' ? step.plan : null;
  const list = useMemo(() => (plan ? listRows(plan) : []), [plan]);
  const sel = selectionTotals(list, unticked);
  const label = plan ? (plan.backups.every((b) => b.targetLabel === plan.backups[0]!.targetLabel) ? plan.backups[0]!.targetLabel : 'the second drives') : '';

  const confirm = (): void => {
    if (step.name !== 'preview') return;
    setMessage(null);
    const p = step.plan;
    void (async () => {
      try {
        const r = await window.backupHub.mirror.start({ planId: p.planId, hash: p.hash, unticked: [...unticked] });
        if (r.ok && r.jobId !== null) setStep({ name: 'running', jobId: r.jobId, label });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was copied.');
      }
    })();
  };

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setMessage('That did not work. Please try again.'));
  if (mine.length === 0 && step.name === 'idle') return null;
  const first = mine[0];
  const targetLabel = first?.mirrors[0]?.label ?? 'the second drive';

  const lineOf = (m: MirrorBackupStatus): { row: BackupRow; line: string | null } | null => {
    const row = rows.find((r) => r.id === m.backupId);
    return row ? { row, line: statusLine(m.sourceLabel, backupStatusOf(row, now), m) } : null;
  };

  return (
    <Panel {...(single ? { label: MIRROR_PANEL_TITLE } : { title: MIRROR_PANEL_TITLE })} accent="drive">
      <div className="settings-stack">
        {step.name === 'idle' ? (
          <>
            <span className="cell-sub">Copies what {targetLabel} is missing from {first?.sourceLabel ?? 'the first drive'}. Both drives must be plugged in. Nothing on either drive is replaced or deleted.</span>
            <details className="more">
              <summary>Why?</summary>
              <span className="cell-sub">Backup Hub reads the first drive, checks every file against its checksum, and copies only what the second drive is missing. Files that are already there with the same size are not read here: "Check old copies" proves them.</span>
            </details>
            {single ? (
              mine.map((m) => {
                const l = lineOf(m);
                if (!l) return null;
                const state = bringUpState(m);
                const level = m.mirrors.every((x) => x.behindFiles === 0);
                return (
                  <div key={m.backupId} className="settings-stack">
                    <span className="home-backup__when cell-sub">{l.line}</span>
                    <span className="settings-actions">
                      {state.enabled ? (
                        <Button variant={level ? 'quiet' : 'primary'} onClick={() => begin(m.backupId)}>{level ? 'Check again' : bringUpButton(m.mirrors[0]!.label)}</Button>
                      ) : state.why ? (
                        <span className="cell-sub" role="status">{state.why}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            ) : (
            <ul className="home-backups" aria-label="Second copies">
              {mine.map((m) => {
                const l = lineOf(m);
                if (!l) return null;
                const state = bringUpState(m);
                const base = backupStatusOf(l.row, now);
                const level = m.mirrors.every((x) => x.behindFiles === 0);
                return (
                  <li key={m.backupId} className="home-backup">
                    <span className="home-backup__who"><b className="home-backup__name">{l.row.name}</b></span>
                    <StatusPill status={combinedStatus(base, m)} />
                    <span className="cell-sub home-backup__when">{l.line}</span>
                    <span className="home-backup__action">
                      {state.enabled && level ? (
                        <Button size="sm" variant="quiet" onClick={() => begin(m.backupId)}>Check again</Button>
                      ) : state.enabled ? (
                        <Button size="sm" variant="secondary" onClick={() => begin(m.backupId)}>{bringUpButton(m.mirrors[0]!.label)}</Button>
                      ) : state.why ? (
                        <span className="cell-sub" role="status">{state.why}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            )}
            {mine.length > 1 && mine.some((m) => m.mirrors.some((x) => x.behindFiles !== 0)) ? (
              <span className="settings-actions">
                <Button variant="primary" disabled={!mine.every((m) => bringUpState(m).enabled) && !mine.some((m) => bringUpState(m).enabled)} onClick={() => begin()}>
                  {bringAllButton(targetLabel)}
                </Button>
              </span>
            ) : null}
          </>
        ) : null}
        {step.name === 'looking' ? <span role="status" className="cell-sub">{job?.message ?? MIRROR_LOOKING}</span> : null}
        {step.name === 'refused' ? (
          <>
            <span role="alert" className="cell-sub">{step.message}</span>
            <span className="settings-actions">
              <Button variant="primary" onClick={() => begin(mine.length === 1 ? mine[0]!.backupId : undefined)}>Try again</Button>
              <Button variant="quiet" onClick={toIdle}>Cancel</Button>
            </span>
          </>
        ) : null}
        {plan ? (
          <>
            <b>
              {plan.totals.files === 0
                ? `${label} has every file of ${plan.backups.length === 1 ? plan.backups[0]!.backupName : 'these backups'} that is not waiting for a decision.`
                : `${formatCount(plan.totals.files)} files (${formatBytes(plan.totals.bytes)}) are on ${plan.backups[0]!.sourceLabel} but not on ${label}. They will go to the same folder (${plan.backups.map((b) => b.folderWords).join(', ')}).`}
            </b>
            {plan.blocked ? <span role="alert" className="cell-sub">{plan.blocked}</span> : null}
            {plan.totals.files > 0 ? (
              <MirrorFileList rows={list} unticked={unticked} onUntickedChange={setUnticked} confirmLabel={confirmText(sel, label)} canConfirm={sel.files > 0 && plan.blocked === null} onConfirm={confirm} showBackup={plan.backups.length > 1} />
            ) : null}
            {planLines(plan, label).map((line) => (
              <span key={line} className="cell-sub">{line}</span>
            ))}
            {plan.toCheck.files > 0 ? (
              <span className="settings-actions">
                <Button size="sm" variant="quiet" onClick={onShowCheck}>{CHECK_LINK_TEXT}</Button>
              </span>
            ) : null}
            {plan.totals.files === 0 && plan.different.files > 0 ? (
              <span className="settings-actions">
                <Button variant="primary" onClick={confirm}>Record what is different</Button>
              </span>
            ) : null}
            {plan.notes.map((n) => (
              <span key={n} className="cell-sub">{n}</span>
            ))}
            <span className="settings-actions">
              <Button variant="quiet" onClick={toIdle}>Cancel</Button>
            </span>
          </>
        ) : null}
        {step.name === 'running' ? (
          job && job.state === 'needs_you' ? (
            <>
              <span role="alert" className="cell-sub">{job.message ?? 'The copy is waiting for you.'}</span>
              <span className="settings-actions">
                {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
                  <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>{c}</Button>
                ))}
              </span>
            </>
          ) : (
            <ProgressPanel
              what={job ? job.title.replace(/^Copy /, 'Copying ') : `Copying to ${step.label}`}
              detail={<span className="cell-sub" role="status">{job?.message ?? 'Getting started.'}</span>}
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
                <Report data={reportData(step.report, when)} title="Second copy report" />
                {step.report.ownChecksums > 0 ? <span className="cell-sub">{ownChecksumLine(step.report.ownChecksums)}</span> : null}
                {step.report.usbPauses > 0 ? <span className="cell-sub">The copy paused {step.report.usbPauses} {step.report.usbPauses === 1 ? 'time' : 'times'} for USB trouble and carried on.</span> : null}
                {step.report.listPaths.map((p) => (
                  <span key={p} className="cell-sub">The list of this run is on the drive: {p}</span>
                ))}
                {step.report.listProblem ? <span role="alert" className="cell-sub">{step.report.listProblem}</span> : null}
                {step.report.damaged + step.report.different > 0 ? (step.report.backups.length === 1 ? <DecisionsAfterRun backupId={step.report.backups[0]!.backupId} since={step.report.startedAt} /> : <span className="cell-sub">Some files need your decision: they are listed on Home under Needs your decision.</span>) : null}
              </>
            ) : (
              <span role="alert" className="cell-sub">{step.job?.error ?? 'The copy stopped. See Activity for what happened. Nothing was deleted or replaced.'}</span>
            )}
            <span className="settings-actions">
              <Button variant="quiet" onClick={toIdle}>Done</Button>
            </span>
          </>
        ) : null}
        {message ? <span role="alert" className="cell-sub">{message}</span> : null}
      </div>
    </Panel>
  );
}

