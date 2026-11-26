import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { useNavigate } from '../navContext';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { useOwnerActions } from '../profiles/useOwnerActions';
import { ADD_ACCOUNT_BUTTON, ADD_WAITING, WHOSE_QUESTION } from './googleAccountModel';

type Step = { name: 'idle' } | { name: 'waiting' } | { name: 'whose'; placeId: string; label: string };

/**
 * "Add a Google account" on the Devices page: opens the browser to sign in, then asks "Whose account is this?" (the people of this laptop). The account is
 * added to the first person at once and moved to the one you pick. Nothing in the Google account is changed.
 */
export function AddGoogleAccount() {
  const { profiles } = useProfileScope();
  const { setPlaceOwner } = useOwnerActions();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [message, setMessage] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  useEffect(() => {
    void window.backupHub.googleAccounts
      .keyStatus()
      .then((s) => setKeySaved(s.saved))
      .catch(() => setKeySaved(null));
  }, []);

  const add = (): void => {
    setMessage(null);
    setStep({ name: 'waiting' });
    void (async () => {
      try {
        const r = await window.backupHub.googleAccounts.add();
        if (r.ok) {
          setMessage(r.message);
          setStep(profiles.length > 1 ? { name: 'whose', placeId: r.placeId, label: r.label } : { name: 'idle' });
        } else {
          setMessage(r.message);
          setStep({ name: 'idle' });
        }
      } catch {
        setMessage('That did not work. Nothing was added.');
        setStep({ name: 'idle' });
      }
    })();
  };

  const choose = (personId: number): void => {
    if (step.name !== 'whose') return;
    const placeId = step.placeId;
    void (async () => {
      const ok = await setPlaceOwner(placeId, personId);
      setMessage(ok ? 'Saved.' : 'That did not work. The account stays with the first person; you can change it in the list.');
      setStep({ name: 'idle' });
    })();
  };

  return (
    <div className="settings-stack add-google">
      {step.name === 'idle' ? (
        <span className="settings-actions">
          <Button size="sm" variant="secondary" disabled={keySaved === false} onClick={add}>
            {ADD_ACCOUNT_BUTTON}
          </Button>
          {keySaved === false ? (
            <Button size="sm" variant="quiet" onClick={() => navigate('settings', 'drives')}>
              Save the Google app key first (Settings)
            </Button>
          ) : null}
        </span>
      ) : null}
      {step.name === 'waiting' ? (
        <span className="cell-sub" role="status">
          {ADD_WAITING}
        </span>
      ) : null}
      {step.name === 'whose' ? (
        <span className="settings-stack" role="group" aria-label={WHOSE_QUESTION}>
          <b>{WHOSE_QUESTION}</b>
          <span className="cell-sub">{step.label}</span>
          <span className="settings-actions">
            {profiles.map((p) => (
              <Button key={p.id} size="sm" variant="secondary" onClick={() => choose(p.id)}>
                {p.name}
              </Button>
            ))}
          </span>
        </span>
      ) : null}
      {message ? (
        <span className="cell-sub" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
