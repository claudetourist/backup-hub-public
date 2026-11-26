import { useMemo, type ReactNode } from 'react';
import { formatBytes } from '../lib/format';
import { Button } from './Button';
import { DataTable, type Column } from './DataTable';
import { KindChipOf } from './KindChip';
import {
  previewTotals,
  skippedHeadline,
  skippedReasonsText,
  sortLargestFirst,
  tickedText,
  toggleUnticked,
  type PreviewItem,
  type SkippedInfo,
} from './previewModel';

interface PreviewListProps {
  /** What the list is for, read by screen readers ("Files to copy to Seagate"). */
  caption: string;
  items: readonly PreviewItem[];
  /** The ids the person has unticked. Everything else is ticked. */
  unticked: ReadonlySet<string>;
  onUntickedChange: (next: ReadonlySet<string>) => void;
  /** Files left out of the list, and why. */
  skipped?: SkippedInfo;
  /** The one button that runs it. Its words say what will happen ("Copy 312 files to Seagate"); it is off when nothing is ticked. */
  confirmLabel: (ticked: { files: number; bytes: number }) => string;
  onConfirm: () => void;
  /** Height of the scrolling list in pixels. */
  height?: number;
}

/**
 * The list shown before anything runs (PLAN section 4 rule 5): the exact files, largest first, each with a tick to take it out,
 * and "Skipped: N files" with why. Nothing runs until the one button is pressed. Long lists are drawn row by row, so 45,000 files stay quick.
 */
export function PreviewList({ caption, items, unticked, onUntickedChange, skipped, confirmLabel, onConfirm, height = 420 }: PreviewListProps) {
  const sorted = useMemo(() => sortLargestFirst(items), [items]);
  const totals = useMemo(() => previewTotals(sorted, unticked), [sorted, unticked]);
  const toggle = (id: string): void => onUntickedChange(toggleUnticked(unticked, id));
  const columns: readonly Column<PreviewItem>[] = useMemo(
    () => [
      {
        key: 'tick',
        header: 'Copy',
        width: 84,
        render: (row) => (
          // The row handles the click and the keyboard (Space); this box only shows the state.
          <input type="checkbox" className="preview-list__tick" checked={!unticked.has(row.id)} tabIndex={-1} aria-label={`Include ${row.name}`} onChange={() => undefined} />
        ),
      },
      { key: 'name', header: 'File', rowHeader: true, render: (row) => <span className="preview-list__name">{row.name}</span> },
      { key: 'kind', header: 'Kind', width: 176, render: (row) => (row.kind ? <KindChipOf kind={row.kind} /> : null) },
      { key: 'bytes', header: 'Size', width: 100, align: 'end', render: (row) => <span className="mono">{formatBytes(row.bytes)}</span> },
    ],
    [unticked],
  );
  const headline = skippedHeadline(skipped);
  const why = skippedReasonsText(skipped);
  const actions: ReactNode = (
    <span className="preview-list__bulk">
      <Button size="sm" variant="quiet" disabled={totals.tickedFiles === 0} onClick={() => onUntickedChange(new Set(sorted.map((item) => item.id)))}>
        Untick all
      </Button>
      <Button size="sm" variant="quiet" disabled={unticked.size === 0} onClick={() => onUntickedChange(new Set())}>
        Tick all
      </Button>
    </span>
  );
  return (
    <section className="preview-list" aria-label={caption}>
      <div className="preview-list__top">
        <span className="preview-list__count" role="status">
          {tickedText(totals)}
        </span>
        {actions}
      </div>
      <DataTable
        caption={caption}
        columns={columns}
        rows={sorted}
        rowKey={(row) => row.id}
        virtual={{ height, rowHeight: 40 }}
        onRowClick={(row) => toggle(row.id)}
        emptyText="Nothing to copy."
      />
      {headline ? (
        <p className="preview-list__skipped">
          <b>{headline}</b>
          {why ? <span>: {why}</span> : null}
        </p>
      ) : null}
      <div className="preview-list__confirm">
        <Button variant="primary" size="lg" disabled={totals.tickedFiles === 0} onClick={onConfirm}>
          {confirmLabel({ files: totals.tickedFiles, bytes: totals.tickedBytes })}
        </Button>
      </div>
    </section>
  );
}
