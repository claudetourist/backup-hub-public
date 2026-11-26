/**
 * Which phone places are plugged in right now. adb says which serials are ready (state "device"); a phone place knows its serial in
 * identity_json (written when the person says which backup the phone is for). Pure: no adb, no database.
 */

/** The serial stored in a place's identity_json, trimmed, or null when there is none (or the text is not an object). */
export function phoneSerialOf(identityJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(identityJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const serial = (parsed as { serial?: unknown }).serial;
    return typeof serial === 'string' && serial.trim() !== '' ? serial.trim() : null;
  } catch {
    return null;
  }
}

/** True when adb sees this phone place's serial. Without a stored serial, or without an answer from adb, it is false. */
export function phoneIsPlugged(identityJson: string, pluggedSerials: ReadonlySet<string> | null): boolean {
  if (pluggedSerials === null) return false;
  const serial = phoneSerialOf(identityJson);
  return serial !== null && pluggedSerials.has(serial);
}
