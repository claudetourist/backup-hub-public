import { useCallback, useEffect, useMemo, useState } from 'react';
import { removeButtonText, type PhoneCleanPlan, type StalePlace } from '../../shared/cleanup';
import { formatGb } from '../../shared/cloudCopy';
import type { PhoneStatus } from '../../shared/phone';
import { Button } from '../components/Button';
import { Pill } from '../components/StatusPill';
import { formatBytes } from '../lib/format';
import { folderShown, groupPhoneFiles, safeIndexes, tickedTotals, verdictLabel } from './cleanupModel';

type PlanState = { state: 'idle' } | { state: 'loading'; done: number; total: number } | { state: 'error'; message: string } | { state: 'ready'; plan: PhoneCleanPlan };

/**
 * Free up phone space. The phone is read only until the very last click. A file is offered only when EVERY place of the Phone backup
 * holds a copy with the same fingerprint; the person ticks files, then confirms the exact "Remove N files (X GB)" of this run. Backup Hub checks
 * every file again right before it is removed and skips any that no longer match.
 */
export function PhoneCleanPanel({ onStarted, blocked = false }: { onStarted: () => void; /** The second drive is not available: nothing can be removed, so the buttons that make a plan are not shown. */ blocked?: boolean }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const [planState, setPlanState] = useState<PlanState>({ state: 'idle' });
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const look = useCallback(() => {
    void (async () => {
      try {
        const phone = await window.backupHub.phone.status();
        setStatus(phone);
        setSerial((current) => current ?? (phone.adb === 'ready' ? (phone.devices.find((d) => d.state === 'device')?.serial ?? phone.devices[0]?.serial ?? null) : null));
      } catch {
        setStatus({ adb: 'ready', devices: [] });
      }
    })();
  }, []);
  useEffect(look, [look]);

  // While the plan is made, ask main how far the fingerprints on the phone are.
  const loading = planState.state === 'loading';
  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setInterval(() => {
      void window.backupHub.cleanup.phoneProgress().then((p) => setPlanState((s) => (s.state === 'loading' ? { state: 'loading', done: p.done, total: p.total } : s)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  const makePlan = (scope: 'camera' | 'others'): void => {
    if (!serial) return;
    setPlanState({ state: 'loading', done: 0, total: 0 });
    setMessage(null);
    setConfirming(false);
    void (async () => {
      try {
        const result = await window.backupHub.cleanup.phonePlan(serial, scope);
        if (result.ok) {
          setTicked(new Set());
          setPlanState({ state: 'ready', plan: result.plan });
        } else setPlanState({ state: 'error', message: result.message });
      } catch {
        setPlanState({ state: 'error', message: 'The plan could not be made. Nothing was changed.' });
      }
    })();
  };

  const plan = planState.state === 'ready' ? planState.plan : null;
  const groups = useMemo(() => (plan ? groupPhoneFiles(plan.files) : []), [plan]);
  const totals = plan ? tickedTotals(plan.files, ticked) : { count: 0, bytes: 0 };

  const setMany = (indexes: number[], on: boolean): void => {
    const next = new Set(ticked);
    for (const i of indexes) {
      if (on) next.add(i);
      else next.delete(i);
    }
    setTicked(next);
    setConfirming(false);
  };

  const remove = (p: PhoneCleanPlan): void => {
    setStarting(true);
    void (async () => {
      try {
        const result = await window.backupHub.cleanup.phoneStart({ planId: p.id, hash: p.hash, confirmed: true, expectCount: totals.count, expectBytes: totals.bytes, indexes: [...ticked] });
        if (result.ok) {
          setPlanState({ state: 'idle' });
          setConfirming(false);
          setMessage({ tone: 'ok', text: 'The clean-up has started. Each file is checked again right before it is removed. Watch it in Jobs.' });
          onStarted();
        } else setMessage({ tone: 'warn', text: result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work. Nothing was removed.' });
      } finally {
        setStarting(false);
      }
    })();
  };

  const lookAgain = (place: StalePlace): void => {
    void (async () => {
      try {
        const result = place.kind === 'gdrive' ? await window.backupHub.drive.refresh(place.placeId) : await window.backupHub.listing.lookAgain(place.placeId);
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.ok ? `Checking ${place.label}. When the job is done, make the plan again.` : result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work.' });
      }
    })();
  };

  const devices = status?.adb === 'ready' ? status.devices : [];
  const ready = devices.find((d) => d.serial === serial)?.state === 'device';

  return (
    <div className="settings-stack">
      <p className="cell-sub">
        Removes a file from the phone only when the same file (same contents) is already on the T7, on the Seagate2TB and in Google. The camera folder (DCIM) comes first. You tick what to remove and confirm the exact number at the end. For
        30 days those copies are locked, and you can put the files back on the phone.
      </p>
      {status?.adb === 'missing' ? (
        <p className="tone-text tone-text--warn" role="alert">
          Backup Hub cannot find adb.exe (the Android tool that talks to the phone). Install Android platform-tools first.
        </p>
      ) : null}
      {status?.adb === 'ready' && devices.length === 0 ? <p className="cell-sub">No phone found. Plug it in with a cable, unlock it, choose File transfer for USB and tap Allow if it asks.</p> : null}
      {devices.length > 1 ? (
        <label className="cell-stack cell-stack--tight">
          <span className="cell-sub">Phone</span>
          <select value={serial ?? ''} onChange={(event) => setSerial(event.target.value)} aria-label="Phone">
            {devices.map((d) => (
              <option key={d.serial} value={d.serial}>
                {d.model} ({d.state})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {devices.length === 1 ? (
        <p>
          <b>{devices[0]!.model}</b> <span className={`tone-text tone-text--${devices[0]!.state === 'device' ? 'ok' : 'warn'}`}>{devices[0]!.state === 'device' ? 'is connected' : `is not ready (${devices[0]!.state})`}</span>
        </p>
      ) : null}
      <span className="settings-actions">
        {blocked ? null : (
          <>
            <Button variant="primary" disabled={!ready || loading} onClick={() => makePlan('camera')}>
              {loading ? 'Looking at the phone…' : 'See what can be removed from the camera folder'}
            </Button>
            <Button variant="secondary" disabled={!ready || loading} onClick={() => makePlan('others')}>
              See the other phone folders
            </Button>
          </>
        )}
        <Button variant="quiet" onClick={look}>
          Look for the phone
        </Button>
        {blocked ? null : <span className="cell-sub">Nothing is removed by this step.</span>}
      </span>
      {planState.state === 'loading' ? (
        <p className="cell-sub" role="status">
          {planState.total > 0 ? `Checking file ${Math.min(planState.done + 1, planState.total).toLocaleString('en-US')} of ${planState.total.toLocaleString('en-US')} on the phone… ` : 'Reading the phone… '}
          This can take a few minutes. Nothing is changed.
        </p>
      ) : null}
      {planState.state === 'error' ? (
        <p className="tone-text tone-text--warn" role="alert">
          {planState.message}
        </p>
      ) : null}
      {message ? (
        <p className={`tone-text tone-text--${message.tone}`} role="status">
          {message.text}
        </p>
      ) : null}

      {plan ? (
        <div className="cloud-plan__body">
          <div className="cloud-plan__top">
            <p>
              <b>
                {plan.safe.files.toLocaleString('en-US')} safe to remove ({formatGb(plan.safe.bytes)})
              </b>{' '}
              · {plan.waiting.files.toLocaleString('en-US')} not yet on all three backups ({formatGb(plan.waiting.bytes)}) · {plan.onlyOnPhone.files.toLocaleString('en-US')} only on the phone ({formatGb(plan.onlyOnPhone.bytes)})
              {plan.stale.files > 0 ? ` · ${plan.stale.files.toLocaleString('en-US')} need a place checked again` : ''}
            </p>
            {plan.stalePlaces.length > 0 ? (
              <ul className="cloud-plan__notes">
                {plan.stalePlaces.map((s) => (
                  <li key={s.placeId} className="cell-sub">
                    <b>{s.label}</b>: {s.why} Check now first, then make the plan again.{' '}
                    <Button size="sm" variant="secondary" onClick={() => lookAgain(s)}>
                      Check now
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.notes.map((n) => (
              <p key={n} className="cell-sub">
                {n}
              </p>
            ))}
          </div>
          {plan.files.length === 0 ? <p className="cell-sub">Nothing from these phone folders is on the T7, the Seagate2TB and Google yet. Plug the phone in and press Start, then Send to Google, and check again.</p> : null}
          <div className="cloud-plan__list" tabIndex={0} aria-label="Phone files">
            {groups.map((g) => (
              <section key={g.folder} aria-label={folderShown(g.folder)}>
                <h3 className="cloud-plan__head">
                  {folderShown(g.folder)}{' '}
                  <span className="cell-sub">
                    {g.files.toLocaleString('en-US')} {g.files === 1 ? 'file' : 'files'}, {formatGb(g.bytes)}
                  </span>
                </h3>
                {g.months.map((m) => {
                  const safe = safeIndexes(m.files);
                  const all = safe.length > 0 && safe.every((i) => ticked.has(i));
                  return (
                    <div key={m.month}>
                      <p className="cell-sub">
                        {safe.length > 0 ? (
                          <label>
                            <input type="checkbox" checked={all} onChange={(event) => setMany(safe, event.target.checked)} /> <b>{m.month}</b> · {m.files.length.toLocaleString('en-US')} {m.files.length === 1 ? 'file' : 'files'}, {formatGb(m.bytes)} · tick the{' '}
                            {safe.length.toLocaleString('en-US')} safe {safe.length === 1 ? 'file' : 'files'}
                          </label>
                        ) : (
                          <span>
                            <b>{m.month}</b> · {m.files.length.toLocaleString('en-US')} {m.files.length === 1 ? 'file' : 'files'}, {formatGb(m.bytes)}
                          </span>
                        )}
                      </p>
                      <table className="data-table cloud-plan__table" aria-label={`Phone files from ${m.month} in ${folderShown(g.folder)}`}>
                        <thead>
                          <tr>
                            <th>File</th>
                            <th>Size</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.files.map((f) => {
                            const v = verdictLabel(f.verdict);
                            return (
                              <tr key={f.index}>
                                <td className="cloud-plan__path" title={f.path}>
                                  {f.verdict === 'safe' ? (
                                    <label>
                                      <input type="checkbox" checked={ticked.has(f.index)} onChange={(event) => setMany([f.index], event.target.checked)} /> {f.name}
                                    </label>
                                  ) : (
                                    f.name
                                  )}
                                </td>
                                <td>{formatBytes(f.size)}</td>
                                <td>
                                  <Pill tone={v.tone}>{v.text}</Pill>
                                  {f.verdict === 'safe' ? <span className="cell-sub"> {f.vouchers.map((x) => x.placeLabel).join(' + ')}</span> : null}
                                  {f.verdict === 'waiting' ? (
                                    <span className="cell-sub"> {f.reason}</span>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
          <div className="cloud-plan__footer">
            <p className="cell-sub">
              {totals.count.toLocaleString('en-US')} {totals.count === 1 ? 'file' : 'files'} ticked ({formatGb(totals.bytes)}).
            </p>
            {confirming && totals.count > 0 ? (
              <p className="tone-text tone-text--warn" role="alert">
                You are about to remove {totals.count.toLocaleString('en-US')} {totals.count === 1 ? 'file' : 'files'} ({formatGb(totals.bytes)}) from {plan.model}. Each one has the same file on the T7, on the Seagate2TB and in Google. Those copies stay
                locked for 30 days.
              </p>
            ) : null}
            <div className="settings-actions">
              {confirming && totals.count > 0 ? (
                <>
                  <Button variant="primary" disabled={starting} onClick={() => remove(plan)}>
                    {removeButtonText(totals.count, totals.bytes)}
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="primary" disabled={totals.count === 0} onClick={() => setConfirming(true)}>
                  Review and remove…
                </Button>
              )}
              <span className="cell-sub">Nothing is removed until you press the Remove button.</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
