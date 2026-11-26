/**
 * The "kind" of a file: a finer, human version of the Search category (camera photos, screenshots, WhatsApp videos,
 * voice recordings ...). It is worked out from the path, the name and the mime type, stored once per file
 * (`files.kind`, filled by the classify job) and read by Search and by the Home screen. Pure and shared.
 *
 * Every kind belongs to exactly one Search category (`categoryOfKind`), and `kindOf` always agrees with `categoryOf`.
 */
import { categoryOf, type SearchCategory } from './fileCategories';

export const FILE_KINDS = [
  'photo-camera',
  'photo-screenshot',
  'photo-whatsapp',
  'photo-other',
  'video-camera',
  'video-whatsapp',
  'video-other',
  'audio-recording',
  'audio-music',
  'documents',
  'google-docs',
  'archives',
  'empty',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const KIND_LABELS: Readonly<Record<FileKind, string>> = {
  'photo-camera': 'Camera photos',
  'photo-screenshot': 'Screenshots',
  'photo-whatsapp': 'WhatsApp photos',
  'photo-other': 'Other photos',
  'video-camera': 'Camera videos',
  'video-whatsapp': 'WhatsApp videos',
  'video-other': 'Other videos',
  'audio-recording': 'Voice recordings',
  'audio-music': 'Music and audio',
  documents: 'Documents',
  'google-docs': 'Google Docs',
  archives: 'Archives and installers',
  empty: 'Empty files',
  other: 'Everything else',
};

const CATEGORY_OF_KIND: Readonly<Record<FileKind, SearchCategory>> = {
  'photo-camera': 'photos',
  'photo-screenshot': 'photos',
  'photo-whatsapp': 'photos',
  'photo-other': 'photos',
  'video-camera': 'videos',
  'video-whatsapp': 'videos',
  'video-other': 'videos',
  'audio-recording': 'audio',
  'audio-music': 'audio',
  documents: 'documents',
  'google-docs': 'googleDocs',
  archives: 'archives',
  empty: 'other',
  other: 'other',
};

/** The Search category a kind sits in. */
export function categoryOfKind(kind: FileKind): SearchCategory {
  return CATEGORY_OF_KIND[kind];
}

/** Every kind of one category (the stored kinds a category filter matches). */
export function kindsOfCategory(category: SearchCategory): FileKind[] {
  return FILE_KINDS.filter((k) => CATEGORY_OF_KIND[k] === category);
}

/** True for text that is one of the kinds. */
export function isFileKind(value: unknown): value is FileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

const CAMERA_NAME = /^(?:img|pxl|dsc|dscn|dscf|vid|mov|mvi|pano|burst)[_-]\d/i;
/**
 * Other camera file names (the base name, no extension): Canon IMG_E1234 / _MG_1234 / 0I2A1030 / 5D4_1234, Sony DSC01234 and
 * C0001, Panasonic P1010123, GoPro GOPR0123 / GH010123 / GX010123, DJI_0123, and the date-time names phones write
 * (20230101_123456, 2023-01-01 12.34.56).
 */
const CAMERA_BASE_NAMES: readonly RegExp[] = [
  /^img_e?\d{3,}/i,
  /^_?mg_\d{3,}/i,
  /^_?dsc\d{3,}/i,
  /^\d[a-z]\d[a-z]\d{4}$/i,
  /^\d[a-z]\d{1,2}_\d{3,}/i,
  /^p\d{7}$/i,
  /^(?:gopr|gh\d\d|gx\d\d)\d{4}$/i,
  /^dji_\d{3,}/i,
  /^c\d{4}$/i,
  /^(?:19|20)\d{6}[_-]\d{6}/,
  /^(?:19|20)\d\d-\d\d-\d\d \d\d\.\d\d\.\d\d/,
];
const WHATSAPP_NAME = /-wa\d{4}/i;
const RECORDING_NAME = /^(?:recording|voice|call|rec)[ _-]/i;
const CAMERA_FOLDERS = new Set(['dcim', 'camera']);
const RECORDING_FOLDERS = new Set(['recordings', 'voice recorder', 'sound recorder', 'call']);

/** The folder names of a stored path (forward slashes; the last segment is the file name and is left out). */
function folderSegments(relPath: string): string[] {
  const parts = relPath.replaceAll('\\', '/').toLowerCase().split('/');
  parts.pop();
  return parts;
}

function isWhatsApp(relPath: string, name: string): boolean {
  return relPath.toLowerCase().includes('whatsapp') || WHATSAPP_NAME.test(name);
}

function isScreenshot(name: string, folders: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('screenshot') || lower.startsWith('screen shot') || folders.includes('screenshots');
}

function isCamera(name: string, folders: readonly string[]): boolean {
  if (CAMERA_NAME.test(name) || folders.some((f) => CAMERA_FOLDERS.has(f))) return true;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return CAMERA_BASE_NAMES.some((re) => re.test(base));
}

function isRecording(name: string, folders: readonly string[]): boolean {
  return RECORDING_NAME.test(name) || folders.some((f) => RECORDING_FOLDERS.has(f));
}

/**
 * The kind of a file. `relPath` is the stored path (forward slashes; it ends with the name), `mime` the Google/general
 * mime type or null. Rules, in this order, for photos and videos: WhatsApp (a path part containing "whatsapp", or a
 * name like "-WA0001"), then screenshots (photos only), then camera (a DCIM or Camera folder, or a camera file name).
 * Audio is a recording when it sits in a recordings folder or is named like one, else music. A file of size 0 is "Empty files"
 * (a size of null = not known, so the rules above apply).
 */
export function kindOf(relPath: string, name: string, mime: string | null, size: number | null = null): FileKind {
  // A file with nothing in it (size 0) is its own kind, whatever its name says.
  if (size === 0) return 'empty';
  switch (categoryOf(name, mime)) {
    case 'photos': {
      if (isWhatsApp(relPath, name)) return 'photo-whatsapp';
      const folders = folderSegments(relPath);
      if (isScreenshot(name, folders)) return 'photo-screenshot';
      return isCamera(name, folders) ? 'photo-camera' : 'photo-other';
    }
    case 'videos': {
      if (isWhatsApp(relPath, name)) return 'video-whatsapp';
      return isCamera(name, folderSegments(relPath)) ? 'video-camera' : 'video-other';
    }
    case 'audio':
      return isRecording(name, folderSegments(relPath)) ? 'audio-recording' : 'audio-music';
    case 'documents':
      return 'documents';
    case 'googleDocs':
      return 'google-docs';
    case 'archives':
      return 'archives';
    default:
      return 'other';
  }
}
