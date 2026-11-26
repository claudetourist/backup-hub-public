import { useMemo, useState, type ReactNode } from 'react';
import { formatBytes } from '../lib/format';
import { Button } from '../components/Button';
import { DataTable, type Column } from '../components/DataTable';
import { toggleUnticked } from '../components/previewModel';
import { PopupMenu } from '../components/PopupMenu';
import { TextField } from '../components/TextField';
import type { RuleDraft, RuleView } from '../../shared/rules';
import { choiceOptions, undoLabel, yourChoicesButton } from './choicesModel';
import { WhyLink } from '../why/WhyLink';
import { phoneFileRequest } from '../why/whyModel';
import { EXCLUDED_WORD, filterListRows, kindWord, listCount, listCountText, PREVIEW_HEADLINE, setTicks, UNTICK_VS_EXCLUDE, withoutExcluded, type ListRow } from './phoneBackupModel';

interface PhoneFileListProps {
  /** Every file that would be copied, largest first (see listRows). */
  rows: readonly ListRow[];
  /** The phone paths the person unticked. Everything else is ticked. */
  unticked: ReadonlySet<string>;
  onUntickedChange: (next: ReadonlySet<string>) => void;
  /** The words of the one button ("Copy 180 files (1.1 GB) to T7"); it is off when nothing would be copied. */
  confirmLabel: string;
  canConfirm: boolean;
  onConfirm: () => void;
  /** The person picked "Never back up ..." in a row's menu: the window asks for the effect and shows Save and Cancel. Without it the menu is not shown. */
  onChoose?: (draft: RuleDraft) => void;
  /** The backup the files belong to: with it every row gets a "Why?" link that explains the file. Without it the column is not shown. */
  backupId?: number;
  /** The rows a "never back up" choice names, with the choice: they show "Excluded" instead of a tick box, dimmed, with Undo in the Exclude column. */
  excluded?: ReadonlyMap<string, RuleView>;
  /** Undo on an excluded row: takes that choice back at once. */
  onUndo?: (rule: RuleView) => void;
  /** How many things this backup never backs up, and the link that opens the list of them (shown next to the search box). */
  exclusionCount?: number;
  onOpenExclusions?: () => void;
  /** The backup has no exclusions (the Google Keep notes): the headline only says what unticking does. */
  untickOnly?: boolean;
}

const NONE: ReadonlyMap<string, RuleView> = new Map();

/** An excluded row's text is dimmed; the word Excluded and the Undo button are not. */
const dim = (excluded: boolean, node: ReactNode): ReactNode => (excluded ? <span className="phone-file--excluded">{node}</span> : node);

const LIST_HEIGHT = 460;
const ROW_HEIGHT = 56;

/**
 * The list the person looks at before anything is copied: every file, largest first, each with a tick, its name in bold with its folder
 * under it, its size, its date and whether it is new or changed. The search box narrows the list; "Untick all" and "Tick all" act on the
 * files the search shows. The one confirm button sits under the list and says what it will do.
 */
