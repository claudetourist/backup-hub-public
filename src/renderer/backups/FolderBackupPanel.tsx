import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from '../components/Drawer';
import { useToast } from '../components/Toast';
import type { JobRecord } from '../../shared/jobs';
import { KEEP_SYNC_PRIVACY, type FolderBackupCard, type FolderBackupReport, type FolderLookResult, type FolderPlanView } from '../../shared/folderBackup';
import type { RuleAddResult, RuleDraft, RuleView } from '../../shared/rules';
import { FOLDER_ROOT_FOLDER } from '../../shared/rules';
import { Button } from '../components/Button';
import { ProgressPanel } from '../components/ProgressPanel';
import { Report } from '../components/Report';
import { Frame } from './Frame';
import type { ResumeJob } from './backupListModel';
import { PopupMenu } from '../components/PopupMenu';
import { useJobs } from '../jobs/JobsProvider';
import { formatBytes, formatCount } from '../lib/format';
import { PhoneFileList } from './PhoneFileList';
import { ChoiceConfirm } from './ChoiceConfirm';
import { BACK_IN_LINE, folderChoice } from './choicesModel';
import { CopiedFilesFold, CopyingNow, CopyLists, useRunProgress } from './PhoneCopyLists';
import { elapsedProps } from '../components/progressModel';
import { tickedOfText } from '../components/previewModel';
import { copyingTitle, confirmText, excludedBy, folderTotals, leftOutLine, leftOutTotal, listRows, selectionTotals, splitLeftOut, toggleFolder, untickEveryRow, withoutExcluded } from './phoneBackupModel';
import { alreadyLine, FOLDER_OLD_TOOL_WARNING, folderButton, folderCardTitle, folderIdleLines, folderReportData, looking, movedLines, onlineOnlyLine } from './folderBackupModel';

type Step =
  | { name: 'idle' }
  | { name: 'looking'; jobId: number }
  | { name: 'refused'; message: string }
  | { name: 'preview'; plan: FolderPlanView; planId: string }
  | { name: 'running'; jobId: number; driveLabel: string | null }
  | { name: 'done'; jobId: number; report: FolderBackupReport | null; job: JobRecord | null };

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * "Back up <folder> now": look, a list with ticks, confirm, progress and report. The same steps and pieces as the phone backup's panel (PLAN section 6),
 * for a folder on this computer (OneDrive, a data folder) and for the Google Keep notes. Nothing here starts by itself; every step waits for a click.
 */
