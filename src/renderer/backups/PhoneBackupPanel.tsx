import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from '../components/Drawer';
import { useToast } from '../components/Toast';
import type { JobRecord } from '../../shared/jobs';
import type { ConnectedPhone, PhoneBackupReport, PhoneLookResult, PhonePlanView } from '../../shared/phoneBackup';
import type { RuleAddResult, RuleDraft, RuleView } from '../../shared/rules';
import { Button } from '../components/Button';
import { ProgressPanel } from '../components/ProgressPanel';
import { Report } from '../components/Report';
import { Frame } from './Frame';
import type { ResumeJob } from './backupListModel';
import { useJobs } from '../jobs/JobsProvider';
import { formatBytes, formatCount } from '../lib/format';
import { CheckOldCopies } from './CheckOldCopies';
import { PhoneFileList } from './PhoneFileList';
import { DecisionsAfterRun } from '../decisions/DecisionsAfterRun';
import { ChoiceConfirm } from './ChoiceConfirm';
import { NotCoveredCard } from './NotCoveredCard';
import { SafeUnplugButton } from '../places/SafeUnplug';
import { PopupMenu } from '../components/PopupMenu';
import { BACK_IN_LINE, folderChoice, includeChoice } from './choicesModel';
import { CopiedFilesFold, CopyingNow, CopyLists, useRunProgress } from './PhoneCopyLists';
import { elapsedProps } from '../components/progressModel';
import { tickedOfText } from '../components/previewModel';
import { backUpNowButton, cardTitle, confirmText, copyingTitle, excludedBy, folderTotals, leftOutLine, leftOutTotal, listRows, OLD_TOOL_WARNING, phoneModelLine, reportData, selectionTotals, splitLeftOut, toggleFolder, untickEveryRow, withoutExcluded } from './phoneBackupModel';

type Step =
  | { name: 'idle' }
  | { name: 'looking'; jobId: number }
  | { name: 'refused'; message: string; backupId: number; canAccept: string | null }
  | { name: 'preview'; plan: PhonePlanView; planId: string }
  | { name: 'running'; jobId: number; driveLabel: string | null }
  | { name: 'done'; jobId: number; report: PhoneBackupReport | null; job: JobRecord | null };

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * "Back up <phone> now": the prompt for a connected phone, then look, preview with ticks, confirm, progress and report (PLAN section 6).
 * Nothing here starts by itself; every step waits for a click.
 */
