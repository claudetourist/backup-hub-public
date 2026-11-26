import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CloseIcon } from '../icons';
import { focusableIn, trapTab } from './focusTrap';

interface DrawerProps {
  /** The heading, also the accessible name of the panel ("Reunion", "Add a backup"). */
  title: string;
  /** One line under the heading. */
  subtitle?: string;
  onClose: () => void;
  /** Buttons pinned to the bottom (Save, Cancel). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The panel on the right that every list opens: details, add and edit all use it (PLAN section 6). It takes the focus when it
 * opens, keeps Tab inside, closes with Esc or a click outside, and gives the focus back to what opened it.
 */
export function Drawer({ title, subtitle, onClose, footer, children }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // First control inside the body, else the close button.
    const first = panel ? (focusableIn(panel).find((element) => !element.classList.contains('drawer__close')) ?? panel) : null;
    first?.focus();
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (panelRef.current) trapTab(event, panelRef.current);
  };

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panelRef} onKeyDown={onKeyDown}>
        <header className="drawer__head">
          <span className="cell-stack cell-stack--tight">
            <h2 className="drawer__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <span className="cell-sub">{subtitle}</span> : null}
          </span>
          <button type="button" className="drawer__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="drawer__foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}
