/**
 * The phone's cable connection, shared by main, preload and the Free up phone space screen. Pure data and pure functions only.
 * Nothing on the phone is ever changed by reading its status.
 */

/** What is looked at unless the person picks other folders (the same ones the old PhoneBackup protected). */
export const DEFAULT_PHONE_FOLDERS: readonly string[] = [
  '/sdcard/DCIM',
  '/sdcard/Pictures',
  '/sdcard/Movies',
  '/sdcard/Download',
  '/sdcard/Recordings',
  '/sdcard/Documents',
  '/sdcard/Music',
  '/sdcard/Android/media/com.whatsapp/WhatsApp/Media',
];

export interface PhoneDevice {
  serial: string;
  /** "Poco F4" from adb, or the serial when adb does not say. */
  model: string;
  /** adb's word: device (ready), unauthorized (tap Allow on the phone), offline. */
  state: string;
}

export type PhoneStatus = { adb: 'missing' } | { adb: 'ready'; devices: PhoneDevice[] };

export interface PhoneEjectResult {
  ok: boolean;
  message: string;
}
