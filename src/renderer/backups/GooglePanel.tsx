import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobRecord } from '../../shared/jobs';
import type { GoogleCopyMoreResult, GoogleCopyPlan, GoogleCopyPreview, GoogleCopyReport, GoogleCopyStatus, GooglePlanLine, GoogleSentLine } from '../../shared/googleCopy';
import { ACCOUNTS_FULL_MESSAGE, googleStatusLine } from '../../shared/googleCopy';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { ProgressPanel } from '../components/ProgressPanel';
import { Report } from '../components/Report';
import { elapsedProps } from '../components/progressModel';
import { useJobs } from '../jobs/JobsProvider';
import type { ResumeJob } from './backupListModel';
import { AccountPicker } from './AccountPicker';
import { GoogleSummaryBar, StepHeading } from './GoogleSummary';
import {
  accountGetLines,
  cannotStart,
  capacitySummary,
  CHECK_BUTTON,
  confirmLines,
  ACCOUNTS_SUGGESTED_NOTE,
  GOOGLE_COUNTING,
  GOOGLE_LEAVE_OUT_NOTE,
  GOOGLE_LOADING,
  GOOGLE_STEP_1,
  GOOGLE_STEP_2,
  GOOGLE_STEP_3,
  GOOGLE_TITLE,
  googleReportData,
  initialAccountTicks,
  FIT_LABEL,
  FIT_NOTE,
  fitIsOn,
  fitLine,
  ONLY_ON_PHONE_LABEL,
  ONLY_ON_PHONE_NOTE,
  RECOUNTING,
  kindProgress,
  kindSize,
  moreAccountTicks,
  moreSummary,
  pickedAccounts,
  progressLine,
  repeatLine,
  reportSummaryLine,
  rowsWithTicks,
  runningAccountLines,
  seenRoom,
  startButton,
  stepOneNote,
  stepTwoNote,
  suggestionNote,
  tickedAccountIds,
  tickedKinds,
  shortBytes,
  type PlanState,
  suggestedAccountTicks,
} from './googleModel';
import { shortLine, toPlaceBytes } from '../../shared/googleCopy';

type Step =
  | { name: 'idle' }
  | { name: 'loading' }
  | { name: 'capacity'; preview: GoogleCopyPreview; ticks: ReadonlySet<string>; accountTicks: ReadonlySet<string>; note: string | null; /** The person changed the account ticks here: the suggestion no longer follows the kinds. */ accountsEdited?: boolean; /** "Fit what I have room for": the person's own choice (absent = on when what is ticked is bigger than the room). */ fit?: boolean | null }
  | { name: 'confirm'; preview: GoogleCopyPreview; ticks: ReadonlySet<string>; accountTicks: ReadonlySet<string>; note: string | null; fit?: boolean | null }
  | { name: 'running'; jobId: number; /** What each account was planned to get when the person confirmed (null after a restart). */ plan: GooglePlanLine[] | null }
  | { name: 'done'; jobId: number; report: GoogleCopyReport | null; job: JobRecord | null };

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const finished = (state: string | undefined): boolean => state === 'done' || state === 'done_warnings' || state === 'failed';

