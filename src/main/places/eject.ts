import type { JobState } from '../../shared/jobs';
import type { EjectResult } from '../../shared/places';

/**
 * "Eject" for a plugged-in named drive. Stops the jobs that use it (after the person said yes), waits for them to let go,
 * then asks Windows to eject it exactly like the "Eject" entry in Explorer (Shell.Application, no admin needed). Windows keeps
 * the last word: if something still holds the drive it refuses, and the answer says so in plain words, naming the program
 * when the Windows log (Kernel-PnP event 225) says which. Nothing is ever forced or dismounted.
 */
export interface EjectJobs {
  list(filter: { states: JobState[] }): { id: number; kind: string; title: string }[];
  params(id: number): unknown;
  /** The app stops a job by itself and says why (the reason is shown; it is never written as "by you"). */
  cancelByApp(id: number, reason: string): boolean;
}

export interface EjectDrive {
  placeId: string;
  label: string;
  /** "F:\\" */
  root: string;
}

export interface EjectDeps {
  /** The named drives plugged in right now. */
  drives(): EjectDrive[];
  /** Looks at the attached volumes again (the drive list is refreshed). */
  refresh(): Promise<unknown>;
  jobs: EjectJobs;
  /** Runs a PowerShell script and returns what it printed. */
  powershell(script: string, timeoutMs: number): Promise<string>;
  /** True while the drive's root can still be opened. */
  stillThere(root: string): Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Test knobs. */
  settleMs?: number;
  waitMs?: number;
}

/** Jobs of these kinds work through every plugged-in drive, whatever their parameters say. */
const ALL_DRIVES_KINDS = new Set<string>(['settings.saveToDrive', 'clean.laptop']);

/** The jobs (waiting, running or asking) that use this drive. */
export function jobsUsing(jobs: EjectJobs, drive: EjectDrive): { id: number; title: string }[] {
  const out: { id: number; title: string }[] = [];
  for (const job of jobs.list({ states: ['queued', 'running', 'needs_you'] })) {
    const text = JSON.stringify(jobs.params(job.id) ?? {});
    const named = text.includes(drive.placeId);
    // A fingerprint job without a place works through every connected place.
    const everything = job.kind === 'hash.files' && !/"placeId"\s*:/.test(text);
    if (named || everything || ALL_DRIVES_KINDS.has(job.kind)) out.push({ id: job.id, title: job.title });
  }
  return out;
}

/** The script that asks Windows to eject one lettered drive. Only a letter this module found itself ever reaches it. */
export function ejectScript(letter: string): string {
  if (!/^[A-Z]:$/.test(letter)) throw new Error('Not a drive letter');
  return (
    "$ErrorActionPreference = 'Stop'; " +
    '$shell = New-Object -ComObject Shell.Application; ' +
    `$item = $shell.Namespace(17).ParseName('${letter}\\'); ` +
    "if ($null -eq $item) { 'NOITEM' } else { $item.InvokeVerb('Eject'); 'SENT' }"
  );
}

/** The latest "stopped the removal or ejection" events (Kernel-PnP 225), newest first, one line each. */
export const VETO_SCRIPT =
  "$ErrorActionPreference = 'SilentlyContinue'; " +
  "Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Kernel-PnP/Configuration'; Id = 225; StartTime = (Get-Date).AddMinutes(-3) } -MaxEvents 5 | " +
  "ForEach-Object { ($_.Message -replace '\\r?\\n', ' ') }";

/** What `programFromVeto` returns when the blocker is Windows itself (the "System" process, id 4). */
export const WINDOWS_ITSELF = 'System';

/** The program named in a Kernel-PnP 225 message ("The application <path> with process id N stopped the removal ..."), or null. */
export function programFromVeto(text: string): string | null {
  const m = /The application\s+(.+?)\s+with process id\s+(\d+)\s+stopped the removal or ejection/i.exec(text);
  if (!m) return null;
  // Process 4 is "System": Windows itself (cached writes, indexing, a scan), not a program the person can close.
  if (m[2] === '4' || /^system$/i.test(m[1]!.trim())) return WINDOWS_ITSELF;
  const exe = m[1]!.split(/[\\/]/).pop() ?? '';
  return exe === '' ? null : exe;
}

