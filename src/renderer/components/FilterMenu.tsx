import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface FilterMenuProps {
  /** Short name shown before the choice: "Type", "Size". */
  label: string;
  /** The current choice, as it reads on the button. */
  summary: ReactNode;
  /** True when the choice is not the default, so the button looks "on". */
  active?: boolean;
  /** The menu content; `close` shuts the menu (for choices that finish the job). */
  children: (close: () => void) => ReactNode;
}

/**
 * A small button that opens a menu under it (a filter bar control). Closes on Esc (focus returns to the button), on a
 * click elsewhere and when a choice calls `close`. Tab moves into the menu: it follows the button in the page order.
 */
export function FilterMenu({ label, summary, active = false, children }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (wrapper.current && event.target instanceof Node && !wrapper.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="fmenu" ref={wrapper}>
      <button ref={button} type="button" className={`fbtn${active ? ' is-on' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => setOpen(!open)}>
        <span className="fbtn__label">{label}</span>
        <span className="fbtn__value">{summary}</span>
        <span className="fbtn__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div id={popId} className="fmenu__pop" role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** One choice inside a FilterMenu. */
export function MenuOption({ selected, onClick, children, count }: { selected: boolean; onClick: () => void; children: ReactNode; count?: string | undefined }) {
  return (
    <button type="button" className="fopt" aria-pressed={selected} onClick={onClick}>
      <span className="fopt__label">{children}</span>
      {count ? <span className="fopt__count">{count}</span> : null}
    </button>
  );
}
