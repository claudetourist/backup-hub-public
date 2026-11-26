import { useCallback, useState } from 'react';
import { browserStorage } from '../lib/sectionState';
import { ACCOUNTS_VIEWS, readAccountsView, writeAccountsView, type AccountsView } from './devicesModel';

/** The Google accounts view (List or Grid), remembered between visits. */
export function useAccountsView(): [AccountsView, (view: AccountsView) => void] {
  const [view, setView] = useState<AccountsView>(() => readAccountsView(browserStorage()));
  const choose = useCallback((next: AccountsView) => {
    writeAccountsView(browserStorage(), next);
    setView(next);
  }, []);
  return [view, choose];
}

/** The List / Grid switch next to the title of the Google accounts section. */
export function AccountsViewSwitch({ view, onChange }: { view: AccountsView; onChange: (view: AccountsView) => void }) {
  return (
    <span className="view-switch" role="group" aria-label="How to show the Google accounts">
      {ACCOUNTS_VIEWS.map((option) => (
        <button key={option.id} type="button" className="fchip" aria-pressed={view === option.id} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </span>
  );
}
