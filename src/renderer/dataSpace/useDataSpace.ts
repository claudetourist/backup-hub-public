import { useEffect, useState } from 'react';
import type { DataSpaceInfo } from '../../shared/dataSpace';

const REFRESH_MS = 60_000;

/** Room on the data disk, read now and then. Null until main has answered once (or when it cannot). */
export function useDataSpace(): DataSpaceInfo | null {
  const [info, setInfo] = useState<DataSpaceInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void (async () => {
        try {
          const next = await window.backupHub.dataSpace.get();
          if (alive && next) setInfo(next);
        } catch {
          // Main is not ready yet; the next read tries again.
        }
      })();
    };
    const first = window.setTimeout(read, 200);
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return info;
}
