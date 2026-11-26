import { useState } from 'react';
import type { RestoreDestination as Destination } from '../../shared/restore';
import { Button } from '../components/Button';

/** "Where should they go?": a new folder (the default, never overwrites) or back to where they were (only what is not there now). */
export function RestoreDestinationChoice({ value, defaultParent, originalWords, onChange, name }: { value: Destination; defaultParent: string | null; originalWords: string | null; onChange: (next: Destination) => void; name: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const choose = (): void => {
    setProblem(null);
    void (async () => {
      try {
        const r = await window.backupHub.restore.chooseFolder();
        if (r.ok) onChange({ mode: 'new', parent: r.parent });
        else if (!r.canceled) setProblem(r.message);
      } catch {
        setProblem('That did not work. Please try again.');
      }
    })();
  };
  return (
    <fieldset className="settings-stack" aria-label="Where should they go?">
      <b>Where should they go?</b>
      <label>
        <input type="radio" name={name} checked={value.mode === 'new'} onChange={() => onChange({ mode: 'new', ...(value.parent === undefined ? {} : { parent: value.parent }) })} /> Into a new folder (recommended)
        <span className="cell-sub"> {value.parent ?? defaultParent ?? 'a new folder in "Restored"'}</span>
      </label>
      {value.mode === 'new' ? (
        <span className="settings-actions">
          <Button size="sm" variant="quiet" onClick={choose}>
            Choose another folder
          </Button>
        </span>
      ) : null}
      {originalWords !== null ? (
        <label>
          <input type="radio" name={name} checked={value.mode === 'original'} onChange={() => onChange({ mode: 'original' })} /> Back to where they were
          <span className="cell-sub"> {originalWords}. Only files that are not there now. A file that is already there stays as it is.</span>
        </label>
      ) : null}
      {problem ? (
        <span role="alert" className="cell-sub">
          {problem}
        </span>
      ) : null}
    </fieldset>
  );
}
