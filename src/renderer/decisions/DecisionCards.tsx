import { useState } from 'react';
import type { DecisionCase, DecisionChoice } from '../../shared/decisions';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';
import { StatusAlertIcon } from '../icons';
import { foundText, similarText } from './decisionsModel';

interface CardProps {
  decision: DecisionCase;
  now: number;
  onAnswered: () => void;
}

/** One case: what happened, when, and its two or three choices. An answer is sent to main, which hands it to the part that owns the case. */
function DecisionCard({ decision, now, onAnswered }: CardProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [same, setSame] = useState(false);
  const similar = similarText(decision);
  const canSimilar = similar !== null && decision.choices.some((c) => c.id === 'copy_again');

  const choose = (choice: DecisionChoice): void => {
    setBusy(true);
    void (async () => {
      try {
        if (choice.action === 'open') {
          // "Show the file" only opens the folder with the search's own button; nothing is changed.
          const result = decision.fileId === null ? { ok: false, message: 'That file cannot be shown.' } : await window.backupHub.search.showInFolder(decision.fileId);
          if (!result.ok) toast.show({ tone: 'error', text: ('message' in result && result.message) || 'That did not work.' });
        } else if (choice.id !== 'show_file') {
          const result = await window.backupHub.decisions.answer({ key: decision.key, choice: choice.id, ...(same && canSimilar ? { similar: true } : {}) });
          toast.show({ tone: result.ok ? 'ok' : 'error', text: result.message });
          if (result.ok) onAnswered();
        }
      } catch {
        toast.show({ tone: 'error', text: 'That did not work. Nothing was changed. Please try again.' });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <li className="decision">
      <span className="decision__head">
        <StatusAlertIcon size={14} />
        <b className="decision__headline">{decision.headline}</b>
      </span>
      <span className="decision__what">{decision.what}</span>
      <span className="cell-sub">{foundText(decision.at, now)}</span>
      {decision.choices.length > 0 ? (
        <span className="decision__choices">
          {decision.choices.map((choice, i) => (
            <span key={choice.id} className="decision__choice">
              <Button size="sm" variant={i === 0 ? 'primary' : 'secondary'} disabled={busy} onClick={() => choose(choice)}>
                {choice.label}
              </Button>
              {choice.hint ? <span className="cell-sub">{choice.hint}</span> : null}
            </span>
          ))}
        </span>
      ) : decision.note ? (
        <span className="decision__note">{decision.note}</span>
      ) : null}
      {canSimilar ? (
        <label className="decision__similar">
          <input type="checkbox" checked={same} disabled={busy} onChange={(event) => setSame(event.target.checked)} /> {similar}
        </label>
      ) : null}
    </li>
  );
}

/** The cases as a list. Answering one reloads the list (`onAnswered`). */
export function DecisionCards({ cases, now, onAnswered, label = 'Needs your decision' }: { cases: readonly DecisionCase[]; now: number; onAnswered: () => void; label?: string }) {
  if (cases.length === 0) return null;
  return (
    <ul className="decision-list" aria-label={label}>
      {cases.map((c) => (
        <DecisionCard key={c.key} decision={c} now={now} onAnswered={onAnswered} />
      ))}
    </ul>
  );
}
