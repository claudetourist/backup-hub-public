import { useMemo, useState } from 'react';
import type { PlaceView } from '../../shared/places';
import { Button } from '../components/Button';
import { OwnerChip } from '../components/OwnerChip';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { useOwnerActions } from '../profiles/useOwnerActions';
import { ProgressBar } from '../components/ProgressBar';
import { TextField } from '../components/TextField';
import {
  ACCOUNT_SORTS,
  accountFacts,
  accountsFold,
  accountsSummary,
  filterAccounts,
  noAccountMatchText,
  percentTone,
  sortAccounts,
  usedOfText,
  type AccountSort,
  type AccountsView,
} from './devicesModel';
import { accountCheckedText } from './placesModel';
import { GoogleAccountMore } from './GoogleAccountMore';
import { LoseButton } from '../insights/HealthFacts';

function AccountRow({ account, now, busy, onSignIn }: { account: PlaceView; now: number; busy: boolean; onSignIn: () => void }) {
  const { profiles } = useProfileScope();
  const { setPlaceOwner } = useOwnerActions();
  const facts = accountFacts(account);
  const tone = facts.percent === null ? 'neutral' : percentTone(facts.percent);
  return (
    <li className="account-row">
      <b className="account-row__name" title={account.label}>
        {account.label}
      </b>
      <span className="account-row__owner">
        <OwnerChip what={account.label} owner={profiles.find((p) => p.id === account.profileId) ?? null} people={profiles} onChoose={(personId) => void setPlaceOwner(account.id, personId)} />
      </span>
      {facts.usedBytes !== null && facts.limitBytes !== null && facts.percent !== null ? (
        <>
          <ProgressBar label={`Space used in ${account.label}`} value={facts.percent} tone={tone} valueText={`${facts.percent}% used`} />
          <span className="cell-sub account-row__space">{usedOfText(facts.usedBytes, facts.limitBytes)}</span>
          <span className={`tone-text tone-text--${tone} account-row__percent`}>{facts.percent}%</span>
        </>
      ) : (
        <span className="cell-sub account-row__unknown">Space not known yet</span>
      )}
      <span className="cell-sub account-row__checked">{accountCheckedText(account.lastLookedAt, now)}</span>
      <span className="account-row__action">
        {account.status === 'needs_signin' ? (
          <Button variant="primary" size="sm" disabled={busy || account.gdrive?.refresh.signingIn === true} title="Opens your web browser so you can sign in to this Google account again" onClick={onSignIn}>
            Sign in again
          </Button>
        ) : null}
        <LoseButton place={account} />
        <GoogleAccountMore account={account} />
      </span>
    </li>
  );
}

/** One account as a card (the Grid view): name, owner, the space bar, when it was last checked. */
function AccountCard({ account, now, busy, onSignIn }: { account: PlaceView; now: number; busy: boolean; onSignIn: () => void }) {
  const { profiles } = useProfileScope();
  const { setPlaceOwner } = useOwnerActions();
  const facts = accountFacts(account);
  const tone = facts.percent === null ? 'neutral' : percentTone(facts.percent);
  return (
    <li className="account-card">
      <b className="account-card__name" title={account.label}>
        {account.label}
      </b>
      <OwnerChip what={account.label} owner={profiles.find((p) => p.id === account.profileId) ?? null} people={profiles} onChoose={(personId) => void setPlaceOwner(account.id, personId)} />
      {facts.usedBytes !== null && facts.limitBytes !== null && facts.percent !== null ? (
        <>
          <ProgressBar label={`Space used in ${account.label}`} value={facts.percent} tone={tone} valueText={`${facts.percent}% used`} />
          <span className="account-card__space">
            <span className="cell-sub">{usedOfText(facts.usedBytes, facts.limitBytes)}</span>
            <span className={`tone-text tone-text--${tone}`}>{facts.percent}%</span>
          </span>
        </>
      ) : (
        <span className="cell-sub">Space not known yet</span>
      )}
      <span className="cell-sub">{accountCheckedText(account.lastLookedAt, now)}</span>
      {account.status === 'needs_signin' ? (
        <Button variant="primary" size="sm" disabled={busy || account.gdrive?.refresh.signingIn === true} title="Opens your web browser so you can sign in to this Google account again" onClick={onSignIn}>
          Sign in again
        </Button>
      ) : null}
      <LoseButton place={account} />
      <GoogleAccountMore account={account} />
    </li>
  );
}

/**
 * The Google accounts, as a compact list (or cards in the Grid view): one summary line, a search box that filters as you type (any part of the address or
 * nickname) and a sort (fullest first to begin with). The 8 first are shown, the rest sit behind "Show all". Nothing here changes
 * an account except "Sign in again", which opens the browser.
 */
export function GoogleAccountsGrid({ accounts, now, view = 'list' }: { accounts: readonly PlaceView[]; now: number; view?: AccountsView }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<AccountSort>('used');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const shown = useMemo(() => sortAccounts(filterAccounts(accounts, query), sort), [accounts, query, sort]);
  const fold = accountsFold(shown, opened, query.trim() !== '');

  const signIn = (id: string): void => {
    setBusy(id);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.drive.signIn(id);
        if (!result.ok) setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      } finally {
        setBusy(null);
      }
    })();
  };

  if (accounts.length === 0) return <p className="cell-sub">No Google account yet.</p>;
  return (
    <div className="devices-accounts cat--google">
      <p className="devices-accounts__summary">{accountsSummary(accounts)}</p>
      <div className="devices-accounts__tools">
        <TextField label="Find an account" value={query} onChange={setQuery} maxLength={200} />
        <label className="devices-accounts__sort">
          <span className="fbar__label">Sort by</span>
          <select className="fsmall" value={sort} onChange={(event) => setSort(event.target.value as AccountSort)}>
            {ACCOUNT_SORTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="row-list__empty" role="status">
          {noAccountMatchText(query)}
        </p>
      ) : (
        <>
          <ul className={view === 'grid' ? 'account-grid' : 'account-list'} aria-label="Google accounts">
            {fold.rows.map((account) =>
              view === 'grid' ? <AccountCard key={account.id} account={account} now={now} busy={busy === account.id} onSignIn={() => signIn(account.id)} /> : <AccountRow key={account.id} account={account} now={now} busy={busy === account.id} onSignIn={() => signIn(account.id)} />,
            )}
          </ul>
          {fold.foldText ? (
            <span>
              <Button variant="quiet" size="sm" onClick={() => setOpened(!opened)}>
                {fold.foldText}
              </Button>
            </span>
          ) : null}
        </>
      )}
      {message ? (
        <span className="tone-text tone-text--warn" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
