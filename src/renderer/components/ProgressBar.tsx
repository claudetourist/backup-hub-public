import { clampPercent, widthPercentRef } from './sizing';
import type { Tone } from './status';

interface ProgressBarProps {
  /** 0..100. Omit (or pass indeterminate) when the amount of work is unknown. */
  value?: number;
  indeterminate?: boolean;
  /** Accessible name, e.g. "Copying Reunion to T7". */
  label: string;
  tone?: Tone;
  /** Optional text read out with the value, e.g. "12.4 of 46.5 GB". */
  valueText?: string;
}

export function ProgressBar({ value, indeterminate = false, label, tone = 'info', valueText }: ProgressBarProps) {
  const unknown = indeterminate || value === undefined;
  const percent = unknown ? 0 : clampPercent(value);
  return (
    <div
      className={`progress progress--${tone}${unknown ? ' progress--indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unknown ? undefined : Math.round(percent)}
      aria-valuetext={valueText ?? (unknown ? 'Working' : `${Math.round(percent)}%`)}
    >
      <span className="progress__fill" ref={unknown ? undefined : widthPercentRef(percent)} />
    </div>
  );
}
