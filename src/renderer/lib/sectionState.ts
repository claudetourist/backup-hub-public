/**
 * Which Sources sections are open. Kept in the renderer's localStorage (a view preference, not
 * data), one key per section. Pure helpers so they are unit-tested; the hook lives next to them.
 */
import { useCallback, useState } from 'react';

export const SECTION_KEY_PREFIX = 'backuphub.section.';

export const sectionKey = (id: string): string => `${SECTION_KEY_PREFIX}${id}`;

/** The slice of Storage these helpers use. */
export interface TinyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** '1' = open, '0' = closed, anything else (or an unreadable store) = the default. */
export function readSectionOpen(storage: TinyStorage | null, id: string, defaultOpen: boolean): boolean {
  try {
    const value = storage?.getItem(sectionKey(id));
    if (value === '1') return true;
    if (value === '0') return false;
  } catch {
    // Storage blocked: use the default.
  }
  return defaultOpen;
}

export function writeSectionOpen(storage: TinyStorage | null, id: string, open: boolean): void {
  try {
    storage?.setItem(sectionKey(id), open ? '1' : '0');
  } catch {
    // Not remembered; the section still works.
  }
}

export function browserStorage(): TinyStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Open/closed state of one section, remembered between visits. */
export function useSectionOpen(id: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => readSectionOpen(browserStorage(), id, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((current) => {
      writeSectionOpen(browserStorage(), id, !current);
      return !current;
    });
  }, [id]);
  return [open, toggle];
}