export function FolderBackupPanel({ card, onFinished, onChoicesChanged, onOpenChoices, rulesVersion = 0, embedded = false, resume = null, autoStart = false, fromOldTool = false, onStarted }: { card: FolderBackupCard; /** On a backup's page: no card of its own (the page title says which backup it is). */ embedded?: boolean; /** A look or copy of this backup that is still going (the page was left and opened again): picked up instead of the button. */ resume?: ResumeJob | null; /** Look at the folder at once (the "Back up now" button of the list asked for it). */ autoStart?: boolean; /** The backup came from the old PhoneBackup: only then the warning not to run it again is shown. */ fromOldTool?: boolean; onStarted?: () => void; onFinished: () => void; /** An exclusion was saved or taken back (the list of backups shows how many there are). */ onChoicesChanged?: () => void; /** Opens the Exclusions of this backup. */ onOpenChoices?: () => void; /** Goes up when the Exclusions drawer changed something: the choices are read again. */ rulesVersion?: number }) {
  const keep = card.layout === 'flat';
  const [step, setStep] = useState<Step>(() => (resume ? (resume.phase === 'look' ? { name: 'looking', jobId: resume.jobId } : { name: 'running', jobId: resume.jobId, driveLabel: resume.driveLabel }) : { name: 'idle' }));
  const [message, setMessage] = useState<string | null>(null);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [rules, setRules] = useState<readonly RuleView[]>([]);
  const [pending, setPending] = useState<{ draft: RuleDraft } | null>(null);
  const toast = useToast();
  const [note, setNote] = useState<string | null>(null);
  const { jobs } = useJobs();
  const job = step.name === 'looking' || step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;

  const begin = (): void => {
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.folderBackup.look(card.backupId);
        if (r.ok && r.jobId !== null) setStep({ name: 'looking', jobId: r.jobId });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
    })();
  };

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || !card.driveConnected) return;
    started.current = true;
    begin();
    onStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResult = useCallback((result: FolderLookResult | null): void => {
    if (result === null) return;
    if (result.ok) {
      setUnticked(new Set());
      setPending(null);
      setNote(null);
      setStep({ name: 'preview', plan: result.plan, planId: result.plan.planId });
    } else setStep({ name: 'refused', message: result.message });
  }, []);

  // A look that has ended: ask main for its answer (the plan stays in main; the window only gets the list to show).
  const lookState = step.name === 'looking' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'looking' || (lookState !== 'done' && lookState !== 'done_warnings' && lookState !== 'failed')) return;
    const jobId = step.jobId;
    void (async () => {
      try {
        const result = await window.backupHub.folderBackup.preview(jobId);
        if (result === null) setStep({ name: 'refused', message: job?.error ?? 'The look did not finish.' });
        else handleResult(result);
      } catch {
        setStep({ name: 'refused', message: 'The look did not finish.' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookState]);

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || (runState !== 'done' && runState !== 'done_warnings' && runState !== 'failed')) return;
    const jobId = step.jobId;
    void (async () => {
      let report: FolderBackupReport | null = null;
      try {
        report = await window.backupHub.folderBackup.report(jobId);
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
  const liveRows = useMemo(() => withoutExcluded(plan?.rows ?? [], excluded), [plan, excluded]);
  const exclusionCount = useMemo(() => rules.filter((r) => r.choice === 'leave_out').length, [rules]);
  const folders = useMemo(() => (plan && !keep ? folderTotals(liveRows, unticked).slice(0, 12) : []), [plan, liveRows, unticked, keep]);
  const progress = useRunProgress(step.name === 'running' ? step.jobId : null, step.name === 'running', 'folder');
  const shownProgress = step.name === 'running' && progress?.jobId === step.jobId ? progress : null;
  const sel = plan ? selectionTotals({ rows: liveRows, leftOut: plan.leftOut }, unticked, new Set()) : { files: 0, bytes: 0 };
  const leftOutSplit = useMemo(() => splitLeftOut(plan?.leftOut ?? []), [plan]);
  const tickedFolderCount = folders.filter((f) => f.tickedFiles > 0).length;

  const confirm = (): void => {
    if (step.name !== 'preview') return;
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.folderBackup.start({ planId: step.planId, hash: step.plan.hash, unticked: [...unticked, ...excluded.keys()], untickedFolders: [], included: [] });
        if (r.ok && r.jobId !== null) setStep({ name: 'running', jobId: r.jobId, driveLabel: step.plan.driveLabel });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was copied.');
      }
    })();
  };

  const readRules = useCallback((): void => {
    if (keep) return;
    void (async () => {
      try {
        const r = await window.backupHub.rules.list(card.backupId);
        if (r.ok) setRules(r.rules);
      } catch {
        // The list simply shows no excluded rows; main still drops what an exclusion names when the copy is confirmed.
      }
    })();
  }, [card.backupId, keep]);
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

  const choiceSaved = (_draft: RuleDraft, result: Extract<RuleAddResult, { ok: true }>): void => {
    setRules((cur) => (cur.some((r) => r.id === result.rule.id) ? cur : [...cur, result.rule]));
    setNote(result.message);
    toast.show({ tone: 'ok', text: result.message });
    setPending(null);
    onChoicesChanged?.();
  };

  const undoExclusion = (rule: RuleView): void => {
    void (async () => {
      try {
        const result = await window.backupHub.rules.remove({ backupId: card.backupId, ruleId: rule.id, confirmed: true });
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
  const online = plan ? onlineOnlyLine(plan.onlineOnly) : null;

  return (
    <Frame embedded={embedded} title={folderCardTitle(card)} accent={keep ? 'drive' : 'onedrive'}>
      <div className="settings-stack">
        {step.name === 'idle' ? (
          <>
            {folderIdleLines(card).map((l) => (
              <span key={l} className="cell-sub">{l}</span>
            ))}
            {!card.driveConnected ? <span role="alert" className="cell-sub">The drive for this backup is not plugged in.</span> : null}
            <span className="settings-actions">
              <Button variant="primary" disabled={!card.driveConnected} onClick={begin}>
                {folderButton(card.backupName)}
              </Button>
            </span>
          </>
        ) : null}
        {step.name === 'looking' ? (
          <span role="status" className="cell-sub">
            {job?.message ?? looking(card)}
          </span>
        ) : null}
        {step.name === 'refused' ? (
          <>
            <span role="alert" className="cell-sub">{step.message}</span>
            <span className="settings-actions">
              <Button variant="primary" onClick={begin}>Try again</Button>
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>Cancel</Button>
            </span>
          </>
        ) : null}
        {plan ? (
          <>
            <b>
              {formatCount(plan.totals.files)} files ({formatBytes(plan.totals.bytes)}) {keep ? 'are not on the drive yet' : 'are new or changed'}. They will go to {plan.driveLabel}, folder {plan.folderWords}.
            </b>
            {keep ? <span className="cell-sub">{KEEP_SYNC_PRIVACY}</span> : null}
            {plan.blocked ? <span role="alert" className="cell-sub">{plan.blocked}</span> : null}
            {pending && step.name === 'preview' ? (
              <Drawer title={pending.draft.choice === 'leave_out' ? 'Exclude from this backup' : 'Always include in this backup'} onClose={() => setPending(null)}>
                <ChoiceConfirm key={`${pending.draft.scope}|${pending.draft.choice}|${pending.draft.pattern}`} backupId={card.backupId} planId={step.planId} draft={pending.draft} onSaved={choiceSaved} onCancel={() => setPending(null)} />
              </Drawer>
            ) : null}
            {note ? <span role="status" className="cell-sub">{note}</span> : null}
            <PhoneFileList
              rows={rows}
              unticked={unticked}
              onUntickedChange={setUnticked}
              confirmLabel={confirmText(sel, plan.driveLabel)}
              canConfirm={sel.files > 0}
              onConfirm={confirm}
              {...(keep ? { untickOnly: true } : { onChoose: (draft: RuleDraft) => setPending({ draft }), backupId: plan.backupId, excluded, onUndo: undoExclusion, exclusionCount })}
              {...(!keep && onOpenChoices ? { onOpenExclusions: onOpenChoices } : {})}
            />
            <span className="cell-sub">{alreadyLine(plan)}</span>
            {movedLines(plan).map((line) => (
              <span key={line} className="cell-sub" role="status">
                {line}
              </span>
            ))}
            {online ? <span className="cell-sub" role="status">{online}{plan.onlineOnly.examples.length > 0 ? ` For example: ${plan.onlineOnly.examples.join(', ')}.` : ''}</span> : null}
            {plan.notes.filter((n) => !n.includes('online only') && !n.includes('same content') && !n.includes('another size')).map((n) => (
              <span key={n} className="cell-sub">{n}</span>
            ))}
            {folders.length > 0 ? (
              <details className="more">
                <summary>By folder</summary>
                <div className="cell-stack cell-stack--tight" role="group" aria-label="Folders">
                  <span className="preview-list__bulk">
                    <Button size="sm" variant="quiet" disabled={tickedFolderCount === 0} onClick={() => setUnticked((cur) => new Set([...cur, ...untickEveryRow(liveRows)]))}>Untick all</Button>
                    <Button size="sm" variant="quiet" disabled={unticked.size === 0} onClick={() => setUnticked(new Set())}>Tick all</Button>
                  </span>
                  <span className="cell-sub" role="status">{tickedOfText(tickedFolderCount, folders.length)}</span>
                  {folders.map((f) => (
                    <span key={f.folder} className="cell-sub">
                      <label>
                        <input type="checkbox" checked={f.tickedFiles > 0} onChange={() => setUnticked(toggleFolder(liveRows, unticked, f.folder))} /> {f.folder}: {formatCount(f.tickedFiles)} of {formatCount(f.files)} files, {formatBytes(f.bytes)}
                      </label>
                      {folderChoice(f.folder, FOLDER_ROOT_FOLDER) ? (
                        <PopupMenu label={`Exclude or include ${f.folder}`} trigger="Choose" items={[{ id: 'folder', label: folderChoice(f.folder, FOLDER_ROOT_FOLDER)!.label, hint: f.folder, onSelect: () => setPending({ draft: folderChoice(f.folder, FOLDER_ROOT_FOLDER)!.draft }) }]} />
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
                what={copyingTitle(card.backupName, step.driveLabel)}
                detail={<CopyingNow progress={shownProgress} />}
                {...(job ? { doneBytes: job.bytesDone, totalBytes: job.bytesTotal, doneFiles: job.progressDone, totalFiles: job.progressTotal, bytesPerSecond: job.speed?.unit === 'bytes' ? job.speed.perSecond : null, filesPerSecond: job.speed?.unit === 'bytes' ? job.speed.itemsPerSecond : null, ...elapsedProps(job.startedAt, Date.now(), job.pausedMs) } : {})}
                paused={job?.paused === true}
              pausing={job?.pausing === true}
                onPause={() => job && act(() => window.backupHub.jobs.pause(job.id))}
                onResume={() => job && act(() => window.backupHub.jobs.resume(job.id))}
                onStop={() => job && act(() => window.backupHub.jobs.cancel(job.id))}
              />
              <CopyLists progress={shownProgress} {...(keep ? {} : { backupId: card.backupId })} />
            </>
          )
        ) : null}
        {step.name === 'done' ? (
          <>
            {step.report ? (
              <>
                <Report data={folderReportData(step.report, when)} title="Folder backup report" />
                {step.report.copied.files > 0 ? <CopiedFilesFold jobId={step.jobId} copiedCount={step.report.copied.files} kind="folder" {...(keep ? {} : { backupId: card.backupId })} /> : null}
                {step.report.leftOut.files > 0 ? <span className="cell-sub">Left out by your choice: {formatCount(step.report.leftOut.files)} files, {formatBytes(step.report.leftOut.bytes)}.</span> : null}
                {onlineOnlyLine(step.report.onlineOnly) ? <span className="cell-sub">{onlineOnlyLine(step.report.onlineOnly)}</span> : null}
                {step.report.listPath ? <span className="cell-sub">The list of this run is on the drive: {step.report.listPath}</span> : null}
                {step.report.listProblem ? <span role="alert" className="cell-sub">{step.report.listProblem}</span> : null}
                {keep ? <span className="cell-sub">{KEEP_SYNC_PRIVACY}</span> : fromOldTool ? <b>{FOLDER_OLD_TOOL_WARNING}</b> : null}
              </>
            ) : (
              <span role="alert" className="cell-sub">{step.job?.error ?? 'The backup stopped. See Activity for what happened. Nothing was deleted.'}</span>
            )}
            <span className="settings-actions">
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>Done</Button>
            </span>
          </>
        ) : null}
        {message ? <span role="alert" className="cell-sub">{message}</span> : null}
      </div>
    </Frame>
  );
}
