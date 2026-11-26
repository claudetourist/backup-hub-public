import { useEffect, useState } from 'react';
import type { GoogleKeyStatus } from '../../shared/googleCopy';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { KEY_MISSING, KEY_SAVED, KEY_TITLE, keyReady } from './googleAccountModel';

/**
 * The Google app key (client ID and secret) in Settings: shown as boxes when it is missing, as one line with "Replace" when it is saved. The secret is
 * kept like every other secret (locked on this computer) and is never shown again.
 */
export function GoogleKeyBox() {
  const [status, setStatus] = useState<GoogleKeyStatus | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = (): void => {
    void window.backupHub.googleAccounts
      .keyStatus()
      .then(setStatus)
      .catch(() => setStatus({ saved: false, problem: 'That did not work. Please try again.' }));
  };
  useEffect(load, []);

  const save = (): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const r = await window.backupHub.googleAccounts.saveKey({ clientId, clientSecret });
        setMessage(r.message);
        if (r.ok) {
          setClientId('');
          setClientSecret('');
          setReplacing(false);
          load();
        }
      } catch {
        setMessage('That did not work. Nothing was saved.');
      } finally {
        setBusy(false);
      }
    })();
  };

  if (status === null) return null;
  const showBoxes = !status.saved || replacing;
  return (
    <div className="settings-stack google-key">
      <b>{KEY_TITLE}</b>
      {status.problem ? <span className="cell-sub" role="status">{status.problem}</span> : null}
      {!showBoxes ? (
        <span className="settings-actions">
          <span className="cell-sub">{KEY_SAVED}</span>
          <Button size="sm" variant="quiet" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </span>
      ) : (
        <>
          {!status.saved ? <span className="cell-sub">{KEY_MISSING}</span> : null}
          <TextField label="Client ID" value={clientId} onChange={setClientId} maxLength={400} disabled={busy} />
          <TextField label="Client secret" value={clientSecret} onChange={setClientSecret} type="password" maxLength={400} disabled={busy} />
          <span className="settings-actions">
            <Button variant="primary" size="sm" disabled={busy || !keyReady({ clientId, clientSecret })} onClick={save}>
              Save the key
            </Button>
            {replacing ? (
              <Button variant="quiet" size="sm" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            ) : null}
          </span>
        </>
      )}
      {message ? <span className="cell-sub" role="status">{message}</span> : null}
    </div>
  );
}