/** The first program named by the latest veto lines. */
export function blockingProgram(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const program = programFromVeto(line);
    if (program !== null) return program;
  }
  return null;
}

export const NOT_FOUND_MESSAGE = 'That drive is not plugged in any more, so there is nothing to eject.';

export function blockedLine(label: string, program: string | null): string {
  if (program === WINDOWS_ITSELF) return `Windows did not let ${label} go. Windows itself is still using the drive (for example writing cached data or scanning it). Wait a minute and try again.`;
  const who = program === null ? 'A program' : /^backuphub\.exe$/i.test(program) ? 'Backup Hub itself' : `The program ${program}`;
  return `Windows did not let ${label} go. ${who} still has it open. Nothing was forced and nothing was lost. Close that program and choose Eject again, or use the "Safely remove" icon in the taskbar.`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EjectService {
  constructor(private readonly deps: EjectDeps) {}

  async eject(placeId: string, confirmed: boolean): Promise<EjectResult> {
    const { deps } = this;
    const now = deps.now ?? Date.now;
    const drive = deps.drives().find((d) => d.placeId === placeId);
    if (!drive) return { ok: false, message: NOT_FOUND_MESSAGE, blockedBy: null };
    const letter = drive.root.slice(0, 2).toUpperCase();
    if (!/^[A-Z]:$/.test(letter)) {
      return { ok: false, message: `${drive.label} does not have a drive letter, so Backup Hub cannot eject it. Use the "Safely remove" icon in the taskbar.`, blockedBy: null };
    }
    const sleep = deps.sleep ?? defaultSleep;

    const busy = jobsUsing(deps.jobs, drive);
    if (busy.length > 0) {
      if (!confirmed) {
        const them = busy.length === 1 ? 'it' : 'them';
        return {
          ok: false,
          needsConfirm: true,
          jobs: busy,
          message: `Backup Hub is still working with ${drive.label}: ${busy.map((j) => j.title).join('; ')}. Stop ${them} and eject? Nothing is lost; you can start ${them} again later.`,
        };
      }
      for (const job of busy) deps.jobs.cancelByApp(job.id, `it was using ${drive.label}, which you chose to eject`);
      deps.log.info(`eject: stopped ${busy.length} job(s) using ${drive.label}`);
      // The jobs close their files as soon as they see the stop.
      await sleep(deps.settleMs ?? 1500);
    }

    const sentAt = now();
    let sent: string;
    try {
      sent = (await deps.powershell(ejectScript(letter), 20_000)).trim();
    } catch (err) {
      deps.log.warn(`eject: could not ask Windows to eject ${drive.label}`, err);
      return { ok: false, message: `Backup Hub could not ask Windows to eject ${drive.label}. Use the "Safely remove" icon in the taskbar.`, blockedBy: null };
    }
    if (sent !== 'SENT') {
      return { ok: false, message: `Windows has no Eject for ${drive.label}. Use the "Safely remove" icon in the taskbar.`, blockedBy: null };
    }

    // Windows answers by itself: the drive letter goes away when it let go.
    const deadline = sentAt + (deps.waitMs ?? 10_000);
    for (;;) {
      await sleep(500);
      if (!(await deps.stillThere(drive.root))) {
        await deps.refresh().catch(() => undefined);
        deps.log.info(`eject: ${drive.label} was ejected`);
        return { ok: true, message: `${drive.label} can be unplugged now.` };
      }
      if (now() >= deadline) break;
    }
    let program: string | null = null;
    try {
      program = blockingProgram(await deps.powershell(VETO_SCRIPT, 15_000));
    } catch {
      // The log could not be read: the plain line below still says what happened.
    }
    deps.log.warn(`eject: Windows did not eject ${drive.label}${program ? ` (${program} has it open)` : ''}`);
    return { ok: false, message: blockedLine(drive.label, program), blockedBy: program };
  }
}
