import path from 'node:path';
import { powershellArgs, runChild } from '../lifecycle/childProcesses';

/** One drive letter and the physical disk it lives on, from `Get-Partition` + `Get-Disk`. */
export interface DiskLetter {
  /** "D:" (upper case, with colon). */
  letter: string;
  diskNumber: number;
  /** "SATA", "NVMe", "USB", "SCSI"... or null when Windows did not say. */
  busType: string | null;
}

function toLetter(value: unknown): string | null {
  if (typeof value === 'number' && value >= 65 && value <= 122) value = String.fromCharCode(value);
  if (typeof value !== 'string') return null;
  const m = /^([A-Za-z]):?\\?$/.exec(value.trim());
  return m ? `${m[1]!.toUpperCase()}:` : null;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Parse PowerShell's `ConvertTo-Json` output for the letter-to-disk query. A single partition comes
 * out as a bare object, none at all as empty output; both are accepted. Entries without a usable
 * letter or disk number are skipped. Throws when the text is not JSON.
 */
export function parseDiskLetters(raw: string): DiskLetter[] {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The disk list was not readable JSON');
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: DiskLetter[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const letter = toLetter(o['DriveLetter']);
    const diskNumber = toInt(o['DiskNumber']);
    if (!letter || diskNumber === null || seen.has(letter)) continue;
    seen.add(letter);
    const bus = o['BusType'];
    out.push({ letter, diskNumber, busType: typeof bus === 'string' && bus.trim() !== '' ? bus.trim() : null });
  }
  return out;
}

export interface SystemDisk {
  diskNumber: number;
  busType: string | null;
  /** Every drive letter on the same physical disk as the system drive, the system drive included. */
  letters: string[];
}

/**
 * The physical disk Windows runs from and every letter on it (C:, and on this laptop D: and E:).
 * Null when the system drive is not in the list, so nothing is guessed.
 */
export function systemDiskOf(letters: readonly DiskLetter[], systemDrive: string): SystemDisk | null {
  const system = letters.find((l) => l.letter === systemDrive.toUpperCase());
  if (!system) return null;
  return {
    diskNumber: system.diskNumber,
    busType: system.busType,
    letters: letters
      .filter((l) => l.diskNumber === system.diskNumber)
      .map((l) => l.letter)
      .toSorted(),
  };
}

/** Read-only query: one call, partitions with a letter joined to their disk's bus type. */
export const DISK_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  '$bus = @{}; Get-Disk | ForEach-Object { $bus[[int]$_.Number] = [string]$_.BusType }; ' +
  'Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { ' +
  '[pscustomobject]@{ DriveLetter = [string]$_.DriveLetter; DiskNumber = [int]$_.DiskNumber; BusType = $bus[[int]$_.DiskNumber] } } | ' +
  'ConvertTo-Json -Compress';

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Run the disk query through a hidden PowerShell. Rejects on timeout or failure. */
export function listDiskLetters(timeoutMs = 30_000): Promise<DiskLetter[]> {
  return runChild(powershellPath(), powershellArgs(DISK_COMMAND), { timeoutMs, maxBuffer: 4 * 1024 * 1024 }).then(
    ({ stdout }) => parseDiskLetters(stdout),
    (error: Error) => {
      throw new Error(`Could not read which disk each drive is on (${error.message.split('\n')[0] ?? 'unknown error'})`);
    },
  );
}
