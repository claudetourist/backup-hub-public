import type { ConnectedPhones, NewPhone } from '../../shared/phoneBackup';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { MAKE_NEW_BACKUP_TEXT, newPhoneQuestion, yesThisIsText } from './backupsModel';

/** The card that asks which backup a plugged-in phone is for. Nothing is linked until a "Yes" is pressed. */
export function NewPhoneCard({ phone, backups, busy, onYes, onMakeNew, onNotNow }: { phone: NewPhone; backups: ConnectedPhones['backupsWithoutPhone']; busy: boolean; onYes: (backupId: number) => void; onMakeNew: () => void; onNotNow: () => void }) {
  return (
    <Panel title="A new phone" accent="phone">
      <div className="settings-stack">
        {phone.ready ? (
          <span>{newPhoneQuestion(phone.phoneName, backups.map((b) => b.backupName))}</span>
        ) : (
          <span role="status">{phone.hint}</span>
        )}
        <span className="settings-actions">
          {phone.ready
            ? backups.map((b) => (
                <Button key={b.backupId} variant="primary" disabled={busy} onClick={() => onYes(b.backupId)}>
                  {yesThisIsText(b.backupName)}
                </Button>
              ))
            : null}
          {phone.ready ? (
            <Button variant={backups.length === 0 ? 'primary' : 'secondary'} disabled={busy} onClick={onMakeNew}>
              {MAKE_NEW_BACKUP_TEXT}
            </Button>
          ) : null}
          <Button variant="quiet" disabled={busy} onClick={onNotNow}>
            Not now
          </Button>
        </span>
      </div>
    </Panel>
  );
}
