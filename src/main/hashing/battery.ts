import { runPowerShell } from '../listing/powershell';
import type { PowerReading } from './pure';

/** Where the job asks about power. Tests pass fakes. */
export interface PowerSource {
  read(): Promise<PowerReading>;
}

/** Electron's powerMonitor knows "on battery" but not the charge, so the charge comes from Windows. */
const CHARGE_SCRIPT = `(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining)`;

/** Parses the helper's output: a whole number 0 to 100, else null (no battery, or no answer). */
export function parseCharge(output: string): number | null {
  const m = /^\s*(\d{1,3})\s*$/.exec(output);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * The real power source. `isOnBattery` comes from Electron's powerMonitor. The charge is read with a
 * read-only Windows query, and only while on battery, at most once a minute.
 */
export function windowsPowerSource(isOnBattery: () => boolean, readOutput: () => Promise<string> = () => runPowerShell(CHARGE_SCRIPT, { timeoutMs: 10_000 }), now: () => number = Date.now): PowerSource {
  let cached: { at: number; percent: number | null } | null = null;
  return {
    async read() {
      const onBattery = isOnBattery();
      if (!onBattery) return { onBattery: false, percent: null };
      if (!cached || now() - cached.at > 60_000) {
        let percent: number | null = null;
        try {
          percent = parseCharge(await readOutput());
        } catch {
          percent = null;
        }
        cached = { at: now(), percent };
      }
      return { onBattery: true, percent: cached.percent };
    },
  };
}
