import { describe, expect, it } from 'vitest';
import { ariaSort, compareValues, nextSort, sortRows } from './sortRows';

interface Row {
  name: string;
  size: number | null;
}

const rows: Row[] = [
  { name: 'b', size: 20 },
  { name: 'a', size: null },
  { name: 'c', size: 5 },
  { name: 'd', size: 20 },
];

describe('compareValues', () => {
  it('sorts numbers numerically, not as text', () => {
    expect(compareValues(9, 10)).toBeLessThan(0);
  });
  it('sorts text naturally and case-insensitively', () => {
    expect(compareValues('file 2', 'file 10')).toBeLessThan(0);
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
  });
  it('puts missing values last', () => {
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues(1, undefined)).toBeLessThan(0);
    expect(compareValues(null, undefined)).toBe(0);
  });
});

describe('sortRows', () => {
  it('sorts ascending and keeps equal values in original order (stable)', () => {
    expect(sortRows(rows, (r) => r.size, 'asc').map((r) => r.name)).toEqual(['c', 'b', 'd', 'a']);
  });
  it('sorts descending but still keeps missing values last', () => {
    expect(sortRows(rows, (r) => r.size, 'desc').map((r) => r.name)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('does not mutate the input', () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.name, 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('sort state', () => {
  it('starts ascending on a new column and toggles on the same one', () => {
    const first = nextSort(null, 'size');
    expect(first).toEqual({ columnKey: 'size', direction: 'asc' });
    expect(nextSort(first, 'size').direction).toBe('desc');
    expect(nextSort(nextSort(first, 'size'), 'size').direction).toBe('asc');
    expect(nextSort(first, 'name')).toEqual({ columnKey: 'name', direction: 'asc' });
  });
  it('maps to aria-sort values', () => {
    expect(ariaSort(null, 'size')).toBe('none');
    expect(ariaSort({ columnKey: 'size', direction: 'asc' }, 'size')).toBe('ascending');
    expect(ariaSort({ columnKey: 'size', direction: 'desc' }, 'size')).toBe('descending');
    expect(ariaSort({ columnKey: 'size', direction: 'desc' }, 'name')).toBe('none');
  });
});
