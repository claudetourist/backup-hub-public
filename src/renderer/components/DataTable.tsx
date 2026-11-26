import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { isListKey, moveIndex } from './listNav';
import { cssVarRef, heightPxRef, widthPxRef } from './sizing';
import { DEFAULT_ROW_HEIGHT, scrollTopToShow, visibleWindow } from './virtualWindow';
import { nextWindow, shownCount, WINDOW_ROWS } from './windowRows';
import { ariaSort, nextSort, sortRows, type SortState, type SortValue } from './sortRows';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Providing this makes the column sortable (header becomes a button with aria-sort). */
  sortValue?: (row: T) => SortValue;
  /** With `onSortChange` on the table: the header is a sort button and the caller sorts (the table never reorders rows). */
  sortable?: boolean;
  align?: 'start' | 'end';
  /** First column of each row is read as the row header by screen readers. */
  rowHeader?: boolean;
  /** Extra class for the th/td, e.g. to set a width in CSS. */
  className?: string;
  /** Width in pixels of a column of a long (virtual) table, so columns do not move while rows scroll. Others share what is left. */
  width?: number;
}

/** A long table that draws only the rows in view: 100,000 rows are as smooth as 100. Rows have one fixed height. */
export interface VirtualOptions {
  /** Height of the scrolling area in pixels. Default 480. */
  height?: number;
  /** Height of every row in pixels. Default 44. */
  rowHeight?: number;
}

/** The sticky header row of a long table is this tall (the CSS uses the same number). */
export const VIRTUAL_HEADER_HEIGHT = 36;
const VIRTUAL_DEFAULT_HEIGHT = 480;
/** `onNearEnd` fires when fewer than this many rows are left below the screen. */
const NEAR_END_ROWS = 30;

interface DataTableProps<T> {
  /** Accessible name of the table (rendered as a visually hidden caption). */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  /**
   * The caller sorts (for example on the server, when only a page of rows is here). Header clicks of columns with
   * `sortable` call `onSortChange` with the column key; `sort` is what the header shows. The rows are shown as given.
   */
  sort?: SortState | null;
  onSortChange?: (columnKey: string) => void;
  /** Keep the header row visible while the surrounding container scrolls vertically. */
  stickyHeader?: boolean;
  /** Shown instead of the body when there are no rows. */
  emptyText?: string;
  /** Makes rows clickable (the mouse convenience; put a real button in a cell for the keyboard). With `virtual`, Enter on the highlighted row does the same. */
  onRowClick?: (row: T) => void;
  /** With `virtual`: Space on the highlighted row (for example to tick it). Falls back to `onRowClick`. */
  onRowToggle?: (row: T) => void;
  /** Row whose key equals this gets the "selected" look. */
  selectedKey?: string | null;
  /** Long tables draw this many rows first and add the same number each time "Show more" is pressed. Default 300. */
  windowRows?: number;
  /** With `virtual`: called when the rows in view come within a screenful of the last row (the next page is loaded here). */
  onNearEnd?: (() => void) | undefined;
  /** Turns on the long-table mode: a scrolling area that draws only the rows in view, with the keyboard (arrows, Page, Home, End, Enter, Space). */
  virtual?: VirtualOptions;
}

