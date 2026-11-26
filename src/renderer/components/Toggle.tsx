import { useId, type ReactNode } from 'react';

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Short explanation under the label. */
  hint?: ReactNode;
  disabled?: boolean;
}

/** An on/off switch built on a real checkbox, so it works with keyboard and screen readers. */
export function Toggle({ label, checked, onChange, hint, disabled = false }: ToggleProps) {
  const id = useId();
  return (
    <div className="toggle">
      <input id={id} className="toggle__input" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label className="toggle__label" htmlFor={id}>
        <b>{label}</b>
        {hint ? <span className="cell-sub">{hint}</span> : null}
      </label>
    </div>
  );
}
