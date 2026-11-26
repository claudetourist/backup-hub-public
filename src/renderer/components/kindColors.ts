/** Which colour family a file kind or Search category uses (the --kind-* tokens). Pure, so it can be tested. */
import type { SearchCategory } from '../../shared/fileCategories';
import { categoryOfKind, type FileKind } from '../../shared/fileKinds';

export const KIND_FAMILIES = ['photos', 'videos', 'audio', 'documents', 'archives', 'google-docs', 'other'] as const;
export type KindFamily = (typeof KIND_FAMILIES)[number];

const FAMILY_OF_CATEGORY: Readonly<Record<SearchCategory, KindFamily>> = {
  photos: 'photos',
  videos: 'videos',
  audio: 'audio',
  documents: 'documents',
  archives: 'archives',
  googleDocs: 'google-docs',
  other: 'other',
};

export function familyOfCategory(category: SearchCategory): KindFamily {
  return FAMILY_OF_CATEGORY[category];
}

export function familyOfKind(kind: FileKind): KindFamily {
  return FAMILY_OF_CATEGORY[categoryOfKind(kind)];
}
