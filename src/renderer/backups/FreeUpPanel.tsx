import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FreeUpFileRowView, FreeUpFilesResult, FreeUpGroupId, FreeUpMode, FreeUpOverview, FreeUpPrepareView, FreeUpResultView } from '../../shared/freeUp';
import { formatGb } from '../../shared/cloudCopy';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { ProgressPanel } from '../components/ProgressPanel';
import { progressInputOf } from '../components/progressModel';
import { useJobs } from '../jobs/JobsProvider';
import { formatBytes, formatCount } from '../lib/format';
import { NotCoveredCard } from './NotCoveredCard';
import { PutBackTable } from './PutBackTable';
import {
  CHECK_MODES,
  FREE_AGAIN,
  FREE_BLOCKED_TITLE,
  FREE_CHECKING,
  FREE_INTRO,
  FREE_NOT_COVERED_HELP,
  FREE_NOT_COVERED_TITLE,
  FREE_NOT_READY_HELP,
  FREE_ONLY_KINDS,
  FREE_START,
  FREE_TITLE,
  TICK_HELP,
  pageFilesTick,
  rangeText,
  tickAllGroupLink,
  untickAllLink,
  REMOVE_MODES,
  ageText,
  confirmLines,
  groupWords,
  isOldCheck,
  keepFileTitle,
  keepFolderTitle,
  keptNote,
  lockedLines,
  notReadyHeader,
  ranSteps,
  removeButton,
  removeModeSummary,
  reviewButton,
  shortDate,
  shortFolder,
  stepLine,
  stepsHeader,
  tickedTotals,
} from './freeUpModel';

type Step =
  | { name: 'loading' }
  | { name: 'start' }
  | { name: 'checking'; jobId: number }
  | { name: 'result'; checkId: number }
  | { name: 'confirm'; checkId: number; groups: FreeUpGroupId[]; prepare: FreeUpPrepareView }
  | { name: 'removing'; jobId: number }
  | { name: 'done'; jobId: number };

/** What the title of a running job says: a put-back brings files back, a removal frees space. */
const PUT_BACK_KIND = 'clean.putBack';

const finished = (state: string | undefined): boolean => state === 'done' || state === 'done_warnings' || state === 'failed';

/**
 * "Free up phone space" on a phone backup's page. One main button on each step: Check what can go, Review, Remove. Everything it shows
 * was read from the phone and the copies when the check ran; the confirm screen says exactly what goes and where the copies are.
 */
