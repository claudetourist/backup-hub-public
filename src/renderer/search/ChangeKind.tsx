import { useEffect, useId, useState } from 'react';
import { FILE_KINDS, KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import type { KindTarget, SimilarFiles } from '../../shared/kinds';
import { Button } from '../components/Button';

interface ChangeKindProps {
  /** The files to change (a file's copies). */
  targets: KindTarget[];
  /** One of the files, to find the files like it in its folder; null = no "similar files" choice. */
  similarFrom: number | null;
  /** The kind the files have now, left out of the choices. */
  current?: FileKind | null;
  /** Called after the kinds were changed, so the screen can look again. */
  onChanged: (message: string) => void;
  onCancel: () => void;
}

/**
 * "Change category": pick the kind these files should have. Your choice wins over the automatic one and stays when the
 * files are sorted again. "Also for similar files in this folder" says how many other files that would change.
 */
export function ChangeKind({ targets, similarFrom, current = null, onChanged, onCancel }: ChangeKindProps) {
  const selectId = useId();
  const [kind, setKind] = useState<FileKind | ''>('');
  const [similar, setSimilar] = useState(false);
  const [info, setInfo] = useState<SimilarFiles | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (similarFrom === null) return undefined;
    let live = true;
    void window.backupHub.kinds
      .similar(similarFrom)
      .then((found) => {
        if (live) setInfo(found);
        return found;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [similarFrom]);

  const apply = (): void => {
    if (kind === '') return;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.kinds.change({ kind, targets, similar });
        if (result.ok) onChanged(result.message);
        else setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="change-kind" role="group" aria-label="Change category">
      <label className="fbar__group" htmlFor={selectId}>
        <span className="fbar__label">Make it</span>
        <select id={selectId} className="fsmall" value={kind} onChange={(e) => setKind(e.target.value as FileKind | '')}>
          <option value="">Choose a kind...</option>
          {FILE_KINDS.filter((k) => k !== current).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {info && info.count > 0 ? (
        <label className="change-kind__similar">
          <input type="checkbox" checked={similar} onChange={(e) => setSimilar(e.target.checked)} />
          <span>
            Also for similar files in this folder
            <span className="cell-sub"> · {info.count.toLocaleString('en-US')} more: {info.description}</span>
          </span>
        </label>
      ) : null}
      <span className="cell-sub">Your choice wins over the automatic one. No file is changed or moved.</span>
      {message ? (
        <p className="tone-text tone-text--crit" role="alert">
          {message}
        </p>
      ) : null}
      <span className="change-kind__buttons">
        <Button size="sm" variant="primary" disabled={kind === '' || busy} onClick={apply}>
          Change category
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}
