import { useSyncExternalStore } from 'react';

/**
 * Failed jobs the person has dismissed on Home. Only the window remembers this (a list of job numbers in its local
 * storage): the job stays in the Jobs list, nothing is deleted anywhere, it just stops asking for attention.
 */

const KEY = 'backuphub.dismissedJobs';
const MAX_KEPT = 500;

let current: ReadonlySet<number> | null = null;
const listeners = new Set<() => void>();

function load(): ReadonlySet<number> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

function read(): ReadonlySet<number> {
  current ??= load();
  return current;
}

/** Dismiss these jobs for good (until the browser data is cleared). */
export function dismissJobs(ids: readonly number[]): void {
  const next = new Set([...read(), ...ids]);
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...next].slice(-MAX_KEPT)));
  } catch {
    // Storage is full or off: the dismissal then lasts until the window closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The dismissed job numbers; the same set object until something is dismissed. */
export function useDismissedJobs(): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, read, read);
}