export function FreeUpPanel({ backupId, backupName }: { backupId: number; backupName: string }) {
  const { jobs } = useJobs();
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [overview, setOverview] = useState<FreeUpOverview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkMode, setCheckMode] = useState<FreeUpMode>('quick');
  // The check kept after a removal: the groups that are still on offer while it is fresh (null when there are none).
  const [remaining, setRemaining] = useState<number | null>(null);

  const loadOverview = useCallback(async (): Promise<FreeUpOverview | null> => {
    try {
      const o = await window.backupHub.freeUp.overview(backupId);
      if (o.ok) {
        setOverview(o);
        return o;
      }
      setMessage(o.message);
    } catch {
      setMessage('This could not be read. Nothing was changed.');
    }
    return null;
  }, [backupId]);

  // On open: pick up a job that is still going, else the newest check that is still fresh, else the start.
  useEffect(() => {
    void (async () => {
      const o = await loadOverview();
      const active = jobs.find((j) => j.kind.startsWith('freeup.') && j.backupIds?.includes(backupId) === true && ['queued', 'running', 'needs_you'].includes(j.state));
      if (active) setStep(active.kind === 'freeup.remove' ? { name: 'removing', jobId: active.id } : { name: 'checking', jobId: active.id });
      else setStep(o?.checkId != null ? { name: 'result', checkId: o.checkId } : { name: 'start' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupId]);

  const job = step.name === 'checking' || step.name === 'removing' || step.name === 'done' ? (jobs.find((j) => j.id === step.jobId) ?? null) : null;
  const jobState = job?.state;
  useEffect(() => {
    if (!finished(jobState)) return;
    if (step.name === 'checking') {
      const jobId = step.jobId;
      void (async () => {
        const r = await window.backupHub.freeUp.result(jobId).catch(() => null);
        await loadOverview();
        if (r?.ok) setStep({ name: 'result', checkId: jobId });
        else {
          setMessage(job?.error ?? job?.message ?? 'The check did not finish. Nothing was changed.');
          setStep({ name: 'start' });
        }
      })();
    } else if (step.name === 'removing') {
      const jobId = step.jobId;
      void (async () => {
        const o = await loadOverview();
        const r = o?.checkId != null ? await window.backupHub.freeUp.result(o.checkId).catch(() => null) : null;
        setRemaining(r?.ok && r.result.blocked.length === 0 && r.result.groups.length > 0 && !isOldCheck(r.result.at, Date.now()) ? r.result.checkId : null);
        setStep({ name: 'done', jobId });
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobState]);

  const act = (run: () => Promise<unknown>): void => void run().catch(() => setMessage('That did not work. Please try again.'));

  const startCheck = (): void => {
    setMessage(null);
    setBusy(true);
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.startCheck(backupId, checkMode);
        if (r.ok) setStep({ name: 'checking', jobId: r.jobId });
        else setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
    })();
  };

  const runPanel = (what: string, fallback: string) => (
    <ProgressPanel
      what={what}
      detail={<span className="cell-sub" role="status">{job?.message ?? fallback}</span>}
      {...(job ? progressInputOf(job, Date.now()) : {})}
      paused={job?.paused === true}
              pausing={job?.pausing === true}
      onPause={() => job && act(() => window.backupHub.jobs.pause(job.id))}
      onResume={() => job && act(() => window.backupHub.jobs.resume(job.id))}
      onStop={() => {
        if (job) act(() => window.backupHub.jobs.cancel(job.id));
        if (step.name === 'checking') setStep({ name: 'start' });
      }}
    />
  );

  return (
    <Panel label={FREE_TITLE} accent="phone">
      <div className="settings-stack">
        {message ? <span role="alert" className="cell-sub">{message}</span> : null}
        {step.name === 'loading' ? <span role="status" className="cell-sub">Reading...</span> : null}
        {step.name === 'start' ? (
          <>
            <span className="cell-sub">{FREE_INTRO}</span>
            <span className="cell-sub">{FREE_ONLY_KINDS}</span>
            <div className="settings-stack">
              <b>{FREE_NOT_COVERED_TITLE}</b>
              <span className="cell-sub">{FREE_NOT_COVERED_HELP}</span>
              <NotCoveredCard backupId={backupId} framed={false} open />
            </div>
            <ModePicker name="check-mode" label="How to check" modes={CHECK_MODES} value={checkMode} onChange={setCheckMode} />
            <span className="settings-actions">
              <Button variant="primary" disabled={busy} onClick={startCheck}>{FREE_START}</Button>
            </span>
            <KeepList overview={overview} backupId={backupId} onChanged={() => void loadOverview()} />
            <RemovedList overview={overview} backupId={backupId} onStarted={(jobId) => setStep({ name: 'removing', jobId })} onMessage={setMessage} />
          </>
        ) : null}
        {step.name === 'checking' ? (
          <>
            <span className="cell-sub">{FREE_CHECKING}</span>
            {job && job.state === 'needs_you' ? (
              <>
                <span role="alert" className="cell-sub">{job.message ?? 'The check is waiting for you.'}</span>
                <span className="settings-actions">
                  {(job.choices.length > 0 ? job.choices : ['Continue']).map((c) => (
                    <Button key={c} variant="primary" onClick={() => act(() => window.backupHub.jobs.resolve(job.id, c))}>{c}</Button>
                  ))}
                </span>
              </>
            ) : (
              runPanel(`Checking ${backupName}`, 'Getting started.')
            )}
          </>
        ) : null}
        {step.name === 'result' ? (
          <ResultView
            checkId={step.checkId}
            backupId={backupId}
            overview={overview}
            onAgain={startCheck}
            checkMode={checkMode}
            onCheckMode={setCheckMode}
            onReview={(groups, prepare) => setStep({ name: 'confirm', checkId: step.checkId, groups, prepare })}
            onMessage={setMessage}
            onChanged={() => void loadOverview()}
            onGone={() => setStep({ name: 'start' })}
            busy={busy}
          />
        ) : null}
        {step.name === 'confirm' ? (
          <ConfirmView
            step={step}
            onBack={() => setStep({ name: 'result', checkId: step.checkId })}
            onStarted={(jobId) => setStep({ name: 'removing', jobId })}
            onMessage={(m) => {
              setMessage(m);
              setStep({ name: 'result', checkId: step.checkId });
            }}
          />
        ) : null}
        {step.name === 'removing' ? (job && job.state === 'needs_you' ? <span role="alert" className="cell-sub">{job.message ?? 'The removal is waiting for you.'}</span> : runPanel(job?.kind === PUT_BACK_KIND ? `Putting files back on ${backupName}` : `Freeing space on ${backupName}`, 'Getting started.')) : null}
        {step.name === 'done' ? (
          <>
            <b>{job?.state === 'failed' ? 'Nothing was removed' : 'Finished'}</b>
            <span className="cell-sub" role="status">{job?.state === 'failed' ? (job.error ?? job.message ?? 'The removal stopped.') : (job?.message ?? 'Done.')}</span>
            {remaining !== null ? (
              <ResultView
                checkId={remaining}
                backupId={backupId}
                overview={overview}
                onAgain={startCheck}
                checkMode={checkMode}
                onCheckMode={setCheckMode}
                onReview={(groups, prepare) => setStep({ name: 'confirm', checkId: remaining, groups, prepare })}
                onMessage={setMessage}
                onChanged={() => void loadOverview()}
                onGone={() => setRemaining(null)}
                busy={busy}
              />
            ) : (
              <>
                <ModePicker name="check-mode" label="How to check" modes={CHECK_MODES} value={checkMode} onChange={setCheckMode} />
                <span className="settings-actions">
                  <Button variant="primary" disabled={busy} onClick={startCheck}>{FREE_AGAIN}</Button>
                  <Button variant="quiet" onClick={() => setStep({ name: 'start' })}>Back</Button>
                </span>
              </>
            )}
            <RemovedList overview={overview} backupId={backupId} onStarted={(jobId) => setStep({ name: 'removing', jobId })} onMessage={setMessage} />
          </>
        ) : null}
      </div>
    </Panel>
  );
}

// ---- the list of what can go ---------------------------------------------------------------------------------------------------------------

function ResultView({ checkId, backupId, overview, onAgain, checkMode, onCheckMode, onReview, onMessage, onChanged, onGone, busy }: { checkId: number; backupId: number; overview: FreeUpOverview | null; onAgain: () => void; checkMode: FreeUpMode; onCheckMode: (m: FreeUpMode) => void; onReview: (groups: FreeUpGroupId[], prepare: FreeUpPrepareView) => void; onMessage: (m: string | null) => void; onChanged: () => void; onGone: () => void; busy: boolean }) {
  const [view, setView] = useState<FreeUpResultView | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<FreeUpGroupId>>(new Set());
  const [version, setVersion] = useState(0);
  const now = Date.now();

  useEffect(() => {
    void (async () => {
      const r = await window.backupHub.freeUp.result(checkId).catch(() => null);
      if (r?.ok) setView(r.result);
      else onGone();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId, version]);

  const totals = useMemo(() => (view ? tickedTotals(view.groups, ticked) : { files: 0, bytes: 0 }), [view, ticked]);
  if (view === null) return <span role="status" className="cell-sub">Reading the result...</span>;

  const toggle = (id: FreeUpGroupId): void => setTicked((t) => (t.has(id) ? new Set([...t].filter((x) => x !== id)) : new Set([...t, id])));
  const review = (): void => {
    const groups = [...ticked];
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.prepare({ checkId, groups });
        if (r.ok) onReview(groups, r.prepare);
        else onMessage(r.message);
      } catch {
        onMessage('That did not work. Nothing was removed.');
      }
    })();
  };
  const kept = (): void => {
    setVersion((v) => v + 1);
    onChanged();
  };
  const old = isOldCheck(view.at, now);
  const locked = lockedLines(view.locked);
  const steps = ranSteps(view);
  const picker = <ModePicker name="check-mode" label="How to check again" modes={CHECK_MODES} value={checkMode} onChange={onCheckMode} />;

  return (
    <>
      <span className="cell-sub">Checked {ageText(view.at, now)}: the phone, {view.places.join(', ')}.{old ? ' This is too old to remove from: check again.' : ''}</span>
      {steps.length > 0 ? (
        <div className="settings-stack" aria-label="What this check did">
          <b>{stepsHeader(view)}</b>
          {steps.map((s) => <span key={s.what} className="cell-sub">{stepLine(s)}</span>)}
        </div>
      ) : null}
      {view.blocked.length > 0 ? (
        <div className="settings-stack">
          <b>{FREE_BLOCKED_TITLE}</b>
          {view.blocked.map((b) => <span key={b} role="alert" className="cell-sub">{b}</span>)}
          {picker}
          <span className="settings-actions">
            <Button variant="primary" disabled={busy} onClick={onAgain}>{FREE_AGAIN}</Button>
          </span>
        </div>
      ) : view.groups.length === 0 ? (
        <>
          <b>Nothing can leave the phone right now.</b>
          <span className="cell-sub">No file has all three checked copies yet.</span>
          {picker}
          <span className="settings-actions">
            <Button variant="primary" disabled={busy} onClick={onAgain}>{FREE_AGAIN}</Button>
          </span>
        </>
      ) : (
        <>
          <b>{formatGb(view.readyBytes)} can go: {formatCount(view.readyFiles)} {view.readyFiles === 1 ? 'file' : 'files'}</b>
          <span className="cell-sub">Tick what you want to free. Nothing is ticked for you. Big videos come first.</span>
          <ul className="home-backups" aria-label="What can go">
            {view.groups.map((g) => (
              <li key={g.id} className="home-backup">
                <label className="home-backup__who">
                  <input type="checkbox" checked={ticked.has(g.id)} onChange={() => toggle(g.id)} /> <b className="home-backup__name">{groupWords(g)}</b>
                </label>
                <GroupFiles checkId={checkId} backupId={backupId} list={g.id} onKept={kept} onTicked={() => setVersion((v) => v + 1)} onMessage={onMessage} />
              </li>
            ))}
          </ul>
          {picker}
          <span className="settings-actions">
            <Button variant="primary" disabled={totals.files === 0 || old} onClick={review}>{reviewButton(totals)}</Button>
            <Button variant="quiet" disabled={busy} onClick={onAgain}>{FREE_AGAIN}</Button>
          </span>
        </>
      )}
      {locked.map((l) => <span key={l} className="cell-sub">{l}</span>)}
      {view.notReady.files > 0 ? (
        <details className="more">
          <summary>{notReadyHeader(view)}</summary>
          <div className="settings-stack">
            <span className="cell-sub">{FREE_NOT_READY_HELP}</span>
            {view.notReady.reasons.map((r) => <span key={r.what} className="cell-sub">{formatCount(r.files)} × {r.what}</span>)}
            <GroupFiles checkId={checkId} backupId={backupId} list="notReady" onKept={kept} onMessage={onMessage} />
          </div>
        </details>
      ) : null}
      <KeepList overview={overview} backupId={backupId} onChanged={kept} />
    </>
  );
}

/** Two or more ways to do the same step, each with its one line (radio choice). */
function ModePicker({ name, label, modes, value, onChange }: { name: string; label: string; modes: readonly { mode: FreeUpMode; label: string; line: string }[]; value: FreeUpMode; onChange: (m: FreeUpMode) => void }) {
  return (
    <div className="settings-stack" role="radiogroup" aria-label={label}>
      {modes.map((m) => (
        <label key={m.mode}>
          <input type="radio" name={name} checked={value === m.mode} onChange={() => onChange(m.mode)} /> <b>{m.label}</b> <span className="cell-sub">{m.line}</span>
        </label>
      ))}
    </div>
  );
}

/** The files of one group (opened on demand, 100 a page) as a compact table: one line per file, Keep on the phone / Keep folder / Show in folder. */
function GroupFiles({ checkId, backupId, list, onKept, onTicked, onMessage }: { checkId: number; backupId: number; list: FreeUpGroupId | 'notReady'; onKept: () => void; onTicked?: () => void; onMessage: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Extract<FreeUpFilesResult, { ok: true }> | null>(null);
  const [offset, setOffset] = useState(0);
  // Counts up after a Keep or an Undo: the page is read again even when the offset did not change.
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState<{ text: string; ruleId: number | null } | null>(null);
  const notReady = list === 'notReady';
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const r = await window.backupHub.freeUp.files({ checkId, list, offset }).catch(() => null);
      if (r?.ok) setPage(r);
    })();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reload only asks for the page to be read again
  }, [open, offset, checkId, list, reload]);
  const keep = (scope: 'file' | 'folder', path: string): void => {
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.keep({ backupId, scope, path });
        if (r.ok) {
          setNote(keptNote(scope, path, r.keep));
          setOffset(0);
          setReload((n) => n + 1);
          onKept();
        } else onMessage(r.message);
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  const undo = (): void => {
    const id = note?.ruleId;
    if (id == null) return;
    void (async () => {
      try {
        await window.backupHub.freeUp.unkeep({ backupId, id });
        setNote(null);
        setReload((n) => n + 1);
        onKept();
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  // Ticks (in this removal) and unticks (stays this time): kept in main with the check; the group lines above follow.
  const setTicks = (what: string[] | 'all', on: boolean): void => {
    if (list === 'notReady') return;
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.tick(what === 'all' ? { checkId, list, ticked: on, all: true } : { checkId, list, ticked: on, paths: what });
        if (!r.ok) return onMessage(r.message);
        if (what === 'all') setReload((n) => n + 1);
        else setPage((p) => (p === null ? p : { ...p, rows: p.rows.map((row) => (what.includes(row.path) ? { ...row, ticked: on } : row)) }));
        onTicked?.();
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  const show = (path: string): void => {
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.showCopy({ checkId, path });
        onMessage(r.ok ? null : r.message);
      } catch {
        onMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  return (
    <details className="more" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Show files</summary>
      {open && page === null ? <span role="status" className="cell-sub">Reading...</span> : null}
      {note ? (
        <span className="settings-actions" role="status">
          <span className="cell-sub">{note.text}</span>
          {note.ruleId !== null ? <Button size="sm" variant="quiet" onClick={undo}>Undo</Button> : null}
        </span>
      ) : null}
      {page && !notReady ? (
        <>
          <span className="cell-sub">{TICK_HELP}</span>
          <span className="settings-actions">
            <Button size="sm" variant="quiet" disabled={page.total === 0} onClick={() => setTicks('all', true)}>{tickAllGroupLink(page.total)}</Button>
            <Button size="sm" variant="quiet" disabled={page.total === 0} onClick={() => setTicks('all', false)}>{untickAllLink}</Button>
          </span>
        </>
      ) : null}
      {page ? (
        <div className="settings-stack">
          <GroupFilesTable rows={page.rows} notReady={notReady} onTick={setTicks} onKeep={keep} onShow={show} />
          <span className="settings-actions">
            {offset > 0 ? <Button size="sm" variant="quiet" onClick={() => setOffset(Math.max(0, offset - page.rows.length))}>Earlier</Button> : null}
            {offset + page.rows.length < page.total ? <Button size="sm" variant="quiet" onClick={() => setOffset(offset + page.rows.length)}>Next</Button> : null}
            <span className="cell-sub">{rangeText(offset, page.rows.length, page.total)}</span>
          </span>
        </div>
      ) : null}
    </details>
  );
}

/** The table of one page of a group's files: with a tick per file for the files that can go (a not-ready list has none). */
export function GroupFilesTable({ rows, notReady, onTick, onKeep, onShow }: { rows: readonly FreeUpFileRowView[]; notReady: boolean; onTick: (paths: string[], on: boolean) => void; onKeep: (scope: 'file' | 'folder', path: string) => void; onShow: (path: string) => void }) {
  return (
    <div className="table-scroll table-scroll--virtual free-files">
      <table className="data-table data-table--sticky data-table--virtual" aria-label={notReady ? 'Files that are not ready' : 'Files that can go'}>
        <colgroup>
          {notReady ? null : <col className="put-back-files__tick" />}
          <col />
          <col className="free-files__date" />
          <col className="free-files__size" />
          <col className="free-files__where" />
          {notReady ? <col className="free-files__why" /> : null}
          <col className="free-files__actions" />
        </colgroup>
        <thead>
          <tr>
            {notReady ? null : (
              <th>
                <input
                  type="checkbox"
                  aria-label="Tick or untick every file on this page"
                  checked={pageFilesTick(rows) === 'all'}
                  ref={(el) => {
                    if (el) el.indeterminate = pageFilesTick(rows) === 'some';
                  }}
                  disabled={rows.length === 0}
                  onChange={(e) => onTick(rows.map((r) => r.path), e.currentTarget.checked)}
                />
              </th>
            )}
            <th>Name</th>
            <th>Date taken</th>
            <th className="is-end">Size</th>
            <th>Where on the phone</th>
            {notReady ? <th>Why</th> : null}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="data-table__empty">No files here.</td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.path}>
              {notReady ? null : (
                <td>
                  <input type="checkbox" aria-label={`Free ${r.name}`} checked={r.ticked === true} onChange={(e) => onTick([r.path], e.currentTarget.checked)} />
                </td>
              )}
              <td title={r.path}>{r.name}</td>
              <td>{shortDate(r.mtimeSec)}</td>
              <td className="is-end">{formatBytes(r.size)}</td>
              <td title={r.folder}>{shortFolder(r.folder)}</td>
              {notReady ? <td title={r.missing.join('; ')}>{r.missing.join('; ')}</td> : null}
              <td className="free-files__cell">
                <span className="free-files__buttons">
                  <Button size="sm" variant="quiet" title={keepFileTitle} onClick={() => onKeep('file', r.path)}>Keep on the phone</Button>
                  <Button size="sm" variant="quiet" title={keepFolderTitle} onClick={() => onKeep('folder', r.folder)}>Keep folder</Button>
                  {r.hasCopy ? <Button size="sm" variant="quiet" title="Open the copy on the first drive in Explorer" onClick={() => onShow(r.path)}>Show in folder</Button> : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConfirmView({ step, onBack, onStarted, onMessage }: { step: Extract<Step, { name: 'confirm' }>; onBack: () => void; onStarted: (jobId: number) => void; onMessage: (m: string) => void }) {
  const p = step.prepare;
  const words = confirmLines(p);
  const [busy, setBusy] = useState(false);
  const [removeMode, setRemoveMode] = useState<FreeUpMode>('full');
  const go = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const r = await window.backupHub.freeUp.start({ checkId: step.checkId, groups: step.groups, hash: p.hash, expectFiles: p.files, expectBytes: p.bytes, confirmed: true, removeMode });
        if (r.ok) onStarted(r.jobId);
        else onMessage(r.message);
      } catch {
        onMessage('That did not work. Nothing was removed.');
      }
      setBusy(false);
    })();
  };
  return (
    <>
      <b>{words.headline}</b>
      {p.groups.map((g) => <span key={g.id} className="cell-sub">{groupWords(g)}</span>)}
      {words.lines.map((l) => <span key={l} className="cell-sub">{l}</span>)}
      <b>How to check each file before it goes</b>
      <ModePicker name="remove-mode" label="How to check each file before it goes" modes={REMOVE_MODES} value={removeMode} onChange={setRemoveMode} />
      <span className="cell-sub" role="status">{removeModeSummary(removeMode)}</span>
      <span className="settings-actions">
        <Button variant="primary" disabled={busy} onClick={go}>{removeButton(p)}</Button>
        <Button variant="quiet" disabled={busy} onClick={onBack}>Back</Button>
      </span>
    </>
  );
}

// ---- Keep on the phone, and Put back -----------------------------------------------------------------------------------------------------

function KeepList({ overview, backupId, onChanged }: { overview: FreeUpOverview | null; backupId: number; onChanged: () => void }) {
  if (overview === null || overview.keep.length === 0) return null;
  return (
    <details className="more">
      <summary>Kept on the phone ({overview.keep.length})</summary>
      <div className="settings-stack">
        <span className="cell-sub">These are never offered. Undo puts one back on the list.</span>
        {overview.keep.map((k) => (
          <span key={k.id} className="settings-actions">
            <span>{k.path} <span className="cell-sub">({k.scope === 'folder' ? 'folder' : 'file'})</span></span>
            <Button size="sm" variant="quiet" onClick={() => void window.backupHub.freeUp.unkeep({ backupId, id: k.id }).then(onChanged)}>Undo</Button>
          </span>
        ))}
      </div>
    </details>
  );
}

/** The put-back table, started again (new key) whenever the totals change: after a put-back the list is the new one and the ticks are gone. */
function RemovedList({ overview, backupId, onStarted, onMessage }: { overview: FreeUpOverview | null; backupId: number; onStarted: (jobId: number) => void; onMessage: (m: string) => void }) {
  if (overview === null || overview.removedTotal.files === 0) return null;
  const t = overview.removedTotal;
  return <PutBackTable key={`${t.files}:${t.bytes}`} backupId={backupId} total={t} onStarted={onStarted} onMessage={onMessage} />;
}
