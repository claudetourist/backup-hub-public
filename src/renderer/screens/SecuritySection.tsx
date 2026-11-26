import { useState } from 'react';
import { passphraseHint, type VaultResult } from '../../shared/vault';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { ShieldCheckIcon } from '../icons';
import { Pill } from '../components/StatusPill';
import { TextField } from '../components/TextField';
import { useVaultStatus } from '../vault/useVaultStatus';

type View = 'set' | 'change' | 'remove' | 'forgot' | 'unlock' | null;

/** A new-passphrase pair of fields with the plain strength hint and a match check. */
function NewPassphraseFields({
  idle,
  value,
  confirm,
  setValue,
  setConfirm,
  label = 'Recovery passphrase',
}: {
  idle: boolean;
  value: string;
  confirm: string;
  setValue: (v: string) => void;
  setConfirm: (v: string) => void;
  label?: string;
}) {
  const hint = passphraseHint(value);
  const mismatch = confirm !== '' && confirm !== value ? 'The two passphrases do not match.' : null;
  return (
    <>
      <TextField
        label={label}
        type="password"
        value={value}
        onChange={setValue}
        autoComplete="new-password"
        disabled={!idle}
        maxLength={1024}
        hint={
          <span className={`tone-text tone-text--${hint.level === 'strong' || hint.level === 'ok' ? 'ok' : hint.level === 'empty' ? 'neutral' : 'warn'}`}>
            {hint.text}
          </span>
        }
      />
      <TextField
        label="Type it again"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        disabled={!idle}
        maxLength={1024}
        error={mismatch}
      />
    </>
  );
}

