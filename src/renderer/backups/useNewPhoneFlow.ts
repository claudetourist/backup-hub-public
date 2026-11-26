import { useState } from 'react';
import type { CreatePhoneBackupRequest, NewBackupChoices, NewPhone } from '../../shared/phoneBackup';
import { useToast } from '../components/Toast';
import { PROFILES_CHANGED_EVENT } from '../profiles/ProfileScopeProvider';
import { phonesToAsk } from './backupsModel';
import type { BackupsData } from './useBackupsData';

/** The form "Make a new backup for this phone", open for one phone, with what main offered. */
export interface MakingNew {
  phone: NewPhone;
  choices: Extract<NewBackupChoices, { ok: true }>;
}

/** Linking a plugged-in phone to a backup, and making a new backup for it (the cards and the form of the list page). */
export function useNewPhoneFlow(data: Pick<BackupsData, 'connected' | 'hiddenPhones' | 'load' | 'checkPhones'>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [making, setMaking] = useState<MakingNew | null>(null);
  const [makeError, setMakeError] = useState<string | null>(null);
  const toast = useToast();
  const { connected, hiddenPhones, load, checkPhones } = data;
  const toAsk = phonesToAsk(connected, hiddenPhones);
  // A phone that is plugged in, ready, and the person said "Not now" to: the header still offers "Make a new backup for this phone".
  const putOff = (connected?.newPhones ?? []).filter((p) => p.ready && hiddenPhones.has(p.serial));

  const linkPhone = (backupId: number, serial: string): void => {
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.backups.linkPhone({ backupId, serial });
        setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
      load();
      checkPhones();
    })();
  };

  const openMakeNew = (phone: NewPhone): void => {
    setBusy(true);
    setMessage(null);
    setMakeError(null);
    void (async () => {
      try {
        const choices = await window.backupHub.backups.newPhoneChoices(phone.serial);
        if (choices.ok) setMaking({ phone, choices });
        else setMessage(choices.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      setBusy(false);
    })();
  };

  const saveMakeNew = (serial: string, request: Omit<CreatePhoneBackupRequest, 'serial'>, onCreated: (backupId: number | null) => void): void => {
    setBusy(true);
    setMakeError(null);
    void (async () => {
      try {
        const result = await window.backupHub.backups.createPhoneBackup({ ...request, serial });
        if (result.ok) {
          toast.show({ tone: 'ok', text: result.message });
          window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT));
          setMaking(null);
          load();
          checkPhones();
          onCreated(null);
        } else setMakeError(result.message);
      } catch {
        setMakeError('That did not work. Nothing was changed.');
      }
      setBusy(false);
    })();
  };

  const closeForm = (): void => {
    setMaking(null);
    setMakeError(null);
  };

  return { busy, message, making, makeError, toAsk, putOff, linkPhone, openMakeNew, saveMakeNew, closeForm };
}
