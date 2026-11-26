import { useEffect, useState } from 'react';
import type { MirrorStatusResult } from '../../shared/mirror';

/**
 * How far behind each second drive is: asked once when the screen opens and again whenever `refreshKey` changes (a job started, ended or failed).
 * Main counts off the window's thread; until the answer is there the screen shows "counting...". The last answer is kept while a fresh one is asked.
 * Null until the first answer (or when it could not be read).
 */
export function useMirrorStatus(refreshKey: string): MirrorStatusResult | null {
  const [status, setStatus] = useState<MirrorStatusResult | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await window.backupHub.mirror.status();
        if (alive) setStatus(next);
      } catch {
        // Keep what is shown: the lines just stay as they were.
      }
    })();
    return () => {
      alive = false;
    };
    // refreshKey is not read inside: a job that started, ended or failed means "count again".
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [refreshKey]);
  return status;
}