export function PhoneFileList({ rows, unticked, onUntickedChange, confirmLabel, canConfirm, onConfirm, onChoose, backupId, excluded = NONE, onUndo, exclusionCount, onOpenExclusions, untickOnly = false }: PhoneFileListProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterListRows(rows, query), [rows, query]);
  const count = listCount(rows, shown, unticked, excluded);
  // Untick all and Tick all never touch an excluded row: it has no tick box.
  const tickable = useMemo(() => withoutExcluded(shown, excluded), [shown, excluded]);
  const searching = shown.length !== rows.length;
  const columns: readonly Column<ListRow>[] = useMemo(
    () => [
      {
        key: 'tick',
        header: 'Copy',
        width: 120,
        render: (row) =>
          excluded.has(row.path) ? (
            <span className="pill pill--excluded">{EXCLUDED_WORD}</span>
          ) : (
            // The row handles the click and the keyboard (Space); this box only shows the state.
            <input type="checkbox" className="preview-list__tick" checked={!unticked.has(row.path)} tabIndex={-1} aria-label={`Copy ${row.name}`} onChange={() => undefined} />
          ),
      },
      {
        key: 'name',
        header: 'File and folder',
        rowHeader: true,
        render: (row) =>
          dim(
            excluded.has(row.path),
            <span className="phone-file">
              <b className="phone-file__name">{row.name}</b>
              <span className="phone-file__folder">{row.folder}</span>
            </span>,
          ),
      },
      { key: 'size', header: 'Size', width: 92, align: 'end', render: (row) => dim(excluded.has(row.path), <span className="mono">{formatBytes(row.size)}</span>) },
      { key: 'date', header: 'Date', width: 128, render: (row) => dim(excluded.has(row.path), row.date) },
      { key: 'kind', header: 'New or changed', width: 164, render: (row) => dim(excluded.has(row.path), <span className={row.kind === 'changed' ? 'phone-file__kind phone-file__kind--changed' : 'phone-file__kind'}>{kindWord(row.kind)}</span>) },
      ...(backupId !== undefined
        ? [{ key: 'why', header: 'Why?', width: 76, render: (row: ListRow) => <WhyLink request={phoneFileRequest(backupId, row.path)} name={row.name} /> }]
        : []),
      ...(onChoose
        ? [
            {
              key: 'choices',
              header: 'Exclude',
              width: 150,
              render: (row: ListRow) => {
                const rule = excluded.get(row.path);
                return (
                  // The menu is its own control: a click or a key in it must not tick the row.
                  <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    {rule ? (
                      <Button variant="quiet" size="sm" title={rule.words} aria-label={`${undoLabel(rule)}: ${rule.words}`} disabled={!onUndo} onClick={() => onUndo?.(rule)}>
                        {undoLabel(rule)}
                      </Button>
                    ) : (
                      <PopupMenu
                        label={`Exclude or include ${row.name}`}
                        trigger="Choose"
                        placement="auto"
                        items={choiceOptions(row.path).map((o) => ({ id: o.id, label: o.label, hint: o.hint, onSelect: () => onChoose(o.draft) }))}
                      />
                    )}
                  </span>
                );
              },
            },
          ]
        : []),
    ],
    [unticked, onChoose, backupId, excluded, onUndo],
  );
  return (
    <section className="phone-preview" aria-label="Files to copy">
      <p className="phone-preview__headline">
        {PREVIEW_HEADLINE}
        <span className="phone-preview__sub">{untickOnly ? 'Untick = skip this time.' : UNTICK_VS_EXCLUDE}</span>
      </p>
      <div className="phone-preview__tools">
        <TextField label="Search by file or folder name" value={query} onChange={setQuery} />
        <span className="preview-list__bulk">
          {onOpenExclusions ? (
            <Button size="sm" variant="quiet" onClick={onOpenExclusions}>
              {yourChoicesButton(exclusionCount ?? 0)}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" disabled={count.shownTicked === 0} onClick={() => onUntickedChange(setTicks(unticked, tickable, false))}>
            {searching ? `Untick all ${tickable.length} shown` : 'Untick all'}
          </Button>
          <Button size="sm" variant="quiet" disabled={count.shownTicked === tickable.length} onClick={() => onUntickedChange(setTicks(unticked, tickable, true))}>
            {searching ? `Tick all ${tickable.length} shown` : 'Tick all'}
          </Button>
        </span>
      </div>
      <span className="preview-list__count" role="status">
        {listCountText(count)}
      </span>
      <DataTable
        caption="Files to copy, largest first"
        columns={columns}
        rows={shown}
        rowKey={(row) => row.path}
        virtual={{ height: LIST_HEIGHT, rowHeight: ROW_HEIGHT }}
        onRowClick={(row) => (excluded.has(row.path) ? undefined : onUntickedChange(toggleUnticked(unticked, row.path)))}
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
