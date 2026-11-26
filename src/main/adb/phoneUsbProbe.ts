/**
 * Is a phone plugged into the PC? Asked of Windows (the Plug and Play list of devices that are present), never of adb: adb must stay stopped
 * while the person unplugs the phone. A USB device's instance id contains the serial number the phone reports (the same one adb shows).
 * Read only, one hidden PowerShell child process; the answer is true, false, or null (could not tell).
 */

const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

/** One number: how many present devices have this serial in their instance id. */
export function usbProbeCommand(serial: string): string {
  if (!SERIAL.test(serial)) throw new Error('Not a valid phone.');
  return `$ErrorActionPreference = "SilentlyContinue"; @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '*${serial}*' }).Count; exit 0`;
}

export function parseUsbProbe(output: string): boolean | null {
  const m = /^\s*(\d+)\s*$/m.exec(output);
  return m ? Number(m[1]) > 0 : null;
}

export async function usbPhonePlugged(run: (script: string) => Promise<string>, serial: string): Promise<boolean | null> {
  try {
    return parseUsbProbe(await run(usbProbeCommand(serial)));
  } catch {
    return null;
  }
}
