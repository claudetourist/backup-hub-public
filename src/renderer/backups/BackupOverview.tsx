import { useState } from 'react';
import { Button } from '../components/Button';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { yourChoicesButton } from './choicesModel';
import { AlsoKeepCopy } from './AlsoKeepCopy';
import { changePhoneWarning } from './backupsModel';
import { OLD_TOOL_WARNING } from './phoneBackupModel';
import { FOLDER_OLD_TOOL_WARNING } from './folderBackupModel';
import { lastLine, type BackupEntry, type BackupTab } from './backupListModel';
import { statusLine as secondLine, plugInNote } from './mirrorModel';
import type { BackupsData } from './useBackupsData';

/** Overview: the facts of this backup, the one next step, and the few things that change the backup itself (Change phone, Also keep a copy, Remove from list). */
export function BackupOverview({ entry, data, onTab, onRemoved }: { entry: BackupEntry; data: BackupsData; onTab: (tab: BackupTab, go: boolean) => void; onRemoved: () => void }) {
  const { row } = entry;
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const mirror = data.mirror?.backups.find((m) => m.backupId === row.id);
  const second = (row.destinations?.length ?? 1) > 1;
  const secondText = second && entry.status !== null ? (mirror ? secondLine(row.destinations![0]!.label, entry.status, mirror) : row.destinations![0]!.label + ': counting the second drive...') : null;
  const plug = plugInNote(mirror);

  const changePhone = (): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.backups.unlinkPhone(row.id, true);
        setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setChanging(false);
      setBusy(false);
      data.load();
      data.checkPhones();
    })();
  };

  const remove = (): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.backups.archive(row.id, true);
        if (result.ok) {
          toast.show({ tone: 'ok', text: result.message });
          data.load();
          onRemoved();
        } else setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setRemoving(false);
      setBusy(false);
    })();
  };

  return (
    <div className="settings-stack bk-overview">
      <dl className="bk-facts">
        <dt>Status</dt>
        <dd>
          {entry.status ? <StatusPill status={entry.status} /> : <span>Switched off</span>}
          {secondText ? <span className="cell-sub">{secondText}</span> : null}
          {plug ? <span className="cell-sub" role="status">{plug}</span> : null}
        </dd>
        <dt>What is backed up</dt>
        <dd>{entry.source}</dd>
        <dt>Kept on</dt>
        <dd>
          {entry.kept}
          {entry.note ? <span className="cell-sub" role="status">{entry.note}</span> : null}
        </dd>
        <dt>Last backup</dt>
        <dd>{lastLine(row.lastBackupAt, data.now)}</dd>
        <dt>Size</dt>
        <dd>{entry.numbers}</dd>
        <dt>Exclusions</dt>
        <dd>
          <Button variant="quiet" size="sm" onClick={() => onTab('choices', false)}>
            {yourChoicesButton(row.choices)}
          </Button>
        </dd>
      </dl>
      {entry.action.label !== 'Open' ? (
        <span className="settings-actions">
          <Button variant="primary" onClick={() => onTab(entry.action.tab, entry.action.go)}>
            {entry.action.label}
          </Button>
        </span>
      ) : null}
      {row.fromOldTool === true ? <b>{row.kind === 'phone' ? OLD_TOOL_WARNING : FOLDER_OLD_TOOL_WARNING}</b> : null}
      {row.enabled && !second ? <AlsoKeepCopy backupId={row.id} backupName={row.name} onAdded={data.load} /> : null}
      {row.phoneLinked && !changing ? (
        <span>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setChanging(true)}>
            Change phone
          </Button>
        </span>
      ) : null}
      {changing ? (
        <span className="settings-stack" role="group" aria-label="Change the phone of this backup">
          <span className="cell-sub">{changePhoneWarning(row.name)}</span>
          <span className="settings-actions">
            <Button variant="primary" size="sm" disabled={busy} onClick={changePhone}>
              Yes, change phone
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </span>
        </span>
      ) : null}
      {!row.enabled && !removing ? (
        <span>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
            Remove from list
          </Button>
        </span>
      ) : null}
      {removing ? (
        <span className="settings-stack" role="group" aria-label="Remove this backup from the list">
          <span>Remove {row.name} from the list? Nothing on any drive is deleted; you can put it back.</span>
          <span className="settings-actions">
            <Button variant="primary" size="sm" disabled={busy} onClick={remove}>
              Remove from list
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setRemoving(false)}>
              Cancel
            </Button>
          </span>
        </span>
      ) : null}
      {message ? <span role="status" className="cell-sub">{message}</span> : null}
      <details className="more">
        <summary>Why this status?</summary>
        <span className="cell-sub">
          Up to date means the last backup is less than 14 days old and each drive of this backup has everything. Behind means it is older, or a second drive is missing files. Never backed up means there is no date yet. Problem means the last run failed. A backup switched off has no status.
        </span>
      </details>
    </div>
  );
}
