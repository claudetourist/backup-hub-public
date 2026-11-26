import { useMemo, useState } from 'react';
import type { SearchHit } from '../../shared/search';
import type { RestoreDestination } from '../../shared/restore';
import { Button } from '../components/Button';
import { type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { RestoreDestinationChoice } from '../backups/RestoreDestination';
import { RestoreRun } from '../backups/RestoreRun';
import { RESTORE_SHOW_BUTTON } from '../backups/restoreModel';
import { formatCount, plural } from '../lib/format';

/** The tick column of the results: it only shows the state (the table's row click and Space do the ticking). */
export function tickColumn(ticked: ReadonlySet<string>, onToggle: (key: string) => void): Column<SearchHit> {
  return {
    key: 'tick',
    header: 'Get back',
    width: 90,
    render: (hit) => <input type="checkbox" className="preview-list__tick" checked={ticked.has(hit.key)} aria-label={'Get back ' + hit.name} onClick={(event) => event.stopPropagation()} onChange={() => onToggle(hit.key)} />,
  };
}

/** Every copy id of the ticked results: main finds the copy on a plugged-in drive (the T7 first). */
export function fileIdsOf(hits: readonly SearchHit[], ticked: ReadonlySet<string>): number[] {
  return [...new Set(hits.filter((h) => ticked.has(h.key)).flatMap((h) => h.copies.map((c) => c.fileId)))].slice(0, 5000);
}

function GetBackFlow({ fileIds, onClose }: { fileIds: number[]; onClose: () => void }) {
  const [destination, setDestination] = useState<RestoreDestination>({ mode: 'new' });
  const [reviewing, setReviewing] = useState(false);
  const pick = useMemo(() => ({ kind: 'files' as const, fileIds }), [fileIds]);
  if (reviewing) return <RestoreRun pick={pick} destination={destination} onBack={() => setReviewing(false)} />;
  return (
    <div className="settings-stack">
      <RestoreDestinationChoice name="search-restore-where" value={destination} defaultParent={null} originalWords={null} onChange={setDestination} />
      <span className="settings-actions">
        <Button variant="primary" onClick={() => setReviewing(true)}>
          {RESTORE_SHOW_BUTTON}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** Under the results, once something is ticked: one button that opens "Get files back" for the ticked files. */
export function GetBackBar({ hits, ticked, onClear }: { hits: readonly SearchHit[]; ticked: ReadonlySet<string>; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const count = useMemo(() => hits.filter((h) => ticked.has(h.key)).length, [hits, ticked]);
  const fileIds = useMemo(() => fileIdsOf(hits, ticked), [hits, ticked]);
  if (count === 0) return null;
  return (
    <div className="search-more">
      <span role="status">
        {formatCount(count)} {plural(count, 'file', 'files')} ticked
      </span>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Get {plural(count, 'this file', 'these files')} back
      </Button>
      <Button variant="quiet" onClick={onClear}>
        Untick all
      </Button>
      {open ? (
        <Drawer title="Get files back" subtitle="From the T7, then the Seagate, then Google. Nothing is replaced." onClose={() => setOpen(false)}>
          <GetBackFlow fileIds={fileIds} onClose={() => setOpen(false)} />
        </Drawer>
      ) : null}
    </div>
  );
}
