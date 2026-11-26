import { useCallback } from 'react';
import { BackupPage } from '../backups/BackupPage';
import { BackupsList } from '../backups/BackupsList';
import { backupSub, parseBackupSub, type BackupTab } from '../backups/backupListModel';
import { useBackupsData } from '../backups/useBackupsData';
import { useNavigate, useRoute } from '../navContext';

export { NewPhoneCard } from '../backups/NewPhoneCard';

/** True after the list opened a backup's page: Back then steps back in the browser's history (so forward and back agree) instead of adding an entry. */
let cameFromList = false;

/**
 * Backups: the list of all backups (#/backups) and one backup's page (#/backups/<id>, with an optional section: <id>/second). The data is read once here and
 * shared by both, so going to a page and back shows the list at once. Nothing here runs by itself.
 */
export default function Backups() {
  const data = useBackupsData();
  const route = useRoute();
  const navigate = useNavigate();
  const address = parseBackupSub(route.sub);

  const open = useCallback(
    (id: number, tab: BackupTab, go: boolean): void => {
      cameFromList = true;
      navigate('backups', backupSub(id, tab, go));
    },
    [navigate],
  );
  const back = useCallback((): void => {
    if (cameFromList && window.history.length > 1) window.history.back();
    else navigate('backups', null);
    cameFromList = false;
  }, [navigate]);

  return address ? <BackupPage key={address.id} data={data} address={address} onBack={back} /> : <BackupsList data={data} onOpen={open} />;
}
