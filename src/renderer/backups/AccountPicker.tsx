import { useMemo, useState } from 'react';
import type { GoogleAccountPick } from '../../shared/googleCopy';
import { ProgressBar } from '../components/ProgressBar';
import { TextField } from '../components/TextField';
import { percentTone } from '../places/devicesModel';
import { StepHeading } from './GoogleSummary';
import { accountChecked, accountName, accountSpace, accountTake, filterAccountRows, showFindBox, sortAccountRows } from './googleModel';

const NOTHING_LOCKED: ReadonlySet<string> = new Set<string>();
const NO_GETS: Readonly<Record<string, string>> = {};

/**
 * Step 2, "Where to put it": every Google account of the backup's owner as a row with a tick, its space (asked from Google just now), what it can
 * still take inside the keep-free line, and a small fill bar. Accounts that cannot take anything are greyed with the reason and cannot be ticked.
 */
export function AccountPicker({
  accounts,
  ticks,
  locked = NOTHING_LOCKED,
  note,
  title,
  titleNote,
  gets = NO_GETS,
  onToggle,
}: {
  accounts: readonly GoogleAccountPick[];
  ticks: ReadonlySet<string>;
  /** Accounts the running copy already uses: ticked, cannot be unticked. */
  locked?: ReadonlySet<string>;
  note: string | null;
  /** The heading ("Step 2 of 3 · Where to put it") and the note on its right ("288 MB to fit · 31.2 GB room in 2 ticked accounts"). */
  title: string;
  titleNote: string;
  /** Per ticked account, what it gets (or takes of what is left), from googleModel `accountGetLines`. */
  gets?: Readonly<Record<string, string>>;
  onToggle: (placeId: string) => void;
}) {
  const [find, setFind] = useState('');
  const shown = useMemo(() => filterAccountRows(sortAccountRows(accounts), find), [accounts, find]);
  return (
    <>
      <StepHeading title={title} note={titleNote} />
      {note ? (
        <span className="cell-sub" role="note">
          {note}
        </span>
      ) : null}
      {showFindBox(accounts) ? <TextField label="Find an account" value={find} onChange={setFind} /> : null}
      <ul className="google-accounts" aria-label="Google accounts">
        {shown.map((a) => (
          <li key={a.placeId} className={`google-accounts__row${a.canTake ? '' : ' is-grey'}`}>
            <label>
              <input type="checkbox" checked={a.canTake && ticks.has(a.placeId)} disabled={!a.canTake || locked.has(a.placeId)} onChange={() => onToggle(a.placeId)} aria-label={accountName(a)} /> <b>{accountName(a)}</b>
            </label>
            <span className="cell-sub google-accounts__space">{accountSpace(a)}</span>
            {a.percent !== null && a.canTake ? <ProgressBar label={`Space used in ${accountName(a)}`} value={a.percent} tone={percentTone(a.percent)} valueText={`${a.percent}% used`} /> : null}
            <span className="cell-sub google-accounts__take">{accountTake(a)}</span>
            {locked.has(a.placeId) ? <span className="cell-sub">used by this copy</span> : null}
            {accountChecked(a) ? <span className="cell-sub">{accountChecked(a)}</span> : null}
            {a.canTake && ticks.has(a.placeId) && gets[a.placeId] ? <span className="google-accounts__get">{gets[a.placeId]}</span> : null}
          </li>
        ))}
      </ul>
      {shown.length === 0 ? <span className="cell-sub">No account matches.</span> : null}
    </>
  );
}
