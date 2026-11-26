/** Pure sorting for DataTable. Stable, missing values always last, numbers numerically, text by locale. */

export type SortValue = string | number | null | undefined;
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnKey: string;
  direction: SortDirection;
}

function isMissing(value: SortValue): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}

/** One shared collator: building one per comparison made sorting 100,000 text rows take ten seconds. */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Compares two texts the way people sort names: "file2" before "file10", capital letters ignored. */
export function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

export function compareValues(a: SortValue, b: SortValue): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return COLLATOR.compare(String(a), String(b));
}

/** Returns a new array; the input is never mutated. Missing values stay last in both directions. */
export function sortRows<T>(rows: readonly T[], sortValue: (row: T) => SortValue, direction: SortDirection): T[] {
  const indexed = rows.map((row, index) => ({ row, index, value: sortValue(row) }));
  indexed.sort((x, y) => {
    let result = compareValues(x.value, y.value);
    if (!isMissing(x.value) && !isMissing(y.value) && direction === 'desc') result = -result;
    return result !== 0 ? result : x.index - y.index;
  });
  return indexed.map((entry) => entry.row);
}

/** Click cycle on one column: asc then desc then asc. A different column starts at asc. */
export function nextSort(current: SortState | null, columnKey: string): SortState {
  if (current?.columnKey === columnKey) {
    return { columnKey, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { columnKey, direction: 'asc' };
}

export function ariaSort(current: SortState | null, columnKey: string): 'ascending' | 'descending' | 'none' {
  if (current?.columnKey !== columnKey) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}
