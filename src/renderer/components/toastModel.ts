/** The toasts on screen, as a plain reducer, so adding, expiring and dismissing can be tested. */
export type ToastTone = 'info' | 'ok' | 'error';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
  /** Milliseconds on screen; null stays until dismissed (errors do). */
  ttl: number | null;
}

/** Newest toasts last; at most this many are shown at once (the oldest goes first). */
export const MAX_TOASTS = 3;
export const DEFAULT_TTL = 6000;

export interface ToastInput {
  tone?: ToastTone;
  text: string;
  /** Overrides the time on screen; null = until dismissed. */
  ttl?: number | null;
}

export function makeToast(id: number, input: ToastInput): ToastItem {
  const tone = input.tone ?? 'info';
  const ttl = input.ttl !== undefined ? input.ttl : tone === 'error' ? null : DEFAULT_TTL;
  return { id, tone, text: input.text, ttl };
}

export type ToastAction = { type: 'add'; toast: ToastItem } | { type: 'dismiss'; id: number };

export function toastReducer(state: readonly ToastItem[], action: ToastAction): ToastItem[] {
  if (action.type === 'dismiss') return state.filter((toast) => toast.id !== action.id);
  // The same words twice in a row only keep one toast.
  const rest = state.filter((toast) => !(toast.text === action.toast.text && toast.tone === action.toast.tone));
  return [...rest, action.toast].slice(-MAX_TOASTS);
}
