import { useState } from 'react';
import { MAX_SAVED_NAME, type SavedSearch } from '../../shared/search';
import { Button } from '../components/Button';
import { FilterMenu } from '../components/FilterMenu';
import { savedSummary } from './savedModel';

/**
 * "Saved searches": the list of what was saved (press one to run it again, × to remove it) and a box to save the search on screen.
 * The screen owns the data; this only asks it to apply, save or remove.
 */
export function SavedSearchesMenu({
  saved,
  canSave,
  suggestion,
  message,
  onApply,
  onSave,
  onRemove,
}: {
  saved: readonly SavedSearch[];
  /** True when there is something on screen to save (words or a filter). */
  canSave: boolean;
  /** The name offered in the box (the typed words). */
  suggestion: string;
  message: string | null;
  onApply: (search: SavedSearch) => void;
  onSave: (name: string) => void;
  onRemove: (search: SavedSearch) => void;
}) {
  return (
    <FilterMenu label="Saved searches" active={saved.length > 0} summary={savedSummary(saved)}>
      {(close) => <Inside saved={saved} canSave={canSave} suggestion={suggestion} message={message} onApply={(s) => { onApply(s); close(); }} onSave={onSave} onRemove={onRemove} />}
    </FilterMenu>
  );
}

function Inside({ saved, canSave, suggestion, message, onApply, onSave, onRemove }: Parameters<typeof SavedSearchesMenu>[0]) {
  const [name, setName] = useState(suggestion);
  return (
    <div className="more-filters saved-searches">
      {saved.length > 0 ? (
        <ul className="saved-searches__list" aria-label="Saved searches">
          {saved.map((s) => (
            <li key={s.id} className="saved-searches__item">
              <button type="button" className="fchip" onClick={() => onApply(s)}>
                {s.name}
              </button>
              <button type="button" className="fchip ftag" aria-label={`Remove saved search: ${s.name}`} onClick={() => onRemove(s)}>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="cell-sub">Nothing saved yet. Set up a search, then save it here to run it again with one press.</span>
      )}
      <label className="more-filters__row">
        <span className="fbar__label">Save as</span>
        <input className="fsmall fsmall--folder" value={name} maxLength={MAX_SAVED_NAME} placeholder="A name for this search" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="more-filters__foot">
        <Button size="sm" variant="primary" disabled={!canSave} onClick={() => onSave(name)}>
          Save this search
        </Button>
      </div>
      {message ? (
        <span className="cell-sub" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
