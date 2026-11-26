import { useEffect, useState } from 'react';
import type { BackupRow } from '../../shared/backups';
import { backupSub } from '../backups/backupListModel';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { CleanUpIcon } from '../icons';

/**
 * Free up space: points to "Free up phone space" on each phone backup's page (backups/FreeUpPanel.tsx), the one place that checks the
 * phone, both drives and Google, biggest videos first. The older screen (cleanup/PhoneCleanupPage.tsx) is no longer shown here.
 */
export default function FreeUpSpace() {
  const [phones, setPhones] = useState<BackupRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.backupHub.backups
      .overview()
      .then((o) => {
        if (alive) setPhones(o.backups.filter((b) => b.kind === 'phone'));
        return undefined;
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <PageHeader icon={CleanUpIcon} cat="drive" eyebrow="Phone" title="Free up phone space" subtitle="Each phone has its own page. Open the phone to see what can leave it." />
      <Panel title="Choose the phone" accent="drive" icon={CleanUpIcon}>
        {failed ? <p className="cell-sub">The list of phones could not be read. Open Backups instead.</p> : null}
        {phones === null && !failed ? <p className="cell-sub">Reading the list of phones...</p> : null}
        {phones !== null && phones.length === 0 ? <p className="cell-sub">There is no phone backup yet.</p> : null}
        {phones?.map((b) => (
          <p key={b.id}>
            <Button variant="secondary" onClick={() => (window.location.hash = `#/backups/${backupSub(b.id, 'free')}`)}>
              Free up space on {b.name}
            </Button>
          </p>
        ))}
      </Panel>
    </>
  );
}
