import { chipDef, chipOfKind, type KindChipDef, type KindChipId } from './kindChips';
import {
  KindArchiveIcon,
  KindChatIcon,
  KindDocumentIcon,
  KindFileIcon,
  KindImageIcon,
  KindMicIcon,
  KindMusicIcon,
  KindScreenIcon,
  KindVideoIcon,
} from '../icons';

const ICONS: Record<KindChipDef['icon'], typeof KindImageIcon> = {
  image: KindImageIcon,
  video: KindVideoIcon,
  screen: KindScreenIcon,
  chat: KindChatIcon,
  mic: KindMicIcon,
  music: KindMusicIcon,
  document: KindDocumentIcon,
  archive: KindArchiveIcon,
  file: KindFileIcon,
};

/** The kind of a file: one fixed colour, one icon and the word (photos, camera videos, screenshots, WhatsApp ...). */
export function KindChip({ id }: { id: KindChipId }) {
  const def = chipDef(id);
  const Icon = ICONS[def.icon];
  return (
    <span className={`kind-chip kind-chip--${id}`}>
      <Icon size={14} />
      {def.label}
    </span>
  );
}

/** The chip for a stored file kind such as "photo-camera". */
export function KindChipOf({ kind }: { kind: string }) {
  return <KindChip id={chipOfKind(kind)} />;
}
