import { useState } from 'react';
import type { SafeUnplugResult } from '../../shared/phoneBackup';
import { Button } from '../components/Button';

/** What the person sees after pressing "Safe to unplug". */
export type SafeUnplugView = { step: 'idle' } | { step: 'working' } | { step: 'done'; result: SafeUnplugResult };

/** The plain line under the button: the good news, or which job still uses the phone. */
export function safeUnplugLine(result: SafeUnplugResult): string {
  return result.ok ? 'Safe to unplug the phone. Plug it in again when you want to use it.' : result.message;
}

/**
 * "Safe to unplug" for a plugged-in phone. Backup Hub lets go of adb (Windows cannot eject a phone while adb runs) and does not ask about phones
 * again until one is plugged in again. A phone job that still uses the phone refuses it and says which one. Nothing on the phone is touched.
 */
export function SafeUnplugButton({ onDone }: { onDone?: () => void }) {
  const [view, setView] = useState<SafeUnplugView>({ step: 'idle' });
  const run = (): void => {
    setView({ step: 'working' });
    void (async () => {
      try {
        const result = await window.backupHub.phoneBackup.safeUnplug();
        setView({ step: 'done', result });
        onDone?.();
      } catch {
        setView({ step: 'done', result: { ok: false, message: 'That did not work. Nothing was changed. Use the "Safely remove" icon in the taskbar.', busyJob: null } });
      }
    })();
  };
  return (
    <span className="cell-stack cell-stack--tight">
      <Button variant="quiet" size="sm" disabled={view.step === 'working'} onClick={run}>
        {view.step === 'working' ? 'Letting go...' : 'Safe to unplug'}
      </Button>
      {view.step === 'done' ? (
        <span className={view.result.ok ? 'cell-sub tone-text tone-text--ok' : 'cell-sub tone-text tone-text--warn'} role="status">
          {safeUnplugLine(view.result)}
        </span>
      ) : null}
    </span>
  );
}

/** The state after it: the phone can be unplugged; the other button takes it back (adb is asked about phones again). */
export function SafeToUnplugNote({ onChanged }: { onChanged?: () => void }) {
  const [working, setWorking] = useState(false);
  const useAgain = (): void => {
    setWorking(true);
    void (async () => {
      try {
        await window.backupHub.phoneBackup.useAgain();
      } finally {
        setWorking(false);
        onChanged?.();
      }
    })();
  };
  return (
    <span className="cell-stack cell-stack--tight">
      <span className="cell-sub tone-text tone-text--ok" role="status">
        Safe to unplug the phone. Plug it in again when you want to use it.
      </span>
      <Button variant="quiet" size="sm" disabled={working} onClick={useAgain}>
        Use the phone again
      </Button>
    </span>
  );
}
