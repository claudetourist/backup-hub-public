import { useState } from 'react';
import { KEEP_SYNC_ADD_BUTTON, KEEP_SYNC_NAME, KEEP_SYNC_PRIVACY, type FolderBackupCards } from '../../shared/folderBackup';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';

/** "Google Keep notes": offered while keep-sync's snapshots folder exists and the backup does not. */
export function KeepNotesCard({ cards, onAdded }: { cards: FolderBackupCards | null; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  if (!cards?.keepSync.available || cards.keepSync.exists) return null;

  const add = (): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.folderBackup.addKeepSync();
        if (result.ok) toast.show({ tone: 'ok', text: result.message });
        else setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
      onAdded();
    })();
  };

  return (
    <Panel title="Google Keep notes" accent="drive">
      <div className="settings-stack">
        <span className="cell-sub">Copy the snapshots of your Google Keep notes to the T7, adding only the ones it does not have yet.</span>
        <details className="more">
          <summary>More</summary>
          <div className="settings-stack">
            <span className="cell-sub">keep-sync saves a snapshot of your notes on this computer. Nothing on the T7 is ever replaced or deleted, even when keep-sync thins its own snapshots.</span>
            <span className="cell-sub">{KEEP_SYNC_PRIVACY}</span>
            <span className="cell-sub">It is added as "{KEEP_SYNC_NAME}". Nothing is copied until you look at its list and confirm.</span>
          </div>
        </details>
        <span className="settings-actions">
          <Button variant="primary" disabled={busy} onClick={add}>
            {KEEP_SYNC_ADD_BUTTON}
          </Button>
        </span>
        {message ? (
          <span role="alert" className="cell-sub">
            {message}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
