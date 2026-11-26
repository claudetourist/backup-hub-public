import { useState } from 'react';
import { CleanupLog } from '../cleanup/CleanupLog';
import { PhoneCleanPanel } from '../cleanup/PhoneCleanPanel';
import { secondDriveNotReady } from '../cleanup/cleanupModel';
import { NotReadyPanel } from '../cleanup/NotReadyPanel';
import { usePlaces } from '../places/PlacesProvider';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { CleanUpIcon } from '../icons';
import { Panel } from '../components/Panel';

/**
 * Free up phone space. The "Free up space" screen. The rule lives in main (cleanup/phoneRule.ts): a file
 * is offered only when the same file is on the T7, on the Seagate2TB and in Google, in the Backups folders. The camera folder
 * comes first, and nothing is removed until the person has ticked files and confirmed the exact list.
 */
export function PhoneCleanupPage({ onBack }: { onBack?: () => void }) {
  const [logKey, setLogKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const { snapshot } = usePlaces();
  const notReady = secondDriveNotReady(snapshot?.places ?? null);
  return (
    <>
      <PageHeader
        icon={CleanUpIcon}
        cat="drive"
        eyebrow="Phone"
        title="Free up phone space"
        subtitle="Only files that are already safe on the T7, the Seagate2TB and Google are offered."
        actions={
          onBack ? (
            <Button variant="secondary" onClick={onBack}>
              Back to Home
            </Button>
          ) : undefined
        }
      />
      {notReady ? <NotReadyPanel /> : null}
      <Panel title="Choose what to remove from the phone" accent="drive" icon={CleanUpIcon}>
        <PhoneCleanPanel blocked={notReady} onStarted={() => setLogKey((k) => k + 1)} />
        <span className="settings-actions">
          <Button
            variant="quiet"
            onClick={() => {
              void (async () => {
                try {
                  const result = await window.backupHub.phone.eject();
                  setNote(result.message);
                } catch {
                  setNote('That did not work.');
                }
              })();
            }}
          >
            Let go of the phone
          </Button>
          <span className="cell-sub">Do this before unplugging the cable.</span>
        </span>
        {note ? (
          <p className="cell-sub" role="status">
            {note}
          </p>
        ) : null}
      </Panel>
      <Panel title="What was removed from the phone">
        <CleanupLog key={logKey} />
      </Panel>
    </>
  );
}
