import { useState } from 'react';
import { Button } from '../components/Button';

/** What the person sees after pressing Eject. */
export type EjectView =
  | { step: 'idle' }
  | { step: 'working' }
  /** Jobs use the drive: ask before stopping them. */
  | { step: 'ask'; message: string }
  | { step: 'done'; ok: boolean; message: string };

/**
 * "Eject" for a plugged-in named drive. Backup Hub lets go of the drive first (after asking, if a job is using it), then asks
 * Windows to eject it. The answer is plain: "T7 can be unplugged now", or why Windows said no. Nothing is ever forced.
 */
export function EjectButton({ placeId, label }: { placeId: string; label: string }) {
  const [view, setView] = useState<EjectView>({ step: 'idle' });

  const run = (confirmed: boolean): void => {
    setView({ step: 'working' });
    void (async () => {
      try {
        const result = await window.backupHub.places.eject(placeId, confirmed);
        if (!result.ok && result.needsConfirm) setView({ step: 'ask', message: result.message });
        else setView({ step: 'done', ok: result.ok, message: result.message });
      } catch {
        setView({ step: 'done', ok: false, message: `Backup Hub could not ask Windows to eject ${label}. Nothing was changed. Use the "Safely remove" icon in the taskbar.` });
      }
    })();
  };

  if (view.step === 'ask') {
    return (
      <span className="cell-stack cell-stack--tight">
        <span className="cell-sub">{view.message}</span>
        <span className="settings-actions">
          <Button variant="primary" size="sm" onClick={() => run(true)}>
            Stop and eject
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setView({ step: 'idle' })}>
            Not now
          </Button>
        </span>
      </span>
    );
  }
  return (
    <span className="cell-stack cell-stack--tight">
      <Button variant="quiet" size="sm" disabled={view.step === 'working'} onClick={() => run(false)}>
        {view.step === 'working' ? 'Ejecting...' : 'Eject'}
      </Button>
      {view.step === 'done' ? (
        <span className={view.ok ? 'cell-sub tone-text tone-text--ok' : 'cell-sub tone-text tone-text--warn'} role="status">
          {view.message}
        </span>
      ) : null}
    </span>
  );
}
