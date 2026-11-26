import { useId, type ComponentType, type ReactNode } from 'react';
import { IconTile } from './IconTile';

/** Makes a panel collapsible: the heading becomes a toggle with a chevron. */
export interface PanelCollapse {
  open: boolean;
  onToggle: () => void;
  /** One line shown in the header while the panel is collapsed, e.g. "27 accounts · 61,180 files". */
  summary?: string;
}

/** What a panel is about: it gets a thin top line in that category colour. */
export type PanelAccent = 'phone' | 'laptop' | 'onedrive' | 'drive' | 'google' | 'person';

interface PanelProps {
  /** A thin top line in the colour of what the panel is about (phone, drive ...). */
  accent?: PanelAccent;
  /** A small coloured icon tile before the title (in the panel's accent colour, teal when there is none). */
  icon?: ComponentType<{ size?: number }>;
  title?: string;
  /** Right-aligned text or controls in the header, e.g. "Oldest first". */
  headerAside?: ReactNode;
  /** Remove body padding so tables and lists can run edge to edge. */
  flush?: boolean;
  /** Required when there is no title. */
  label?: string;
  /** With a title only: the heading toggles the body open and closed. */
  collapse?: PanelCollapse;
  children: ReactNode;
  footer?: ReactNode;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chevron${open ? ' chevron--open' : ''}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M4 5.5 7 8.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** White bordered card. With a title it becomes a labelled region (section + h2). */
export function Panel({ title, accent, icon, headerAside, flush = false, label, collapse, children, footer }: PanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const open = collapse ? collapse.open : true;
  return (
    <section
      className={`panel${accent ? ` panel--accent panel--accent-${accent}` : ''}${flush ? ' panel--flush' : ''}${collapse && !open ? ' panel--collapsed' : ''}`}
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : label}
    >
      {title ? (
        <div className="panel__head">
          <h2 className="panel__heading" id={headingId}>
            {icon ? <IconTile icon={icon} cat={accent ?? 'brand'} size="sm" /> : null}
            {collapse ? (
              <button type="button" className="panel__toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={collapse.onToggle}>
                <Chevron open={open} />
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {collapse && !open && collapse.summary ? <span className="panel__summary">{collapse.summary}</span> : null}
          {headerAside && open ? <span className="panel__aside">{headerAside}</span> : null}
        </div>
      ) : null}
      {open ? (
        <>
          <div className={flush ? 'panel__body panel__body--flush' : 'panel__body'} id={bodyId}>
            {children}
          </div>
          {footer ? <div className="panel__footer">{footer}</div> : null}
        </>
      ) : null}
    </section>
  );
}
