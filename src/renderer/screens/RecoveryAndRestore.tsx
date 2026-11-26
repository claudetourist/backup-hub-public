import { useCallback, useEffect, useState } from 'react';
import type { ChosenRestoreFile, RestoreStatus } from '../../shared/settings';
import { RECOVERY_DRIVE_KEEP } from '../../shared/settings';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { formatBytes } from '../lib/format';
import { usePlaces } from '../places/PlacesProvider';
import { useSettings } from '../settings/SettingsProvider';

type Note = { tone: 'ok' | 'warn'; text: string } | null;

function NoteLine({ note }: { note: Note }) {
  return note ? (
    <span className={`tone-text tone-text--${note.tone}`} role="status">
      {note.text}
    </span>
  ) : null;
}

/**
 * The encrypted recovery copy of Backup Hub's database in ONE Google Drive account. Off until the person picks the account
 * (nothing is sent before that). Backup Hub never deletes in Drive, so it stops at 7 copies and says how to go on.
 */
export function GoogleRecovery() {
  const { settings, update } = useSettings();
  const { snapshot } = usePlaces();
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const accounts = (snapshot?.places ?? []).filter((p) => p.kind === 'gdrive');
  const chosen = accounts.find((a) => a.id === settings.recoveryGoogleAccount) ?? null;

  const sendNow = (): void => {
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const result = await window.backupHub.settings.recoveryNow();
        setNote(result.ok ? { tone: 'ok', text: 'Saving now. Watch it in Jobs.' } : { tone: 'warn', text: result.message });
      } catch {
        setNote({ tone: 'warn', text: 'That did not work. Nothing was sent.' });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="settings-stack">
      <b>Recovery copy in Google Drive</b>
      <p className="cell-sub">
        An encrypted copy of Backup Hub's own list (not your files), so a new laptop can start where this one stopped. It is opened with your recovery passphrase, so set one
        first (Security). Off until you pick an account below.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="recovery-account">
          Which Google account keeps it
        </label>
        <select
          id="recovery-account"
          className="search-unit"
          value={settings.recoveryGoogleAccount ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            void update('recoveryGoogleAccount', value === '' ? null : value);
            if (value === '') void update('recoveryToGoogle', false);
          }}
        >
          <option value="">None chosen</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <span className="settings-actions">
        <Button disabled={busy || chosen === null} onClick={sendNow}>
          Send one now
        </Button>
        <span className="cell-sub">Only when you press it. Backup Hub never deletes in Drive, so it stops at {RECOVERY_DRIVE_KEEP} copies; remove old ones by hand there to let it go on.</span>
      </span>
      <NoteLine note={note} />
    </div>
  );
}

/**
 * Restore Backup Hub (new laptop or after a loss): from a copy on a backup drive (see the list above) or a file the person
 * chose (a database copy, or a recovery file downloaded from Google Drive). The copy is checked and staged; the swap happens when
 * Backup Hub is opened again, and what was in use is moved aside, never deleted.
 */
export function RestoreBackupHub() {
  const [status, setStatus] = useState<RestoreStatus>({ pending: null });
  const [chosen, setChosen] = useState<Extract<ChosenRestoreFile, { ok: true }> | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    window.backupHub.settings
      .restoreStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const choose = (): void => {
    setNote(null);
    setConfirming(false);
    void (async () => {
      try {
        const result = await window.backupHub.settings.chooseRestoreFile();
        if (result.ok) setChosen(result);
        else if (!result.canceled) setNote({ tone: 'warn', text: result.message });
      } catch {
        setNote({ tone: 'warn', text: 'That did not work. Please try again.' });
      }
    })();
  };

  const restore = (): void => {
    setBusy(true);
    setConfirming(false);
    void (async () => {
      try {
        const result = await window.backupHub.settings.restoreFromFile(chosen?.kind === 'recovery' ? passphrase : null, true);
        setNote({ tone: result.ok ? 'ok' : 'warn', text: result.message });
        if (result.ok) {
          setPassphrase('');
          setChosen(null);
        }
      } catch {
        setNote({ tone: 'warn', text: 'That did not work. Nothing was changed.' });
      } finally {
        setBusy(false);
        reload();
      }
    })();
  };

  const cancel = (): void => {
    void (async () => {
      try {
        await window.backupHub.settings.cancelRestore();
        setNote({ tone: 'ok', text: 'The restore was cancelled. Nothing was changed.' });
      } catch {
        setNote({ tone: 'warn', text: 'That did not work.' });
      }
      reload();
    })();
  };

  return (
    <div className="settings-stack">
      <b>Restore Backup Hub on a new laptop</b>
      {status.pending ? (
        <div className="cell-stack cell-stack--tight">
          <span>
            <b>Ready to restore:</b> {status.pending.source}. It holds {status.pending.summary}.
          </span>
          <span className="cell-sub">Close Backup Hub and open it again to finish. What you have now is moved aside into the "before-restore" folder, not deleted.</span>
          <span className="settings-actions">
            <Button variant="quiet" onClick={cancel}>
              Cancel the restore
            </Button>
          </span>
        </div>
      ) : (
        <p className="cell-sub">
          Pick a database copy saved on your backup drive (in the list above), or choose a file here: a database copy, or a recovery file you downloaded from Google Drive.
          Nothing changes until you confirm, and then only at the next start.
        </p>
      )}
      <span className="settings-actions">
        <Button disabled={busy} onClick={choose}>
          Choose a file…
        </Button>
        {chosen ? (
          <span className="cell-sub">
            {chosen.name} ({formatBytes(chosen.bytes)}, {chosen.kind === 'recovery' ? 'recovery file' : 'database copy'})
          </span>
        ) : null}
      </span>
      {chosen?.kind === 'recovery' ? <TextField label="Recovery passphrase" type="password" value={passphrase} onChange={setPassphrase} hint="The one you set under Security on the old laptop." autoComplete="current-password" /> : null}
      {chosen ? (
        confirming ? (
          <span className="cell-stack cell-stack--tight">
            <b>Check this copy and get it ready?</b>
            <span className="cell-sub">It is checked first. The swap happens when Backup Hub is opened again; what you have now is kept aside.</span>
            <span className="settings-actions">
              <Button variant="primary" disabled={busy || (chosen.kind === 'recovery' && passphrase === '')} onClick={restore}>
                Yes, get it ready
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Not now
              </Button>
            </span>
          </span>
        ) : (
          <span className="settings-actions">
            <Button disabled={busy} onClick={() => setConfirming(true)}>
              Restore from this file
            </Button>
          </span>
        )
      ) : null}
      <NoteLine note={note} />
    </div>
  );
}
