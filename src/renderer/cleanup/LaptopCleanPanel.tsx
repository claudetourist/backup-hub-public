import { useState } from 'react';
import { QUARANTINE_WORDS } from '../../shared/appFolders';
import { removeButtonText, type DuplicateGroup, type LaptopCleanPlan } from '../../shared/cleanup';
import { formatGb } from '../../shared/cloudCopy';
import { Button } from '../components/Button';
import { formatBytes } from '../lib/format';
import { Toggle } from '../components/Toggle';
import { usePlaces } from '../places/PlacesProvider';
import { useSettings } from '../settings/SettingsProvider';
import { tickedOfText } from '../components/previewModel';
import { duplicateTotals, removableGroupIds, shownPath } from './cleanupModel';

type PlanState = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; plan: LaptopCleanPlan };

/**
 * Laptop duplicates. Identical files (same SHA-256) on the laptop, grouped. One copy per group is kept (you can switch which).
 * The others are MOVED to the quarantine folder (QUARANTINE_WORDS) on the same drive, never deleted; Undo puts them back, and after 30 days Backup Hub
 * asks before emptying. Protected folders, the T7, cloud and OneDrive-synced folders are never touched.
 */
export function LaptopCleanPanel({ onStarted }: { onStarted: () => void }) {
  const { snapshot } = usePlaces();
  const { settings, update } = useSettings();
  const [planState, setPlanState] = useState<PlanState>({ state: 'idle' });
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [keeps, setKeeps] = useState<ReadonlyMap<string, string>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const plan = planState.state === 'ready' ? planState.plan : null;
  const keepOf = (g: DuplicateGroup): string => keeps.get(g.id) ?? g.keep;
  const totals = plan ? duplicateTotals(plan.groups, ticked, keepOf) : { count: 0, bytes: 0 };
  const tickable = plan ? removableGroupIds(plan.groups, keepOf) : [];
  const tickedCount = tickable.filter((id) => ticked.has(id)).length;

  const makePlan = (): void => {
    setPlanState({ state: 'loading' });
    setMessage(null);
    setConfirming(false);
    void (async () => {
      try {
        const result = await window.backupHub.cleanup.laptopPlan();
        if (result.ok) {
          setTicked(new Set());
          setKeeps(new Map());
          setPlanState({ state: 'ready', plan: result.plan });
        } else setPlanState({ state: 'error', message: result.message });
      } catch {
        setPlanState({ state: 'error', message: 'The plan could not be made. Nothing was changed.' });
      }
    })();
  };

  const lookAgain = (): void => {
    const laptop = snapshot?.places.find((p) => p.kind === 'laptop');
    if (!laptop) return;
    void (async () => {
      try {
        const result = await window.backupHub.listing.lookAgain(laptop.id);
        setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.ok ? 'Checking the laptop. When the job is done, find duplicates again.' : result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work.' });
      }
    })();
  };

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
    setConfirming(false);
  };

  const setAll = (on: boolean): void => {
    setTicked(on ? new Set(tickable) : new Set());
    setConfirming(false);
  };

  const start = (p: LaptopCleanPlan): void => {
    setStarting(true);
    void (async () => {
      try {
        const groups = p.groups.filter((g) => ticked.has(g.id)).map((g) => ({ id: g.id, keep: keepOf(g) }));
        const result = await window.backupHub.cleanup.laptopStart({ planId: p.id, hash: p.hash, confirmed: true, expectCount: totals.count, expectBytes: totals.bytes, groups });
        if (result.ok) {
          setPlanState({ state: 'idle' });
          setConfirming(false);
          setMessage({ tone: 'ok', text: 'Moving to the quarantine has started. Each file is checked again right before it moves. Watch it in Jobs.' });
          onStarted();
        } else setMessage({ tone: 'warn', text: result.message });
      } catch {
        setMessage({ tone: 'warn', text: 'That did not work. Nothing was moved.' });
      } finally {
        setStarting(false);
      }
    })();
  };

  return (
    <div className="settings-stack">
      <p className="cell-sub">
        Finds identical files on this laptop (same contents). You choose which copy to keep; the others are moved to the folder {QUARANTINE_WORDS} on the same drive, not deleted, and you can undo it. Backup Hub never touches its own folders, MyData, PhoneBackup, the
        backup drive, the cloud or OneDrive folders.
      </p>
      <Toggle
        label="Also look for duplicates in my C: folders"
        checked={settings.duplicatesInUserFolders}
        hint="Off by default. Your Documents, Desktop, Pictures, Downloads and everything else under your Windows user folder are left alone. Turn it on only if you want those offered too: a copy you move is put in the quarantine (not deleted) and Undo puts it back, but these are the files you use every day, so look at each group before you tick it."
        onChange={(checked) => {
          void update('duplicatesInUserFolders', checked);
          setPlanState({ state: 'idle' });
          setTicked(new Set());
        }}
      />
      <span className="settings-actions">
        <Button variant="primary" disabled={planState.state === 'loading'} onClick={makePlan}>
          {planState.state === 'loading' ? 'Looking for duplicates…' : 'Find duplicates'}
        </Button>
        <span className="cell-sub">Nothing is moved by this step.</span>
      </span>
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
                {plan.groups.length.toLocaleString('en-US')} {plan.groups.length === 1 ? 'group' : 'groups'} of identical files, {formatGb(plan.total.bytes)} could be freed
              </b>
            </p>
            {plan.stale ? (
              <p className="tone-text tone-text--warn" role="alert">
                The laptop was not checked in the last 24 hours, so nothing can be moved yet.{' '}
                <Button size="sm" variant="secondary" onClick={lookAgain}>
                  Check now
                </Button>
              </p>
            ) : null}
            {plan.notes.map((n) => (
              <p key={n} className="cell-sub">
                {n}
              </p>
            ))}
          </div>
          <div className="preview-list__top">
            <span className="preview-list__count" role="status">
              {tickedOfText(tickedCount, tickable.length)}
            </span>
            <span className="preview-list__bulk">
              <Button size="sm" variant="quiet" disabled={plan.stale || tickedCount === 0} onClick={() => setAll(false)}>
                Untick all
              </Button>
              <Button size="sm" variant="quiet" disabled={plan.stale || tickedCount === tickable.length} onClick={() => setAll(true)}>
                Tick all
              </Button>
            </span>
          </div>
          <div className="cloud-plan__list" tabIndex={0} aria-label="Groups of identical files">
            {plan.groups.map((g) => {
              const keep = keepOf(g);
              const removable = g.members.filter((m) => m.removable && m.relPath !== keep);
              return (
                <section key={g.id} aria-label={`Identical files, ${formatBytes(g.size)} each`}>
                  <p>
                    <label>
                      <input type="checkbox" checked={ticked.has(g.id)} disabled={plan.stale || removable.length === 0} onChange={(event) => toggle(g.id, event.target.checked)} /> <b>{shownPath(g.members[0]!.relPath).name}</b>{' '}
                      <span className="cell-sub">
                        {g.members.length} copies of {formatBytes(g.size)} · {removable.length} {removable.length === 1 ? 'copy' : 'copies'} would move ({formatBytes(removable.length * g.size)})
                      </span>
                    </label>
                  </p>
                  <table className="data-table cloud-plan__table" aria-label={`Copies of ${shownPath(g.members[0]!.relPath).name}`}>
                    <thead>
                      <tr>
                        <th>Keep</th>
                        <th>Where</th>
                        <th>What happens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.members.map((m) => (
                        <tr key={m.relPath}>
                          <td>
                            <input
                              type="radio"
                              name={`keep-${g.id}`}
                              aria-label={`Keep ${m.relPath}`}
                              checked={keep === m.relPath}
                              onChange={() => {
                                setKeeps(new Map(keeps).set(g.id, m.relPath));
                                setConfirming(false);
                              }}
                            />
                          </td>
                          <td className="cloud-plan__path" title={m.relPath}>
                            {shownPath(m.relPath).folder}
                            {m.collection ? <span className="cell-sub"> · in {m.collection}</span> : null}
                          </td>
                          <td>
                            {keep === m.relPath ? 'Kept' : m.removable ? 'Moves to the quarantine' : <span className="cell-sub">Stays: {m.why}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
          </div>
          <div className="cloud-plan__footer">
            <p className="cell-sub">
              {totals.count.toLocaleString('en-US')} {totals.count === 1 ? 'file' : 'files'} would move ({formatGb(totals.bytes)}).
            </p>
            {confirming && totals.count > 0 ? (
              <p className="tone-text tone-text--warn" role="alert">
                You are about to move {totals.count.toLocaleString('en-US')} {totals.count === 1 ? 'file' : 'files'} ({formatGb(totals.bytes)}) to the quarantine. One identical copy of each stays where it is. Nothing is deleted, and you can undo it.
              </p>
            ) : null}
            <div className="settings-actions">
              {confirming && totals.count > 0 ? (
                <>
                  <Button variant="primary" disabled={starting || plan.stale} onClick={() => start(plan)}>
                    {removeButtonText(totals.count, totals.bytes)}
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="primary" disabled={totals.count === 0 || plan.stale} onClick={() => setConfirming(true)}>
                  Review and move…
                </Button>
              )}
              <span className="cell-sub">Nothing moves until you press the Move button.</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
