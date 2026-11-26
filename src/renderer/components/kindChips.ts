/**
 * The nine kinds of file the person sees, each with one fixed colour and icon (PLAN section 6). Pure.
 * The colour of a kind is the --kind-<id> token; the icon is named here and drawn by KindChip.
 */
import { isFileKind, type FileKind } from '../../shared/fileKinds';

export const KIND_CHIP_IDS = ['photos', 'videos', 'screenshots', 'whatsapp', 'recordings', 'audio', 'documents', 'archives', 'other'] as const;
export type KindChipId = (typeof KIND_CHIP_IDS)[number];

export interface KindChipDef {
  id: KindChipId;
  label: string;
  icon: 'image' | 'video' | 'screen' | 'chat' | 'mic' | 'music' | 'document' | 'archive' | 'file';
}

export const KIND_CHIPS: readonly KindChipDef[] = [
  { id: 'photos', label: 'Photos', icon: 'image' },
  { id: 'videos', label: 'Camera videos', icon: 'video' },
  { id: 'screenshots', label: 'Screenshots', icon: 'screen' },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'chat' },
  { id: 'recordings', label: 'Recordings', icon: 'mic' },
  { id: 'audio', label: 'Music', icon: 'music' },
  { id: 'documents', label: 'Documents', icon: 'document' },
  { id: 'archives', label: 'Archives', icon: 'archive' },
  { id: 'other', label: 'Other', icon: 'file' },
];

const CHIP_OF_KIND: Readonly<Record<FileKind, KindChipId>> = {
  'photo-camera': 'photos',
  'photo-screenshot': 'screenshots',
  'photo-whatsapp': 'whatsapp',
  'photo-other': 'photos',
  'video-camera': 'videos',
  'video-whatsapp': 'whatsapp',
  'video-other': 'other',
  'audio-recording': 'recordings',
  'audio-music': 'audio',
  documents: 'documents',
  'google-docs': 'documents',
  archives: 'archives',
  empty: 'other',
  other: 'other',
};

/** The chip a stored file kind is shown with. Anything unknown is "Other". */
export function chipOfKind(kind: string): KindChipId {
  return isFileKind(kind) ? CHIP_OF_KIND[kind] : 'other';
}

export function chipDef(id: KindChipId): KindChipDef {
  return KIND_CHIPS.find((chip) => chip.id === id)!;
}
