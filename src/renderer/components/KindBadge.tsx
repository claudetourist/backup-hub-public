import { KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import type { SearchCategory } from '../../shared/fileCategories';
import { familyOfCategory, familyOfKind, type KindFamily } from './kindColors';

/** A small coloured dot for a file type (used in menus and on chips). Decorative: the text next to it says the same. */
export function KindDot({ family }: { family: KindFamily }) {
  return <span className={`kind-dot kind-dot--${family}`} aria-hidden="true" />;
}

export function CategoryDot({ category }: { category: SearchCategory }) {
  return <KindDot family={familyOfCategory(category)} />;
}

/** The kind of a file as a tinted pill with a dot: "Camera photos", "Screenshots" ... Always carries its text. */
export function KindBadge({ kind }: { kind: FileKind }) {
  const family = familyOfKind(kind);
  return (
    <span className={`kind-pill kind-pill--${family}`}>
      <KindDot family={family} />
      {KIND_LABELS[kind]}
    </span>
  );
}