export function PhoneBackupPanel({ phone, onFinished, onChoicesChanged, onOpenChoices, rulesVersion = 0, embedded = false, resume = null, autoStart = false, fromOldTool = false, onStarted, onReleased }: { phone: ConnectedPhone; /** The phone was told "Safe to unplug": the screen asks which phones are plugged in again (it will say it is safe to unplug). */ onReleased?: () => void; /** On a backup's page: no card of its own, no "Check old copies" or "Not covered" (they have their own sections). */ embedded?: boolean; /** A look or copy of this backup that is still going (the page was left and opened again): picked up instead of the button. */ resume?: ResumeJob | null; /** Look at the phone at once (the "Back up now" button of the list asked for it). */ autoStart?: boolean; /** The backup came from the old PhoneBackup: only then the warning not to run it again is shown. */ fromOldTool?: boolean; onStarted?: () => void; onFinished: () => void; /** A choice was saved or taken back (the list of backups shows how many there are). */ onChoicesChanged?: () => void; /** Opens the Exclusions of this backup. */ onOpenChoices?: () => void; /** Goes up when the Exclusions drawer changed something: the choices are read again. */ rulesVersion?: number }) {
  const [step, setStep] = useState<Step>(() => (resume ? (resume.phase === 'look' ? { name: 'looking', jobId: resume.jobId } : { name: 'running', jobId: resume.jobId, driveLabel: resume.driveLabel }) : { name: 'idle' }));
  const [message, setMessage] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set());
  // What the person told this backup (never back up / always include): a row a "never back up" names shows as Excluded in the list.
  const [rules, setRules] = useState<readonly RuleView[]>([]);
  // A "never back up" or "always include" waiting for Save or Cancel (with the left-out group it came from, when it came from one), and the line after one was saved.
  const [pending, setPending] = useState<{ draft: RuleDraft; groupKey: string | null } | null>(null);
  const toast = useToast();
  const [note, setNote] = useState<string | null>(null);
  const { jobs } = useJobs();
  const job = step.name === 'looking' || step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;

  const begin = (accept?: string[]): void => {
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.phoneBackup.look(phone.backupId, accept);
        if (r.ok && r.jobId !== null) setStep({ name: 'looking', jobId: r.jobId });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
    })();
  };

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || !phone.driveConnected) return;
    started.current = true;
    begin();
    onStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResult = useCallback(
    (jobId: number, result: PhoneLookResult | null): void => {
      if (result === null) return;
      if (result.ok) {
        setUnticked(new Set());
        setIncluded(new Set());
        setPending(null);
        setNote(null);
        setStep({ name: 'preview', plan: result.plan, planId: result.plan.planId });
      } else setStep({ name: 'refused', message: result.message, backupId: phone.backupId, canAccept: result.decision?.canAccept ? result.decision.kind : null });
      void jobId;
    },
    [phone.backupId],
  );

  // A look that has ended: ask main for its answer (the plan stays in main; the window only gets the list to show).
  const lookState = step.name === 'looking' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'looking' || (lookState !== 'done' && lookState !== 'done_warnings' && lookState !== 'failed')) return;
    const jobId = step.jobId;
    void (async () => {
      try {
        const result = await window.backupHub.phoneBackup.preview(jobId);
        if (result === null) setStep({ name: 'refused', message: job?.error ?? 'The look did not finish.', backupId: phone.backupId, canAccept: null });
        else handleResult(jobId, result);
      } catch {
        setStep({ name: 'refused', message: 'The look did not finish.', backupId: phone.backupId, canAccept: null });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookState]);

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || (runState !== 'done' && runState !== 'done_warnings' && runState !== 'failed')) return;
    const jobId = step.jobId;
    void (async () => {
      let report: PhoneBackupReport | null = null;
      try {
        report = await window.backupHub.phoneBackup.report(jobId);
      } catch {
        report = null;
      }
      setStep({ name: 'done', jobId, report, job });
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const plan = step.name === 'preview' ? step.plan : null;
  const rows = useMemo(() => (plan ? listRows(plan.rows) : []), [plan]);
  const excluded = useMemo(() => excludedBy(rows, rules), [rows, rules]);
  // An excluded row is not in any count, tick or folder total: it is never copied.
  const liveRows = useMemo(() => withoutExcluded(plan?.rows ?? [], excluded), [plan, excluded]);
  const exclusionCount = useMemo(() => rules.filter((r) => r.choice === 'leave_out').length, [rules]);
  const folders = useMemo(() => (plan ? folderTotals(liveRows, unticked).slice(0, 12) : []), [plan, liveRows, unticked]);
  // While the copy runs, main is asked once a second how it is going; the timer stops when the run ends or the panel goes away.
  const progress = useRunProgress(step.name === 'running' ? step.jobId : null, step.name === 'running');
  const shownProgress = step.name === 'running' && progress?.jobId === step.jobId ? progress : null;
  const sel = plan ? selectionTotals({ rows: liveRows, leftOut: plan.leftOut }, unticked, included) : { files: 0, bytes: 0 };
  const leftOutSplit = useMemo(() => splitLeftOut(plan?.leftOut ?? []), [plan]);
  const tickedFolderCount = folders.filter((f) => f.tickedFiles > 0).length;
  const modelLine = phoneModelLine(phone.backupName, phone.phoneName);

  const confirm = (): void => {
    if (step.name !== 'preview') return;
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.phoneBackup.start({ planId: step.planId, hash: step.plan.hash, unticked: [...unticked, ...excluded.keys()], untickedFolders: [], included: [...included] });
        if (r.ok && r.jobId !== null) setStep({ name: 'running', jobId: r.jobId, driveLabel: step.plan.driveLabel });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was copied.');
      }
    })();
  };

  const readRules = useCallback((): void => {
    void (async () => {
      try {
        const r = await window.backupHub.rules.list(phone.backupId);
        if (r.ok) setRules(r.rules);
      } catch {
        // The list simply shows no excluded rows; main still drops what a choice names when the copy is confirmed.
      }
    })();
  }, [phone.backupId]);
  // The choices are read when a list opens and again whenever the Exclusions drawer changed something.
  const openPlanId = step.name === 'preview' ? step.planId : null;
  useEffect(() => {
    if (openPlanId !== null) readRules();
  }, [openPlanId, rulesVersion, readRules]);

  // A row that was excluded and is not any more (Undo, here or in the drawer) comes back ticked.
  const wasExcluded = useRef<ReadonlyMap<string, RuleView>>(new Map());
  useEffect(() => {
    const back = [...wasExcluded.current.keys()].filter((p) => !excluded.has(p));
    wasExcluded.current = excluded;
    if (back.length > 0) setUnticked((cur) => new Set([...cur].filter((p) => !back.includes(p))));
  }, [excluded]);

  const choiceSaved = (draft: RuleDraft, result: Extract<RuleAddResult, { ok: true }>): void => {
    // Saved in main; the open list shows the rows the choice names as Excluded (main still checks the list it confirms).
    setRules((cur) => (cur.some((r) => r.id === result.rule.id) ? cur : [...cur, result.rule]));
    if (draft.choice === 'include' && pending?.groupKey) {
      const key = pending.groupKey;
      setIncluded((cur) => new Set([...cur, key]));
    }
    setNote(result.message);
    toast.show({ tone: 'ok', text: result.message });
    setPending(null);
    onChoicesChanged?.();
  };

  // Undo on an excluded row: an explicit click, so nothing to confirm (it deletes nothing; the file is offered again).
  const undoExclusion = (rule: RuleView): void => {
    void (async () => {
      try {
        const result = await window.backupHub.rules.remove({ backupId: phone.backupId, ruleId: rule.id, confirmed: true });
        if (result.ok) {
          setRules((cur) => cur.filter((r) => r.id !== rule.id));
          setNote(null);
          toast.show({ tone: 'ok', text: BACK_IN_LINE });
          onChoicesChanged?.();
        } else setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
    })();
  };

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setMessage('That did not work. Please try again.'));

  return (
    <Frame embedded={embedded} title={cardTitle(phone.backupName)} accent="phone">
      <div className="settings-stack">
        {step.name === 'idle' ? (
          <>
            {modelLine ? <span className="cell-sub">{modelLine}</span> : null}
            <span className="cell-sub">Looks at the phone and shows you the list first. Nothing is copied until you confirm.</span>
            {!phone.driveConnected ? <span role="alert" className="cell-sub">The drive for this backup is not plugged in.</span> : null}
            <span className="settings-actions">
              <Button variant="primary" disabled={!phone.driveConnected} onClick={() => begin()}>
                {backUpNowButton(phone.backupName)}
              </Button>
              <SafeUnplugButton {...(onReleased ? { onDone: onReleased } : {})} />
            </span>
          </>
        ) : null}
        {step.name === 'looking' ? (
          <span role="status" className="cell-sub">
            {job?.message ?? 'Looking at the phone. This can take a few minutes. Nothing is copied.'}
          </span>
        ) : null}
        {step.name === 'refused' ? (
          <>
            <span role="alert" className="cell-sub">{step.message}</span>
            <span className="settings-actions">
              <Button variant="primary" onClick={() => begin()}>Try again</Button>
              {step.canAccept ? <Button onClick={() => begin([step.canAccept!])}>Accept this list</Button> : null}
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>Cancel</Button>
            </span>
          </>
        ) : null}
        {plan ? (
          <>
            <b>
              {formatCount(plan.totals.files)} files ({formatBytes(plan.totals.bytes)}) are new or changed. They will go to {plan.driveLabel}, folder {plan.folderWords}.
            </b>
            {plan.blocked ? <span role="alert" className="cell-sub">{plan.blocked}</span> : null}
            {pending && step.name === 'preview' ? (
              // A drawer, not a line above the list: the list is long and scrolled, and a confirm above it was out of sight.
              <Drawer title={pending.draft.choice === 'leave_out' ? 'Exclude from this backup' : 'Always include in this backup'} onClose={() => setPending(null)}>
                <ChoiceConfirm key={`${pending.draft.scope}|${pending.draft.choice}|${pending.draft.pattern}`} backupId={phone.backupId} planId={step.planId} draft={pending.draft} onSaved={choiceSaved} onCancel={() => setPending(null)} />
              </Drawer>
            ) : null}
            {note ? <span role="status" className="cell-sub">{note}</span> : null}
            <PhoneFileList rows={rows} unticked={unticked} onUntickedChange={setUnticked} confirmLabel={confirmText(sel, plan.driveLabel)} canConfirm={sel.files > 0} onConfirm={confirm} onChoose={(draft) => setPending({ draft, groupKey: null })} backupId={plan.backupId} excluded={excluded} onUndo={undoExclusion} exclusionCount={exclusionCount} {...(onOpenChoices ? { onOpenExclusions: onOpenChoices } : {})} />
            <span className="cell-sub">
              Already backed up: {formatCount(plan.alreadyBackedUp)} files.
              {plan.confirmedOnDrive > 0 ? ` ${formatCount(plan.confirmedOnDrive)} more were already on the drive and are confirmed by the phone's checksum, so they are linked and not copied.` : ''}
              {plan.notConfirmed > 0 ? ` ${formatCount(plan.notConfirmed)} seemed to be copies already on the drive but did not match, so they will be copied as new files.` : ''}
            </span>
            {plan.notes.map((n) => (
              <span key={n} className="cell-sub">{n}</span>
            ))}
            {folders.length > 0 ? (
              <details className="more">
                <summary>By folder</summary>
                <div className="cell-stack cell-stack--tight" role="group" aria-label="Folders">
                  <span className="preview-list__bulk">
                    <Button size="sm" variant="quiet" disabled={tickedFolderCount === 0} onClick={() => setUnticked((cur) => new Set([...cur, ...untickEveryRow(liveRows)]))}>
                      Untick all
                    </Button>
                    <Button size="sm" variant="quiet" disabled={unticked.size === 0} onClick={() => setUnticked(new Set())}>
                      Tick all
                    </Button>
                  </span>
                  <span className="cell-sub" role="status">
                    {tickedOfText(tickedFolderCount, folders.length)}
                  </span>
                  {folders.map((f) => (
                    <span key={f.folder} className="cell-sub">
                      <label>
                        <input type="checkbox" checked={f.tickedFiles > 0} onChange={() => setUnticked(toggleFolder(liveRows, unticked, f.folder))} /> {f.folder}: {formatCount(f.tickedFiles)} of {formatCount(f.files)} files, {formatBytes(f.bytes)}
                      </label>
                      {folderChoice(f.folder) ? (
                        <PopupMenu label={`Exclude or include ${f.folder}`} trigger="Choose" items={[{ id: 'folder', label: folderChoice(f.folder)!.label, hint: f.folder, onSelect: () => setPending({ draft: folderChoice(f.folder)!.draft, groupKey: null }) }]} />
                      ) : null}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}
            {leftOutSplit.byYou.length > 0 ? (
              <div className="cell-stack cell-stack--tight" role="group" aria-label="Left out by your choice">
                <b>
                  Left out by your choice: {formatCount(leftOutTotal(leftOutSplit.byYou).files)} files, {formatBytes(leftOutTotal(leftOutSplit.byYou).bytes)}. They are not in the list above and will not be copied.
                </b>
                {leftOutSplit.byYou.slice(0, 40).map((g) => (
                  <span key={g.key} className="cell-sub">{leftOutLine(g)}</span>
                ))}
                {onOpenChoices ? (
                  <span>
                    <Button size="sm" variant="quiet" onClick={onOpenChoices}>Change your choices</Button>
                  </span>
                ) : null}
              </div>
            ) : null}
            {leftOutSplit.byFilters.length > 0 ? (
              <div className="cell-stack cell-stack--tight" role="group" aria-label="Left out">
                <b>
                  Left out: {formatCount(leftOutTotal(leftOutSplit.byFilters).files)} files, {formatBytes(leftOutTotal(leftOutSplit.byFilters).bytes)}. Nothing is dropped silently: include any group for this backup only, or always include it.
                </b>
                {leftOutSplit.byFilters.slice(0, 40).map((g) => (
                  <span key={g.key} className="cell-sub">
                    {leftOutLine(g)}{' '}
                    {g.canInclude ? (
                      <Button size="sm" variant="quiet" onClick={() => setIncluded((cur) => { const next = new Set(cur); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next; })}>
                        {included.has(g.key) ? 'Left in (undo)' : 'Include'}
                      </Button>
                    ) : null}
                    {g.canInclude && includeChoice(g.folder) ? (
                      <Button size="sm" variant="quiet" onClick={() => setPending({ draft: includeChoice(g.folder)!, groupKey: g.key })}>Always include</Button>
                    ) : null}
                  </span>
                ))}
                {leftOutSplit.byFilters.length > 40 ? <span className="cell-sub">And {leftOutSplit.byFilters.length - 40} smaller groups.</span> : null}
              </div>
            ) : null}
            <span className="settings-actions">
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>Cancel</Button>
            </span>
          </>
        ) : null}
        {step.name === 'running' ? (
          job && job.state === 'needs_you' ? (
            <>
              <span role="alert" className="cell-sub">{job.message ?? 'The backup is waiting for you.'}</span>
              <span className="settings-actions">
                {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
                  <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>{c}</Button>
                ))}
              </span>
            </>
          ) : (
            <>
            <ProgressPanel
              what={copyingTitle(phone.backupName, step.driveLabel)}
              detail={<CopyingNow progress={shownProgress} />}
              {...(job ? { doneBytes: job.bytesDone, totalBytes: job.bytesTotal, doneFiles: job.progressDone, totalFiles: job.progressTotal, bytesPerSecond: job.speed?.unit === 'bytes' ? job.speed.perSecond : null, filesPerSecond: job.speed?.unit === 'bytes' ? job.speed.itemsPerSecond : null, ...elapsedProps(job.startedAt, Date.now(), job.pausedMs) } : {})}
              paused={job?.paused === true}
              pausing={job?.pausing === true}
              onPause={() => job && act(() => window.backupHub.jobs.pause(job.id))}
              onResume={() => job && act(() => window.backupHub.jobs.resume(job.id))}
              onStop={() => job && act(() => window.backupHub.jobs.cancel(job.id))}
            />
            <CopyLists progress={shownProgress} backupId={phone.backupId} />
            </>
          )
        ) : null}
        {step.name === 'done' ? (
          <>
            {step.report ? (
              <>
                <Report data={reportData(step.report, when)} title="Phone backup report" />
                {step.report.copied.files > 0 ? <CopiedFilesFold jobId={step.jobId} copiedCount={step.report.copied.files} backupId={phone.backupId} /> : null}
                {step.report.leftOut.files > 0 ? <span className="cell-sub">Left out on purpose (the filters and your choices): {formatCount(step.report.leftOut.files)} files, {formatBytes(step.report.leftOut.bytes)}.</span> : null}
                {step.report.notCovered.map((n) => (
                  <span key={n} className="cell-sub">Not covered: {n}</span>
                ))}
                {step.report.listPath ? <span className="cell-sub">The list of this run is on the drive: {step.report.listPath}</span> : null}
                {step.report.listProblem ? <span role="alert" className="cell-sub">{step.report.listProblem}</span> : null}
                <DecisionsAfterRun backupId={phone.backupId} since={step.report.startedAt} />
                {embedded ? null : <NotCoveredCard backupId={phone.backupId} framed={false} />}
                {fromOldTool ? <b>{OLD_TOOL_WARNING}</b> : null}
              </>
            ) : (
              <span role="alert" className="cell-sub">{step.job?.error ?? 'The backup stopped. See Activity for what happened. Nothing was deleted.'}</span>
            )}
            <span className="settings-actions">
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>Done</Button>
            </span>
          </>
        ) : null}
        {step.name === 'idle' && !embedded ? <CheckOldCopies phone={phone} onFinished={onFinished} /> : null}
        {step.name === 'idle' && !embedded ? <NotCoveredCard backupId={phone.backupId} framed={false} /> : null}
        {message ? <span role="alert" className="cell-sub">{message}</span> : null}
      </div>
    </Frame>
  );
}