function SortArrow({ direction }: { direction: 'asc' | 'desc' | null }) {
  return (
    <svg className="sort-arrow" width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" focusable="false">
      <path d="M5 1 2 4.5h6z" className={direction === 'asc' ? 'sort-arrow__on' : 'sort-arrow__off'} />
      <path d="M5 11 2 7.5h6z" className={direction === 'desc' ? 'sort-arrow__on' : 'sort-arrow__off'} />
    </svg>
  );
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  initialSort,
  sort: controlledSort,
  onSortChange,
  stickyHeader = false,
  emptyText = 'Nothing to show yet.',
  onRowClick,
  onRowToggle,
  selectedKey = null,
  windowRows = WINDOW_ROWS,
  onNearEnd,
  virtual,
}: DataTableProps<T>) {
  const [ownSort, setSort] = useState<SortState | null>(initialSort ?? null);
  const controlled = onSortChange !== undefined;
  const sort = controlled ? (controlledSort ?? null) : ownSort;
  const isSortable = (column: Column<T>): boolean => (controlled ? column.sortable === true : column.sortValue !== undefined);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((c) => c.key === sort.columnKey) : undefined;
    if (controlled || !sort || !column?.sortValue) return rows;
    return sortRows(rows, column.sortValue, sort.direction);
  }, [rows, columns, sort, controlled]);

  // Only the first rows are drawn (a few thousand rows made the screen slow); the window starts again when the first row changes.
  const firstKey = sorted.length > 0 ? rowKey(sorted[0]!) : '';
  const [win, setWin] = useState({ first: firstKey, rows: windowRows });
  if (win.first !== firstKey) setWin({ first: firstKey, rows: windowRows });
  const selectedIndex = selectedKey === null ? -1 : sorted.findIndex((row) => rowKey(row) === selectedKey);
  const shown = shownCount(sorted.length, win.first === firstKey ? win.rows : windowRows, selectedIndex);
  const visible = virtual ? sorted : shown < sorted.length ? sorted.slice(0, shown) : sorted;

  // Long-table mode: the first row in view (whole rows only, so scrolling draws again once per row) and the highlighted row.
  const tableId = useId();
  const [topRow, setTopRow] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowHeight = virtual?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const viewHeight = virtual?.height ?? VIRTUAL_DEFAULT_HEIGHT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The scrolling area has a fixed height (set through the CSSOM: the page's style rules do not allow style attributes).
  const setScrollArea = (element: HTMLDivElement | null): void => {
    scrollRef.current = element;
    if (element) element.style.height = `${viewHeight}px`;
  };
  const windowOfRows = virtual ? visibleWindow(topRow * rowHeight, viewHeight - VIRTUAL_HEADER_HEIGHT, rowHeight, sorted.length) : null;
  const rowDomId = (index: number): string => `${tableId}-row-${index}`;
  const activeRow = virtual && activeIndex >= 0 && activeIndex < sorted.length ? sorted[activeIndex] : undefined;

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const next = Math.floor(element.scrollTop / rowHeight);
    setTopRow((current) => (current === next ? current : next));
    if (onNearEnd && next + Math.ceil(viewHeight / rowHeight) + NEAR_END_ROWS >= sorted.length) onNearEnd();
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLTableElement>): void => {
    // Keys pressed on a header button belong to that button.
    if (event.target !== event.currentTarget || sorted.length === 0) return;
    if (isListKey(event.key)) {
      event.preventDefault();
      const page = Math.max(1, Math.floor((viewHeight - VIRTUAL_HEADER_HEIGHT) / rowHeight) - 1);
      const next = moveIndex(activeIndex, event.key, sorted.length, page);
      setActiveIndex(next);
      const element = scrollRef.current;
      if (element) element.scrollTop = scrollTopToShow(next, element.scrollTop, viewHeight, rowHeight, VIRTUAL_HEADER_HEIGHT);
    } else if (event.key === 'Enter' && activeRow !== undefined) {
      event.preventDefault();
      onRowClick?.(activeRow);
    } else if (event.key === ' ' && activeRow !== undefined) {
      event.preventDefault();
      (onRowToggle ?? onRowClick)?.(activeRow);
    }
  };

  const sortedColumn = sort ? columns.find((c) => c.key === sort.columnKey) : undefined;
  const announcement = sort && sortedColumn ? `Sorted by ${sortedColumn.header}, ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : '';
  const widthOf = (column: Column<T>): number | undefined => column.width;

  const body = (rowsToDraw: readonly T[], firstIndex: number) =>
    rowsToDraw.map((row, offset) => {
      const index = firstIndex + offset;
      const classes = `${onRowClick ? 'is-clickable' : ''}${selectedKey !== null && rowKey(row) === selectedKey ? ' is-selected' : ''}${virtual && index === activeIndex ? ' is-active' : ''}`.trim();
      return (
        <tr
          key={rowKey(row)}
          id={virtual ? rowDomId(index) : undefined}
          aria-rowindex={virtual ? index + 2 : undefined}
          className={classes || undefined}
          onClick={
            onRowClick || virtual
              ? () => {
                  if (virtual) setActiveIndex(index);
                  onRowClick?.(row);
                }
              : undefined
          }
        >
          {columns.map((column) => {
            const cls = `${column.align === 'end' ? 'is-end' : ''} ${column.className ?? ''}`.trim();
            return column.rowHeader ? (
              <th key={column.key} scope="row" className={cls || undefined}>
                {column.render(row)}
              </th>
            ) : (
              <td key={column.key} className={cls || undefined}>
                {column.render(row)}
              </td>
            );
          })}
        </tr>
      );
    });

  const head = (
    <thead>
      <tr>
        {columns.map((column) => {
          const cls = `${column.align === 'end' ? 'is-end' : ''} ${column.className ?? ''}`.trim();
          if (!isSortable(column)) {
            return (
              <th key={column.key} scope="col" className={cls || undefined}>
                {column.header}
              </th>
            );
          }
          const direction = sort?.columnKey === column.key ? sort.direction : null;
          return (
            <th key={column.key} scope="col" aria-sort={ariaSort(sort, column.key)} className={cls || undefined}>
              <button type="button" className="sort-button" onClick={() => (onSortChange ? onSortChange(column.key) : setSort((current) => nextSort(current, column.key)))}>
                {column.header}
                <SortArrow direction={direction} />
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );

  if (virtual && windowOfRows) {
    return (
      <div className="table-scroll table-scroll--virtual" ref={setScrollArea} onScroll={onScroll}>
        <div className="table-scroll__sizer" ref={cssVarRef('--row-height', `${rowHeight}px`)}>
          <table
            className="data-table data-table--virtual data-table--sticky"
            role="grid"
            tabIndex={0}
            aria-rowcount={sorted.length + 1}
            aria-activedescendant={activeRow !== undefined ? rowDomId(activeIndex) : undefined}
            onKeyDown={onGridKeyDown}
            onFocus={(event) => {
              if (event.target === event.currentTarget && activeIndex < 0 && sorted.length > 0) setActiveIndex(0);
            }}
          >
            <caption className="sr-only">{caption}</caption>
            <colgroup>
              {columns.map((column) => {
                const width = widthOf(column);
                return <col key={column.key} ref={width === undefined ? undefined : widthPxRef(width)} />;
              })}
            </colgroup>
            {head}
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="data-table__empty">
                    {emptyText}
                  </td>
                </tr>
              ) : (
                <>
                  <tr aria-hidden="true" className="data-table__pad">
                    <td colSpan={columns.length} ref={heightPxRef(windowOfRows.padTop)} />
                  </tr>
                  {body(visible.slice(windowOfRows.start, windowOfRows.end), windowOfRows.start)}
                  <tr aria-hidden="true" className="data-table__pad">
                    <td colSpan={columns.length} ref={heightPxRef(windowOfRows.padBottom)} />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className={`data-table${stickyHeader ? ' data-table--sticky' : ''}`}>
        <caption className="sr-only">{caption}</caption>
        {head}
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="data-table__empty">
                {emptyText}
              </td>
            </tr>
          ) : (
            body(visible, 0)
          )}
          {shown < sorted.length ? (
            <tr>
              <td colSpan={columns.length} className="data-table__more">
                <span>
                  Showing {shown.toLocaleString()} of {sorted.length.toLocaleString()}.{' '}
                </span>
                <Button variant="quiet" size="sm" onClick={() => setWin({ first: firstKey, rows: nextWindow(sorted.length, shown, windowRows) })}>
                  Show {Math.min(windowRows, sorted.length - shown).toLocaleString()} more
                </Button>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
