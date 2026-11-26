import { useCallback, useEffect, useState } from 'react';
import type { VaultResult, VaultStatus } from '../../shared/vault';

/** The vault's status (never any key material). `apply` takes the result of a vault action. */
export function useVaultStatus(): {
  status: VaultStatus | null;
  refresh: () => void;
  apply: (result: VaultResult) => void;
} {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        setStatus(await window.backupHub.vault.status());
      } catch {
        // Main is not ready; stay quiet (the reminder simply does not show).
      }
    })();
  }, []);

  useEffect(() => {
    // Not on the first-paint path.
    const timer = window.setTimeout(refresh, 120);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const apply = useCallback((result: VaultResult) => {
    if (result.ok) setStatus(result.status);
  }, []);

  return { status, refresh, apply };
}
