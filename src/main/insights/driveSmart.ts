import type { SmartState } from '../../shared/insights';

/**
 * What Windows says about a disk's own health, per drive letter. Read only, from Get-PhysicalDisk and Get-StorageReliabilityCounter,
 * run in a hidden PowerShell child process (never on the window's thread). Many USB drives do not pass their health on: then the
 * answer is "could not tell", which is fine and is never shown as a problem.
 */

/** One object per drive letter, as compact JSON (a single object, an array, or nothing). */
export const SMART_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = "SilentlyContinue"; ' +
  '$disks = @(Get-PhysicalDisk); ' +
  'Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { ' +
  '$n = [int]$_.DiskNumber; $pd = $disks | Where-Object { [int]$_.DeviceId -eq $n } | Select-Object -First 1; ' +
  'if ($pd) { $rc = $pd | Get-StorageReliabilityCounter; ' +
  '[pscustomobject]@{ Letter = [string]$_.DriveLetter; Disk = $n; Health = [string]$pd.HealthStatus; Operational = [string]($pd.OperationalStatus -join ","); ' +
  'Wear = $rc.Wear; ReadErrors = $rc.ReadErrorsUncorrected; WriteErrors = $rc.WriteErrorsUncorrected } } } | ' +
  'ConvertTo-Json -Compress; exit 0';

export interface SmartReading {
  /** "E:" */
  letter: string;
  /** The Windows disk number it is on (what the event log names), or null. */
  disk: number | null;
  state: SmartState;
  note: string;
}

const COULD_NOT_TELL = 'Windows could not tell how healthy this disk is';

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The state and the plain line for one disk. Warnings win over "healthy"; anything unreadable is "could not tell". */
export function smartOf(health: string, operational: string, wear: number | null, readErrors: number | null, writeErrors: number | null): { state: SmartState; note: string } {
  const h = health.trim().toLowerCase();
  const op = operational.toLowerCase();
  if (h === 'unhealthy' || op.includes('predictive') || op.includes('failure')) return { state: 'bad', note: 'Windows says this disk is failing. Copy what matters off it soon' };
  if (h === 'warning' || op.includes('degraded') || op.includes('lost communication')) return { state: 'warning', note: 'Windows warns about this disk. Check the cable, and keep a second copy' };
  if ((readErrors ?? 0) > 0 || (writeErrors ?? 0) > 0) return { state: 'warning', note: 'This disk has had read or write errors it could not fix' };
  if (wear !== null && wear >= 90) return { state: 'warning', note: 'This disk is worn out (' + Math.round(wear) + '% of its life used)' };
  if (h === 'healthy') return { state: 'good', note: 'Windows says this disk is healthy' };
  return { state: 'unknown', note: COULD_NOT_TELL };
}

/**
 * Parses what the command printed. Nothing printed = nothing known. Entries without a usable letter are skipped; the first entry of a
 * letter wins. Throws only when the text is not JSON.
 */
export function parseSmart(raw: string): SmartReading[] {
  const text = raw.replace(/^\u{FEFF}/u, '').trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The disk health list was not readable JSON');
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: SmartReading[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const letter = typeof o['Letter'] === 'string' ? /^([A-Za-z]):?$/.exec(o['Letter'].trim()) : null;
    if (!letter) continue;
    const key = letter[1]!.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const { state, note } = smartOf(typeof o['Health'] === 'string' ? o['Health'] : '', typeof o['Operational'] === 'string' ? o['Operational'] : '', numberOf(o['Wear']), numberOf(o['ReadErrors']), numberOf(o['WriteErrors']));
    out.push({ letter: key + ':', disk: typeof o['Disk'] === 'number' && Number.isInteger(o['Disk']) ? o['Disk'] : null, state, note });
  }
  return out;
}

export const SMART_UNKNOWN: { state: SmartState; note: string } = { state: 'unknown', note: COULD_NOT_TELL };
