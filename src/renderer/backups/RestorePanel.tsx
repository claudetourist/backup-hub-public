import { useEffect, useMemo, useState } from 'react';
import type { RestoreDateView, RestoreDestination, RestoreInfoResult } from '../../shared/restore';
import { Button } from '../components/Button';
import { RestoreDays, RestoreBrowser } from './RestoreBrowser';
import { RestoreDestinationChoice } from './RestoreDestination';
import { RestoreRun } from './RestoreRun';
import { pickOf, RESTORE_SHOW_BUTTON, type RestoreMode } from './restoreModel';

type Info = Extract<RestoreInfoResult, { ok: true }>;

/**
 * "Get files back" on a backup's page: pick a day and tick folders and files (or take the newest copy of every file), choose where they go, see the list, press
 * the one button. The files come from the T7 or the Seagate, whichever is plugged in. Nothing is replaced.
 */
export function RestorePanel({ backupId, onFinished }: { backupId: number; onFinished?: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<RestoreMode>('day');
  const [dates, setDates] = useState<readonly RestoreDateView[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [ticks, setTicks] = useState<ReadonlySet<string>>(new Set());
  const [everything, setEverything] = useState(false);
  const [destination, setDestination] = useState<RestoreDestination>({ mode: 'new' });
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.backupHub.restore.info(backupId);
        if (!alive) return;
        if (r.ok) setInfo(r);
        else setProblem(r.message);
      } catch {
        if (alive) setProblem('This backup could not be read.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [backupId]);

  const ready = info !== null;
  const flat = info?.layout === 'flat';
  useEffect(() => {
    if (!ready || flat) return;
    let alive = true;
    void (async () => {
      try {
        const r = await window.backupHub.restore.dates(backupId);
        if (!alive) return;
        if (r.ok) {
          setDates(r.dates);
          setDay((cur) => cur ?? r.dates[0]?.folder ?? null);
        } else setProblem(r.message);
      } catch {
        if (alive) setProblem('The days of this backup could not be read.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [backupId, ready, flat]);

  const pick = useMemo(() => pickOf({ mode, backupId, flat: flat === true, day, everything, ticks }), [mode, backupId, flat, day, everything, ticks]);

  if (info === null)
    return (
      <p className="cell-sub" role="status">
        {problem ?? 'Reading the backup…'}
      </p>
    );

  if (reviewing && pick !== null) return <RestoreRun pick={pick} destination={destination} onBack={() => setReviewing(false)} {...(onFinished ? { onFinished } : {})} />;

  return (
    <div className="settings-stack" aria-label="Get files back">
      <span className="cell-sub">{info.from ? `The files come from ${info.from.label}, or from Google if a copy there is the only one left. Nothing there is changed.` : (info.message ?? 'The files come from Google.')}</span>
      <span className="chips" role="group" aria-label="What to get back">
        <button type="button" className="chip" aria-pressed={mode === 'day'} onClick={() => setMode('day')}>
          {flat ? 'Pick files' : 'Pick files by day'}
        </button>
        <button type="button" className="chip" aria-pressed={mode === 'newest'} onClick={() => setMode('newest')}>
          The newest copy of every file
        </button>
      </span>
      {mode === 'day' ? (
        <>
          {!flat ? dates === null ? <p className="cell-sub" role="status">{problem ?? 'Reading the days…'}</p> : dates.length === 0 ? <p className="cell-sub">This backup has no days yet.</p> : <RestoreDays dates={dates} day={day} onPick={(d) => { setDay(d); setTicks(new Set()); setEverything(false); }} /> : null}
          {flat || day !== null ? <RestoreBrowser key={flat ? 'flat' : day} backupId={backupId} day={flat ? null : day} ticks={ticks} everything={everything} onTicks={setTicks} onEverything={setEverything} /> : null}
        </>
      ) : (
        <span className="cell-sub">Every file comes back once, in the newest version that was backed up.</span>
      )}
      <RestoreDestinationChoice name={'restore-where-' + backupId} value={destination} defaultParent={info.defaultParent} originalWords={info.originalWords} onChange={setDestination} />
      <span className="settings-actions">
        <Button variant="primary" disabled={pick === null} onClick={() => setReviewing(true)}>
          {RESTORE_SHOW_BUTTON}
        </Button>
      </span>
    </div>
  );
}
