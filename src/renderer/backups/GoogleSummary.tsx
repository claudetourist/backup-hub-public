import { useEffect, useRef, useState } from 'react';
import { becameFits, type GoogleSummary, type SummaryState } from './googleModel';

/** A step heading with a short note on its right ("Step 1 of 3 · What to send" ... "288 MB ticked"). */
export function StepHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="google-step">
      <b className="google-step__title">{title}</b>
      <span className="cell-sub google-step__note">{note}</span>
    </div>
  );
}

const CONFETTI = [0, 1, 2, 3, 4, 5, 6, 7];

/** True (a counter that goes up) each time the summary goes from "does not fit" to "fits": the signal for one short celebration. Never on a first look, never while loading. */
export function useFitsBurst(state: SummaryState): number {
  const settled = useRef<SummaryState | null>(null);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (state === 'loading') return;
    if (becameFits(settled.current, state)) setBurst((n) => n + 1);
    settled.current = state;
  }, [state]);
  return burst;
}

/**
 * The always-visible bar: "To send · Placed · Still to place" and whether everything fits. It stays at the top while the panel scrolls. When
 * everything starts to fit a short check-mark pop with a glow and a few confetti dots plays once (CSS only; with reduced motion only the check mark).
 */
export function GoogleSummaryBar({ summary }: { summary: GoogleSummary }) {
  const burst = useFitsBurst(summary.state);
  const fits = summary.state === 'fits';
  const verdictText = fits ? summary.verdict.replace(/^✓\s*/, '') : summary.verdict;
  return (
    <div className={`google-summary is-${summary.state}`} role="status" aria-live="polite" aria-label="How much fits">
      {fits && burst > 0 ? (
        <span key={burst} className="google-summary__burst" aria-hidden="true">
          <span className="google-summary__glow" />
          {CONFETTI.map((i) => (
            <i key={i} className={`google-summary__dot google-summary__dot--${i}`} />
          ))}
        </span>
      ) : null}
      <span className="google-summary__part">{summary.send}</span>
      {summary.placed === '' ? null : <span className="google-summary__part">{summary.placed}</span>}
      {summary.still === '' ? null : (
        <span className="google-summary__part">
          <b>{summary.still}</b>
        </span>
      )}
      <span className="google-summary__verdict">
        {fits ? (
          <span key={`ok${burst}`} className={`google-summary__check${burst > 0 ? ' is-pop' : ''}`} aria-hidden="true">
            ✓
          </span>
        ) : null}
        <b>{verdictText}</b>
      </span>
    </div>
  );
}
