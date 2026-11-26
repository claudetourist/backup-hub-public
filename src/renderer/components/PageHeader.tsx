import type { ComponentType, ReactNode } from 'react';
import { IconTile } from './IconTile';
import type { PanelAccent } from './Panel';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Right-hand slot: buttons, a status chip or a short note. */
  actions?: ReactNode;
  /** Bigger headline for verdict pages such as Home. */
  large?: boolean;
  /** A coloured icon tile before the title, in the colour of the screen's sidebar entry ('brand' is teal). */
  icon?: ComponentType<{ size?: number }>;
  cat?: PanelAccent | 'brand';
}

export function PageHeader({ eyebrow, title, subtitle, actions, large = false, icon, cat = 'brand' }: PageHeaderProps) {
  const text = (
    <div className="page-header__text">
      <span className="page-header__eyebrow">{eyebrow}</span>
      <h1 className={`page-header__title${large ? ' page-header__title--large' : ''}`}>{title}</h1>
      {subtitle ? <span className="page-header__subtitle">{subtitle}</span> : null}
    </div>
  );
  return (
    <header className="page-header">
      {icon ? (
        <div className="page-header__lead">
          <IconTile icon={icon} cat={cat} size="lg" />
          {text}
        </div>
      ) : (
        text
      )}
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
