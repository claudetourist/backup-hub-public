/**
 * Disk errors Windows logged in the last 30 days: the System log's `disk` and `Ntfs` errors (a bad block, a retried or failed read or write,
 * a file system corruption, a surprise removal). Read only, in a hidden PowerShell child process (never the window's thread). An event names
 * a disk number (\Device\Harddisk2\DR2, "Disk 2") or a volume ("volume E:"); one that names neither counts for no drive.
 */
export const DISK_EVENT_DAYS = 30;

export const DISK_EVENT_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  "try { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'disk', 'Ntfs'; Id = 7, 11, 15, 51, 52, 55, 98, 130, 133, 140, 153, 157; StartTime = (Get-Date).AddDays(-" +
  DISK_EVENT_DAYS +
  ') } -MaxEvents 500 -ErrorAction Stop | ' +
  'ForEach-Object { [pscustomobject]@{ Id = [int]$_.Id; Message = [string]$_.Message } } | ConvertTo-Json -Compress } ' +
  // `exit 0`: with no matching events the failed Get-WinEvent would otherwise make PowerShell exit 1, though nothing is wrong.
  "catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }; exit 0";

export interface DiskEvent {
  id: number;
  /** The disk number the message names, else null. */
  disk: number | null;
  /** The drive letter the message names ("E:"), else null. */
  letter: string | null;
}

/** Parses what the command printed. Nothing printed = no events. Throws when the text is not JSON. */
export function parseDiskEvents(raw: string): DiskEvent[] {
  const text = raw.replace(/^\u{FEFF}/u, '').trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The disk event list was not readable JSON');
  }
  const out: DiskEvent[] = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['Id'] !== 'number') continue;
    const message = typeof o['Message'] === 'string' ? o['Message'] : '';
    const disk = /Harddisk(\d+)/i.exec(message) ?? /\bDisk\s+(\d+)\b/i.exec(message);
    const letter = /\bvolume\s+([A-Za-z]):/i.exec(message) ?? /\(([A-Za-z]):\)/.exec(message);
    out.push({ id: o['Id'], disk: disk ? Number(disk[1]) : null, letter: letter ? letter[1]!.toUpperCase() + ':' : null });
  }
  return out;
}

/** How many events belong to each drive letter: by the volume it names, else by the disk it names (every letter on that disk). */
export function eventsPerLetter(events: readonly DiskEvent[], letters: readonly { letter: string; disk: number | null }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { letter } of letters) out.set(letter, 0);
  for (const event of events) {
    const targets = event.letter !== null ? letters.filter((l) => l.letter === event.letter) : event.disk !== null ? letters.filter((l) => l.disk === event.disk) : [];
    for (const target of targets) out.set(target.letter, (out.get(target.letter) ?? 0) + 1);
  }
  return out;
}
