import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon } from '../icons';
import { isListKey, moveIndex } from './listNav';
import { backgroundColorRef } from './sizing';
import { chooseMenuPlacement, estimateMenuHeight } from './menuPlacement';

export interface MenuItemDef {
  id: string;
  label: string;
  /** Shown small under the label. */
  hint?: string;
  /** With true or false the item is a choice (one of several); true marks the one in use. */
  checked?: boolean;
  /** A colour dot (#rrggbb) before the label, for a person. */
  swatch?: string;
  onSelect: () => void;
}

interface PopupMenuProps {
  /** What is on the button. */
  trigger: ReactNode;
  /** The accessible name of the button ("Person", "More"). */
  label: string;
  items: readonly MenuItemDef[];
  /** Which way it opens. The sidebar menu at the bottom opens upwards. 'auto' puts the menu on top of the page (not inside the list, whose edge would cut it off) and opens it upwards when there is no room below. */
  placement?: 'below' | 'above' | 'auto';
  className?: string;
}

/**
 * A button that opens a short list. Arrow keys, Home and End move through it, Enter or Space chooses, Esc closes and gives
 * the focus back to the button. Used for the person switcher and the menu at the bottom of the sidebar.
 */
/** The widest a floating menu gets; its lines wrap inside it. */
export const MENU_MAX_WIDTH = 360;

/** Where a floating menu goes across: from the button's left edge, or, when that would run past the window, leftwards from its right edge. */
export function menuX(buttonLeft: number, buttonRight: number, windowWidth: number): { left: number } | { right: number } {
  return buttonLeft + MENU_MAX_WIDTH + 8 <= windowWidth ? { left: buttonLeft } : { right: Math.max(8, windowWidth - buttonRight) };
}

export function PopupMenu({ trigger, label, items, placement = 'below', className }: PopupMenuProps) {
  const [open, setOpen] = useState(false);
  // For placement 'auto': where the menu is put on the page (decided before the first paint after opening).
  const [spot, setSpot] = useState<{ left?: number; right?: number; top?: number; bottom?: number; side: 'below' | 'above' } | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const focusItem = (index: number): void => refs.current[index]?.focus();

  const list = useRef<HTMLDivElement>(null);
  // Opening decides where an 'auto' menu goes: from the button's place on the page and the height the menu will have (before it is drawn).
  const openMenu = (): void => {
    if (placement === 'auto' && button.current) {
      const rect = button.current.getBoundingClientRect();
      const side = chooseMenuPlacement({ buttonTop: rect.top, buttonBottom: rect.bottom, menuHeight: estimateMenuHeight(items), boundsTop: 0, boundsBottom: window.innerHeight });
      // A menu near the right edge opens leftwards from the button's right edge, so its text is never cut off by the window.
      const x = menuX(rect.left, rect.right, window.innerWidth);
      setSpot(side === 'below' ? { ...x, top: rect.bottom + 4, side } : { ...x, bottom: window.innerHeight - rect.top + 4, side });
    }
    setOpen(true);
  };
  // A menu on top of the page does not follow the list: scrolling or resizing closes it.
  useEffect(() => {
    if (!open || placement !== 'auto') return undefined;
    const dismiss = (): void => setOpen(false);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open, placement]);
  const shownPlacement = placement === 'auto' ? (spot?.side ?? 'below') : placement;
  const floating: CSSProperties | undefined =
    placement === 'auto' && spot !== null ? { position: 'fixed', left: spot.left ?? 'auto', right: spot.right ?? 'auto', ...(spot.top !== undefined ? { top: spot.top } : { top: 'auto', bottom: spot.bottom }), minWidth: 240, maxWidth: MENU_MAX_WIDTH } : undefined;

  // Opening puts the focus on the item in use, else the first.
  useEffect(() => {
    if (!open) return;
    const inUse = itemsRef.current.findIndex((item) => item.checked === true);
    refs.current[inUse >= 0 ? inUse : 0]?.focus();
  }, [open, itemsRef, refs]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (root.current && !root.current.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (isListKey(event.key)) {
      event.preventDefault();
      const current = refs.current.findIndex((node) => node === document.activeElement);
      focusItem(moveIndex(current, event.key, items.length, 5, true));
    }
  };

  const menu = (
    <div id={menuId} ref={list} role="menu" aria-label={label} className={`popup-menu__list popup-menu__list--${shownPlacement}`} style={floating} onKeyDown={onMenuKeyDown}>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          ref={(node) => {
            refs.current[index] = node;
          }}
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          tabIndex={-1}
          className="popup-menu__item"
          onClick={() => {
            close(true);
            item.onSelect();
          }}
        >
          <span className="popup-menu__check" aria-hidden="true">
            {item.checked ? <CheckIcon size={14} /> : null}
          </span>
          <span className="popup-menu__label">
            <span className="popup-menu__name">
              {item.swatch ? <span className="profile-dot" ref={backgroundColorRef(item.swatch)} aria-hidden="true" /> : null}
              {item.label}
            </span>
            {item.hint ? <span className="cell-sub">{item.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={`popup-menu${className ? ` ${className}` : ''}`} ref={root}>
      <button
        type="button"
        ref={button}
        className="popup-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger}
      </button>
      {open ? (placement === 'auto' ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}
