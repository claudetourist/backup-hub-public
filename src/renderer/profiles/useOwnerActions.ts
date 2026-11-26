import { useCallback } from 'react';
import { useToast } from '../components/Toast';
import { PROFILES_CHANGED_EVENT } from './ProfileScopeProvider';

/**
 * "Belongs to": the two ways to change an owner, each with the toast ("Sam phone now belongs to Sam."). Main changes the database
 * only. Resolves true when it worked, so a screen can read its list again.
 */
export function useOwnerActions(): {
  setBackupOwner: (backupId: number, personId: number) => Promise<boolean>;
  setPlaceOwner: (placeId: string, personId: number) => Promise<boolean>;
} {
  const toast = useToast();
  const finish = useCallback(
    async (call: () => Promise<{ ok: boolean; message: string } | undefined>): Promise<boolean> => {
      try {
        const result = await call();
        if (result?.ok) {
          toast.show({ tone: 'ok', text: result.message });
          window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT));
          return true;
        }
        toast.show({ tone: 'error', text: result?.message ?? 'That did not work. Nothing was changed.' });
      } catch {
        toast.show({ tone: 'error', text: 'That did not work. Nothing was changed.' });
      }
      return false;
    },
    [toast],
  );
  const setBackupOwner = useCallback((backupId: number, personId: number) => finish(() => window.backupHub.people.setBackupOwner(backupId, personId)), [finish]);
  const setPlaceOwner = useCallback((placeId: string, personId: number) => finish(() => window.backupHub.people.setPlaceOwner(placeId, personId)), [finish]);
  return { setBackupOwner, setPlaceOwner };
}
