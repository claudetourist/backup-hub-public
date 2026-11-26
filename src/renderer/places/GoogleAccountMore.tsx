import { useState } from 'react';
import type { PlaceView } from '../../shared/places';
import { Button } from '../components/Button';
import { removeQuestion } from './googleAccountModel';

/** "More" on one Google account: Sign out (the app's permission is given back to Google) and Remove from the list. Nothing in the account is deleted. */
export function GoogleAccountMore({ account }: { account: PlaceView }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = (action: () => Promise<{ ok: boolean; message: string }>): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const r = await action();
        setMessage(r.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      } finally {
        setBusy(false);
        setAsking(false);
      }
    })();
  };
  return (
    <details className="more account-more">
      <summary>More</summary>
      <span className="settings-actions">
        <Button size="sm" variant="quiet" disabled={busy || account.status === 'needs_signin'} title="Gives Backup Hub's permission back to Google and forgets the sign-in on this computer" onClick={() => run(() => window.backupHub.googleAccounts.signOut(account.id))}>
          Sign out
        </Button>
        {asking ? null : (
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => setAsking(true)}>
            Remove from the list
          </Button>
        )}
      </span>
      {asking ? (
        <span className="settings-stack" role="alert">
          <span className="cell-sub">{removeQuestion(account.label)}</span>
          <span className="settings-actions">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => window.backupHub.googleAccounts.remove(account.id, true))}>
              Yes, take it off the list
            </Button>
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </span>
        </span>
      ) : null}
      {message ? (
        <span className="cell-sub" role="status">
          {message}
        </span>
      ) : null}
    </details>
  );
}
