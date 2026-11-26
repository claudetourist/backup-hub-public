import { useState } from 'react';
import { isDriveProtected, MAX_DRIVE_REMINDER_DAYS, MIN_DRIVE_REMINDER_DAYS, readOnlyLine, validSettingValue, withProtection } from '../../shared/settings';
import { nameDriveConfirmation, type PlaceView, type UnnamedDriveView } from '../../shared/places';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { CloudIcon, DriveIcon } from '../icons';
import { TextField } from '../components/TextField';
import { Toggle } from '../components/Toggle';
import { EjectButton } from '../places/EjectButton';
import { GoogleKeyBox } from '../places/GoogleKeyBox';
import { usePlaces } from '../places/PlacesProvider';
import { placeStatus, quotaText, unnamedDriveDetail } from '../places/placesModel';
import { useSettings } from '../settings/SettingsProvider';

/**
 * Drives and accounts: name a drive, rename it, eject it, make it read-only; and see each Google account, sign it in again or
 * read its space. Everything here is the person's own click; nothing starts by itself.
 */
export function DrivesAndAccounts() {
  const { snapshot, refresh } = usePlaces();
  const places = snapshot?.places ?? [];
  const drives = places.filter((p) => p.kind === 'drive');
  const accounts = places.filter((p) => p.kind === 'gdrive');
  return (
    <>
      <UnnamedDrives unnamed={snapshot?.unnamed ?? []} refresh={refresh} />
      <Drives drives={drives} />
      <GoogleAccounts accounts={accounts} />
    </>
  );
}

