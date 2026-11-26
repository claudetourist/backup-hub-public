import { useEffect, useState } from 'react';
import type { MirrorChoicesResult } from '../../shared/mirror';
import { Button } from '../components/Button';
import { alsoKeepButton, alsoKeepQuestion } from './mirrorModel';

type Choices = Extract<MirrorChoicesResult, { ok: true }>;

/**
 * "Also keep a copy on <drive>" for a backup that has one drive: a question first (database only, nothing is copied), then the second drive is added.
 * Shown inside the backup's row of the Backups list. `onAdded` reloads the list.
 */
export function AlsoKeepCopy({ backupId, backupName, onAdded }: { backupId: number; backupName: string; onAdded: () => void }) {
  // What can hold the second copy is read when the row opens (database only), so the button can name the drive.
  const [known, setKnown] = useState<Choices | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const answer = await window.backupHub.mirror.choices(backupId);
        if (alive && answer.ok) setKnown(answer);
      } catch {
        // No button: nothing can be added.
      }
    })();
    return () => {
      alive = false;
    };
  }, [backupId]);

  const open = (): void => {
    setMessage(null);
    if (known !== null && known.drives.length > 0) {
      setChoices(known);
      if (known.drives.length === 1) setAsking(known.drives[0]!.placeId);
    } else setMessage('No other drive is known yet. Plug the second drive in and name it in Devices first.');
  };

  const add = (placeId: string): void => {
    setBusy(true);
    void (async () => {
      try {
        const result = await window.backupHub.mirror.add({ backupId, placeId });
        setMessage(result.message);
        if (result.ok) {
          setChoices(null);
          setAsking(null);
          onAdded();
        }
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
    })();
  };

  if (choices === null) {
    return (
      <span className="cell-stack cell-stack--tight">
        <span>
          <Button variant="quiet" size="sm" disabled={busy || known === null || known.drives.length === 0} onClick={open}>
            {alsoKeepButton(known?.drives.length === 1 ? known.drives[0]!.label : 'another drive')}
          </Button>
        </span>
        {message ? <span role="status" className="cell-sub">{message}</span> : null}
      </span>
    );
  }
  const chosen = choices.drives.find((d) => d.placeId === asking) ?? null;
  return (
    <span className="settings-stack" role="group" aria-label={`Also keep ${backupName} on another drive`}>
      {chosen === null ? (
        <>
          <span className="cell-sub">Which drive should also hold {backupName}?</span>
          <span className="settings-actions">
            {choices.drives.map((d) => (
              <Button key={d.placeId} size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(d.placeId)}>
                {alsoKeepButton(d.label)}
              </Button>
            ))}
            <Button size="sm" variant="quiet" onClick={() => setChoices(null)}>
              Cancel
            </Button>
          </span>
        </>
      ) : (
        <>
          <span className="cell-sub">{alsoKeepQuestion(backupName, chosen.label, choices.folder)}</span>
          <span className="settings-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => add(chosen.placeId)}>
              Yes, also keep it on {chosen.label}
            </Button>
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => setAsking(null)}>
              Back
            </Button>
          </span>
        </>
      )}
      {message ? <span role="alert" className="cell-sub">{message}</span> : null}
    </span>
  );
}
