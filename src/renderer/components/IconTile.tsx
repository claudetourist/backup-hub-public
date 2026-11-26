import type { ComponentType, ReactNode } from 'react';
import type { PanelAccent } from './Panel';

interface IconTileProps {
  /** An icon component from icons.tsx. */
  icon: ComponentType<{ size?: number }>;
  /** The category colour of the tile (phone violet, laptop blue, OneDrive sky, drive amber, Google green, person pink), or 'brand' (teal). */
  cat: PanelAccent | 'brand';
  size?: 'sm' | 'md' | 'lg';
}

/** A rounded, solid, category-coloured tile with an icon in it. Decorative: the words beside it say the rest. */
export function IconTile({ icon: Icon, cat, size = 'md' }: IconTileProps): ReactNode {
  return (
    <span className={`icon-tile icon-tile--${size} cat--${cat}`} aria-hidden="true">
      <Icon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
    </span>
  );
}