/** The real per-file plan for the ticked kinds and accounts, asked from main a moment after the ticks change (null = nothing to plan, 'loading' = being worked out). */
function usePlan(backupId: number, kinds: string[], accountIds: string[], on: boolean, onlyOnPhone: boolean, fitBiggest: boolean): PlanState {
  const key = JSON.stringify([backupId, kinds, accountIds, onlyOnPhone, fitBiggest]);
  const want = on && kinds.length > 0 && accountIds.length > 0;
  const [got, setGot] = useState<{ key: string; plan: GoogleCopyPlan } | null>(null);
  useEffect(() => {
    if (!want) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      void window.backupHub.googleCopy
        .plan({ backupId, kinds, accountIds, onlyOnPhone, fitBiggest })
        .then((r) => {
          if (alive && r.ok) setGot({ key, plan: r.plan });
          return undefined;
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, want]);
  if (!want) return null;
  return got && got.key === key ? got.plan : 'loading';
}

/** What each ticked account was sent so far in the copy (asked from main every second while the copy is on this screen). */
function useSent(jobId: number | null): GoogleSentLine[] {
  const [lines, setLines] = useState<GoogleSentLine[]>([]);
  useEffect(() => {
    if (jobId === null) return undefined;
    let alive = true;
    const load = (): void => {
      void window.backupHub.googleCopy
        .sent(jobId)
        .then((r) => {
          if (alive) setLines(r);
          return undefined;
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId]);
  return lines;
}

type More = Extract<GoogleCopyMoreResult, { ok: true }>;

/**
 * The Google section of a backup's page: one line (how much is on Google, how much to go), one button "Copy to Google". The button opens the capacity
 * screen BEFORE anything is sent: the kinds of file (videos first), "Which accounts?" (live space, Backup Hub's suggestion pre-ticked, the person
 * changes the ticks), and the live verdict. "Use these N accounts and copy" opens a confirm step that lists the accounts by email and where the files
 * go; only its button starts the job. It stays off while any file does not fit. When the ticked accounts fill up the copy waits and the picker comes
 * back (a new suggestion, to be confirmed again). Nothing starts by itself and no account is used that the person did not confirm.
 */
export function GooglePanel({ backupId, onFinished, resume = null }: { backupId: number; onFinished: () => void; resume?: ResumeJob | null }) {
  const [step, setStep] = useState<Step>(() => (resume ? { name: 'running', jobId: resume.jobId, plan: null } : { name: 'idle' }));
  const [status, setStatus] = useState<GoogleCopyStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [more, setMore] = useState<{ data: More; ticks: ReadonlySet<string>; confirm: boolean } | null>(null);
  const { jobs } = useJobs();
  const job = step.name === 'running' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;
  const sent = useSent(step.name === 'running' && !finished(job?.state) ? step.jobId : null);

  const loadStatus = useCallback((): void => {
    void (async () => {
      try {
        const r = await window.backupHub.googleCopy.status(backupId);
        if (r.ok) setStatus(r.status);
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Please try again.');
      }
    })();
  }, [backupId]);
  useEffect(loadStatus, [loadStatus]);

  const runState = step.name === 'running' ? job?.state : undefined;
  useEffect(() => {
    if (step.name !== 'running' || !finished(runState)) return;
    const jobId = step.jobId;
    void (async () => {
      let report: GoogleCopyReport | null = null;
      try {
        report = await window.backupHub.googleCopy.report(jobId);
      } catch {
        report = null;
      }
      setStep({ name: 'done', jobId, report, job });
      loadStatus();
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  // The copy waits because the accounts the person picked are full: the picker comes back with a new suggestion.
  const waitingFull = step.name === 'running' && job?.state === 'needs_you' && job.message === ACCOUNTS_FULL_MESSAGE;
  const waitingJobId = waitingFull ? job.id : null;
  useEffect(() => {
    if (waitingJobId === null) {
      setMore(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const r = await window.backupHub.googleCopy.more(waitingJobId);
        if (!alive) return;
        if (r.ok) setMore({ data: r, ticks: moreAccountTicks(r.preview, r.inUse, r.needBytes), confirm: false });
        else setMessage(r.message);
      } catch {
        if (alive) setMessage('That did not work. Please try again.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [waitingJobId]);

  const [recounting, setRecounting] = useState(false);
  const capacity = step.name === 'capacity' || step.name === 'confirm' ? step : null;
  const fitOn = capacity !== null && fitIsOn(capacity.preview, capacity.ticks, capacity.accountTicks, capacity.fit ?? null);
  const capacityPlan = usePlan(backupId, capacity ? tickedKinds(capacity.preview.kinds, capacity.ticks) : [], capacity ? tickedAccountIds(capacity.preview, capacity.accountTicks) : [], capacity !== null, capacity?.preview.onlyOnPhone === true, fitOn);
  const moreFit = more?.data.fitBiggest === true;
  const morePlan = usePlan(backupId, more ? more.data.kinds : [], more ? tickedAccountIds(more.data.preview, more.ticks) : [], more !== null, more?.data.onlyOnPhone === true, moreFit);

  const open = (): void => {
    setMessage(null);
    setStep({ name: 'loading' });
    void (async () => {
      try {
        // A phone backup opens with "Only what is still on the phone" on.
        const r = await window.backupHub.googleCopy.preview(backupId, true);
        if (r.ok) {
          const ticks = new Set(r.preview.kinds.filter((k) => k.ticked).map((k) => k.kind));
          setStep({ name: 'capacity', preview: r.preview, ticks, accountTicks: initialAccountTicks(r.preview, ticks), note: suggestionNote(r.preview) });
        } else {
          setMessage(r.message);
          setStep({ name: 'idle' });
        }
      } catch {
        setMessage('That did not work. Nothing was sent.');
        setStep({ name: 'idle' });
      }
    })();
  };

  /** The numbers moved (or the files no longer fit): the same screen again with fresh numbers, the person's ticks kept where they still can be. */
  const reload = (ticks: ReadonlySet<string>, accountTicks: ReadonlySet<string>, why: string, onlyOnPhone: boolean, fit: boolean | null): void => {
    void (async () => {
      try {
        const r = await window.backupHub.googleCopy.preview(backupId, onlyOnPhone);
        if (r.ok) {
          const keep = new Set([...accountTicks].filter((id) => r.preview.accounts.some((a) => a.placeId === id && a.canTake)));
          setStep({ name: 'capacity', preview: r.preview, ticks, accountTicks: keep, note: null, fit });
          setMessage(why);
        } else setMessage(r.message);
      } catch {
        setMessage(why);
      }
    })();
  };

  const start = (): void => {
    if (step.name !== 'confirm') return;
    setMessage(null);
    const { preview, ticks, accountTicks } = step;
    const kinds = tickedKinds(preview.kinds, ticks);
    void (async () => {
      try {
        const r = await window.backupHub.googleCopy.start({ backupId, kinds, accountIds: tickedAccountIds(preview, accountTicks), confirmedAccounts: true, seenRoom: seenRoom(preview, accountTicks), ...(preview.isPhone ? { onlyOnPhone: preview.onlyOnPhone, fitBiggest: fitOn } : {}) });
        if (r.ok) setStep({ name: 'running', jobId: r.jobId, plan: capacityPlan !== null && capacityPlan !== 'loading' ? capacityPlan.lines : null });
        else if (r.changed) reload(ticks, accountTicks, r.message, preview.onlyOnPhone, step.fit ?? null);
        else {
          setMessage(r.message);
          setStep({ name: 'capacity', preview, ticks, accountTicks, note: step.note, fit: step.fit ?? null });
        }
      } catch {
        setMessage('That did not work. Nothing was sent.');
      }
    })();
  };

  const toggle = (kind: string): void => {
    if (step.name !== 'capacity') return;
    const ticks = new Set(step.ticks);
    if (ticks.has(kind)) ticks.delete(kind);
    else ticks.add(kind);
    // Until the person touches the accounts, the suggestion follows the kinds: fewer kinds, fewer accounts.
    if (step.accountsEdited === true) setStep({ ...step, ticks });
    else setStep({ ...step, ticks, accountTicks: suggestedAccountTicks(step.preview, ticks), note: suggestionNote(step.preview) === null ? null : ACCOUNTS_SUGGESTED_NOTE });
  };

  /** "Only what is still on the phone" ticked or unticked: the counts are made again (the person's ticks stay where they still apply). */
  const toggleOnlyOnPhone = (on: boolean): void => {
    if (step.name !== 'capacity') return;
    const before = step;
    setRecounting(true);
    void (async () => {
      try {
        const r = await window.backupHub.googleCopy.preview(backupId, on);
        if (r.ok) {
          const had = new Set(before.preview.kinds.map((k) => k.kind));
          const ticks = new Set(r.preview.kinds.filter((k) => (had.has(k.kind) ? before.ticks.has(k.kind) : k.ticked)).map((k) => k.kind));
          const accountTicks = new Set([...before.accountTicks].filter((id) => r.preview.accounts.some((a) => a.placeId === id && a.canTake)));
          setStep({ ...before, preview: r.preview, ticks, accountTicks });
        } else setMessage(r.message);
      } catch {
        setMessage('That did not work. Please try again.');
      }
      setRecounting(false);
    })();
  };

  const toggleAccount = (placeId: string): void => {
    if (step.name !== 'capacity') return;
    const accountTicks = new Set(step.accountTicks);
    if (accountTicks.has(placeId)) accountTicks.delete(placeId);
    else accountTicks.add(placeId);
    setStep({ ...step, accountTicks, accountsEdited: true });
  };

  const toggleMore = (placeId: string): void => {
    if (!more || more.data.inUse.includes(placeId)) return;
    const ticks = new Set(more.ticks);
    if (ticks.has(placeId)) ticks.delete(placeId);
    else ticks.add(placeId);
    setMore({ ...more, ticks });
  };

  /** The person confirmed more accounts for the waiting copy: they are added, then the copy carries on. */
  const continueWith = (): void => {
    if (!more || !job) return;
    const jobId = job.id;
    const accountIds = tickedAccountIds(more.data.preview, more.ticks);
    setMessage(null);
    void (async () => {
      try {
        const added = await window.backupHub.googleCopy.addAccounts({ jobId, accountIds, confirmedAccounts: true });
        if (!added.ok) {
          setMessage(added.message);
          setMore({ ...more, confirm: false });
          return;
        }
        await window.backupHub.jobs.resolve(jobId, 'Continue');
      } catch {
        setMessage('That did not work. Please try again.');
      }
    })();
  };

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setMessage('That did not work. Please try again.'));
  const preview = capacity ? capacity.preview : null;
  const problem = useMemo(() => (capacity ? cannotStart(capacity.preview, capacity.ticks, capacity.accountTicks, capacityPlan, fitOn) : null), [capacity, capacityPlan, fitOn]);
  const morePicked = more ? pickedAccounts(more.data.preview, more.ticks) : [];
  const summary = capacity ? capacitySummary(capacity.preview, capacity.ticks, capacity.accountTicks, capacityPlan, fitOn) : null;
  const moreSummaryNow = more ? moreSummary(more.data.needBytes, morePicked, morePlan, moreFit) : null;
  const moreShort = more ? shortBytes(more.data.needBytes, morePicked, morePlan, moreFit) : 0;
  const moreProblem = !more ? null : morePicked.length === 0 ? 'Tick at least one Google account.' : moreShort > 0 ? shortLine(moreShort) : morePlan === 'loading' || morePlan === null ? 'Working out where each file goes...' : null;

  return (
    <Panel label={GOOGLE_TITLE} accent="google">
      <div className="settings-stack">
        {step.name === 'idle' ? (
          <>
            <span className="home-backup__when cell-sub" role="status">
              {status ? googleStatusLine(status) : GOOGLE_COUNTING}
            </span>
            <span className="cell-sub">Every file is read again from the drive, sent whole to a Google account you pick, and counted only when Google confirms it. Nothing in Google is ever deleted.</span>
            <span className="settings-actions">
              <Button variant="primary" onClick={open}>
                {GOOGLE_TITLE}
              </Button>
            </span>
          </>
        ) : null}
        {step.name === 'loading' ? (
          <span role="status" className="cell-sub">
            {GOOGLE_LOADING}
          </span>
        ) : null}
        {preview && step.name === 'capacity' ? (
          <>
            {summary ? <GoogleSummaryBar summary={summary} /> : null}
            <StepHeading title={GOOGLE_STEP_1} note={stepOneNote(preview, step.ticks)} />
            {preview.isPhone ? (
              <label className="google-kinds__row">
                <input type="checkbox" checked={preview.onlyOnPhone} disabled={recounting} onChange={(e) => toggleOnlyOnPhone(e.target.checked)} aria-label={ONLY_ON_PHONE_LABEL} /> <b>{ONLY_ON_PHONE_LABEL}</b>{' '}
                <span className="cell-sub">{recounting ? RECOUNTING : ONLY_ON_PHONE_NOTE}</span>
              </label>
            ) : null}
            {preview.kinds.length === 0 ? <span className="cell-sub">{preview.onlyOnPhone ? `Nothing on ${preview.driveLabel} with a checksum is still on the phone. Untick "${ONLY_ON_PHONE_LABEL}" to see everything.` : 'No file with a checksum yet. Run "Check old copies" first.'}</span> : null}
            <ul className="google-kinds" aria-label="Kinds of file">
              {preview.kinds.map((k) => (
                <li key={k.kind} className="google-kinds__row">
                  <label>
                    <input type="checkbox" checked={step.ticks.has(k.kind)} onChange={() => toggle(k.kind)} aria-label={k.label} /> <b>{k.label}</b>
                  </label>{' '}
                  <span className="cell-sub">
                    {kindSize(k)} · {kindProgress(k)}
                  </span>
                </li>
              ))}
            </ul>
            {repeatLine(rowsWithTicks(preview.kinds, step.ticks)) ? (
              <span role="status" className="cell-sub">
                {repeatLine(rowsWithTicks(preview.kinds, step.ticks))}
              </span>
            ) : null}
            <AccountPicker
              accounts={preview.accounts}
              ticks={step.accountTicks}
              note={step.note}
              title={GOOGLE_STEP_2}
              titleNote={stepTwoNote(toPlaceBytes(rowsWithTicks(preview.kinds, step.ticks)), pickedAccounts(preview, step.accountTicks))}
              gets={accountGetLines(preview.accounts, step.accountTicks, toPlaceBytes(rowsWithTicks(preview.kinds, step.ticks)), capacityPlan)}
              onToggle={toggleAccount}
            />
            {preview.isPhone ? (
              <>
                <label className="google-kinds__row">
                  <input type="checkbox" checked={fitOn} onChange={(e) => setStep({ ...step, fit: e.target.checked })} aria-label={FIT_LABEL} /> <b>{FIT_LABEL}</b> <span className="cell-sub">{FIT_NOTE}</span>
                </label>
                {fitLine(capacityPlan) ? (
                  <span role="status">
                    <b>{fitLine(capacityPlan)}</b>
                  </span>
                ) : null}
              </>
            ) : null}
            <span className="cell-sub">{GOOGLE_LEAVE_OUT_NOTE}</span>
            {preview.noChecksumFiles > 0 ? <span className="cell-sub">{preview.noChecksumFiles.toLocaleString('en-US')} files have no checksum yet and cannot go until "Check old copies" has read them.</span> : null}
            <span className="settings-actions">
              <Button variant="primary" disabled={problem !== null} onClick={() => setStep({ ...step, name: 'confirm' })}>
                {CHECK_BUTTON}
              </Button>
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>
                Cancel
              </Button>
              {problem ? (
                <span role="alert" className="cell-sub">
                  {problem}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
        {preview && step.name === 'confirm' ? (
          <>
            {summary ? <GoogleSummaryBar summary={summary} /> : null}
            <StepHeading title={GOOGLE_STEP_3} note={stepOneNote(preview, step.ticks)} />
            {fitLine(capacityPlan) ? (
              <span role="status">
                <b>{fitLine(capacityPlan)}</b>
              </span>
            ) : null}
            <ul className="google-kinds" aria-label="Accounts that will be used">
              {confirmLines(preview, step.accountTicks, capacityPlan).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <span className="cell-sub">Only these accounts are used. If they fill up, the copy waits and asks you which accounts to add.</span>
            <span className="settings-actions">
              <Button variant="primary" disabled={problem !== null} onClick={start}>
                {startButton(tickedAccountIds(preview, step.accountTicks).length)}
              </Button>
              <Button variant="quiet" onClick={() => setStep({ ...step, name: 'capacity' })}>
                Back
              </Button>
              {problem ? (
                <span role="alert" className="cell-sub">
                  {problem}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
        {step.name === 'running' ? (
          job && job.state === 'needs_you' && waitingFull ? (
            <>
              <span role="alert">
                <b>{job.message}</b>
              </span>
              {more ? (
                more.confirm ? (
                  <>
                    <b>Carry on with these accounts?</b>
                    <ul className="google-kinds" aria-label="Accounts that will be used">
                      {confirmLines(more.data.preview, more.ticks, morePlan).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    {moreSummaryNow ? <GoogleSummaryBar summary={moreSummaryNow} /> : null}
                    <span className="settings-actions">
                      <Button variant="primary" disabled={moreProblem !== null} onClick={continueWith}>
                        Continue the copy
                      </Button>
                      <Button variant="quiet" onClick={() => setMore({ ...more, confirm: false })}>
                        Back
                      </Button>
                    </span>
                  </>
                ) : (
                  <>
                    {moreSummaryNow ? <GoogleSummaryBar summary={moreSummaryNow} /> : null}
                    <AccountPicker
                      accounts={more.data.preview.accounts}
                      ticks={more.ticks}
                      locked={new Set(more.data.inUse)}
                      note={ACCOUNTS_SUGGESTED_NOTE}
                      title="Where to put the rest"
                      titleNote={stepTwoNote(more.data.needBytes, morePicked)}
                      gets={accountGetLines(more.data.preview.accounts, more.ticks, more.data.needBytes, morePlan)}
                      onToggle={toggleMore}
                    />
                    <span className="settings-actions">
                      <Button variant="primary" disabled={moreProblem !== null} onClick={() => setMore({ ...more, confirm: true })}>
                        {startButton(morePicked.length)}
                      </Button>
                      <Button variant="quiet" onClick={() => act(() => window.backupHub.jobs.cancel(job.id))}>
                        Stop
                      </Button>
                      {moreProblem ? (
                        <span role="alert" className="cell-sub">
                          {moreProblem}
                        </span>
                      ) : null}
                    </span>
                  </>
                )
              ) : (
                <span role="status" className="cell-sub">
                  Reading the accounts...
                </span>
              )}
            </>
          ) : job && job.state === 'needs_you' ? (
            <>
              <span role="alert" className="cell-sub">
                {job.message ?? 'The copy is waiting for you.'}
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
              what={job ? job.title.replace(/^Copy /, 'Copying ') : 'Copying to Google'}
              detail={
                <>
                  {job && job.bytesTotal > 0 ? (
                    <span role="status">
                      <b>{progressLine(job.bytesDone, job.bytesTotal)}</b>
                    </span>
                  ) : null}
                  {runningAccountLines(step.plan, sent).map((line) => (
                    <span key={line} className="cell-sub">
                      {line}
                    </span>
                  ))}
                  <span className="cell-sub" role="status">
                    {job?.message ?? 'Getting started.'}
                  </span>
                </>
              }
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
                <span role="status">
                  <b>{reportSummaryLine(step.report)}</b>
                </span>
                <Report data={googleReportData(step.report, step.job?.finishedAt ? when(step.job.finishedAt) : when(Date.now()))} title="Google copy report" />
                {step.report.mismatches > 0 ? <span className="cell-sub">{step.report.mismatches} {step.report.mismatches === 1 ? 'file' : 'files'} came back different in Google. They are still there; Backup Hub did not count them and did not delete them.</span> : null}
                {step.report.stopped ? <span className="cell-sub">The copy was stopped before the end. Start it again: files already on Google are not sent twice.</span> : null}
              </>
            ) : (
              <span role="alert" className="cell-sub">
                {step.job?.error ?? 'The copy stopped. See Activity for what happened. Nothing was deleted.'}
              </span>
            )}
            <span className="settings-actions">
              <Button variant="quiet" onClick={() => setStep({ name: 'idle' })}>
                Done
              </Button>
            </span>
          </>
        ) : null}
        {message ? (
          <span role="alert" className="cell-sub">
            {message}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}