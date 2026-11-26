/**
 * "This drive is having USB trouble". Reads (never writes) the Windows System log for two kinds of events that a flaky USB
 * disk leaves behind: Event 153 from `disk` ("The IO operation at logical block address ... for Disk 2 was retried") and
 * Event 129 from `UASPStor` ("Reset to device, \Device\RaidPort2, was issued"). A drive with such an event in the last 30
 * minutes is "having USB trouble": no job starts on it (the per-drive start gate) and Places and the plan say so.
 *
 * Event 153 names the physical disk, which is matched to the drive through `disks.ts`. Event 129 names only a port, so it
 * marks every connected drive on the USB bus (the safe reading). It clears by itself 30 minutes after the last event.
 */
import { USB_TROUBLE_WINDOW_MS } from '../../shared/plans';
import type { DiskLetter } from './disks';

export interface UsbEvent {
  /** Epoch ms. */
  at: number;
  id: number;
  /** The disk number named in the message (event 153), else null. */
  disk: number | null;
}

/** Read only: the two events of the last half hour, as compact JSON (one object or an array). */
export const USB_EVENT_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  "try { Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 153, 129; StartTime = (Get-Date).AddMinutes(-30) } -ErrorAction Stop | " +
  'Where-Object { ($_.Id -eq 153 -and $_.ProviderName -eq \'disk\') -or ($_.Id -eq 129 -and $_.ProviderName -eq \'UASPStor\') } | ' +
  'ForEach-Object { [pscustomobject]@{ At = [int64]([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(); Id = [int]$_.Id; Message = [string]$_.Message } } | ' +
  // `exit 0`: with no matching events the failed Get-WinEvent would otherwise make PowerShell exit 1, though nothing is wrong.
  'ConvertTo-Json -Compress } catch { if ($_.FullyQualifiedErrorId -notlike \'NoMatchingEventsFound*\') { throw } }; exit 0';

/** Parses what the command printed. Nothing printed = no events. Throws when the text is not JSON. */
export function parseUsbEvents(raw: string): UsbEvent[] {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The USB event list was not readable JSON');
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: UsbEvent[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const at = o['At'];
    const id = o['Id'];
    if (typeof at !== 'number' || (id !== 153 && id !== 129)) continue;
    const m = id === 153 && typeof o['Message'] === 'string' ? /\bDisk\s+(\d+)\b/i.exec(o['Message']) : null;
    out.push({ at, id, disk: m ? Number(m[1]) : null });
  }
  return out;
}

export interface UsbHealthDeps {
  readEvents(): Promise<UsbEvent[]>;
  /** Plugged-in named drives (root like "E:\"). */
  drives(): { placeId: string; label: string; root: string }[];
  /** Which disk each letter is on. */
  disks(): Promise<DiskLetter[]>;
  now?: () => number;
  log?: { warn(...args: unknown[]): void; info(...args: unknown[]): void };
}

/** Which connected drives have USB trouble right now. `check()` reads the log; `troubleFor` answers from the last check. */
export class UsbHealth {
  private readonly now: () => number;
  private trouble = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: UsbHealthDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Reads the log now and updates every drive's state. A failed read keeps the earlier answer (nothing is guessed). */
  check(): Promise<void> {
    this.inflight ??= this.doCheck().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doCheck(): Promise<void> {
    const now = this.now();
    let events: UsbEvent[];
    try {
      events = (await this.deps.readEvents()).filter((e) => now - e.at <= USB_TROUBLE_WINDOW_MS);
    } catch (err) {
      this.deps.log?.warn('usb health: could not read the System log', err);
      return;
    }
    const drives = this.deps.drives();
    const next = new Map<string, number>();
    if (events.length > 0 && drives.length > 0) {
      let letters: DiskLetter[] = [];
      try {
        letters = await this.deps.disks();
      } catch (err) {
        this.deps.log?.warn('usb health: could not read which disk each drive is on', err);
      }
      for (const drive of drives) {
        const letter = drive.root.slice(0, 2).toUpperCase();
        const disk = letters.find((l) => l.letter === letter);
        // Without the disk map nothing is known about which drive it was, so every connected drive is held back.
        const hit = events.filter((e) => (e.disk !== null ? disk === undefined || disk.diskNumber === e.disk : disk === undefined || disk.busType === 'USB'));
        if (hit.length > 0) next.set(drive.placeId, Math.max(...hit.map((e) => e.at)));
      }
    }
    for (const id of next.keys()) if (!this.trouble.has(id)) this.deps.log?.warn(`usb health: ${id} is having USB trouble`);
    this.trouble = next;
  }

  /** The plain line when the drive had a USB error in the last 30 minutes, else null. Answers from the last check. */
  troubleFor(placeId: string): string | null {
    const at = this.trouble.get(placeId);
    if (at === undefined || this.now() - at > USB_TROUBLE_WINDOW_MS) return null;
    return 'This drive is having USB trouble: check it before using it.';
  }

  /** True when this drive had a USB error AFTER `sinceMs` (a copy that was told Continue only reacts to new trouble). Answers from the last check. */
  troubleSince(placeId: string, sinceMs: number): boolean {
    const at = this.trouble.get(placeId);
    return at !== undefined && at > sinceMs;
  }

  troubled(): string[] {
    return [...this.trouble.keys()].filter((id) => this.troubleFor(id) !== null);
  }

  /** Every 5 minutes while a named drive is connected. */
  start(everyMs = 5 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.deps.drives().length > 0) void this.check();
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