function UnnamedDrives({ unnamed, refresh }: { unnamed: UnnamedDriveView[]; refresh: () => void }) {
  const [naming, setNaming] = useState<{ drive: UnnamedDriveView; name: string; error: string | null; busy: boolean } | null>(null);
  if (unnamed.length === 0) return null;
  const confirm = (): void => {
    if (!naming) return;
    const { drive } = naming;
    setNaming({ ...naming, busy: true, error: null });
    void (async () => {
      try {
        const request = { letter: drive.letter, name: naming.name, confirmed: true as const };
        const result = await window.backupHub.places.nameDrive(drive.probable ? { ...request, existingPlaceId: drive.probable.placeId } : request);
        if (result.ok) {
          setNaming(null);
          refresh();
        } else setNaming({ ...naming, busy: false, error: result.message });
      } catch {
        setNaming({ ...naming, busy: false, error: 'That did not work. Nothing was written. Please try again.' });
      }
    })();
  };
  return (
    <Panel title="Drives plugged in that have no name yet" accent="drive" icon={DriveIcon}>
      <div className="settings-stack">
        <p className="cell-sub">Backup Hub tells drives apart by a small ID file on the drive, not by its letter. Name your backup drives T7 and Seagate2TB so Start can find them.</p>
        <ul className="row-list">
          {unnamed.map((drive) => (
            <li key={drive.letter} className="row-list__item">
              <span className="row-list__top">
                <span className="cell-stack">
                  <b>
                    {drive.letter}
                    {drive.label ? ` ${drive.label}` : ''}
                  </b>
                  <span className="cell-sub">{unnamedDriveDetail(drive)}</span>
                  {drive.probable ? <span className="tone-text tone-text--amber">Probably {drive.probable.label}. Confirm to write its ID file again.</span> : null}
                  {drive.reason ? <span className="tone-text tone-text--warn">{drive.reason}</span> : null}
                </span>
                {drive.canName && naming?.drive.letter !== drive.letter ? (
                  <Button variant={drive.probable ? 'secondary' : 'primary'} size="sm" onClick={() => setNaming({ drive, name: drive.probable?.label ?? '', error: null, busy: false })}>
                    {drive.probable ? `Yes, it is ${drive.probable.label}` : 'Name this drive'}
                  </Button>
                ) : null}
              </span>
              {naming?.drive.letter === drive.letter ? (
                <div className="name-drive" role="group" aria-label={`Name drive ${drive.letter}`}>
                  <TextField label={`Name for the drive in ${drive.letter}`} value={naming.name} onChange={(name) => setNaming({ ...naming, name, error: null })} error={naming.error} disabled={naming.busy} maxLength={60} autoFocus hint="Short and clear, for example T7." onEnter={confirm} />
                  <p className="name-drive__confirm">{nameDriveConfirmation(drive.letter)}</p>
                  <span className="inline-edit__buttons">
                    <Button variant="primary" disabled={naming.busy || naming.name.trim() === ''} onClick={confirm}>
                      Write the file to {drive.letter}
                    </Button>
                    <Button disabled={naming.busy} onClick={() => setNaming(null)}>
                      Cancel
                    </Button>
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function Rename({ place }: { place: PlaceView }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (value === null) {
    return (
      <Button variant="quiet" size="sm" onClick={() => setValue(place.label)}>
        Rename
      </Button>
    );
  }
  const save = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const result = await window.backupHub.places.rename(place.id, value);
        if (result.ok) setValue(null);
        else setError(result.message);
      } catch {
        setError('That did not work. Please try again.');
      } finally {
        setBusy(false);
      }
    })();
  };
  return (
    <span className="inline-edit">
      <TextField label={`New name for ${place.label}`} value={value} onChange={(v) => {
          setValue(v);
          setError(null);
        }} error={error} disabled={busy} maxLength={60} autoFocus onEnter={save} />
      <span className="inline-edit__buttons">
        <Button variant="primary" size="sm" disabled={busy} onClick={save}>
          Save name
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setValue(null)}>
          Cancel
        </Button>
      </span>
    </span>
  );
}

function Drives({ drives }: { drives: PlaceView[] }) {
  const { settings, update } = useSettings();
  const [confirmingOff, setConfirmingOff] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (drive: PlaceView, on: boolean): Promise<void> => {
    setProblem(await update('writeProtectedDrives', withProtection(settings, drive, on)));
    setConfirmingOff(null);
  };
  return (
    <Panel title="Drives" accent="drive" icon={DriveIcon}>
      <div className="settings-stack">
        <p className="cell-sub">Eject lets go of a plugged-in drive and asks Windows to eject it, so it can be unplugged safely. A read-only drive is only read: nothing is ever written, renamed or deleted on it.</p>
        {drives.length === 0 ? <p className="cell-sub">No drive has been named yet.</p> : null}
        {drives.map((drive) => {
          const on = isDriveProtected(settings, drive);
          const status = placeStatus(drive.status, drive.kind);
          return (
            <div key={drive.id} className="cell-stack cell-stack--tight drive-card">
              <span className="row-list__top">
                <b>{drive.label}</b>
                <span className={`tone-text tone-text--${status.tone}`}>{status.label}</span>
              </span>
              <Rename place={drive} />
              <Toggle
                label="Read-only (protected)"
                checked={on}
                hint={on ? readOnlyLine(drive.label) : `${drive.label} can be written to.`}
                onChange={(checked) => {
                  if (checked) void change(drive, true);
                  else setConfirmingOff(drive.id);
                }}
              />
              {confirmingOff === drive.id ? (
                <span className="cell-stack cell-stack--tight">
                  <b>Allow Backup Hub to write to {drive.label}?</b>
                  <span className="cell-sub">Start could then copy to this drive. Only do this when you know the drive is healthy.</span>
                  <span className="settings-actions">
                    <Button variant="primary" onClick={() => void change(drive, false)}>
                      Yes, allow writing
                    </Button>
                    <Button variant="quiet" onClick={() => setConfirmingOff(null)}>
                      Keep it read-only
                    </Button>
                  </span>
                </span>
              ) : null}
              {drive.status === 'connected' ? <EjectButton placeId={drive.id} label={drive.label} /> : null}
            </div>
          );
        })}
        {problem ? (
          <span className="tone-text tone-text--warn" role="status">
            {problem}
          </span>
        ) : null}
        <ReminderDays />
      </div>
    </Panel>
  );
}

/** "Remind me when a drive has not been plugged in for N days": a small number field. Saved as soon as the number is a whole number from 1 to 365. */
function ReminderDays() {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? String(settings.driveReminderDays);
  const change = (text: string): void => {
    const digits = text.replace(/\D/g, '').slice(0, 3);
    setDraft(digits);
    const days = digits === '' ? undefined : validSettingValue('driveReminderDays', Number(digits));
    if (days === undefined) {
      setProblem(`Use a whole number of days from ${MIN_DRIVE_REMINDER_DAYS} to ${MAX_DRIVE_REMINDER_DAYS}.`);
      return;
    }
    setProblem(null);
    void update('driveReminderDays', days).then((message) => {
      if (message !== null) setProblem(message);
      else setDraft(null);
      return undefined;
    });
  };
  return <TextField label="Remind me when a drive has not been plugged in for this many days" value={shown} onChange={change} error={problem} maxLength={3} hint="Home shows a line such as T7 not plugged in for 14 days. It only reminds you; nothing starts." />;
}

function GoogleAccounts({ accounts }: { accounts: PlaceView[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = (id: string, action: () => Promise<{ ok: boolean; message?: string }>): void => {
    setBusy(id);
    setMessage(null);
    void (async () => {
      try {
        const result = await action();
        if (!result.ok) setMessage(result.message ?? 'That did not work. Nothing was changed.');
      } catch {
        setMessage('That did not work. Nothing was changed.');
      } finally {
        setBusy(null);
      }
    })();
  };
  return (
    <Panel title="Google accounts" accent="google" icon={CloudIcon}>
      <div className="settings-stack">
        <p className="cell-sub">Sign in again when an account says it needs it. Refresh asks Google how much room the account has. Nothing in your Google accounts is ever changed or deleted by these buttons.</p>
        <GoogleKeyBox />
        {accounts.length === 0 ? <p className="cell-sub">No Google account yet. Add one on the Devices page, or bring them in from Fleet Manager v1 under Advanced.</p> : null}
        {accounts.map((a) => {
          const info = a.gdrive;
          const status = placeStatus(a.status, a.kind);
          const space = quotaText(info?.quotaUsageBytes ?? null, info?.quotaLimitBytes ?? null);
          return (
            <div key={a.id} className="cell-stack cell-stack--tight drive-card">
              <span className="row-list__top">
                <b>{a.label}</b>
                <span className={`tone-text tone-text--${status.tone}`}>{status.label}</span>
              </span>
              <span className="cell-sub">{space === '' ? 'Space not known yet' : space}</span>
              <span className="settings-actions">
                {a.status === 'needs_signin' ? (
                  <Button variant="primary" size="sm" disabled={busy === a.id || info?.refresh.signingIn === true} title="Opens your web browser so you can sign in to this Google account again" onClick={() => run(a.id, () => window.backupHub.drive.signIn(a.id))}>
                    Sign in again
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy === a.id || !info?.canRefresh} title="Asks Google for the space used. Nothing in the account is changed." onClick={() => run(a.id, () => window.backupHub.drive.refresh(a.id))}>
                    Read its space from Google
                  </Button>
                )}
                <Rename place={a} />
              </span>
            </div>
          );
        })}
        {message ? (
          <span className="tone-text tone-text--warn" role="status">
            {message}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
