import { describe, expect, it } from 'vitest';
import { parseSmart, smartOf } from './driveSmart';

describe('disk health from Windows (fake PowerShell output)', () => {
  it('reads a list of drives and says good, warning, bad or could-not-tell in plain words', () => {
    const raw = JSON.stringify([
      { Letter: 'E', Health: 'Healthy', Operational: 'OK', Wear: null, ReadErrors: 0, WriteErrors: 0 },
      { Letter: 'F', Health: 'Warning', Operational: 'OK', Wear: null, ReadErrors: null, WriteErrors: null },
      { Letter: 'G', Health: 'Unhealthy', Operational: 'Predictive Failure', Wear: null, ReadErrors: null, WriteErrors: null },
      { Letter: 'H', Health: '', Operational: '', Wear: null, ReadErrors: null, WriteErrors: null },
    ]);
    expect(parseSmart(raw).map((r) => [r.letter, r.state])).toEqual([['E:', 'good'], ['F:', 'warning'], ['G:', 'bad'], ['H:', 'unknown']]);
    expect(parseSmart(raw)[3]!.note).toBe('Windows could not tell how healthy this disk is');
  });

  it('accepts one bare object, a BOM, nothing at all, and skips entries without a letter; the first of a letter wins', () => {
    expect(parseSmart('\u{FEFF}{"Letter":"d","Health":"Healthy","Operational":"OK"}')).toEqual([{ letter: 'D:', disk: null, state: 'good', note: 'Windows says this disk is healthy' }]);
    expect(parseSmart('')).toEqual([]);
    expect(parseSmart('  \n')).toEqual([]);
    const two = parseSmart(JSON.stringify([{ Health: 'Healthy' }, { Letter: 'E', Health: 'Healthy' }, { Letter: 'E:', Health: 'Unhealthy' }, 5, null]));
    expect(two.map((r) => [r.letter, r.state])).toEqual([['E:', 'good']]);
  });

  it('throws on text that is not JSON (the caller then says "could not tell")', () => {
    expect(() => parseSmart('Get-PhysicalDisk : not available')).toThrow(/not readable/);
  });

  it('a healthy disk with unfixed errors or a worn-out SSD is a warning', () => {
    expect(smartOf('Healthy', 'OK', null, 3, 0).state).toBe('warning');
    expect(smartOf('Healthy', 'OK', null, 0, 1).state).toBe('warning');
    expect(smartOf('Healthy', 'OK', 95, 0, 0).note).toContain('95%');
    expect(smartOf('Healthy', 'OK', 40, 0, 0).state).toBe('good');
    expect(smartOf('Healthy', 'Lost Communication', null, null, null).state).toBe('warning');
  });
});
