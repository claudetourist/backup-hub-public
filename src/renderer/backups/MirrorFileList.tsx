import { useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import { Button } from '../components/Button';
import { DataTable, type Column } from '../components/DataTable';
import { toggleUnticked } from '../components/previewModel';
import { TextField } from '../components/TextField';
import { countOf, countText, filterRows, MIRROR_HEADLINE, MIRROR_UNTICK, setTicks, type MirrorListRow } from './mirrorModel';

interface MirrorFileListProps {
  /** Every file that would be copied, largest first (see listRows). */
  rows: readonly MirrorListRow[];
  /** The row ids the person unticked. Everything else is ticked. */
  unticked: ReadonlySet<string>;
  onUntickedChange: (next: ReadonlySet<string>) => void;
  /** The words of the one button ("Copy 180 files (1.1 GB) to Seagate2TB"); it is off when nothing would be copied. */
  confirmLabel: string;
  canConfirm: boolean;
  onConfirm: () => void;
  /** Show which backup each file belongs to (when the list covers several). */
  showBackup: boolean;
}

const LIST_HEIGHT = 460;
const ROW_HEIGHT = 56;

/**
 * The list the person looks at before anything is copied to the second drive: every file, largest first, each with a tick, its name in bold with its
 * folder under it, its size, its date and what its checksum is checked against. The search box narrows the list; "Untick all" and "Tick all" act on the
 * files the search shows. The one confirm button sits under the list and says what it will do.
 */
export function MirrorFileList({ rows, unticked, onUntickedChange, confirmLabel, canConfirm, onConfirm, showBackup }: MirrorFileListProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const count = countOf(rows, shown, unticked);
  const searching = shown.length !== rows.length;
  const columns: readonly Column<MirrorListRow>[] = useMemo(
    () => [
      {
        key: 'tick',
        header: 'Copy',
        width: 90,
        render: (row) => (
          // The row handles the click and the keyboard (Space); this box only shows the state.
          <input type="checkbox" className="preview-list__tick" checked={!unticked.has(row.id)} tabIndex={-1} aria-label={`Copy ${row.name}`} onChange={() => undefined} />
        ),
      },
      {
        key: 'name',
        header: 'File and folder',
        rowHeader: true,
        render: (row) => (
          <span className="phone-file">
            <b className="phone-file__name">{row.name}</b>
            <span className="phone-file__folder">{showBackup ? row.backupName + ': ' : ''}{row.folder}</span>
          </span>
        ),
      },
      { key: 'size', header: 'Size', width: 92, align: 'end', render: (row) => <span className="mono">{formatBytes(row.size)}</span> },
      { key: 'date', header: 'Date', width: 128, render: (row) => row.date },
      { key: 'checked', header: 'Checked against', width: 180, render: (row) => <span className={row.checked === 'Own checksum' ? 'phone-file__kind phone-file__kind--changed' : 'phone-file__kind'}>{row.checked}</span> },
    ],
    [unticked, showBackup],
  );
  return (
    <section className="phone-preview" aria-label="Files to copy to the second drive">
      <p className="phone-preview__headline">
        {MIRROR_HEADLINE}
        <span className="phone-preview__sub">{MIRROR_UNTICK}</span>
      </p>
      <div className="phone-preview__tools">
        <TextField label="Search by file or folder name" value={query} onChange={setQuery} />
        <span className="preview-list__bulk">
          <Button size="sm" variant="quiet" disabled={count.shownTicked === 0} onClick={() => onUntickedChange(setTicks(unticked, shown, false))}>
            {searching ? `Untick all ${shown.length} shown` : 'Untick all'}
          </Button>
          <Button size="sm" variant="quiet" disabled={count.shownTicked === shown.length} onClick={() => onUntickedChange(setTicks(unticked, shown, true))}>
            {searching ? `Tick all ${shown.length} shown` : 'Tick all'}
          </Button>
        </span>
      </div>
      <span className="preview-list__count" role="status">
        {countText(count)}
      </span>
      <DataTable
        caption="Files to copy, largest first"
        columns={columns}
        rows={shown}
        rowKey={(row) => row.id}
        virtual={{ height: LIST_HEIGHT, rowHeight: ROW_HEIGHT }}
        onRowClick={(row) => onUntickedChange(toggleUnticked(unticked, row.id))}
        emptyText={rows.length === 0 ? 'Nothing to copy.' : 'No file matches that search.'}
      />
      <div className="preview-list__confirm">
        <Button variant="primary" size="lg" disabled={!canConfirm} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </section>
  );
}
