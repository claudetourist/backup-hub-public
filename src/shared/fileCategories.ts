/**
 * File categories for Search, decided by the Google mime type first (Google Docs), then the file
 * extension, then the general mime type (image/, video/, audio/). Pure and shared so the query
 * worker and the screen agree.
 */

export const SEARCH_CATEGORIES = ['photos', 'videos', 'audio', 'documents', 'archives', 'googleDocs', 'other'] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<SearchCategory, string>> = {
  photos: 'Photos',
  videos: 'Videos',
  audio: 'Audio',
  documents: 'Documents',
  archives: 'Archives',
  googleDocs: 'Google Docs',
  other: 'Other',
};

const list = (text: string): string[] => text.split(' ');

const EXTENSIONS: Readonly<Record<Exclude<SearchCategory, 'googleDocs' | 'other'>, readonly string[]>> = {
  photos: list('jpg jpeg jpe png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 svg ico psd'),
  videos: list('mp4 m4v mov avi mkv wmv flv webm mpg mpeg mts m2ts ts 3gp 3g2 vob mxf'),
  audio: list('mp3 wav flac aac m4a ogg oga opus wma amr aiff aif mid midi'),
  documents: list('pdf doc docx dot dotx xls xlsx xlsm csv ppt pptx pps ppsx txt rtf odt ods odp md epub mobi pages numbers key tex'),
  archives: list('zip rar 7z tar gz tgz bz2 xz zst iso cab'),
};

const BY_EXTENSION: ReadonlyMap<string, SearchCategory> = new Map(
  (Object.entries(EXTENSIONS) as [SearchCategory, readonly string[]][]).flatMap(([category, exts]) => exts.map((e) => [e, category] as const)),
);

export const GOOGLE_APPS_MIME_PREFIX = 'application/vnd.google-apps.';

/** Lower-case text after the last dot of a file name; '' when there is none (or the name only starts with a dot). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function categoryOf(name: string, mime: string | null): SearchCategory {
  const m = mime === null ? '' : mime.toLowerCase();
  if (m.startsWith(GOOGLE_APPS_MIME_PREFIX)) return 'googleDocs';
  const byExtension = BY_EXTENSION.get(extensionOf(name));
  if (byExtension) return byExtension;
  if (m.startsWith('image/')) return 'photos';
  if (m.startsWith('video/')) return 'videos';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m.startsWith('text/')) return 'documents';
  if (m === 'application/zip' || m === 'application/x-7z-compressed' || m === 'application/x-rar-compressed' || m === 'application/gzip') return 'archives';
  return 'other';
}
