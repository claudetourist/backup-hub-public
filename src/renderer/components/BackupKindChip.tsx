import { CloudIcon, DriveIcon, LaptopIcon, PhoneIcon } from '../icons';
import { BACKUP_KIND_CATEGORY, type BackupKind } from './backupKinds';

const ICONS: Record<BackupKind, typeof PhoneIcon> = { phone: PhoneIcon, laptop: LaptopIcon, cloud: CloudIcon, drive: DriveIcon };

/** A small rounded icon in the colour of what a backup is of (phone violet, laptop blue, cloud sky, drive amber). Decorative: the name beside it says the rest. */
export function BackupKindChip({ kind }: { kind: BackupKind }) {
  const Icon = ICONS[kind];
  return (
    <span className={`kind-icon kind-icon--${BACKUP_KIND_CATEGORY[kind]}`} aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}
