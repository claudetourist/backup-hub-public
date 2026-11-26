/**
 * Where a phone file lands on the drive (v3_engine.py 366-385 and 923-925), with the rules of section 4 rule 7 for names Windows cannot
 * store. Pure.
 *
 * <backup folder>/<prefix>-DDMonYY/<mapped path>. The mapped path is the phone path without "/sdcard/", with the four Android data
 * remaps (Sound Recorder, Call Recordings, Notes). A name Windows cannot store is cleaned, and a cleaned name carries a short tag made from
 * the original path, so two different phone names can never land on one name; the real name is kept on the phone row (the copy's
 * `origin_file_id`) and in the run list. (The old code replaced every "/sdcard/" inside the path; only the leading one is removed here.)
 */
import { createHash } from 'node:crypto';
import { cleanSegment } from '../localCopy/localModel';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "23Nov26" (strftime %d%b%y, English month, the laptop's local date). */
export function dayStamp(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
}

/** "Poco-F4-23Nov26". */
export function sessionFolderName(prefix: string, d: Date): string {
  return `${prefix}-${dayStamp(d)}`;
}

const REMAPS: readonly (readonly [string, string])[] = [
  ['Android/data/com.android.soundrecorder/files/', 'Recordings/Sound Recorder/'],
  ['Android/data/com.miui.soundrecorder/files/', 'Recordings/Sound Recorder/'],
  ['Android/data/com.google.android.dialer/files/callrecording/', 'Recordings/Call Recordings/'],
  ['Android/data/com.miui.notes/files/', 'Notes Media/'],
];

/** "/sdcard/DCIM/a.jpg" -> "DCIM/a.jpg"; the Android data folders of the recorder, dialer and notes apps move to friendly names. */
export function remapPhonePath(phonePath: string): string {
  const rel = phonePath.startsWith('/sdcard/') ? phonePath.slice('/sdcard/'.length) : phonePath.replace(/^\/+/, '');
  for (const [from, to] of REMAPS) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}

/** A short tag of the original phone path, for names that had to change. */
export function nameTag(phonePath: string): string {
  return createHash('sha1').update(phonePath).digest('hex').slice(0, 6);
}

function tagged(name: string, tag: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} [${tag}]${name.slice(dot)}` : `${name} [${tag}]`;
}

/** The folders and name below the session folder, every part storable on Windows. Returns null for a path with no usable name. */
export function windowsSafeParts(mapped: string, phonePath: string): { parts: string[]; changed: boolean } | null {
  const raw = mapped.split('/').filter((s) => s !== '');
  if (raw.length === 0 || raw.some((s) => s === '..' || s === '.')) return null;
  let changed = false;
  const parts = raw.map((s, i) => {
    const c = cleanSegment(s);
    if (c === s) return s;
    changed = true;
    return i === raw.length - 1 ? tagged(c, nameTag(phonePath)) : c;
  });
  return { parts, changed };
}

/** The time added to a name when the same phone file, changed, is backed up a second time on the same day: "a (143005).jpg". */
export function timedName(name: string, d: Date): string {
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${t})${name.slice(dot)}` : `${name} (${t})`;
}

export interface PlacementInput {
  /** The backup folder on the drive ("MyData/POCO"), no slashes at the ends. */
  root: string;
  sessionFolder: string;
  phonePath: string;
}

/** The path of one file on the drive, relative to the drive root, forward slashes; null when the phone path has no usable name. */
export function placeOnDrive(i: PlacementInput): { rel: string; nameChanged: boolean } | null {
  const safe = windowsSafeParts(remapPhonePath(i.phonePath), i.phonePath);
  if (safe === null) return null;
  const rel = [...i.root.split('/').filter((s) => s !== ''), i.sessionFolder, ...safe.parts].join('/');
  return { rel, nameChanged: safe.changed };
}

/** Case-insensitive key of a drive path (Windows does not tell "A.jpg" and "a.jpg" apart). */
export const driveKey = (rel: string): string => rel.normalize('NFC').toLowerCase();
