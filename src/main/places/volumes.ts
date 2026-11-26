import path from 'node:path';
import { powershellArgs, runChild } from '../lifecycle/childProcesses';

/** One Windows volume as reported by `Get-CimInstance Win32_Volume`. */
export interface Volume {
  /** "E:" (upper case, with colon), or null for a volume with no letter. */
  letter: string | null;
  label: string;
  fileSystem: string | null;
  capacity: number | null;
  free: number | null;
  /** Win32_Volume.DriveType: 2 removable, 3 local disk, 4 network, 5 optical, 6 RAM disk. */
  driveType: number;
  /** Volume serial as 8 hex digits, or null when missing or zero. */
  serial: string | null;
}

export const DRIVE_TYPE_REMOVABLE = 2;
export const DRIVE_TYPE_FIXED = 3;

export class VolumeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VolumeParseError';
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function toLetter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^([A-Za-z]):?\\?$/.exec(value.trim());
  return m ? `${m[1]!.toUpperCase()}:` : null;
}

function toSerial(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const unsigned = value < 0 ? value + 2 ** 32 : value;
    if (unsigned === 0) return null;
    return Math.floor(unsigned).toString(16).toUpperCase().padStart(8, '0');
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || /^0+$/.test(text)) return null;
    if (/^\d+$/.test(text) && text.length > 8) return Number(text).toString(16).toUpperCase().padStart(8, '0');
    return text.toUpperCase();
  }
  return null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Parse PowerShell's `ConvertTo-Json` output. PowerShell prints a bare object (not an array) when
 * there is exactly one volume and nothing at all when there are none; both are accepted. Entries
 * that are not objects are skipped. Throws VolumeParseError when the text is not JSON at all.
 */
export function parseVolumes(raw: string): Volume[] {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VolumeParseError('The volume list was not readable JSON');
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const volumes: Volume[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const driveType = toNumber(o['DriveType']);
    volumes.push({
      letter: toLetter(o['DriveLetter']),
      label: toText(o['Label']) ?? '',
      fileSystem: toText(o['FileSystem']),
      capacity: toNumber(o['Capacity']),
      free: toNumber(o['FreeSpace']),
      driveType: driveType ?? 0,
      serial: toSerial(o['SerialNumber']),
    });
  }
  return volumes;
}

/** Read-only query. UTF-8 output so labels with accents survive. */
export const VOLUME_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Volume | Select-Object DriveLetter, Label, FileSystem, Capacity, FreeSpace, DriveType, SerialNumber | ConvertTo-Json -Compress';

export interface ListVolumesOptions {
  timeoutMs?: number;
}

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** List the Windows volumes through a hidden PowerShell. Rejects on timeout or failure. */
export function listVolumes(options: ListVolumesOptions = {}): Promise<Volume[]> {
  return runChild(powershellPath(), powershellArgs(VOLUME_COMMAND), { timeoutMs: options.timeoutMs ?? 20_000, maxBuffer: 4 * 1024 * 1024 }).then(
    ({ stdout }) => parseVolumes(stdout),
    (error: Error) => {
      throw new Error(`Could not list the drives (${error.message.split('\n')[0] ?? 'unknown error'})`);
    },
  );
}
