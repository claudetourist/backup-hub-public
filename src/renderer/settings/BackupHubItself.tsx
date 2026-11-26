import { useState } from 'react';
import { isDriveProtected, readOnlyLine } from '../../shared/settings';
import { Button } from '../components/Button';
import { formatWhen } from '../jobs/jobsModel';
import { useJobs } from '../jobs/JobsProvider';
import { useNow } from '../jobs/useNow';
import { usePlaces } from '../places/PlacesProvider';
import { GoogleRecovery, RestoreBackupHub } from '../screens/RecoveryAndRestore';
import { SavedCopies } from '../screens/SavedCopies';
import { useSettings } from './SettingsProvider';

/**
 * "Backup Hub itself" (Settings > Tools): Backup Hub's own safety: the settings file saved to your drives, the saved copies
 * list (check, restore), and the recovery copy in Google Drive.
 */

interface ActionResult {
  ok: boolean;
  message: string;
  canceled?: boolean;
}

export function BackupHubItselfPanel() {
  const { settings } = useSettings();
  const { snapshot } = usePlaces();
  const { jobs } = useJobs();
  const now = useNow();
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const named = (snapshot?.places ?? []).filter((p) => p.kind === 'drive');
  const connected = named.filter((p) => p.status === 'connected');
  const writable = connected.filter((p) => !isDriveProtected(settings, p));
  const protectedConnected = connected.find((p) => isDriveProtected(settings, p));
  const lastSave = jobs.find((job) => job.kind === 'settings.saveToDrive' && (job.state === 'done' || job.state === 'done_warnings'));

  const act = async (run: () => Promise<ActionResult>) => {
    setBusy(true);
    try {
      const result = await run();
      if (!result.canceled) setMessage({ tone: result.ok ? 'ok' : 'warn', text: result.message });
    } catch {
      setMessage({ tone: 'warn', text: 'That did not work. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plan-section" aria-label="Saved copies and recovery copy">
      <span className="page-header__eyebrow">What</span>
      <p className="cell-sub">A copy of Backup Hub&apos;s own index and a file with its settings, saved in BackupHub / settings on your backup drives. Start saves these by itself at its last step; Save now does it on demand.</p>
      <div className="settings-stack">
        <p className="cell-sub">
          {named.length === 0
            ? 'No drive has been named yet. Name your backup drives under Settings, Drives and accounts first.'
            : `Named drives: ${named.map((p) => `${p.label} (${p.status === 'connected' ? 'connected' : 'not connected'})`).join(', ')}.`}
          {lastSave?.finishedAt ? ` Last saved ${formatWhen(lastSave.finishedAt, now)}.` : ''}
        </p>
        <span className="settings-actions">
          <Button
            disabled={busy || writable.length === 0}
            onClick={() =>
              void act(async () => {
                const result = await window.backupHub.settings.saveToDriveNow();
                return result.ok ? { ok: true, message: 'Saving now. Watch it in the side panel.' } : { ok: false, message: result.message };
              })
            }
          >
            Save now
          </Button>
          {connected.length > 0 && writable.length === 0 && protectedConnected ? <span className="cell-sub">{readOnlyLine(protectedConnected.label)}</span> : null}
          <Button disabled={busy} onClick={() => void act(() => window.backupHub.settings.exportToFile())}>
            Export settings
          </Button>
          <Button disabled={busy} onClick={() => void act(() => window.backupHub.settings.importFromFile())}>
            Import settings
          </Button>
        </span>
        <SavedCopies refreshKey={lastSave?.finishedAt ?? 0} />
        <RestoreBackupHub />
        <GoogleRecovery />
        <p className="cell-sub">Exports never include passwords or Google sign-ins. Importing only adds; it never removes or overwrites what you have.</p>
        {message ? (
          <span className={`tone-text tone-text--${message.tone}`} role="status">
            {message.text}
          </span>
        ) : null}
      </div>
    </section>
  );
}
