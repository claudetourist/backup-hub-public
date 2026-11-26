import { useEffect, useState } from 'react';
import type { RuleAddResult, RuleDraft, RuleEffectResult } from '../../shared/rules';
import { Button } from '../components/Button';
import { draftTitle, effectLines } from './choicesModel';

interface ChoiceConfirmProps {
  backupId: number;
  /** The plan open in the window, so main counts over it. */
  planId: string | null;
  draft: RuleDraft;
  /** Called with main's answer when the choice was saved. */
  onSaved: (draft: RuleDraft, result: Extract<RuleAddResult, { ok: true }>) => void;
  onCancel: () => void;
}

/**
 * Before a choice is saved: what it is and what it does to the list ("This leaves out 1,234 files (2.1 GB) now and in every later backup
 * of Sam phone."), with Save and Cancel. The numbers are worked out in main from the plan it holds; nothing is stored until Save.
 */
export function ChoiceConfirm({ backupId, planId, draft, onSaved, onCancel }: ChoiceConfirmProps) {
  const [effect, setEffect] = useState<RuleEffectResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const answer = await window.backupHub.rules.effect({ backupId, ...(planId !== null ? { planId } : {}), change: { kind: 'add', draft } });
        if (alive) setEffect(answer);
      } catch {
        if (alive) setEffect({ ok: false, message: 'That did not work. Nothing was changed.' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [backupId, planId, draft]);

  const save = (): void => {
    setSaving(true);
    setProblem(null);
    void (async () => {
      try {
        const result = await window.backupHub.rules.add({ backupId, ...draft });
        if (result.ok) onSaved(draft, result);
        else setProblem(result.message);
      } catch {
        setProblem('That did not work. Nothing was changed.');
      }
      setSaving(false);
    })();
  };

  return (
    <div className="settings-stack" role="group" aria-label="Your choice">
      <b>{draftTitle(draft)}</b>
      {effect === null ? <span role="status" className="cell-sub">Counting the files this changes.</span> : null}
      {effect !== null && effect.ok ? effectLines(effect, 'add').map((line) => <span key={line} role="status">{line}</span>) : null}
      {effect !== null && !effect.ok ? <span role="alert" className="cell-sub">{effect.message}</span> : null}
      {problem ? <span role="alert" className="cell-sub">{problem}</span> : null}
      <span className="settings-actions">
        <Button variant="primary" size="sm" disabled={saving || effect === null || !effect.ok} onClick={save}>Save</Button>
        <Button variant="quiet" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}
