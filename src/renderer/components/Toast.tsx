import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { CloseIcon, StatusAlertIcon, StatusCheckIcon, StatusClockIcon } from '../icons';
import { makeToast, toastReducer, type ToastInput, type ToastItem } from './toastModel';

interface ToastApi {
  show: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Shows a short message in the corner ("Copied 312 files"). An error stays until it is closed. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TONE_ICONS = { info: StatusClockIcon, ok: StatusCheckIcon, error: StatusAlertIcon } as const;

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.ttl === null) return undefined;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.ttl);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.ttl, onDismiss]);
  const Icon = TONE_ICONS[toast.tone];
  return (
    <li className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} />
      <span className="toast__text">{toast.text}</span>
      <button type="button" className="toast__close" aria-label="Close this message" onClick={() => onDismiss(toast.id)}>
        <CloseIcon size={14} />
      </button>
    </li>
  );
}

/** The stack of messages. Exported so the gallery and the tests can draw it without a provider. */
export function ToastStack({ toasts, onDismiss, inline = false }: { toasts: readonly ToastItem[]; onDismiss: (id: number) => void; inline?: boolean }) {
  return (
    <ul className={`toast-stack${inline ? ' toast-stack--inline' : ''}`} aria-label="Messages">
      {toasts.map((toast) => (
        <ToastView key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const counter = useRef(0);
  const show = useCallback((input: ToastInput) => {
    counter.current += 1;
    dispatch({ type: 'add', toast: makeToast(counter.current, input) });
  }, []);
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);
  const api = useMemo<ToastApi>(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