export function SecuritySection() {
  const { status, apply } = useVaultStatus();
  const [view, setView] = useState<View>(null);
  const [current, setCurrent] = useState('');
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const clearFields = () => {
    setCurrent('');
    setPass('');
    setAgain('');
  };
  const open = (next: View) => {
    clearFields();
    setMessage(null);
    setView(next);
  };

  /** Run a vault call. Passphrase fields are cleared the moment it is sent, whatever the outcome. */
  const run = async (call: () => Promise<VaultResult>, success: string) => {
    setBusy(true);
    setMessage(null);
    clearFields();
    try {
      const result = await call();
      apply(result);
      if (result.ok) {
        setView(null);
        setMessage({ tone: 'ok', text: success });
      } else {
        setMessage({ tone: 'warn', text: result.message });
      }
    } catch {
      setMessage({ tone: 'warn', text: 'That did not work. Nothing was changed. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const hasPassphrase = status?.hasPassphrase ?? false;
  const locked = status?.state === 'locked';
  const unavailable = status?.state === 'unavailable';
  // Until a passphrase exists, the "set" form is simply there (no extra click).
  const shown: View = view ?? (status && !hasPassphrase && !unavailable ? 'set' : locked ? 'unlock' : null);

  const newOk = passphraseHint(pass).acceptable && pass === again;

  return (
    <Panel
      title="Security"
      accent="laptop"
      icon={ShieldCheckIcon}
      headerAside={
        status ? (
          <Pill tone={hasPassphrase ? 'ok' : 'amber'}>
            <span className="pill__dot" aria-hidden="true" />
            {hasPassphrase ? 'Recovery passphrase set' : 'No recovery passphrase'}
          </Pill>
        ) : undefined
      }
    >
      <div className="settings-stack">
        <p className="settings-copy">
          {hasPassphrase
            ? 'Your Google sign-ins are protected by your recovery passphrase. On a new computer you type it once and everything unlocks there.'
            : 'The app works fully without a recovery passphrase. Until you set one, saved sign-ins are tied to this laptop: if you move to another computer you would sign in again. A passphrase makes them portable.'}
        </p>

        {locked ? (
          <p className="tone-text tone-text--warn" role="status">
            This computer does not have the key yet. Type your recovery passphrase once to unlock the saved sign-ins here.
          </p>
        ) : null}
        {unavailable ? (
          <p className="tone-text tone-text--warn" role="status">
            This computer&apos;s protected copy of the key is missing, so the saved sign-ins cannot be read. You can sign in again (use &quot;Forgot passphrase&quot; below to start over). No files are affected.
          </p>
        ) : null}
        {status && !status.protectedStorageAvailable ? (
          <p className="tone-text tone-text--warn">Windows&apos; protected storage is not available right now, so new sign-ins cannot be saved safely.</p>
        ) : null}

        {shown === 'set' ? (
          <form
            className="settings-block"
            aria-label="Set a recovery passphrase"
            onSubmit={(e) => {
              e.preventDefault();
              if (newOk && !busy) void run(() => window.backupHub.vault.setPassphrase(pass), 'Recovery passphrase set. Keep it somewhere safe: it cannot be recovered.');
            }}
          >
            <b className="settings-block__title">Set a recovery passphrase</b>
            <NewPassphraseFields idle={!busy} value={pass} confirm={again} setValue={setPass} setConfirm={setAgain} />
            <span className="settings-actions">
              <Button type="submit" variant="primary" disabled={busy || !newOk}>
                Set passphrase
              </Button>
            </span>
          </form>
        ) : null}

        {shown === 'unlock' ? (
          <form
            className="settings-block"
            aria-label="Unlock with the recovery passphrase"
            onSubmit={(e) => {
              e.preventDefault();
              if (current !== '' && !busy) void run(() => window.backupHub.vault.unlock(current), 'Unlocked on this computer.');
            }}
          >
            <TextField label="Recovery passphrase" type="password" value={current} onChange={setCurrent} autoComplete="current-password" disabled={busy} maxLength={1024} />
            <span className="settings-actions">
              <Button type="submit" variant="primary" disabled={busy || current === ''}>
                Unlock
              </Button>
            </span>
          </form>
        ) : null}

        {shown === 'change' ? (
          <form
            className="settings-block"
            aria-label="Change the recovery passphrase"
            onSubmit={(e) => {
              e.preventDefault();
              if (current !== '' && newOk && !busy) void run(() => window.backupHub.vault.changePassphrase(current, pass), 'Passphrase changed. Saved sign-ins did not need to be touched.');
            }}
          >
            <b className="settings-block__title">Change the passphrase</b>
            <TextField label="Current passphrase" type="password" value={current} onChange={setCurrent} autoComplete="current-password" disabled={busy} maxLength={1024} />
            <NewPassphraseFields idle={!busy} value={pass} confirm={again} setValue={setPass} setConfirm={setAgain} label="New passphrase" />
            <span className="settings-actions">
              <Button type="submit" variant="primary" disabled={busy || current === '' || !newOk}>
                Change passphrase
              </Button>
              <Button disabled={busy} onClick={() => open(null)}>
                Cancel
              </Button>
            </span>
          </form>
        ) : null}

        {shown === 'remove' ? (
          <form
            className="confirm-box"
            aria-label="Remove the recovery passphrase"
            onSubmit={(e) => {
              e.preventDefault();
              if (current !== '' && !busy) void run(() => window.backupHub.vault.removePassphrase(current), 'Recovery passphrase removed. Sign-ins now stay on this laptop.');
            }}
          >
            <p>
              <b>Remove the recovery passphrase?</b> Saved sign-ins then stay tied to this laptop and cannot be unlocked on another computer. You can set a new passphrase any time.
            </p>
            <TextField label="Current passphrase" type="password" value={current} onChange={setCurrent} autoComplete="current-password" disabled={busy} maxLength={1024} />
            <span className="inline-edit__buttons">
              <Button type="submit" variant="primary" disabled={busy || current === ''}>
                Yes, remove it
              </Button>
              <Button disabled={busy} onClick={() => open(null)}>
                Keep it
              </Button>
            </span>
          </form>
        ) : null}

        {shown === 'forgot' ? (
          <div className="confirm-box" role="group" aria-label="Forgot passphrase">
            <p>
              <b>Start over without the passphrase?</b>
            </p>
            <p>
              Nobody can recover a forgotten passphrase, including this app. Continuing deletes the {status?.secretCount ?? 0} saved{' '}
              {status?.secretCount === 1 ? 'sign-in' : 'sign-ins'} and the passphrase setup, so you will need to sign in to your Google accounts again. Your files, backups and
              everything else in Backup Hub are not touched.
            </p>
            <span className="inline-edit__buttons">
              <Button variant="primary" disabled={busy} onClick={() => void run(() => window.backupHub.vault.forgot(true), 'Done. The saved sign-ins were deleted; sign in again when asked.')}>
                Yes, delete the saved sign-ins
              </Button>
              <Button disabled={busy} onClick={() => open(null)}>
                Cancel
              </Button>
            </span>
          </div>
        ) : null}

        {status && (hasPassphrase || unavailable) && shown !== 'forgot' ? (
          <span className="settings-actions">
            {hasPassphrase && !locked ? (
              <>
                <Button disabled={busy} onClick={() => open('change')}>
                  Change passphrase
                </Button>
                <Button disabled={busy} onClick={() => open('remove')}>
                  Remove passphrase
                </Button>
              </>
            ) : null}
            <Button variant="quiet" disabled={busy} onClick={() => open('forgot')}>
              Forgot passphrase
            </Button>
          </span>
        ) : null}

        {message ? (
          <span className={`tone-text tone-text--${message.tone}`} role="status">
            {message.text}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
